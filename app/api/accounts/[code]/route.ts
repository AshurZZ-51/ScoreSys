import { NextRequest, NextResponse } from 'next/server';
import { isSuperAdmin } from '@/lib/adminAuth';
import { requireAdminSession } from '@/lib/adminSession';
import { tx } from '@/lib/db/client';
import {
  findAccountByCode,
  updateAccount,
  writeAccountAudit,
} from '@/lib/db/repositories/accounts';
import type { AccountPatch } from '@/lib/db/repositories/accounts';

export const dynamic = 'force-dynamic';

function superAdminSession(request: NextRequest) {
  const session = requireAdminSession(request);
  return session?.is_admin === true && isSuperAdmin(session.code) ? session : null;
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ code: string }> }) {
  const { code } = await params;
  const session = superAdminSession(request);
  if (!session) return NextResponse.json({ error: '仅超管可管理账号' }, { status: 403 });

  try {
    const targetCode = decodeURIComponent(code || '').trim();
    if (!targetCode) return NextResponse.json({ error: '账号不能为空' }, { status: 400 });
    const body = await request.json();
    const account = await findAccountByCode(targetCode);
    if (!account) return NextResponse.json({ error: '账号不存在' }, { status: 404 });

    let patch: AccountPatch;
    let action: string;
    if (body?.action === 'reset_password') {
      const password = String(body?.password || '');
      if (!password) return NextResponse.json({ error: '请填写新密码' }, { status: 400 });
      patch = { password_hash: password };
      action = 'password_reset';
    } else if (body?.action === 'set_admin') {
      if (typeof body?.is_admin !== 'boolean') return NextResponse.json({ error: '管理员状态无效' }, { status: 400 });
      if (isSuperAdmin(account.code)) return NextResponse.json({ error: '不能调整 admin51 的管理员身份' }, { status: 403 });
      patch = { is_admin: body.is_admin };
      action = body.is_admin ? 'admin_enabled' : 'admin_disabled';
    } else {
      return NextResponse.json({ error: '不支持的账号操作' }, { status: 400 });
    }

    const updated = await tx(async (transaction) => {
      const changed = await updateAccount(account.code, patch, transaction);
      await writeAccountAudit(session.code, account.code, action, transaction);
      return changed;
    });
    return NextResponse.json({ account: updated });
  } catch (err: any) {
    return NextResponse.json({ error: `更新账号失败：${err.message}` }, { status: 500 });
  }
}
