import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled, supabaseAdmin } from '@/lib/supabase';
import { getMissingTemplateProjects } from '@/lib/projectSlots';
import { requireAdminSession, requireReviewerSession } from '@/lib/adminSession';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

export async function GET(request: NextRequest) {
  try {
    if (!requireReviewerSession(request)) return NextResponse.json({ error: '请先登录' }, { status: 401 });
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const role = searchParams.get('role') || 'reviewer';  // 'admin' | 'reviewer'

    if (!meetingId) {
      return NextResponse.json({ error: 'meetingId 必填' }, { status: 400 });
    }

    if (!isProjectPoolV2Enabled()) {
      const { data: existingProjects, error: existingError } = await supabaseAdmin
        .from('projects').select('seq_no').eq('meeting_id', meetingId);
      if (existingError) throw existingError;
      const missingProjects = getMissingTemplateProjects(existingProjects || [], meetingId);
      if (missingProjects.length > 0) {
        const { error: insertError } = await supabaseAdmin.from('projects').insert(missingProjects);
        if (insertError) throw insertError;
      }
    }

    let query = supabaseAdmin
      .from('projects')
      .select('id, meeting_id, seq_no, name, submitter, description, problems, actions, is_pending, is_template, created_at, pool_project_id, round_no, attempt_no, scoring_version, assignment_status')
      .eq('meeting_id', meetingId)
      .order('seq_no');

    // 评委只看到已填的（name + submitter 都不为空）
    if (role === 'reviewer') {
      query = query
        .neq('name', '')
        .neq('submitter', '');
    }

    const { data: projects, error } = await query;

    if (error) throw error;

    return NextResponse.json(
      { projects: projects || [] },
      { headers: { 'Cache-Control': 'no-store, max-age=0' } }
    );
  } catch (err: any) {
    return NextResponse.json(
      { error: '获取项目失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    if (!requireAdminSession(request)) return NextResponse.json({ error: '仅管理员可创建项目' }, { status: 403 });
    const body = await request.json();
    const { meeting_id, seq_no, name, submitter, description, is_pending } = body;

    if (!meeting_id || !name || !submitter) {
      return NextResponse.json({ error: 'meeting_id/name/submitter 必填' }, { status: 400 });
    }

    const { data, error } = await supabaseAdmin
      .from('projects')
      .insert({
        meeting_id,
        seq_no: seq_no || 0,
        name,
        submitter,
        description: description || '',
        is_pending: is_pending || false,
        is_template: false,
        problems: body.problems || [],
        actions: body.actions || []
      })
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, project: data });
  } catch (err: any) {
    return NextResponse.json(
      { error: '创建项目失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    if (!requireAdminSession(request)) return NextResponse.json({ error: '仅管理员可更新项目' }, { status: 403 });
    const body = await request.json();
    const { id, ...updates } = body;

    const { data, error } = await supabaseAdmin
      .from('projects')
      .update(updates)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, project: data });
  } catch (err: any) {
    return NextResponse.json(
      { error: '更新项目失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  try {
    if (!requireAdminSession(request)) return NextResponse.json({ error: '仅管理员可删除项目' }, { status: 403 });
    const { searchParams } = new URL(request.url);
    const id = searchParams.get('id');

    if (!id) {
      return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    }

    const { error } = await supabaseAdmin
      .from('projects')
      .delete()
      .eq('id', id);

    if (error) throw error;

    return NextResponse.json({ success: true });
  } catch (err: any) {
    return NextResponse.json(
      { error: '删除项目失败: ' + err.message },
      { status: 500 }
    );
  }
}
