'use client';

import { useEffect, useMemo, useState } from 'react';
import { reorderMeetingAssignments } from '@/lib/adminLifecycle';

type Item = Record<string, any>;
const schedulableStatuses = ['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready'];

export default function MeetingWorkspace({ meeting, projects, source = 'meetings', onBack, onRefresh, onMeetingSaved, onNotice }: {
  meeting: Item; projects: Item[]; source?: 'meetings' | 'reports'; onBack: (source: 'meetings' | 'reports') => void; onRefresh: () => Promise<void> | void; onMeetingSaved?: (meeting: Item) => void; onNotice: (message: string) => void;
}) {
  const [tab, setTab] = useState<'settings' | 'arrange' | 'summary'>('settings');
  const [assignments, setAssignments] = useState<Item[]>([]);
  const [summary, setSummary] = useState<Item | null>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [poolProjects, setPoolProjects] = useState<Item[]>(projects);
  const [form, setForm] = useState({ name: meeting.name || '', meeting_date: meeting.meeting_date || '', deadline: meeting.deadline ? String(meeting.deadline).slice(0, 16) : '', notes: meeting.notes || '' });

  const load = async () => {
    const [projectResponse, summaryResponse, poolResponse] = await Promise.all([fetch(`/api/projects?meetingId=${meeting.id}&role=admin`, { cache: 'no-store' }), fetch(`/api/summary?meetingId=${meeting.id}&_=${Date.now()}`, { cache: 'no-store' }), fetch('/api/project-pool?scope=pending', { cache: 'no-store' })]);
    const projectData = await projectResponse.json(); const summaryData = await summaryResponse.json(); const poolData = await poolResponse.json();
    if (projectResponse.ok) setAssignments((projectData.projects || []).sort((left: Item, right: Item) => Number(left.seq_no) - Number(right.seq_no)));
    if (summaryResponse.ok) setSummary(summaryData);
    if (poolResponse.ok) setPoolProjects(poolData.projects || []);
  };
  useEffect(() => { load(); }, [meeting.id]);
  useEffect(() => { setPoolProjects(projects); }, [projects]);
  const eligible = useMemo(() => poolProjects.filter((project) => schedulableStatuses.includes(project.status) && !(project.projects || []).some((assignment: Item) => assignment.meeting_id === meeting.id)), [poolProjects, meeting.id]);
  const summaryProjects = useMemo(() => [...(summary?.projects || [])].filter((project: Item) => project.name && project.submitter).sort((left: Item, right: Item) => Number(right.totalScore || 0) - Number(left.totalScore || 0)), [summary]);

  const saveSettings = async () => {
    const response = await fetch('/api/meetings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: meeting.id, ...form }) });
    const data = await response.json(); onNotice(response.ok ? '评审会设置已保存。' : data.error || '保存失败');
    if (response.ok) {
      const saved = data.meeting || { ...meeting, ...form };
      setForm({ name: saved.name || '', meeting_date: saved.meeting_date || '', deadline: saved.deadline ? String(saved.deadline).slice(0, 16) : '', notes: saved.notes || '' });
      onMeetingSaved?.(saved);
      await onRefresh();
    }
  };
  const saveOrder = async (next: Item[]) => {
    setAssignments(next);
    const response = await fetch('/api/meeting-assignments', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: meeting.id, ordered_assignment_ids: next.map((item) => item.id) }) });
    const data = await response.json();
    if (!response.ok) { onNotice(data.error || '保存排序失败'); await load(); return; }
    onNotice('项目评审顺序已保存。');
  };
  const drop = (event: React.DragEvent, targetId: string) => { event.preventDefault(); const sourceId = event.dataTransfer.getData('text/plain'); if (sourceId && sourceId !== targetId) saveOrder(reorderMeetingAssignments(assignments, sourceId, targetId)); };
  const addSelected = async () => {
    for (const project of eligible.filter((item) => selected.includes(item.id))) {
      const round_no = project.status.includes('r2') ? 2 : 1;
      const response = await fetch('/api/meeting-assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: meeting.id, pool_project_id: project.id, round_no }) });
      const data = await response.json(); if (!response.ok) { onNotice(data.error || '加入评审会失败'); break; }
    }
    setSelected([]); await load(); await onRefresh();
  };
  const remove = async (assignment: Item) => {
    if (!window.confirm(`将“${assignment.name}”移出本次评审会？`)) return;
    const response = await fetch(`/api/meeting-assignments?id=${encodeURIComponent(assignment.id)}`, { method: 'DELETE' });
    const data = await response.json(); onNotice(response.ok ? '项目已移出评审会。' : data.error || '移除失败'); if (response.ok) { await load(); await onRefresh(); }
  };
  return <section style={styles.section}><div style={styles.header}><div><button style={styles.secondary} onClick={() => onBack(source)}>返回{source === 'reports' ? '结论与报告' : '评审会列表'}</button><h2 style={{ margin: '12px 0 0', fontSize: 20 }}>{meeting.name}</h2></div><button style={styles.secondary} onClick={() => fetch('/api/meetings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: meeting.id, is_current: true }) }).then(async (response) => { const data = await response.json(); onNotice(response.ok ? '已设为当前评审会。' : data.error || '设置失败'); if (response.ok) await onRefresh(); })}>设为当前</button></div>
    <nav style={styles.tabs}>{[['settings', '评审会设置'], ['arrange', '项目编排'], ['summary', '本轮结论与汇总']].map(([id, label]) => <button key={id} style={{ ...styles.tab, ...(tab === id ? styles.activeTab : {}) }} onClick={() => setTab(id as typeof tab)}>{label}</button>)}</nav>
    {tab === 'settings' && <div style={styles.panel}><input style={styles.input} placeholder="评审会名称" value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/><input style={styles.input} type="date" value={form.meeting_date} onChange={(event) => setForm({ ...form, meeting_date: event.target.value })}/><input style={styles.input} type="datetime-local" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })}/><textarea style={styles.input} rows={3} placeholder="会议备注" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })}/><button style={styles.primary} onClick={saveSettings}>保存设置</button></div>}
    {tab === 'arrange' && <><div style={styles.panel}><h3 style={styles.h3}>加入待评审项目</h3><div style={styles.choices}>{eligible.map((project) => <label key={project.id} style={styles.choice}><input type="checkbox" checked={selected.includes(project.id)} onChange={() => setSelected((items) => items.includes(project.id) ? items.filter((id) => id !== project.id) : [...items, project.id])}/><span>{project.name} · {project.submitter}</span><small>{project.status.includes('r2') ? '第二轮' : '第一轮'}</small></label>)}{!eligible.length && <span style={styles.help}>暂无可加入的项目。</span>}</div><button style={styles.primary} disabled={!selected.length || assignments.length >= 12} onClick={addSelected}>加入所选项目</button></div><h3 style={styles.h3}>项目评审顺序（12 个槽位）</h3><div style={styles.slots}>{Array.from({ length: 12 }, (_, index) => { const assignment = assignments[index]; return <div key={assignment?.id || index} style={{ ...styles.slot, ...(assignment ? {} : styles.emptySlot) }} onDragOver={(event) => event.preventDefault()} onDrop={(event) => assignment && drop(event, assignment.id)}>{assignment ? <div draggable onDragStart={(event) => event.dataTransfer.setData('text/plain', assignment.id)} style={styles.dragItem}><strong>{index + 1}. {assignment.name}</strong><span>{assignment.submitter} · 第 {assignment.round_no || 1} 轮</span><div><button style={styles.danger} onClick={() => remove(assignment)}>移出</button></div></div> : <span>{index + 1}. 空槽位</span>}</div>; })}</div></>}
    {tab === 'summary' && <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['排名', '项目', '轮次', '总分', '完成度', 'Walker 结论', '问题与建议'].map((item) => <th key={item} style={styles.cell}>{item}</th>)}</tr></thead><tbody>{summaryProjects.map((project: Item, index: number) => <tr key={project.id}><td style={styles.cell}>{index + 1}</td><td style={styles.cell}>{project.name}</td><td style={styles.cell}>第 {project.round_no || 1} 轮</td><td style={styles.cell}>{Number(project.totalScore || 0).toFixed(1)}</td><td style={styles.cell}>{project.completionRate || 0}%</td><td style={styles.cell}>{({ approved: '通过', recheck: '重评', rejected: '驳回' } as Item)[project.verdict] || '待 Walker 结论'}</td><td style={styles.cell}>{project.roundSummaries?.[project.currentRound]?.problemSummary || '-'}{project.roundSummaries?.[project.currentRound]?.actionSummary ? `；${project.roundSummaries[project.currentRound].actionSummary}` : ''}</td></tr>)}{!summaryProjects.length && <tr><td colSpan={7} style={{ ...styles.cell, textAlign: 'center', color: '#64748b' }}>本场评审会尚未形成汇总数据。</td></tr>}</tbody></table></div>}
  </section>;
}

const styles: Record<string, React.CSSProperties> = { section: { marginTop: 20 }, header: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start' }, tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #d9e1ec', margin: '20px 0 16px' }, tab: { background: 'transparent', border: 0, borderBottom: '3px solid transparent', padding: '10px 12px', cursor: 'pointer', color: '#536177' }, activeTab: { color: '#0f766e', borderBottomColor: '#0f766e', fontWeight: 700 }, panel: { display: 'grid', gap: 10, padding: 16, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff' }, input: { width: '100%', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box' }, primary: { background: '#0f766e', color: '#fff', border: '1px solid #0f766e', borderRadius: 5, padding: '8px 12px', cursor: 'pointer' }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', borderRadius: 5, padding: '8px 12px', cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', borderRadius: 4, padding: '5px 8px', cursor: 'pointer' }, h3: { margin: '0 0 10px', fontSize: 15 }, choices: { display: 'grid', gap: 7, maxHeight: 210, overflowY: 'auto' }, choice: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 8, padding: 8, border: '1px solid #e2e8f0', borderRadius: 4, background: '#fff' }, help: { color: '#64748b', fontSize: 13 }, slots: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }, slot: { minHeight: 102, padding: 10, border: '1px solid #d9e1ec', borderRadius: 5, background: '#fff' }, emptySlot: { color: '#94a3b8', borderStyle: 'dashed' }, dragItem: { display: 'grid', gap: 7, cursor: 'grab' }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', verticalAlign: 'top', borderBottom: '1px solid #e7edf5' } };
