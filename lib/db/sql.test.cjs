const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const { ValidationError } = require('./errors.ts');
const { buildUpdateSet, PROJECT_UPDATABLE } = require('./sql.ts');

test('buildUpdateSet emits only placeholders and keeps values in params', () => {
  const dangerousValue = "x', is_template = true --";
  const result = buildUpdateSet(
    { name: dangerousValue, description: null },
    PROJECT_UPDATABLE,
    3,
  );

  assert.deepEqual(result, {
    clause: '"name" = $3, "description" = $4',
    params: [dangerousValue, null],
  });
  assert.equal(result.clause.includes(dangerousValue), false);
});

test('buildUpdateSet rejects any field outside the explicit allowlist', () => {
  assert.throws(
    () => buildUpdateSet({ name: 'valid', scoring_version: 'attacker-controlled' }, PROJECT_UPDATABLE),
    (error) => error instanceof ValidationError && error.message === 'field is not updatable: scoring_version',
  );
});

test('buildUpdateSet rejects empty updates and invalid placeholder offsets', () => {
  assert.throws(
    () => buildUpdateSet({}, PROJECT_UPDATABLE),
    ValidationError,
  );
  assert.throws(
    () => buildUpdateSet({ name: 'x' }, PROJECT_UPDATABLE, 0),
    ValidationError,
  );
});

test('buildUpdateSet rejects unsafe identifiers even if supplied in an allowlist', () => {
  assert.throws(
    () => buildUpdateSet({ 'name" = now() --': 'x' }, ['name" = now() --']),
    ValidationError,
  );
});
