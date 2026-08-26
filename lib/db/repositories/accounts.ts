import type { Executor } from '../client';
import { execute, maybeOne, one, query } from '../client';
import { buildUpdateSet } from '../sql';

export interface AccountSummary {
  code: string;
  name: string;
  role: string | null;
  is_admin: boolean;
}

export interface AccountInput {
  code: string;
  name: string;
  role: string;
  isAdmin: boolean;
  passwordHash: string;
}

export interface AccountPatch {
  password_hash?: string;
  is_admin?: boolean;
}

const ACCOUNT_UPDATABLE = ['password_hash', 'is_admin'] as const;

function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function listAccounts(executor?: Executor): Promise<AccountSummary[]> {
  return query<AccountSummary>(
    `SELECT code, name, role, is_admin
       FROM reviewers
      ORDER BY code`,
    [],
    executor,
  );
}

export function findAccountByCode(code: string, executor?: Executor): Promise<AccountSummary | null> {
  return maybeOne<AccountSummary>(
    `SELECT code, name, role, is_admin
       FROM reviewers
      WHERE code ILIKE $1 ESCAPE '\\'`,
    [escapeIlikeLiteral(code)],
    executor,
  );
}

export function createAccount(input: AccountInput, executor?: Executor): Promise<AccountSummary> {
  return one<AccountSummary>(
    `INSERT INTO reviewers (code, name, role, is_admin, password_hash)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING code, name, role, is_admin`,
    [input.code, input.name, input.role, input.isAdmin, input.passwordHash],
    executor,
  );
}

export function updateAccount(
  code: string,
  patch: AccountPatch,
  executor?: Executor,
): Promise<AccountSummary> {
  const update = buildUpdateSet(patch as Record<string, unknown>, ACCOUNT_UPDATABLE);
  const targetIndex = update.params.length + 1;
  return one<AccountSummary>(
    `UPDATE reviewers
        SET ${update.clause}
      WHERE code ILIKE $${targetIndex} ESCAPE '\\'
      RETURNING code, name, role, is_admin`,
    [...update.params, escapeIlikeLiteral(code)],
    executor,
  );
}

export function writeAccountAudit(
  actorCode: string,
  targetCode: string,
  action: string,
  executor?: Executor,
): Promise<number> {
  return execute(
    `INSERT INTO account_audit_logs (actor_code, target_code, action)
     VALUES ($1, $2, $3)`,
    [actorCode, targetCode, action],
    executor,
  );
}
