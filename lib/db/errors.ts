export class DbError extends Error {
  readonly cause?: unknown;
  readonly status: number;

  constructor(message: string, cause?: unknown, status = 500) {
    super(message);
    this.name = new.target.name;
    this.cause = cause;
    this.status = status;
  }
}

export class NotFoundError extends DbError {
  constructor(message = 'resource not found', cause?: unknown) {
    super(message, cause, 404);
  }
}

export class ConflictError extends DbError {
  constructor(message = 'resource conflict', cause?: unknown) {
    super(message, cause, 409);
  }
}

export class ForeignKeyError extends DbError {
  constructor(message = 'foreign key constraint failed', cause?: unknown) {
    super(message, cause, 409);
  }
}

export class ValidationError extends DbError {
  constructor(message = 'invalid database input', cause?: unknown) {
    super(message, cause, 400);
  }
}

export class BusinessRuleError extends DbError {
  constructor(message = 'business rule rejected the operation', cause?: unknown) {
    super(message, cause, 400);
  }
}

export class DatabaseUnavailableError extends DbError {
  constructor(message = 'database unavailable', cause?: unknown) {
    super(message, cause, 503);
  }
}

export class TransactionScopeError extends DbError {}

type PgErrorLike = {
  code?: unknown;
  message?: unknown;
};

type DbErrorConstructor = new (message: string, cause?: unknown) => DbError;

const BY_SQLSTATE: Readonly<Record<string, DbErrorConstructor>> = {
  '23505': ConflictError,
  '23503': ForeignKeyError,
  '23514': ValidationError,
  '23502': ValidationError,
  P0001: BusinessRuleError,
  '57014': DatabaseUnavailableError,
};

const CONNECTION_ERROR_CODES = new Set(['ECONNREFUSED', 'ETIMEDOUT', 'ENOTFOUND']);

export function mapPgError(error: unknown): DbError {
  if (error instanceof DbError) return error;

  const pgError = error as PgErrorLike | null;
  const code = typeof pgError?.code === 'string' ? pgError.code : undefined;
  const message = typeof pgError?.message === 'string' ? pgError.message : 'database error';

  if (code && BY_SQLSTATE[code]) return new BY_SQLSTATE[code](message, error);
  if (code && CONNECTION_ERROR_CODES.has(code)) {
    return new DatabaseUnavailableError('database unavailable', error);
  }
  return new DbError(message, error);
}
