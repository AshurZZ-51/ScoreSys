const test = require('node:test');
const assert = require('node:assert/strict');
const { isSuperAdmin } = require('./adminAuth');

test('only admin51 is the super administrator', () => {
  assert.equal(isSuperAdmin('ADMIN51'), true);
  assert.equal(isSuperAdmin(' admin51 '), true);
  assert.equal(isSuperAdmin('admin52'), false);
  assert.equal(isSuperAdmin('walker'), false);
  assert.equal(isSuperAdmin(null), false);
});
