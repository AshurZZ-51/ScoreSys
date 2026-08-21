import { NextRequest, NextResponse } from 'next/server';
import { isSuperAdmin } from '@/lib/adminAuth';
import { requireAdminSession } from '@/lib/adminSession';
import { supabaseAdmin } from '@/lib/supabase';

export const dynamic = 'force-dynamic';

function superAdminSession(request: NextRequest) {
  const session = requireAdminSession(request);
  return session?.is_admin === true && isSuperAdmin(session.code) ? session : null;
}

export async function PATCH(request: NextRequest, { params }: { params: { code: string } }) {
  const session = superAdminSession(request);
  if (!session) return NextResponse.json({ error: '仅超管可管理账号' }, { status: 403 });

  try {
    const targetCode = decodeURIComponent(params.code || '').trim();
    if (!targetCode) return NextResponse.json({ error: '账号不能为空' }, { status: 400 });
    const body = await request.json();
    const { data: account, error: accountError } = await supabaseAdmin
      .from('reviewers')
      .select('code, is_admin')
      .ilike('code', targetCode)
      .maybeSingle();
    if (accountError) throw accountError;
    if (!account) return NextResponse.json({ error: '账号不存在' }, { status: 404 });

    let patch: Record<string, unknown>;
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

    const { data: updated, error: updateError } = await supabaseAdmin
      .from('reviewers')
      .update(patch)
      .eq('code', account.code)
      .select('code, name, role, is_admin')
      .single();
    if (updateError) throw updateError;
    const { error: auditError } = await supabaseAdmin.from('account_audit_logs').insert({
      actor_code: session.code,
      target_code: account.code,
      action
    });
    if (auditError) throw auditError;
    return NextResponse.json({ account: updated });
  } catch (err: any) {
    return NextResponse.json({ error: `更新账号失败：${err.message}` }, { status: 500 });
  }
}
