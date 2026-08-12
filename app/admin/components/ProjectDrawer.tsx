'use client';

import { useEffect, useMemo, useState } from 'react';
import { MATERIAL_ITEMS, getMaterialProgress, projectStatusLabel } from '@/lib/projectPoolWorkflow';
import { buildInitiationAnnouncement, PROJECT_RATING_OPTIONS } from '@/lib/initiationWorkflow';
import { mergeProjectMaterials } from '@/lib/projectDetailWorkflow';

type Project = Record<string, any>;
const MATERIAL_STATUS_OPTIONS = [
  { value: 'missing', label: '缺失' },
  { value: 'needs_completion', label: '待完善' },
  { value: 'submitted', label: '已提交' },
  { value: 'exempt', label: '豁免' }
] as const;
const PROJECT_STATUS_OPTIONS = ['materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected'];

function adminCode() { try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; } }
function adminRequestHeaders(json = false) {
  const token = typeof window === 'undefined' ? '' : sessionStorage.getItem('scoresys_session_token') || '';
  return { ...(json ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}) };
}
function assignmentStatusLabel(status: string) { return ({ scheduled: '待评审', scoring: '评分中', completed: '已完成' } as Record<string, string>)[status] || status || '-'; }

export default function ProjectDrawer({ project, onDismiss, onSaved }: { project: Project; onDismiss: () => void; onSaved: (project?: Project) => Promise<void> | void; }) {
  const [form, setForm] = useState({ name: project.name || '', submitter: project.submitter || '', description: project.description || '' });
  const [materials, setMaterials] = useState<Project[]>(project.project_materials || []);
  const [manualStatus, setManualStatus] = useState(project.status || 'materials_pending');
  const [manualNote, setManualNote] = useState('');
  const [ratings, setRatings] = useState({ preliminary: project.preliminary_rating || '', final: project.final_rating || '' });
  const [ratingHistory, setRatingHistory] = useState<Project[]>(project.rating_history || []);
  const [announcement, setAnnouncement] = useState(project.initiation_announcement || '');
  const [announcementFields, setAnnouncementFields] = useState({ team: '', resources: '', kpi: '', tenderStart: '', milestones: '' });
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  // Read the detail record on every open so the drawer never falls back to a stale list-row snapshot.
  useEffect(() => {
    let cancelled = false;
    const applyProject = (nextProject: Project) => {
      if (cancelled) return;
      setForm({ name: nextProject.name || '', submitter: nextProject.submitter || '', description: nextProject.description || '' });
      setMaterials(nextProject.project_materials || []);
      setManualStatus(nextProject.status || 'materials_pending');
      setRatings({ preliminary: nextProject.preliminary_rating || '', final: nextProject.final_rating || '' });
      setRatingHistory(nextProject.rating_history || []);
      setAnnouncement(nextProject.initiation_announcement || '');
      setManualNote('');
      setFeedback('');
    };
    applyProject(project);
    Promise.all([
      fetch(`/api/project-pool/${project.id}/history`, { cache: 'no-store' }),
      fetch(`/api/project-pool/${project.id}/materials`, { cache: 'no-store' })
    ])
      .then(async ([historyResponse, materialsResponse]) => {
        const historyData = historyResponse.ok ? await historyResponse.json() : null;
        const materialsData = materialsResponse.ok ? await materialsResponse.json() : null;
        if (historyData?.project) applyProject(mergeProjectMaterials(historyData.project, materialsData?.materials));
        else if (materialsData && Array.isArray(materialsData.materials)) applyProject(mergeProjectMaterials(project, materialsData.materials));
      })
      .catch(() => undefined);
    return () => { cancelled = true; };
  }, [project.id]);

  const materialByKey = useMemo(() => new Map(materials.map((item) => [item.item_key, item])), [materials]);
  const materialProgress = getMaterialProgress(materials);
  const completedReviews = project.completed_reviews || [];

  const saveProject = async () => {
    setBusy(true);
    try {
      const response = await fetch('/api/project-pool', { method: 'PATCH', headers: adminRequestHeaders(true), body: JSON.stringify({ id: project.id, ...form, operator_code: adminCode() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存项目详情失败');
      setFeedback('项目详情已保存。');
      await onSaved({ ...project, ...(data.project || {}), project_materials: materials });
    } catch (error: any) { setFeedback(error.message || '保存项目详情失败'); } finally { setBusy(false); }
  };

  const saveMaterial = async (itemKey: string, status: string) => {
    if (!MATERIAL_STATUS_OPTIONS.some((option) => option.value === status)) return;
    const priorMaterials = materials;
    const nextMaterials = materials.some((item) => item.item_key === itemKey)
      ? materials.map((item) => item.item_key === itemKey ? { ...item, status } : item)
      : [...materials, { project_id: project.id, item_key: itemKey, status }];
    setMaterials(nextMaterials);
    setBusy(true);
    try {
      const response = await fetch(`/api/project-pool/${project.id}/materials`, { method: 'PATCH', headers: adminRequestHeaders(true), body: JSON.stringify({ item_key: itemKey, status, operator_code: adminCode() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存资料状态失败');
      setFeedback('资料状态已保存。');
      await onSaved({ ...project, ...(data.project || {}), project_materials: data.materials || nextMaterials, material_status: data.material_status });
    } catch (error: any) { setMaterials(priorMaterials); setFeedback(error.message || '保存资料状态失败'); } finally { setBusy(false); }
  };

  const changeStatus = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/project-pool/${project.id}/status`, { method: 'POST', headers: adminRequestHeaders(true), body: JSON.stringify({ status: manualStatus, note: manualNote, confirmed: true }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '调整项目状态失败');
      setFeedback('项目状态已更新。');
      await onSaved({ ...project, ...(data.project || {}), project_materials: materials });
    } catch (error: any) { setFeedback(error.message || '调整项目状态失败'); } finally { setBusy(false); }
  };

  const saveRating = async (ratingType: 'preliminary' | 'final', rating: string) => {
    if (!PROJECT_RATING_OPTIONS.includes(rating as any)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/project-pool/${project.id}/rating`, { method: 'POST', headers: adminRequestHeaders(true), body: JSON.stringify({ rating_type: ratingType, rating }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存项目评级失败');
      setRatings((current) => ({ ...current, [ratingType]: rating }));
      setFeedback(`${ratingType === 'final' ? '最终评级' : '初步评级'}已保存。`);
      await onSaved({ ...project, ...(data.project || {}), project_materials: materials });
    } catch (error: any) { setFeedback(error.message || '保存项目评级失败'); } finally { setBusy(false); }
  };

  const generateAnnouncement = () => {
    setAnnouncement(buildInitiationAnnouncement({
      projectCode: project.project_code || project.id,
      projectName: form.name,
      rating: ratings.final || ratings.preliminary,
      approvedAt: new Date().toISOString().slice(0, 10),
      ...announcementFields
    }));
  };

  const saveAnnouncement = async () => {
    setBusy(true);
    try {
      const response = await fetch(`/api/project-pool/${project.id}/announcement`, { method: 'POST', headers: adminRequestHeaders(true), body: JSON.stringify({ announcement }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '保存立项公示失败');
      setFeedback('立项公示已保存。');
      await onSaved({ ...project, ...(data.project || {}), project_materials: materials });
    } catch (error: any) { setFeedback(error.message || '保存立项公示失败'); } finally { setBusy(false); }
  };

  const archive = async () => {
    if (!window.confirm(`归档“${project.name}”？历史评审记录会保留。`)) return;
    setBusy(true);
    try {
      const response = await fetch(`/api/project-pool?id=${encodeURIComponent(project.id)}&operator_code=${encodeURIComponent(adminCode())}`, { method: 'DELETE', headers: adminRequestHeaders() });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '归档项目失败');
      setFeedback('项目已归档。');
      await onSaved({ ...project, archived_at: new Date().toISOString() });
      onDismiss();
    } catch (error: any) { setFeedback(error.message || '归档项目失败'); } finally { setBusy(false); }
  };

  return <div style={styles.overlay} onMouseDown={(event) => { if (event.target !== event.currentTarget) return; onDismiss(); }}>
    <aside aria-label="项目详情" style={styles.drawer}>
      <div style={styles.actions}><button type="button" style={styles.secondary} onClick={onDismiss}>关闭</button>{project.status === 'initiation' && <button type="button" style={styles.secondary} onClick={() => window.open(`/report?projectId=${encodeURIComponent(project.id)}`, '_blank', 'noopener,noreferrer')}>项目报告</button>}<button type="button" style={styles.danger} disabled={busy} onClick={archive}>归档项目</button></div>
      <h2 style={styles.heading}>{project.name}</h2>
      {feedback && <div role="status" style={styles.feedback}>{feedback}</div>}
      <section style={styles.panel}><h3 style={styles.sectionHeading}>项目详情</h3><input aria-label="项目名称" style={styles.input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })} /><input aria-label="提报人" style={styles.input} value={form.submitter} onChange={(event) => setForm({ ...form, submitter: event.target.value })} /><textarea aria-label="项目说明" style={styles.input} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })} /><button type="button" style={styles.primary} disabled={busy} onClick={saveProject}>保存项目详情</button></section>
      <section><h3 style={styles.sectionHeading}>资料检查：{materialProgress.complete ? '资料齐全' : `待补充 ${materialProgress.approved}/${materialProgress.total}`}</h3>{MATERIAL_ITEMS.map((item) => <div key={item.item_key} style={styles.material}><span>{item.label}{item.required ? ' *' : ''}</span><select aria-label={`${item.item_key}状态`} style={styles.select} disabled={busy} value={materialByKey.get(item.item_key)?.status || 'missing'} onChange={(event) => saveMaterial(item.item_key, event.target.value)}>{MATERIAL_STATUS_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>)}</section>
      <section style={styles.panel}><h3 style={styles.sectionHeading}>人工调整状态</h3><select aria-label="项目状态" style={styles.select} value={manualStatus} onChange={(event) => setManualStatus(event.target.value)}>{PROJECT_STATUS_OPTIONS.map((status) => <option key={status} value={status}>{projectStatusLabel(status)}</option>)}</select><textarea aria-label="状态调整备注" style={styles.input} rows={2} placeholder="调整备注（可选）" value={manualNote} onChange={(event) => setManualNote(event.target.value)} /><button type="button" style={styles.secondary} disabled={busy} onClick={changeStatus}>确认人工调整</button></section>
      <section><h3 style={styles.sectionHeading}>状态历史</h3>{(project.status_history || []).map((entry: Project) => <div key={entry.id} style={styles.history}>{new Date(entry.created_at).toLocaleString('zh-CN')} · {projectStatusLabel(entry.to_status)} · {entry.operator_code || '系统'}{entry.note ? ` · ${entry.note}` : ''}</div>)}{!(project.status_history || []).length && <p style={styles.muted}>暂无状态变更记录。</p>}</section>
      <section><h3 style={styles.sectionHeading}>Walker 评审历史</h3>{completedReviews.map((assignment: Project) => <div key={assignment.id} style={styles.history}><strong>第 {assignment.round_no || 1} 轮 / 第 {assignment.attempt_no || 1} 次 · {assignment.meetings?.name || '评审会'}</strong><span>{assignmentStatusLabel(assignment.assignment_status)}</span></div>)}{!completedReviews.length && <p style={styles.muted}>尚无 Walker 已确认结论的评审记录。</p>}</section>
      <section style={styles.panel}><h3 style={styles.sectionHeading}>项目评级</h3><div style={styles.ratingRow}><label>初步评级<select aria-label="初步评级" style={styles.select} value={ratings.preliminary} disabled={busy} onChange={(event) => saveRating('preliminary', event.target.value)}><option value="">待评级</option>{PROJECT_RATING_OPTIONS.map((rating) => <option key={rating} value={rating}>{rating}</option>)}</select></label><label>最终评级<select aria-label="最终评级" style={styles.select} value={ratings.final} disabled={busy} onChange={(event) => saveRating('final', event.target.value)}><option value="">待评级</option>{PROJECT_RATING_OPTIONS.map((rating) => <option key={rating} value={rating}>{rating}</option>)}</select></label></div>{ratingHistory.map((entry: Project) => <div key={entry.id} style={styles.history}>{entry.rating_type === 'final' ? '最终评级' : '初步评级'}：{entry.from_rating || '空'} → {entry.to_rating} · {entry.operator_code} · {new Date(entry.created_at).toLocaleString('zh-CN')}</div>)}</section>
      {project.status === 'initiation' && <section style={styles.panel}><h3 style={styles.sectionHeading}>立项公示草稿</h3><div style={styles.fieldGrid}>{[['team', '项目团队'], ['resources', '资源配置'], ['kpi', '运营考核指标'], ['tenderStart', '招标启动日期'], ['milestones', '关键里程碑']].map(([key, label]) => <input key={key} aria-label={label} style={styles.input} placeholder={label} value={(announcementFields as any)[key]} onChange={(event) => setAnnouncementFields((current) => ({ ...current, [key]: event.target.value }))} />)}</div><textarea aria-label="立项公示" style={styles.input} rows={9} value={announcement} onChange={(event) => setAnnouncement(event.target.value)} placeholder="生成后可继续编辑" /><div style={styles.actions}><button type="button" style={styles.secondary} disabled={busy} onClick={generateAnnouncement}>生成公示草稿</button><button type="button" style={styles.primary} disabled={busy || !announcement.trim()} onClick={saveAnnouncement}>保存公示</button><button type="button" style={styles.secondary} disabled={!announcement.trim()} onClick={() => navigator.clipboard?.writeText(announcement)}>复制文本</button></div></section>}
    </aside>
  </div>;
}

const styles: Record<string, React.CSSProperties> = {
  overlay: { position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(15,23,42,.34)', display: 'flex', justifyContent: 'flex-end' }, drawer: { width: 620, maxWidth: '100%', background: '#fff', padding: 24, overflowY: 'auto' }, heading: { margin: '16px 0', fontSize: 20 }, sectionHeading: { margin: '20px 0 10px', fontSize: 15 }, panel: { display: 'grid', gap: 10, padding: 16, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff', marginBottom: 16 }, input: { width: '100%', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box', fontSize: 14 }, select: { padding: '8px', border: '1px solid #cbd5e1', borderRadius: 5, background: '#fff' }, primary: { background: '#0f766e', color: '#fff', border: '1px solid #0f766e', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, actions: { display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }, ratingRow: { display: 'flex', gap: 16, flexWrap: 'wrap' }, fieldGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }, material: { display: 'grid', gridTemplateColumns: '1fr 150px', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #edf2f7' }, history: { padding: 10, background: '#f7fafc', marginBottom: 6, borderRadius: 4, display: 'grid', gap: 4 }, muted: { color: '#64748b', fontSize: 13 }, feedback: { margin: '12px 0', padding: '9px 11px', color: '#155e75', background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 5 }
};
