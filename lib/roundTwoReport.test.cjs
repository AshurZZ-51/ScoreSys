const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('round-two report derives its dimension columns from the canonical scoring rules', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'report', 'components', 'RoundTwoReport.tsx'), 'utf8');
  assert.match(source, /ROUND_BY_ID\.r2\.dimensions/);
});
