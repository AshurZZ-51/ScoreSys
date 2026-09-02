const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const { isProjectPoolV2Enabled, isPublicProjectPoolV2Enabled } = require('../featureFlags.ts');

test('project pool v2 is enabled by default and only explicit false disables it', () => {
  delete process.env.PROJECT_POOL_V2_ENABLED;
  assert.equal(isProjectPoolV2Enabled(), true);
  process.env.PROJECT_POOL_V2_ENABLED = 'FALSE';
  assert.equal(isProjectPoolV2Enabled(), false);
  process.env.PROJECT_POOL_V2_ENABLED = 'true';
  assert.equal(isProjectPoolV2Enabled(), true);
  delete process.env.PROJECT_POOL_V2_ENABLED;
});

test('the browser entrypoint is enabled by default and supports an explicit rollback flag', () => {
  delete process.env.NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED;
  assert.equal(isPublicProjectPoolV2Enabled(), true);
  process.env.NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED = 'false';
  assert.equal(isPublicProjectPoolV2Enabled(), false);
  process.env.NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED = 'true';
  assert.equal(isPublicProjectPoolV2Enabled(), true);
  delete process.env.NEXT_PUBLIC_PROJECT_POOL_V2_ENABLED;
});
