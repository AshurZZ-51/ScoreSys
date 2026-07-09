import { NextRequest, NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { PROJECT_SLOT_COUNT, copyProjectsForMeeting, createTemplateProjects } from '@/lib/projectSlots';

export const dynamic = 'force-dynamic';

export async function GET(request: NextRequest) {
  try {
    const { searchParams } = new URL(request.url);
    const meetingId = searchParams.get('meetingId');
    const includeDeleted = searchParams.get('includeDeleted') === 'true';

    let query = supabaseAdmin
      .from('meetings')
      .select('id, name, meeting_date, deadline, status, notes, is_current, deleted_at, scheduled_purge_at, created_at')
      .order('meeting_date', { ascending: false });

    if (meetingId) {
      query = query.eq('id', meetingId);
    } else if (!includeDeleted) {
      query = query.is('deleted_at', null);
    }

    const { data: meetings, error } = await query;
    if (error) throw error;

    return NextResponse.json({ meetings: meetings || [] });
  } catch (err: any) {
    console.error('Get meetings error:', err);
    return NextResponse.json(
      { error: '获取评审会列表失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const { name, meeting_date, deadline, notes, copy_from_meeting_id } = body;

    if (!name || !meeting_date) {
      return NextResponse.json(
        { error: '评审会名称和日期必填' },
        { status: 400 }
      );
    }

    // 创建评审会
    const { data: meeting, error } = await supabaseAdmin
      .from('meetings')
      .insert({
        name,
        meeting_date,
        deadline: deadline || null,
        notes: notes || '',
        status: 'active'
      })
      .select()
      .single();

    if (error) throw error;

    // 自动创建空模板项目
    const templateProjects = createTemplateProjects(meeting.id);
    await supabaseAdmin.from('projects').insert(templateProjects);

    // 如果指定了复制来源，覆盖模板
    if (copy_from_meeting_id) {
      const { data: sourceProjects } = await supabaseAdmin
        .from('projects')
        .select('seq_no, name, submitter, description, problems, actions, is_pending')
        .eq('meeting_id', copy_from_meeting_id)
        .order('seq_no');

      if (sourceProjects && sourceProjects.length > 0) {
        // 删除刚建的模板
        await supabaseAdmin
          .from('projects')
          .delete()
          .eq('meeting_id', meeting.id);

        // 复制来源（限前 PROJECT_SLOT_COUNT 个）
        const newProjects = copyProjectsForMeeting(sourceProjects, meeting.id);
        await supabaseAdmin.from('projects').insert(newProjects);
      }
    }

    return NextResponse.json({ success: true, meeting, projectSlotCount: PROJECT_SLOT_COUNT });
  } catch (err: any) {
    console.error('Create meeting error:', err);
    return NextResponse.json(
      { error: '创建评审会失败: ' + err.message },
      { status: 500 }
    );
  }
}

export async function PATCH(request: NextRequest) {
  try {
    const body = await request.json();
    const { id, is_current, name, meeting_date, deadline, notes } = body;

    if (!id) {
      return NextResponse.json({ error: 'id 必填' }, { status: 400 });
    }

    // 切换当前评审会：先把所有is_current置false，再设指定id为true
    if (is_current === true) {
      await supabaseAdmin
        .from('meetings')
        .update({ is_current: false })
        .eq('is_current', true);
    }

    const updateData: any = {};
    if (is_current !== undefined) updateData.is_current = is_current;
    if (name !== undefined) updateData.name = name;
    if (meeting_date !== undefined) updateData.meeting_date = meeting_date;
    if (deadline !== undefined) updateData.deadline = deadline;
    if (notes !== undefined) updateData.notes = notes;

    const { data, error } = await supabaseAdmin
      .from('meetings')
      .update(updateData)
      .eq('id', id)
      .select()
      .single();

    if (error) throw error;

    return NextResponse.json({ success: true, meeting: data });
  } catch (err: any) {
    console.error('Update meeting error:', err);
    return NextResponse.json(
      { error: '更新评审会失败: ' + err.message },
      { status: 500 }
    );
  }
}
