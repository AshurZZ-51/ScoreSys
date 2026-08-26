const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const root = path.join(__dirname, '..');
const forbidden = ['sup', 'abase'].join('');

function read(relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8');
}

function loadRoute(relativePath, mocks) {
  const routePath = path.join(root, relativePath);
  const originalLoad = Module._load;
  const originalTypeScriptLoader = Module._extensions['.ts'];
  Module._extensions['.ts'] = (module, filename) => {
    const output = typescript.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: typescript.ModuleKind.CommonJS,
        target: typescript.ScriptTarget.ES2022,
        esModuleInterop: true,
      },
    }).outputText;
    module._compile(output, filename);
  };
  Module._load = (request, parent, isMain) => mocks[request] || originalLoad(request, parent, isMain);
  delete require.cache[routePath];
  try {
    return require(routePath);
  } finally {
    Module._load = originalLoad;
    Module._extensions['.ts'] = originalTypeScriptLoader;
  }
}

test('runtime and dependency surface has no hosted database client references', () => {
  const files = [
    ...['app', 'lib', 'scripts'].flatMap((directory) => {
      const absolute = path.join(root, directory);
      if (!fs.existsSync(absolute)) return [];
      const pending = [absolute];
      const result = [];
      while (pending.length) {
        const current = pending.pop();
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const target = path.join(current, entry.name);
          if (entry.isDirectory()) pending.push(target);
          else if (!target.endsWith('t8Contract.test.cjs')) result.push(target);
        }
      }
      return result;
    }),
    path.join(root, 'package.json'),
    path.join(root, 'package-lock.json'),
    path.join(root, '.env.example'),
    path.join(root, 'DEVELOPER_GUIDE.md'),
    path.join(root, '交付说明.md'),
  ];

  for (const file of files) {
    assert.equal(read(path.relative(root, file)).toLowerCase().includes(forbidden), false, file);
  }
  assert.equal(fs.existsSync(path.join(root, 'lib', `${forbidden}.ts`)), false);
  assert.equal(fs.existsSync(path.join(root, 'scripts', 'migrate-project-pool.mjs')), false);
});

test('reports and ratings routes are repository-only and expose required POST contracts', () => {
  const reports = read('app/api/reports/route.ts');
  const ratings = read('app/api/project-ratings/route.ts');
  assert.equal(reports.toLowerCase().includes(forbidden), false);
  assert.equal(ratings.toLowerCase().includes(forbidden), false);
  assert.match(reports, /createReportSnapshot/);
  assert.match(reports, /getProjectReportData/);
  assert.match(ratings, /findReviewerByCode/);
  assert.match(ratings, /getProjectRatingAssignment/);
  assert.match(ratings, /findMeetingReviewerSnapshot/);
  assert.match(ratings, /upsertProjectRating/);
});

test('report snapshot repository locks version allocation and writes in one transaction', () => {
  const reports = read('lib/db/repositories/reports.ts');
  assert.match(reports, /pg_advisory_xact_lock/);
  assert.match(reports, /INSERT INTO report_snapshots/);
  assert.match(reports, /ON CONFLICT|MAX\(version\)/);
  assert.match(reports, /tx\(/);
});

test('project ratings repository uses the assignment conflict target', () => {
  const scores = read('lib/db/repositories/scores.ts');
  assert.match(scores, /ON CONFLICT \(meeting_id, project_id, reviewer_code, round_no, attempt_no\)/);
});

test('database health endpoint has a diagnostic-only SELECT 1 contract', () => {
  const health = read('app/api/health/db/route.ts');
  assert.match(health, /SELECT 1/);
  assert.match(health, /ok:\s*true/);
  assert.match(health, /totalCount/);
  assert.match(health, /idleCount/);
  assert.match(health, /waitingCount/);
  assert.match(health, /status:\s*503/);
  assert.doesNotMatch(health, /liveness|readiness|probe/i);
  assert.doesNotMatch(health, /error\.message/);
});

test('database health returns pool shape on success and a redacted 503 on failure', async () => {
  let mode = 'ok';
  const route = loadRoute('app/api/health/db/route.ts', {
    '@/lib/db/client': {
      query: async (text) => {
        assert.equal(text, 'SELECT 1');
        if (mode === 'fail') throw new Error('password=secret SELECT private_table');
        return [];
      },
    },
    '@/lib/db/pool': {
      getPoolStats: () => ({ totalCount: 3, idleCount: 2, waitingCount: 1 }),
    },
  });

  const success = await route.GET();
  assert.equal(success.status, 200);
  assert.deepEqual(await success.json(), {
    ok: true,
    pool: { totalCount: 3, idleCount: 2, waitingCount: 1 },
  });

  mode = 'fail';
  const failure = await route.GET();
  assert.equal(failure.status, 503);
  const body = await failure.json();
  assert.deepEqual(body, { ok: false });
  assert.equal(JSON.stringify(body).includes('secret'), false);
  assert.equal(JSON.stringify(body).includes('private_table'), false);
});

test('reports POST keeps the snapshot response wrapper while using the PG repositories', async () => {
  let snapshotInput;
  const route = loadRoute('app/api/reports/route.ts', {
    '@/lib/adminSession': { requireAdminSession: () => ({ code: 'admin51', is_admin: true }) },
    '@/lib/reportSnapshots': {
      buildInitiationProjectPayload: (project, summaries, timeline) => ({ project, summaries, timeline }),
      buildMeetingReportPayload: () => ({}),
    },
    '@/lib/db/repositories/reports': {
      listReportSnapshots: async () => [],
      getProjectReportData: async () => ({
        project: { id: 'pool-1', name: 'Project' },
        assignments: [],
        timeline: [{ event_type: 'project_created' }],
      }),
      createReportSnapshot: async (input) => {
        snapshotInput = input;
        return { id: 'snapshot-1', version: 1, payload: input.payload };
      },
    },
  });

  const response = await route.POST({
    json: async () => ({ scope_type: 'project', scope_id: 'pool-1', report_type: 'initiation' }),
  });
  assert.equal(response.status, 201);
  assert.deepEqual(await response.json(), {
    snapshot: { id: 'snapshot-1', version: 1, payload: snapshotInput.payload },
  });
  assert.equal(snapshotInput.scopeType, 'project');
  assert.equal(snapshotInput.scopeId, 'pool-1');
  assert.equal(snapshotInput.reportType, 'initiation');
  assert.equal(snapshotInput.generatedBy, 'admin51');
});

test('project ratings POST preserves reviewer and meeting snapshot rules', async () => {
  const calls = [];
  const route = loadRoute('app/api/project-ratings/route.ts', {
    '@/lib/featureFlags': { isProjectPoolV2Enabled: () => true },
    '@/lib/adminSession': {
      requireReviewerSession: () => ({ code: 'r1', is_admin: false }),
      isSameReviewerCode: (left, right) => String(left).toLowerCase() === String(right).toLowerCase(),
    },
    '@/lib/projectReviewerRating': { normalizeProjectRating: (value) => String(value).toUpperCase() === 'A' ? 'A' : null },
    '@/lib/db/repositories/reviewers': {
      findReviewerByCode: async () => ({ code: 'R1', is_admin: false }),
    },
    '@/lib/db/repositories/scores': {
      listProjectRatings: async () => [],
      getProjectRatingAssignment: async (meetingId, projectId) => {
        calls.push(['assignment', meetingId, projectId]);
        return { id: projectId, meeting_id: meetingId, round_no: 2, attempt_no: 2 };
      },
      findMeetingReviewerSnapshot: async (meetingId, reviewerCode) => {
        calls.push(['snapshot', meetingId, reviewerCode]);
        return { reviewer_code: reviewerCode };
      },
      upsertProjectRating: async (input) => {
        calls.push(['upsert', input]);
        return { id: 'rating-1', ...input };
      },
    },
  });

  const response = await route.POST({
    json: async () => ({ meeting_id: 'meeting-1', project_id: 'project-1', rating: 'a' }),
  });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.success, true);
  assert.equal(body.rating.roundNo, 2);
  assert.equal(body.rating.attemptNo, 2);
  assert.deepEqual(calls.slice(0, 2), [
    ['assignment', 'meeting-1', 'project-1'],
    ['snapshot', 'meeting-1', 'R1'],
  ]);
  assert.equal(calls[2][0], 'upsert');
  assert.deepEqual(calls[2][1], {
    meetingId: 'meeting-1',
    projectId: 'project-1',
    reviewerCode: 'R1',
    roundNo: 2,
    attemptNo: 2,
    rating: 'A',
    updatedAt: calls[2][1].updatedAt,
  });
});
