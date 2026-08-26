import { NextRequest, NextResponse } from 'next/server';
import { isSuperAdmin } from '@/lib/adminAuth';
import { requireAdminSession, requireReviewerSession } from '@/lib/adminSession';
import { tx } from '@/lib/db/client';
import {
  createAccount,
  findAccountByCode,
  listAccounts,
  writeAccountAudit,
} from '@/lib/db/repositories/accounts';

export const dynamic = 'force-dynamic';

function superAdminSession(request: NextRequest) {
  const session = requireAdminSession(request);
  return session?.is_admin === true && isSuperAdmin(session.code) ? session : null;
}

export async function GET(request: NextRequest) {
  if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
  if (!superAdminSession(request)) return NextResponse.json({ error: '仅超管可管理账号' }, { status: 403 });

  try {
    const accounts = await listAccounts();
    return NextResponse.json({ accounts });
  } catch (err: any) {
    return NextResponse.json({ error: `读取账号失败：${err.message}` }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const session = superAdminSession(request);
  if (!session) return NextResponse.json({ error: '仅超管可管理账号' }, { status: 403 });

  try {
    const body = await request.json();
    const code = String(body?.code || '').trim();
    const password = String(body?.password || '');
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(code) || !password) {
      return NextResponse.json({ error: '请填写有效的账号和初始密码' }, { status: 400 });
    }
    if (isSuperAdmin(code)) return NextResponse.json({ error: 'admin51 为保留超管账号，不能新建' }, { status: 403 });

    const account = await tx(async (transaction) => {
      const existing = await findAccountByCode(code, transaction);
      if (existing) return null;
      const created = await createAccount({
        code,
        name: String(body?.name || '').trim(),
        role: String(body?.role || '').trim(),
        isAdmin: body?.is_admin === true,
        passwordHash: password,
      }, transaction);
      await writeAccountAudit(session.code, created.code, 'account_created', transaction);
      return created;
    });
    if (!account) return NextResponse.json({ error: '账号已存在' }, { status: 409 });
    return NextResponse.json({ account }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: `创建账号失败：${err.message}` }, { status: 500 });
  }
}
