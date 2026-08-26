const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

const routePaths = [
  'app/api/auth/login/route.ts',
  'app/api/results/route.ts',
  'app/api/summary/route.ts',
  'app/api/project-ratings/route.ts',
  'app/api/projects/route.ts',
  'app/api/scores/route.ts',
];

function source(relativePath) {
  return fs.readFileSync(path.join(__dirname, '..', relativePath), 'utf8');
}

function methodBody(relativePath, method, nextMethod) {
  const text = source(relativePath);
  const start = text.indexOf(`export async function ${method}`);
  assert.notEqual(start, -1, `${relativePath} exports ${method}`);
  const end = nextMethod ? text.indexOf(`export async function ${nextMethod}`, start) : text.length;
  return text.slice(start, end < 0 ? text.length : end);
}

test('migrated read paths call repositories without Supabase access', () => {
  const methods = [
    ['app/api/auth/login/route.ts', 'POST'],
    ['app/api/results/route.ts', 'GET'],
    ['app/api/summary/route.ts', 'GET'],
    ['app/api/project-ratings/route.ts', 'GET', 'POST'],
    ['app/api/projects/route.ts', 'GET', 'POST'],
    ['app/api/scores/route.ts', 'GET', 'POST'],
  ];

  for (const [route, method, nextMethod] of methods) {
    const body = methodBody(route, method, nextMethod);
    assert.doesNotMatch(body, /supabaseAdmin/, `${route} ${method}`);
  }

  for (const route of routePaths) {
    assert.match(source(route), /@\/lib\/db\/repositories\//, route);
  }
});

test('projects and scores write handlers remain on Supabase', () => {
  for (const [route, methods] of [
    ['app/api/projects/route.ts', ['POST', 'PATCH', 'DELETE']],
    ['app/api/scores/route.ts', ['POST', 'DELETE']],
  ]) {
    const text = source(route);
    for (const method of methods) {
      const start = text.indexOf(`export async function ${method}`);
      const body = text.slice(start);
      assert.match(body, /supabaseAdmin/, `${route} ${method}`);
    }
  }
});

test('unknown login keeps the 401 response contract', async () => {
  const routePath = path.join(__dirname, '..', 'app', 'api', 'auth', 'login', 'route.ts');
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
  Module._load = (request, parent, isMain) => {
    if (request === '@/lib/db/repositories/reviewers') {
      return {
        findReviewerByCode: async () => null,
        listReviewerDimensions: async () => [],
      };
    }
    if (request === '@/lib/adminSession') {
      return {
        adminSessionCookie: () => ({ name: 'session', value: 'token', options: {} }),
        createReviewerSession: () => 'token',
      };
    }
    return originalLoad(request, parent, isMain);
  };

  delete require.cache[routePath];
  try {
    const route = require(routePath);
    const response = await route.POST({ json: async () => ({ code: 'unknown', password: 'pw' }) });
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: '账号不存在' });
  } finally {
    Module._load = originalLoad;
    Module._extensions['.ts'] = originalTypeScriptLoader;
  }
});
