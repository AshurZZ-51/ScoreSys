const assert = require('node:assert/strict');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');
const typescript = require('typescript');

function loadRoute(relativePath, mocks) {
  const routePath = path.join(__dirname, '..', relativePath);
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

function request(body) {
  return { json: async () => body };
}

test('account creation rolls back the primary write when audit insertion fails', async () => {
  const transaction = { name: 'transaction' };
  const calls = [];
  let rolledBack = false;
  const route = loadRoute('app/api/accounts/route.ts', {
    '@/lib/adminAuth': { isSuperAdmin: (code) => code === 'admin51' },
    '@/lib/adminSession': { requireAdminSession: () => ({ code: 'admin51', is_admin: true }) },
    '@/lib/db/client': {
      tx: async (callback) => {
        try {
          return await callback(transaction);
        } catch (error) {
          rolledBack = true;
          throw error;
        }
      },
    },
    '@/lib/db/repositories/accounts': {
      findAccountByCode: async (code, executor) => {
        calls.push(['find', code, executor]);
        return null;
      },
      createAccount: async (input, executor) => {
        calls.push(['create', input, executor]);
        return { code: input.code, name: input.name, role: input.role, is_admin: input.isAdmin };
      },
      writeAccountAudit: async (actor, target, action, executor) => {
        calls.push(['audit', actor, target, action, executor]);
        throw new Error('audit unavailable');
      },
      listAccounts: async () => [],
    },
  });

  const response = await route.POST(request({ code: 'new-user', password: 'pw', name: 'N', role: 'R' }));

  assert.equal(response.status, 500);
  assert.equal(calls[0][2], transaction);
  assert.equal(calls[1][2], transaction);
  assert.equal(calls[2][4], transaction);
  assert.equal(rolledBack, true);
});

test('project PATCH maps repository validation errors to HTTP 400', async () => {
  const route = loadRoute('app/api/projects/route.ts', {
    '@/lib/adminSession': { requireAdminSession: () => ({ code: 'admin51', is_admin: true }), requireReviewerSession: () => true },
    '@/lib/featureFlags': { isProjectPoolV2Enabled: () => true },
    '@/lib/projectSlots': { getMissingTemplateProjects: () => [] },
    '@/lib/db/repositories/projects': {
      updateProject: async () => { throw { status: 400, message: 'field is not updatable: meeting_id' }; },
      listMeetingProjects: async () => [],
      createProject: async () => ({}),
      deleteProject: async () => 0,
    },
  });

  const response = await route.PATCH(request({ id: 'p1', meeting_id: 'm2' }));

  assert.equal(response.status, 400);
});
