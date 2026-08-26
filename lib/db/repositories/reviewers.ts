import type { Executor } from '../client';
import { maybeOne, query } from '../client';

export interface LoginReviewer {
  code: string;
  name: string;
  role: string | null;
  is_admin: boolean;
  password_hash: string;
}

export interface ReviewerSummary {
  code: string;
  name: string;
  role: string | null;
  is_admin: boolean;
}

export interface ReviewerDimension {
  reviewer_code: string;
  dim_name: string;
  max_score: number;
}

export interface LoginDimension {
  dim_name: string;
  max_score: number;
}

function escapeIlikeLiteral(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

export function findReviewerByCode(
  code: string,
  executor?: Executor,
): Promise<LoginReviewer | null> {
  return maybeOne<LoginReviewer>(
    `SELECT code, name, role, is_admin, password_hash
       FROM reviewers
      WHERE code ILIKE $1 ESCAPE '\\'`,
    [escapeIlikeLiteral(code)],
    executor,
  );
}

export function verifyReviewerPassword(
  code: string,
  password: string,
  executor?: Executor,
): Promise<LoginReviewer | null> {
  return maybeOne<LoginReviewer>(
    `SELECT code, name, role, is_admin, password_hash
       FROM reviewers
      WHERE code ILIKE $1 ESCAPE '\\'
        AND password_hash = crypt($2, password_hash)`,
    [escapeIlikeLiteral(code), password],
    executor,
  );
}

export function listReviewerDimensions(
  reviewerCode: string,
  executor?: Executor,
): Promise<LoginDimension[]> {
  return query<LoginDimension>(
    `SELECT dim_name, max_score
       FROM reviewer_dims
      WHERE reviewer_code = $1
      ORDER BY max_score DESC`,
    [reviewerCode],
    executor,
  );
}

export function listReviewers(executor?: Executor): Promise<ReviewerSummary[]> {
  return query<ReviewerSummary>(
    `SELECT code, name, role, is_admin
       FROM reviewers
      ORDER BY code`,
    [],
    executor,
  );
}

export function listAllReviewerDimensions(executor?: Executor): Promise<ReviewerDimension[]> {
  return query<ReviewerDimension>(
    `SELECT reviewer_code, dim_name, max_score
       FROM reviewer_dims`,
    [],
    executor,
  );
}
