const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const accounts = require('./repositories/accounts.ts');
const meetings = require('./repositories/meetingMutations.ts');
const projects = require('./repositories/projects.ts');
const { ValidationError } = require('./errors.ts');

function executorWith(rows = [], rowCount = rows.length) {
  const calls = [];
  return {
    calls,
    async query(text, params = []) {
      calls.push({ text, params });
      return { rows, rowCount };
    },
  };
}

function normalizedSql(text) {
  return text.replace(/\s+/g, ' ').trim();
}

test('accounts use escaped case-insensitive exact code matching', async () => {
  const executor = executorWith([{ code: 'A%_\\B', name: 'A', role: 'R', is_admin: false }]);

  await accounts.findAccountByCode('A%_\\B', executor);

  assert.deepEqual(executor.calls[0].params, ['A\\%\\_\\\\B']);
  assert.match(normalizedSql(executor.calls[0].text), /code ILIKE \$1 ESCAPE/);
  assert.equal(executor.calls[0].text.includes('A%_\\B'), false);
});

test('account creation and audit can share an explicit transaction executor', async () => {
  const executor = executorWith([{ code: 'new-user', name: 'N', role: 'R', is_admin: false }]);

  const account = await accounts.createAccount({
    code: 'new-user',
    name: 'N',
    role: 'R',
    isAdmin: false,
    passwordHash: 'pw',
  }, executor);
  await accounts.writeAccountAudit('admin51', account.code, 'account_created', executor);

  assert.equal(executor.calls.length, 2);
  assert.deepEqual(executor.calls[0].params, ['new-user', 'N', 'R', false, 'pw']);
  assert.match(normalizedSql(executor.calls[0].text), /INSERT INTO reviewers/);
  assert.deepEqual(executor.calls[1].params, ['admin51', 'new-user', 'account_created']);
  assert.match(normalizedSql(executor.calls[1].text), /INSERT INTO account_audit_logs/);
});

test('account updates parameterize the case-insensitive target code', async () => {
  const executor = executorWith([{ code: 'User', name: 'N', role: 'R', is_admin: true }]);

  await accounts.updateAccount('u%ser', { is_admin: true }, executor);

  assert.deepEqual(executor.calls[0].params, [true, 'u\\%ser']);
  assert.match(normalizedSql(executor.calls[0].text), /SET "is_admin" = \$1/);
  assert.match(normalizedSql(executor.calls[0].text), /WHERE code ILIKE \$2 ESCAPE/);
});

test('meeting batch mutation returns one row per updated meeting and keeps ids parameterized', async () => {
  const executor = executorWith([{ id: 'm1' }, { id: 'm2' }]);

  const rows = await meetings.batchUpdateMeetings(['m1', 'm2'], 'recycle', executor);

  assert.deepEqual(rows, [{ id: 'm1' }, { id: 'm2' }]);
  assert.match(executor.calls[0].params[0], /^20\d\d-/);
  assert.deepEqual(executor.calls[0].params.slice(1), [
    null,
    'archived',
    false,
    ['m1', 'm2'],
  ]);
  assert.match(normalizedSql(executor.calls[0].text), /WHERE id = ANY\(\$5::uuid\[\]\)/);
  assert.equal(executor.calls[0].text.includes('m1'), false);
});

test('meeting single mutation returns the complete meeting row', async () => {
  const meeting = { id: 'm1', name: 'Meeting', status: 'active' };
  const executor = executorWith([meeting]);

  const result = await meetings.updateMeeting('m1', 'restore', executor);

  assert.deepEqual(result, meeting);
  assert.deepEqual(executor.calls[0].params, [null, null, 'active', 'm1']);
  assert.match(normalizedSql(executor.calls[0].text), /WHERE id = \$4/);
});

test('project creation inserts only the supported business fields', async () => {
  const executor = executorWith([{ id: 'p1', meeting_id: 'm1', name: 'P' }]);

  await projects.createProject({
    meeting_id: 'm1',
    seq_no: 2,
    name: 'P',
    submitter: 'S',
    description: 'D',
    is_pending: true,
    problems: ['problem'],
    actions: ['action'],
  }, executor);

  assert.deepEqual(executor.calls[0].params, ['m1', 2, 'P', 'S', 'D', true, false, ['problem'], ['action']]);
  assert.match(normalizedSql(executor.calls[0].text), /INSERT INTO projects/);
  assert.equal(executor.calls[0].text.includes('pool_project_id'), false);
});

test('project updates use the allowlist and reject protected columns before querying', async () => {
  const executor = executorWith([{ id: 'p1' }]);

  await assert.rejects(
    projects.updateProject('p1', { meeting_id: 'm2' }, executor),
    ValidationError,
  );
  await assert.rejects(
    projects.updateProject('p1', { is_template: true }, executor),
    ValidationError,
  );
  await assert.rejects(
    projects.updateProject('p1', { scoring_version: 'legacy_v1' }, executor),
    ValidationError,
  );
  assert.equal(executor.calls.length, 0);
});

test('project updates parameterize values and return the updated row', async () => {
  const executor = executorWith([{ id: 'p1', name: 'Updated' }]);

  const project = await projects.updateProject('p1', { name: 'Updated', is_pending: false }, executor);

  assert.deepEqual(project, { id: 'p1', name: 'Updated' });
  assert.deepEqual(executor.calls[0].params, ['Updated', false, 'p1']);
  assert.match(normalizedSql(executor.calls[0].text), /SET "name" = \$1, "is_pending" = \$2 WHERE id = \$3/);
});

test('project deletion uses a parameterized id and returns affected count', async () => {
  const executor = executorWith([], 1);

  assert.equal(await projects.deleteProject('p1', executor), 1);
  assert.deepEqual(executor.calls[0].params, ['p1']);
  assert.match(normalizedSql(executor.calls[0].text), /DELETE FROM projects WHERE id = \$1/);
});
