import { NextRequest, NextResponse } from 'next/server';
import { isProjectPoolV2Enabled } from '@/lib/featureFlags';
import { isMaterialStatus, MATERIAL_ITEMS } from '@/lib/projectPoolWorkflow';
import { requireAdminSession } from '@/lib/adminSession';
import { listProjectMaterials } from '@/lib/db/repositories/projectMaterials';
import { upsertProjectMaterial } from '@/lib/db/repositories/projectPoolWorkflow';

export const dynamic = 'force-dynamic';

export async function GET(_: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const materials = await listProjectMaterials(id);
    return NextResponse.json({ materials });
  } catch (error: any) {
    return NextResponse.json({ error: error.message }, { status: 500 });
  }
}

export async function PATCH(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!isProjectPoolV2Enabled()) return NextResponse.json({ error: '项目池功能尚未启用' }, { status: 404 });
  try {
    const { item_key, status, note = '' } = await request.json();
    const session = requireAdminSession(request);
    if (!session) return NextResponse.json({ error: '只有管理员可以检查资料' }, { status: 403 });
    if (!isMaterialStatus(status)) return NextResponse.json({ error: '无效资料状态' }, { status: 400 });
    const materialDefinition = MATERIAL_ITEMS.find((item) => item.item_key === item_key);
    if (!materialDefinition) return NextResponse.json({ error: '无效资料项' }, { status: 400 });
    const now = new Date().toISOString();
    const result = await upsertProjectMaterial(id, item_key, materialDefinition.required, status, String(note || ''), session.code, now);
    return NextResponse.json({ success: true, ...result });
  } catch (err: any) {
    return NextResponse.json({ error: `保存资料检查失败: ${err.message}` }, { status: 500 });
  }
}
