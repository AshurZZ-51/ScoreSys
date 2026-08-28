const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const root = path.join(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(root, relative), 'utf8');

function loadRoute(relativePath, mocks) {
  const routePath = path.join(root, relativePath);
  const originalLoad = Module._load;
  const originalTs = Module._extensions['.ts'];
  Module._extensions['.ts'] = (module, filename) => {
    const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: { module: typescript.ModuleKind.CommonJS, target: typescript.ScriptTarget.ES2022, esModuleInterop: true },
    }).outputText;
    module._compile(output, filename);
  };
  Module._load = (request, parent, isMain) => mocks[request] || originalLoad(request, parent, isMain);
  delete require.cache[routePath];
  try {
    return require(routePath);
  } finally {
    Module._load = originalLoad;
    Module._extensions['.ts'] = originalTs;
  }
}

function request(url, body) {
  return {
    url,
    json: async () => body,
    cookies: { get: () => undefined },
    headers: { get: () => null },
  };
}

test('final runtime image installs the Alpine 3.23 PostgreSQL client pin and exposes psql', () => {
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /apk add --no-cache postgresql16-client=16\.15-r0\b/i);
  assert.match(dockerfile, /command -v psql|psql --version/);
});

test('CI never runs database migration or import and offline tooling remains available', () => {
  const ci = read('.gitlab-ci.yml');
  for (const forbidden of [
    /db-gates/,
    /migrate-db/,
    /import-db/,
    /PRODUCTION_DB_MUTATION_APPROVED/,
    /MIGRATOR_SECRET_NAME/,
    /SNAPSHOT_FILE/,
    /MANIFEST_FILE/,
    /scripts\/db\//,
    /scoringsys-db-mutation/,
  ]) {
    assert.doesNotMatch(ci, forbidden);
  }
  assert.match(read('scripts/db/migrate.mjs'), /MIGRATOR_DATABASE_URL/);
  assert.match(read('scripts/db/import-snapshot.mjs'), /MIGRATOR_DATABASE_URL/);
});

test('all sensitive API GET handlers fail closed with the shared reviewer 401', () => {
  const routes = [
    'app/api/accounts/route.ts',
    'app/api/meetings/route.ts',
    'app/api/project-pool/route.ts',
    'app/api/project-pool/[id]/history/route.ts',
    'app/api/project-pool/[id]/materials/route.ts',
    'app/api/project-ratings/route.ts',
    'app/api/projects/route.ts',
    'app/api/reports/route.ts',
    'app/api/results/route.ts',
    'app/api/scores/route.ts',
    'app/api/summary/route.ts',
  ];
  for (const route of routes) {
    const source = read(route);
    assert.match(source, /requireReviewerSession\(request\)/, `${route} must authenticate GET`);
    assert.match(source, /\{ error: '请先登录' \}, \{ status: 401 \}/, `${route} must preserve 401 shape`);
  }
  assert.doesNotMatch(read('app/api/health/db/route.ts'), /requireReviewerSession/);
  assert.doesNotMatch(read('app/api/auth/login/route.ts'), /requireReviewerSession/);
});

test('DELETE scores requires reviewer identity and permits only own scope unless admin', async () => {
  const calls = [];
  const route = loadRoute('app/api/scores/route.ts', {
    '@/lib/featureFlags': { isProjectPoolV2Enabled: () => false },
    '@/lib/projectPoolWorkflow': { transitionForVerdict: () => ({ ok: false }) },
    '@/lib/scoringRules': { getScoreMax: () => 0, isValidScoreValue: () => true, parseScoreKey: () => null },
    '@/lib/reviewWorkflow': { ADMIN_TRACKING_SPECIAL_DIMENSIONS: new Set(), getRoundFromDimName: () => null, nextStatusForVerdict: () => '', stripRoundPrefix: (value) => value },
    '@/lib/reviewerBlindReview': { shouldAdvanceProjectWorkflow: () => false },
    '@/lib/db/repositories/scores': { listScores: async () => [] },
    '@/lib/adminSession': {
      requireReviewerSession: (req) => req.session || null,
      requireAdminSession: (req) => req.session?.is_admin ? req.session : null,
      isSameReviewerCode: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
    },
    '@/lib/db/repositories/scoreWorkflow': {
      deleteScores: async (input) => { calls.push(input); },
      getScoringMeeting: async () => null,
      getScoringAssignment: async () => null,
      getScoringReviewer: async () => null,
      hasReviewerDimension: async () => false,
      isMeetingReviewer: async () => false,
      submitScoreWorkflow: async () => null,
    },
  });

  const anonymous = request('http://localhost/api/scores?meetingId=m&reviewerCode=R');
  let response = await route.DELETE(anonymous);
  assert.equal(response.status, 401);

  const crossReviewer = request('http://localhost/api/scores?meetingId=m&reviewerCode=R2', null);
  crossReviewer.session = { code: 'r1', is_admin: false };
  response = await route.DELETE(crossReviewer);
  assert.equal(response.status, 403);

  const admin = request('http://localhost/api/scores?meetingId=m', null);
  admin.session = { code: 'admin51', is_admin: true };
  response = await route.DELETE(admin);
  assert.equal(response.status, 200);
  assert.deepEqual(calls, [{ meetingId: 'm', reviewerCode: null, projectId: null }]);
});

test('login and account writes use pgcrypto bcrypt verification/hashing without JS plaintext equality', () => {
  const login = read('app/api/auth/login/route.ts');
  const reviewers = read('lib/db/repositories/reviewers.ts');
  const accounts = read('lib/db/repositories/accounts.ts');
  const initiation = read('MIGRATION_INITIATION_V4.sql');
  assert.doesNotMatch(login, /password_hash\s*!==?\s*password/);
  assert.match(reviewers, /crypt\(\$2,\s*password_hash\)|crypt\(password_hash/);
  assert.match(accounts, /crypt\(\$5,\s*gen_salt\('bf'\)\)/);
  assert.match(accounts, /crypt\(\$\$\{passwordIndex\},\s*gen_salt\('bf'\)\)/);
  assert.doesNotMatch(initiation, /'ollie123'|'simon123'|Initial passwords/i);
  assert.match(initiation, /crypt\(gen_random_uuid\(\)::text,\s*gen_salt\('bf'\)\)/);
});

test('wrong login password remains a 401 after SQL-side bcrypt verification', async () => {
  const route = loadRoute('app/api/auth/login/route.ts', {
    '@/lib/db/repositories/reviewers': {
      findReviewerByCode: async () => ({ code: 'W', name: 'Walker', role: '评委', is_admin: false, password_hash: '$2b$12$not-printed' }),
      verifyReviewerPassword: async () => null,
      listReviewerDimensions: async () => [],
    },
    '@/lib/adminSession': {
      adminSessionCookie: () => ({ name: 'session', value: 'token', options: {} }),
      createReviewerSession: () => 'token',
    },
  });
  const response = await route.POST(request('http://localhost/api/auth/login', { code: 'W', password: 'wrong' }));
  assert.equal(response.status, 401);
  assert.deepEqual(await response.json(), { error: '密码错误' });
});

test('stdin bundle import transforms legacy plaintext reviewer passwords before commit', () => {
  const importer = read('scripts/db/import-snapshot.mjs');
  assert.match(importer, /readStdin|stdin/);
  assert.match(importer, /snapshot\s*:\s*[^,]+manifest|bundle\.snapshot/);
  assert.match(importer, /UPDATE public\.reviewers[\s\S]+crypt\(password_hash,\s*gen_salt\('bf'\)\)/);
  assert.ok(importer.indexOf("crypt(password_hash") < importer.indexOf('COMMIT'));
});
