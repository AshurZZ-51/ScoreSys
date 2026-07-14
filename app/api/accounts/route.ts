import { NextRequest, NextResponse } from 'next/server';
import { isSuperAdmin } from '@/lib/adminAuth';
import { requireAdminSession } from '@/lib/adminSession';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function superAdminSession(request: NextRequest) {
  const session = requireAdminSession(request);
  return session?.is_admin === true && isSuperAdmin(session.code) ? session : null;
}

async function writeAudit(actorCode: string, targetCode: string, action: string) {
  const { error } = await supabaseAdmin.from('account_audit_logs').insert({
    actor_code: actorCode,
    target_code: targetCode,
    action
  });
  if (error) throw error;
}

export async function GET(request: NextRequest) {
  if (!superAdminSession(request)) return NextResponse.json({ error: '仅超管可管理账号' }, { status: 403 });

  try {
    const { data, error } = await supabaseAdmin
      .from('reviewers')
      .select('code, name, role, is_admin')
      .order('code');
    if (error) throw error;
    return NextResponse.json({ accounts: data || [] });
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

    const { data: existing, error: lookupError } = await supabaseAdmin
      .from('reviewers')
      .select('code')
      .ilike('code', code)
      .maybeSingle();
    if (lookupError) throw lookupError;
    if (existing) return NextResponse.json({ error: '账号已存在' }, { status: 409 });

    const { data: account, error } = await supabaseAdmin
      .from('reviewers')
      .insert({
        code,
        name: String(body?.name || '').trim(),
        role: String(body?.role || '').trim(),
        is_admin: body?.is_admin === true,
        password_hash: password
      })
      .select('code, name, role, is_admin')
      .single();
    if (error) throw error;
    await writeAudit(session.code, account.code, 'account_created');
    return NextResponse.json({ account }, { status: 201 });
  } catch (err: any) {
    return NextResponse.json({ error: `创建账号失败：${err.message}` }, { status: 500 });
  }
}
