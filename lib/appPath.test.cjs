const assert = require('node:assert/strict');
const test = require('node:test');
const { appPath, getBasePath, normalizeBasePath } = require('./appPath');

test('normalizes optional deployment prefixes', () => {
  assert.equal(normalizeBasePath(''), '');
  assert.equal(normalizeBasePath('/'), '');
  assert.equal(normalizeBasePath('scoringsys/'), '/scoringsys');
  assert.equal(getBasePath('', 'production'), '');
  assert.equal(getBasePath(undefined, 'development'), '');
  assert.equal(getBasePath(undefined, 'production'), '/scoringsys');
});

test('prefixes only local root-relative paths and avoids duplicates', () => {
  assert.equal(appPath('/api/summary'), '/api/summary');
  assert.equal(appPath('/scoringsys/api/summary'), '/scoringsys/api/summary');
  assert.equal(appPath('https://example.com/api'), 'https://example.com/api');
  assert.equal(appPath('//cdn.example.com/app.js'), '//cdn.example.com/app.js');
  assert.equal(appPath('/report?meetingId=1'), '/report?meetingId=1');
});
