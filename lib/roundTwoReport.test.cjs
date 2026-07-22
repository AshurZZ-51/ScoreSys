const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('round-two report derives its dimension columns from the canonical scoring rules', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'report', 'components', 'RoundTwoReport.tsx'), 'utf8');
  assert.match(source, /getRoundDefinition\('r2', versionGroup\.scoringVersion\)/);
});

test('round-two report selects dimensions from the snapshot scoring version', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'report', 'components', 'RoundTwoReport.tsx'), 'utf8');

  assert.match(source, /getRoundDefinition\('r2', versionGroup\.scoringVersion\)/);
  assert.match(source, /two_round_v3/);
});

test('round-two report separates historical and five-dimension projects before rendering', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'app', 'report', 'components', 'RoundTwoReport.tsx'), 'utf8');

  assert.match(source, /versionGroups/);
  assert.match(source, /projects: versionGroup\.projects/);
});
