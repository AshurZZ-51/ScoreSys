'use client';

import { useEffect, useMemo, useState } from 'react';
import { getMaterialProgress, projectStatusLabel } from '@/lib/projectPoolWorkflow';

type Project = Record<string, any>;
type Meeting = Record<string, any>;

const READY_STATUSES = new Set(['ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready']);
const STATUS_OPTIONS = ['materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected'];

function adminCode() {
  try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; }
}

function roundFor(project: Project) {
  return String(project.status || '').includes('r2') ? 2 : 1;
}

function materialText(project: Project) {
  const progress = project.material_progress || getMaterialProgress(project.project_materials || []);
  return progress.complete ? '资料齐全' : `待补充 ${progress.approved}/${progress.total}`;
}

export default function ProjectPoolTable({ projects, meetings, scope, month, onRefresh, onOpenProject, onMonthChange }: {
  projects: Project[];
  meetings: Meeting[];
  scope: string;
  month: string;
  onRefresh: () => Promise<void> | void;
  onOpenProject: (project: Project) => void;
  onMonthChange?: (month: string) => void;
}) {
  const [selected, setSelected] = useState<string[]>([]);
  const [meetingId, setMeetingId] = useState('');
  const [status, setStatus] = useState('');
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    setSelected((current) => current.filter((id) => projects.some((project) => project.id === id)));
  }, [projects]);

  const activeMeetings = useMemo(() => meetings.filter((meeting) => meeting.status === 'active'), [meetings]);
  const selectedProjects = useMemo(() => projects.filter((project) => selected.includes(project.id)), [projects, selected]);
  const canSchedule = selectedProjects.length > 0 && selectedProjects.every((project) => READY_STATUSES.has(project.status));
  const allSelected = projects.length > 0 && selected.length === projects.length;

  const toggle = (id: string) => setSelected((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  const refreshAfter = async (message: string) => { setFeedback(message); await onRefresh(); };

  const batchStatus = async () => {
    if (!selected.length || !status) return;
    setBusy(true);
    try {
      const response = await fetch('/api/project-pool/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected, action: 'status', status, operator_code: adminCode() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '批量状态更新失败');
      await refreshAfter(`已更新 ${selected.length} 个项目状态。`);
    } catch (error: any) {
      setFeedback(error.message || '批量状态更新失败');
    } finally { setBusy(false); }
  };

  const assign = async (ids = selected, targetMeetingId = meetingId) => {
    const chosen = projects.filter((project) => ids.includes(project.id));
    if (!targetMeetingId || !chosen.length) return;
    if (!chosen.every((project) => READY_STATUSES.has(project.status))) { setFeedback('只有待安排状态的项目可以加入评审会。'); return; }
    const rounds = chosen.map(roundFor).filter((round, index, values) => values.indexOf(round) === index);
    if (rounds.length !== 1) { setFeedback('请按评审轮次分别安排项目。'); return; }
    setBusy(true);
    try {
      const response = await fetch('/api/meeting-assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: targetMeetingId, pool_project_ids: ids, round_no: rounds[0], operator_code: adminCode() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '安排评审会失败');
      await refreshAfter(`已安排 ${data.assignments?.length || ids.length} 个项目进入评审会。${data.errors?.length ? ` 另有 ${data.errors.length} 个未能安排。` : ''}`);
      setSelected([]);
    } catch (error: any) {
      setFeedback(error.message || '安排评审会失败');
    } finally { setBusy(false); }
  };

  const archive = async () => {
    if (!selected.length || !window.confirm(`归档选中的 ${selected.length} 个项目？历史评审记录会保留。`)) return;
    setBusy(true);
    try {
      const response = await fetch('/api/project-pool/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids: selected, action: 'archive', operator_code: adminCode() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '批量归档失败');
      await refreshAfter(`已归档 ${selected.length} 个项目。`);
      setSelected([]);
    } catch (error: any) {
      setFeedback(error.message || '批量归档失败');
    } finally { setBusy(false); }
  };

  return <>
    <div style={styles.toolbar}><label style={styles.monthLabel}>创建月份 <input type="month" value={month} onChange={(event) => onMonthChange?.(event.target.value)} style={styles.select} /></label><span style={styles.scope}>{scope === 'reviewed' ? '已有 Walker 结论的项目' : '项目池'}</span></div>
    {feedback && <div role="status" style={styles.feedback}>{feedback}</div>}
    <div style={styles.bulkBar}>
      <span>已选 {selected.length} 项</span>
      <select aria-label="批量项目状态" value={status} onChange={(event) => setStatus(event.target.value)} style={styles.select}><option value="">批量调整状态</option>{STATUS_OPTIONS.map((value) => <option key={value} value={value}>{projectStatusLabel(value)}</option>)}</select>
      <button type="button" style={styles.secondary} disabled={busy || !selected.length || !status} onClick={batchStatus}>更新状态</button>
      <select aria-label="批量安排评审会" value={meetingId} onChange={(event) => setMeetingId(event.target.value)} style={styles.select}><option value="">选择评审会</option>{activeMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.name}</option>)}</select>
      <button type="button" style={styles.secondary} disabled={busy || !meetingId || !canSchedule} onClick={() => assign()}>批量加入评审会</button>
      <button type="button" style={styles.danger} disabled={busy || !selected.length} onClick={archive}>批量归档</button>
    </div>
    <div style={styles.tableWrap}><table style={styles.table}><thead><tr><th style={styles.cell}><input aria-label="全选项目" type="checkbox" checked={allSelected} onChange={() => setSelected(allSelected ? [] : projects.map((project) => project.id))} /></th>{['项目', '提报人', '资料检查', '项目状态', 'Walker 评审历史', '安排'].map((label) => <th key={label} style={styles.cell}>{label}</th>)}</tr></thead><tbody>
      {projects.map((project) => <tr key={project.id}><td style={styles.cell}><input aria-label={`选择${project.name}`} type="checkbox" checked={selected.includes(project.id)} onChange={() => toggle(project.id)} /></td><td style={styles.cell}><button type="button" style={styles.link} onClick={() => onOpenProject(project)}>{project.name}</button></td><td style={styles.cell}>{project.submitter}</td><td style={styles.cell}>{materialText(project)}</td><td style={styles.cell}>{projectStatusLabel(project.status)}</td><td style={styles.cell}>{project.completed_review_count ?? 0} 次</td><td style={styles.cell}>{READY_STATUSES.has(project.status) ? <select aria-label={`安排${project.name}入会`} defaultValue="" onChange={(event) => event.target.value && assign([project.id], event.target.value)} style={styles.select}><option value="">安排入会</option>{activeMeetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.name}</option>)}</select> : '-'}</td></tr>)}
      {!projects.length && <tr><td colSpan={7} style={styles.empty}>暂无项目</td></tr>}
    </tbody></table></div>
  </>;
}

const styles: Record<string, React.CSSProperties> = {
  toolbar: { display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap', marginBottom: 10 }, monthLabel: { display: 'flex', alignItems: 'center', gap: 8, color: '#475569', fontSize: 13 }, scope: { color: '#64748b', fontSize: 13 }, bulkBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 0 14px' }, select: { padding: '8px', border: '1px solid #cbd5e1', borderRadius: 5, background: '#fff' }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, feedback: { marginBottom: 12, padding: '9px 11px', color: '#155e75', background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 5 }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e7edf5', verticalAlign: 'top' }, empty: { padding: 20, color: '#8591a5', textAlign: 'center' }, link: { border: 0, padding: 0, background: 'transparent', color: '#0f766e', cursor: 'pointer', fontWeight: 700, textAlign: 'left' }
};
