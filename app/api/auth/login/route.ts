import { NextRequest, NextResponse } from 'next/server';
import { adminSessionCookie, createReviewerSession } from '@/lib/adminSession';
import { findReviewerByCode, listReviewerDimensions, verifyReviewerPassword } from '@/lib/db/repositories/reviewers';

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

    const reviewer = await findReviewerByCode(code);

    if (!reviewer) {
      return NextResponse.json(
        { error: '账号不存在' },
        { status: 401 }
      );
    }

    const authenticatedReviewer = await verifyReviewerPassword(code, password);
    if (!authenticatedReviewer) {
      return NextResponse.json(
        { error: '密码错误' },
        { status: 401 }
      );
    }

    const dims = await listReviewerDimensions(authenticatedReviewer.code);

    const sessionToken = createReviewerSession(authenticatedReviewer);
    const response = NextResponse.json({
      success: true,
      session_token: sessionToken,
      reviewer: {
        code: authenticatedReviewer.code,
        name: authenticatedReviewer.name,
        role: authenticatedReviewer.role,
        is_admin: authenticatedReviewer.is_admin,
        dimensions: dims
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
