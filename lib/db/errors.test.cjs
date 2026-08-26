const assert = require('node:assert/strict');
const test = require('node:test');
require('./testTypeScript.cjs');

const {
  BusinessRuleError,
  ConflictError,
  DatabaseUnavailableError,
  DbError,
  ForeignKeyError,
  mapPgError,
  NotFoundError,
  TransactionScopeError,
  ValidationError,
} = require('./errors.ts');

test('DAL errors expose the HTTP status contract', () => {
  assert.equal(new DbError('x').status, 500);
  assert.equal(new NotFoundError('x').status, 404);
  assert.equal(new ConflictError('x').status, 409);
  assert.equal(new ForeignKeyError('x').status, 409);
  assert.equal(new ValidationError('x').status, 400);
  assert.equal(new BusinessRuleError('x').status, 400);
  assert.equal(new DatabaseUnavailableError('x').status, 503);
  assert.equal(new TransactionScopeError('x').status, 500);
});

test('mapPgError maps SQLSTATE without losing the database message or cause', () => {
  const cases = [
    ['23505', ConflictError],
    ['23503', ForeignKeyError],
    ['23514', ValidationError],
    ['23502', ValidationError],
    ['P0001', BusinessRuleError],
    ['57014', DatabaseUnavailableError],
  ];

  for (const [code, ErrorType] of cases) {
    const cause = { code, message: `database message ${code}` };
    const mapped = mapPgError(cause);
    assert.ok(mapped instanceof ErrorType, code);
    assert.equal(mapped.message, cause.message, code);
    assert.equal(mapped.cause, cause, code);
  }
});

test('mapPgError maps connection failures to a stable 503 contract', () => {
  for (const code of ['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']) {
    const mapped = mapPgError({ code, message: 'socket details' });
    assert.ok(mapped instanceof DatabaseUnavailableError, code);
    assert.equal(mapped.status, 503, code);
    assert.equal(mapped.message, 'database unavailable', code);
  }
});

test('mapPgError preserves existing DAL errors and wraps unknown errors', () => {
  const known = new ValidationError('bad input');
  assert.equal(mapPgError(known), known);

  const cause = new Error('unexpected');
  const mapped = mapPgError(cause);
  assert.ok(mapped instanceof DbError);
  assert.equal(mapped.message, 'unexpected');
  assert.equal(mapped.cause, cause);
});
