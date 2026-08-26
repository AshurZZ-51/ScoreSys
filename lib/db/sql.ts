import { ValidationError } from './errors';

const SAFE_IDENTIFIER = /^[a-z_][a-z0-9_]*$/;

export const PROJECT_UPDATABLE = [
  'seq_no',
  'name',
  'submitter',
  'description',
  'is_pending',
  'is_template',
  'problems',
  'actions',
  'round_no',
  'attempt_no',
  'assignment_status',
] as const;

export function buildUpdateSet(
  patch: Record<string, unknown>,
  allowed: readonly string[],
  startIndex = 1,
): { clause: string; params: unknown[] } {
  if (!Number.isInteger(startIndex) || startIndex < 1) {
    throw new ValidationError('placeholder start index must be a positive integer');
  }
  if (allowed.some((field) => !SAFE_IDENTIFIER.test(field))) {
    throw new ValidationError('update allowlist contains an unsafe identifier');
  }

  const allowedFields = new Set(allowed);
  const keys = Object.keys(patch);
  const invalidField = keys.find((field) => !allowedFields.has(field));
  if (invalidField) throw new ValidationError(`field is not updatable: ${invalidField}`);
  if (keys.length === 0) throw new ValidationError('no updatable field provided');

  return {
    clause: keys.map((field, index) => `"${field}" = $${startIndex + index}`).join(', '),
    params: keys.map((field) => patch[field]),
  };
}
