import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { adminSessionCookie, createReviewerSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';

export async function POST(request: NextRequest) {
  try {
    const { code, password } = await request.json();

    if (!code || !password) {
      return NextResponse.json(
        { error: '请输入账号和密码' },
        { status: 400 }
      );
    }

    // 查询评委账号（真实字段：password_hash）
    // 大小写不敏感搜索（ilike），让 admin/W/N/S/J/G 都可登录
    const { data: reviewer, error } = await supabaseAdmin
      .from('reviewers')
      .select('code, name, role, is_admin, password_hash')
      .ilike('code', code)
      .single();

    if (error || !reviewer) {
      return NextResponse.json(
        { error: '账号不存在' },
        { status: 401 }
      );
    }

    if (reviewer.password_hash !== password) {
      return NextResponse.json(
        { error: '密码错误' },
        { status: 401 }
      );
    }

    // 查询该评委负责的维度（真实表：reviewer_dims）
    const { data: dims } = await supabaseAdmin
      .from('reviewer_dims')
      .select('dim_name, max_score')
      .eq('reviewer_code', reviewer.code)
      .order('max_score', { ascending: false });

    const sessionToken = createReviewerSession(reviewer);
    const response = NextResponse.json({
      success: true,
      session_token: sessionToken,
      reviewer: {
        code: reviewer.code,
        name: reviewer.name,
        role: reviewer.role,
        is_admin: reviewer.is_admin,
        dimensions: dims || []
      }
    });
    const cookie = adminSessionCookie(sessionToken);
    response.cookies.set(cookie.name, cookie.value, cookie.options);
    return response;
  } catch (err: any) {
    console.error('Login error:', err);
    return NextResponse.json(
      { error: '登录失败: ' + err.message },
      { status: 500 }
    );
  }
}
