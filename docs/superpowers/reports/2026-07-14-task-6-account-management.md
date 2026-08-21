# Task 6: 超管账号管理

## Delivered

- `admin51` is the sole case-insensitive superadmin identity.
- Account APIs use the signed admin session and reject non-superadmin requests with `403`.
- Superadmin can list safe account fields, create accounts, reset passwords, and toggle administrator status.
- Account creation, password resets, and administrator changes insert `account_audit_logs` records.
- `admin51` cannot be created through the API, demoted, or deleted through this feature.
- The Chinese account-management tab is visible only when the locally stored reviewer code is `admin51`; API authorization remains server-side.

## Verification

- `git diff --check`: passed.
- `pnpm test`: blocked in this workspace because the `node` executable is not on `PATH`.
- `pnpm run build`: blocked for the same missing `node` executable.
