const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const { isProjectPoolV2Enabled } = require('../featureFlags.ts');

test('project pool v2 is enabled only by the exact string true', () => {
  delete process.env.PROJECT_POOL_V2_ENABLED;
  assert.equal(isProjectPoolV2Enabled(), false);
  process.env.PROJECT_POOL_V2_ENABLED = 'TRUE';
  assert.equal(isProjectPoolV2Enabled(), false);
  process.env.PROJECT_POOL_V2_ENABLED = 'true';
  assert.equal(isProjectPoolV2Enabled(), true);
  delete process.env.PROJECT_POOL_V2_ENABLED;
});
