'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MATERIAL_ITEMS, getMaterialProgress, projectStatusLabel } from '@/lib/projectPoolWorkflow';
import { hasCompletedReview, isPendingReviewProject } from '@/lib/adminLifecycle';
import ProjectPoolTable from './components/ProjectPoolTable';
import ProjectDrawer from './components/ProjectDrawer';
import ProjectArchivePanel from './components/ProjectArchivePanel';
import MeetingList from './components/MeetingList';
import MeetingRecycleBin from './components/MeetingRecycleBin';
import MeetingWorkspace from './components/MeetingWorkspace';
import ReportSelector from './components/ReportSelector';
import LiveReportPanel from './components/LiveReportPanel';
import ResultPool from './components/ResultPool';
import AccountManagement from './components/AccountManagement';

type AnyRecord = Record<string, any>;
const tabs = [['pending', '待评审项目池'], ['meetings', '评审会管理'], ['reports', '结论与报告'], ['reviewed', '已评审项目池'], ['results', '结果池'], ['archive', '归档与恢复'], ['accounts', '账号管理']] as const;
const schedulableStatuses = ['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready'];
const readyStatuses = schedulableStatuses;
const statusOptions = ['materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected'];
const materialStatusOptions = [
  { value: 'missing', label: '缺失' },
  { value: 'needs_completion', label: '待完成' },
  { value: 'submitted', label: '已提交' },
  { value: 'exempt', label: '豁免' }
];

function adminCode() { try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; } }
function isLocalSuperAdmin() { return String(adminCode()).trim().toLowerCase() === 'admin51'; }
function materialText(project: AnyRecord) { const progress = getMaterialProgress(project.project_materials || []); return progress.complete ? '资料齐全' : `待补充 ${progress.approved}/${progress.total}`; }
function assignmentStatusLabel(status: string) { return ({ scheduled: '待评审', scoring: '评分中', completed: '已完成' } as AnyRecord)[status] || status || '-'; }

export default function V2AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('pending');
  const [projects, setProjects] = useState<AnyRecord[]>([]);
  const [archivedProjects, setArchivedProjects] = useState<AnyRecord[]>([]);
  const [purgePendingProjects, setPurgePendingProjects] = useState<AnyRecord[]>([]);
  const [meetings, setMeetings] = useState<AnyRecord[]>([]);
  const [recycledMeetings, setRecycledMeetings] = useState<AnyRecord[]>([]);
  const [selectedProject, setSelectedProject] = useState<AnyRecord | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<AnyRecord | null>(null);
  const [meetingView, setMeetingView] = useState<'list' | 'workspace' | 'recycle'>('list');
  const [notice, setNotice] = useState('');
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [showCreateMeeting, setShowCreateMeeting] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: '', submitter: '', description: '' });
  const [meetingForm, setMeetingForm] = useState({ name: '', meeting_date: '', deadline: '', notes: '' });
  const [meetingProjectIds, setMeetingProjectIds] = useState<string[]>([]);
  const [quickProjects, setQuickProjects] = useState<Array<{ name: string; submitter: string; description: string; round_no: number }>>([]);
  const [poolMonth, setPoolMonth] = useState('');

  const load = async (month = poolMonth) => {
    const query = month ? `&month=${encodeURIComponent(month)}` : '';
    const [poolResponse, archiveResponse, purgeResponse, meetingResponse, recycleResponse] = await Promise.all([
      fetch(`/api/project-pool?scope=active${query}`, { cache: 'no-store' }),
      fetch(`/api/project-pool?scope=archived${query}`, { cache: 'no-store' }),
      fetch(`/api/project-pool?scope=purge_pending${query}`, { cache: 'no-store' }),
      fetch('/api/meetings', { cache: 'no-store' }),
      fetch('/api/meetings?includeDeleted=true', { cache: 'no-store' })
    ]);
    const pool = await poolResponse.json(); const archive = await archiveResponse.json(); const purge = await purgeResponse.json(); const meeting = await meetingResponse.json();
    if (poolResponse.ok) setProjects(pool.projects || []); else setNotice(pool.error || 'Unable to load the project pool');
    if (archiveResponse.ok) setArchivedProjects(archive.projects || []);
    if (purgeResponse.ok) setPurgePendingProjects(purge.projects || []);
    if (meetingResponse.ok) setMeetings((meeting.meetings || []).filter((item: AnyRecord) => !item.deleted_at));
    if (recycleResponse.ok) setRecycledMeetings((await recycleResponse.json()).meetings?.filter((item: AnyRecord) => item.deleted_at) || []);
  };

  useEffect(() => {
    const stored = localStorage.getItem('reviewer');
    if (!stored) { router.push('/'); return; }
    if (!JSON.parse(stored).is_admin) { router.push('/scoring'); return; }
    load();
  }, [router]);

  useEffect(() => {
    if (tab === 'reports' && !selectedMeeting && meetings.length) setSelectedMeeting(meetings[0]);
  }, [tab, selectedMeeting, meetings]);

  const pendingProjects = useMemo(() => projects.filter(isPendingReviewProject), [projects]);
  const reviewedProjects = useMemo(() => projects.filter(hasCompletedReview), [projects]);
  const assignmentsForMeeting = (meetingId: string) => projects.flatMap((project) => project.projects || []).filter((assignment: AnyRecord) => assignment.meeting_id === meetingId).sort((a: AnyRecord, b: AnyRecord) => a.seq_no - b.seq_no);
  const meetingAssignmentCounts = useMemo(() => Object.fromEntries(meetings.map((meeting) => [meeting.id, assignmentsForMeeting(meeting.id).length])), [meetings, projects]);
  const meetingEligibleProjects = useMemo(() => projects.filter((project) => schedulableStatuses.includes(project.status) && !project.archived_at), [projects]);

  const createProject = async () => {
    const response = await fetch('/api/project-pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...projectForm, operator_code: adminCode() }) });
    const data = await response.json(); setNotice(response.ok ? '待评审项目已创建。' : data.error || '创建失败');
    if (response.ok) { setProjectForm({ name: '', submitter: '', description: '' }); setShowCreateProject(false); await load(); }
  };
  const createMeeting = async () => {
    const response = await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...meetingForm, pool_project_ids: meetingProjectIds, create_projects: quickProjects }) });
    const data = await response.json(); setNotice(response.ok ? '评审会已创建。' : data.error || '创建失败');
    if (response.ok) { setMeetingForm({ name: '', meeting_date: '', deadline: '', notes: '' }); setMeetingProjectIds([]); setQuickProjects([]); setShowCreateMeeting(false); await load(); }
  };
  const setCurrentMeeting = async (meeting: AnyRecord) => {
    const response = await fetch('/api/meetings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: meeting.id, is_current: true }) });
    const data = await response.json(); setNotice(response.ok ? '已设为当前默认评审会。' : data.error || '设置失败'); if (response.ok) await load();
  };
  const recycleMeetings = async (ids: string[]) => {
    const response = await fetch('/api/meetings/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action: 'recycle' }) });
    const data = await response.json(); setNotice(response.ok ? `${data.updated || ids.length} 场评审会已移入回收站。` : data.error || '移入回收站失败'); if (response.ok) { setSelectedMeeting(null); setMeetingView('list'); await load(); }
  };
  const restoreMeetings = async (ids: string[]) => {
    const response = await fetch('/api/meetings/batch', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ids, action: 'restore' }) });
    const data = await response.json(); setNotice(response.ok ? `${data.updated || ids.length} 场评审会已恢复。` : data.error || '恢复失败'); if (response.ok) { setMeetingView('list'); await load(); }
  };
  const schedule = async (projectIds: string[], meetingId: string) => {
    const response = await fetch('/api/meeting-assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: meetingId, pool_project_ids: projectIds, operator_code: adminCode() }) });
    const data = await response.json();
    setNotice(response.ok ? `已安排 ${data.assignments?.length || projectIds.length} 个项目进入评审会。${data.errors?.length ? ` 另有 ${data.errors.length} 个未能安排。` : ''}` : data.error || '安排失败');
    if (response.ok) await load();
  };
  const archiveProjects = async (ids: string[]) => {
    if (!ids.length || !window.confirm(`归档选中的 ${ids.length} 个项目？历史评分仍会保留。`)) return;
    const results = await Promise.all(ids.map((id) => fetch(`/api/project-pool?id=${encodeURIComponent(id)}&operator_code=${encodeURIComponent(adminCode())}`, { method: 'DELETE' }).then(async (response) => ({ ok: response.ok, data: await response.json() }))));
    const failed = results.filter((result) => !result.ok); setNotice(failed.length ? `${ids.length - failed.length} 个已归档，${failed.length} 个失败。` : `已归档 ${ids.length} 个项目。`); await load();
  };
  const refreshProject = async (updated?: AnyRecord) => {
    if (!updated?.id) return;
    setProjects((current) => current.map((project) => project.id === updated.id ? { ...project, ...updated } : project));
    setSelectedProject((current) => current?.id === updated.id ? { ...current, ...updated } : current);
    void load();
  };
  const openProject = async (project: AnyRecord) => {
    const id = project.id || project.pool_project_id; if (!id) return;
    const response = await fetch(`/api/project-pool/${id}/history`, { cache: 'no-store' }); const data = await response.json();
    if (response.ok) setSelectedProject({ ...data.project, projects: data.assignments || [], completed_reviews: data.completed_reviews || [], status_history: data.history || [] }); else setNotice(data.error || '读取项目详情失败');
  };
  const openMeeting = (meeting: AnyRecord) => { setSelectedMeeting(meeting); setMeetingView('workspace'); };

  const showAccountManagement = isLocalSuperAdmin();

  return <main style={styles.page}>
    <header style={styles.header}><div><h1 style={styles.h1}>立项评审管理</h1><p style={styles.subtle}>项目池管理项目本身；评分规则和评审轮次由每个项目的当前状态决定。</p></div><button style={styles.secondary} onClick={() => { localStorage.removeItem('reviewer'); router.push('/'); }}>退出</button></header>
    <nav style={styles.tabs}>{tabs.filter(([id]) => id !== 'accounts' || showAccountManagement).map(([id, label]) => <button key={id} style={{ ...styles.tab, ...(tab === id ? styles.tabActive : {}) }} onClick={() => { setTab(id); if (id !== 'reports') setSelectedMeeting(null); }}>{label}</button>)}</nav>
    {notice && <div style={styles.notice}>{notice}</div>}
    {tab === 'pending' && <section><Toolbar title={`待评审项目池 (${pendingProjects.length})`} action="新建项目" onAction={() => setShowCreateProject((value) => !value)} />{showCreateProject && <div style={styles.panel}><input style={styles.input} placeholder="项目名称" value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })}/><input style={styles.input} placeholder="提报人" value={projectForm.submitter} onChange={(event) => setProjectForm({ ...projectForm, submitter: event.target.value })}/><textarea style={styles.input} rows={3} placeholder="项目说明" value={projectForm.description} onChange={(event) => setProjectForm({ ...projectForm, description: event.target.value })}/><button style={styles.primary} onClick={createProject}>建立项目</button></div>}<ProjectPoolTable projects={pendingProjects} meetings={meetings} scope="active" month={poolMonth} onMonthChange={(month) => { setPoolMonth(month); load(month); }} onRefresh={load} onOpenProject={openProject}/></section>}
    {tab === 'meetings' && <section>{meetingView === 'workspace' && selectedMeeting ? <MeetingWorkspace meeting={selectedMeeting} projects={projects} onBack={() => { setSelectedMeeting(null); setMeetingView('list'); }} onRefresh={load} onMeetingSaved={(updated) => setSelectedMeeting(updated)} onNotice={setNotice} /> : meetingView === 'recycle' ? <MeetingRecycleBin meetings={recycledMeetings} onRestore={restoreMeetings} onBack={() => setMeetingView('list')} /> : <><MeetingList meetings={meetings} assignmentCounts={meetingAssignmentCounts} onOpen={openMeeting} onCreate={() => setShowCreateMeeting((value) => !value)} onSetCurrent={setCurrentMeeting} onRecycle={recycleMeetings} onOpenRecycleBin={() => setMeetingView('recycle')} />{showCreateMeeting && <div style={styles.panel}><input style={styles.input} placeholder="评审会名称" value={meetingForm.name} onChange={(event) => setMeetingForm({ ...meetingForm, name: event.target.value })}/><input style={styles.input} type="date" value={meetingForm.meeting_date} onChange={(event) => setMeetingForm({ ...meetingForm, meeting_date: event.target.value })}/><input style={styles.input} type="date" value={meetingForm.deadline} onChange={(event) => setMeetingForm({ ...meetingForm, deadline: event.target.value })}/><textarea style={styles.input} rows={2} placeholder="会议备注" value={meetingForm.notes} onChange={(event) => setMeetingForm({ ...meetingForm, notes: event.target.value })}/><div style={styles.choiceList}>{meetingEligibleProjects.map((project) => <label key={project.id} style={styles.choice}><input type="checkbox" checked={meetingProjectIds.includes(project.id)} onChange={() => setMeetingProjectIds((ids) => ids.includes(project.id) ? ids.filter((id) => id !== project.id) : [...ids, project.id])}/><span>{project.name} · {project.submitter}</span><small>{projectStatusLabel(project.status)}</small></label>)}{!meetingEligibleProjects.length && <span style={styles.subtle}>暂无可直接安排的项目。</span>}</div><div style={styles.actions}><button style={styles.secondary} onClick={() => setQuickProjects((items) => [...items, { name: '', submitter: '', description: '', round_no: 1 }])}>添加快速项目</button></div>{quickProjects.map((project, index) => <div key={index} style={styles.panel}><input style={styles.input} placeholder="项目名称" value={project.name} onChange={(event) => setQuickProjects((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, name: event.target.value } : item))}/><input style={styles.input} placeholder="提报人" value={project.submitter} onChange={(event) => setQuickProjects((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, submitter: event.target.value } : item))}/><textarea style={styles.input} rows={2} placeholder="项目说明" value={project.description} onChange={(event) => setQuickProjects((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, description: event.target.value } : item))}/><select style={styles.select} value={project.round_no} onChange={(event) => setQuickProjects((items) => items.map((item, itemIndex) => itemIndex === index ? { ...item, round_no: Number(event.target.value) } : item))}><option value={1}>第一轮</option><option value={2}>第二轮</option></select><button style={styles.danger} onClick={() => setQuickProjects((items) => items.filter((_, itemIndex) => itemIndex !== index))}>移除快速项目</button></div>)}<button style={styles.primary} disabled={meetingProjectIds.length + quickProjects.length > 12} onClick={createMeeting}>创建评审会</button></div>}</>}</section>}
    {tab === 'reports' && <section><Toolbar title="结论与报告" /><ReportSelector
      meetings={meetings as Array<{ id: string; name: string; meeting_date?: string; is_current?: boolean }>}
      selectedId={selectedMeeting?.id}
      onSelect={(meeting) => setSelectedMeeting(meeting as AnyRecord)}
      onOpen={(meeting) => window.open(`/report?meetingId=${encodeURIComponent(meeting.id)}&fromAdmin=true`, '_blank', 'noopener,noreferrer')}
    />{selectedMeeting ? <LiveReportPanel meeting={selectedMeeting} /> : <div style={styles.empty}>暂无可查看报告的评审会。</div>}</section>}
    {tab === 'reviewed' && <section><Toolbar title={`已评审项目池 (${reviewedProjects.length})`} /><ProjectPoolTable projects={reviewedProjects} meetings={meetings} scope="reviewed" month={poolMonth} onMonthChange={(month) => { setPoolMonth(month); load(month); }} onRefresh={load} onOpenProject={openProject}/></section>}
    {tab === 'results' && <section><Toolbar title="结果池" /><ResultPool projects={projects} onOpenProject={openProject} /></section>}
    {tab === 'archive' && <section><Toolbar title="归档与恢复" /><ProjectArchivePanel archivedProjects={archivedProjects} purgePendingProjects={purgePendingProjects} onRefresh={load} onOpenProject={openProject} /></section>}
    {tab === 'accounts' && showAccountManagement && <AccountManagement />}
    {selectedProject && (
      <ProjectDrawer project={selectedProject} onDismiss={() => setSelectedProject(null)} onSaved={refreshProject}/>
    )}
  </main>;
}

function Toolbar({ title, action, onAction }: AnyRecord) { return <div style={styles.toolbar}><h2 style={styles.h2}>{title}</h2>{action && <button style={styles.primary} onClick={onAction}>{action}</button>}</div>; }

function LegacyProjectTable({ projects, meetings, onOpen, onSchedule, onArchive }: AnyRecord) {
  const [selected, setSelected] = useState<string[]>([]); const [meetingId, setMeetingId] = useState('');
  useEffect(() => setSelected((items) => items.filter((id) => projects.some((project: AnyRecord) => project.id === id))), [projects]);
  const toggle = (id: string) => setSelected((items) => items.includes(id) ? items.filter((item) => item !== id) : [...items, id]);
  const scheduleSelected = () => meetingId && onSchedule(selected, meetingId);
  return <><div style={styles.bulkBar}><span>已选 {selected.length} 项</span><select style={styles.select} value={meetingId} onChange={(event) => setMeetingId(event.target.value)}><option value="">选择评审会</option>{meetings.filter((meeting: AnyRecord) => meeting.status === 'active').map((meeting: AnyRecord) => <option key={meeting.id} value={meeting.id}>{meeting.name}</option>)}</select><button style={styles.secondary} disabled={!selected.length || !meetingId} onClick={scheduleSelected}>批量加入评审会</button><button style={styles.danger} disabled={!selected.length} onClick={() => onArchive(selected)}>批量归档</button></div><div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['', '项目', '提报人', '资料检查', '项目状态', '评审历史', '安排'].map((text) => <th style={styles.cell} key={text}>{text}</th>)}</tr></thead><tbody>{projects.map((project: AnyRecord) => <tr key={project.id}><td style={styles.cell}><input type="checkbox" checked={selected.includes(project.id)} onChange={() => toggle(project.id)} aria-label={`选择${project.name}`}/></td><td style={styles.cell}><button style={styles.link} onClick={() => onOpen(project)}>{project.name}</button></td><td style={styles.cell}>{project.submitter}</td><td style={styles.cell}>{materialText(project)}</td><td style={styles.cell}>{projectStatusLabel(project.status)}</td><td style={styles.cell}>{(project.projects || []).length ? `${(project.projects || []).length} 次` : '-'}</td><td style={styles.cell}>{readyStatuses.includes(project.status) ? <select value="" style={styles.select} onChange={(event) => event.target.value && onSchedule([project.id], event.target.value)}><option value="">安排入会</option>{meetings.filter((meeting: AnyRecord) => meeting.status === 'active').map((meeting: AnyRecord) => <option key={meeting.id} value={meeting.id}>{meeting.name}</option>)}</select> : '-'}</td></tr>)}{projects.length === 0 && <tr><td colSpan={7} style={styles.empty}>暂无项目</td></tr>}</tbody></table></div></>;
}

function LegacyMeetingWorkspace({ meeting, projects, onBack, onOpenProject, onSchedule, onCurrent, onRefresh, onNotice }: AnyRecord) {
  const router = useRouter(); const [assignments, setAssignments] = useState<AnyRecord[]>([]); const [summary, setSummary] = useState<AnyRecord | null>(null); const [selected, setSelected] = useState<string[]>([]); const [form, setForm] = useState({ name: meeting.name || '', meeting_date: meeting.meeting_date || '', deadline: meeting.deadline ? String(meeting.deadline).slice(0, 10) : '', notes: meeting.notes || '' });
  const loadWorkspace = async () => { const [projectResponse, summaryResponse] = await Promise.all([fetch(`/api/projects?meetingId=${meeting.id}&role=admin`, { cache: 'no-store' }), fetch(`/api/summary?meetingId=${meeting.id}&_=${Date.now()}`, { cache: 'no-store' })]); const projectData = await projectResponse.json(); const summaryData = await summaryResponse.json(); if (projectResponse.ok) setAssignments((projectData.projects || []).sort((a: AnyRecord, b: AnyRecord) => a.seq_no - b.seq_no)); if (summaryResponse.ok) setSummary(summaryData); };
  useEffect(() => { loadWorkspace(); }, [meeting.id]);
  const eligible = projects.filter((project: AnyRecord) => readyStatuses.includes(project.status) && !(project.projects || []).some((assignment: AnyRecord) => assignment.meeting_id === meeting.id));
  const saveMeeting = async () => { const response = await fetch('/api/meetings', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: meeting.id, ...form }) }); const data = await response.json(); onNotice(response.ok ? '评审会基本信息已保存。' : data.error || '保存失败'); if (response.ok) onRefresh(); };
  const addSelected = async () => { await onSchedule(selected, meeting.id); setSelected([]); await loadWorkspace(); };
  const removeAssignment = async (assignment: AnyRecord) => { if (!window.confirm(`将“${assignment.name}”移出本次评审会？`)) return; const response = await fetch(`/api/meeting-assignments?id=${assignment.id}&operator_code=${encodeURIComponent(adminCode())}`, { method: 'DELETE' }); const data = await response.json(); onNotice(response.ok ? '项目已移出评审会。' : data.error || '移除失败'); if (response.ok) { await loadWorkspace(); onRefresh(); } };
  const move = async (index: number, offset: number) => { const next = [...assignments]; const target = index + offset; if (target < 0 || target >= next.length) return; [next[index], next[target]] = [next[target], next[index]]; setAssignments(next); const response = await fetch('/api/meeting-assignments', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: meeting.id, ordered_assignment_ids: next.map((assignment) => assignment.id), operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '项目评审顺序已保存。' : data.error || '保存排序失败'); if (!response.ok) await loadWorkspace(); };
  const summaryProjects = [...(summary?.projects || [])].filter((project: AnyRecord) => project.name && project.submitter).sort((a: AnyRecord, b: AnyRecord) => b.totalScore - a.totalScore);
  return <div><div style={styles.toolbar}><div><button style={styles.secondary} onClick={onBack}>返回评审会列表</button><h2 style={{ ...styles.h2, marginTop: 12 }}>{meeting.name}</h2></div><div style={styles.actions}><button style={styles.secondary} onClick={() => onCurrent(meeting)}>设为当前评审会</button><button style={styles.secondary} onClick={() => router.push(`/report?meetingId=${meeting.id}&from=admin`)}>打开打印报告</button></div></div><div style={styles.panel}><h3 style={{ margin: 0 }}>评审会设置</h3><input style={styles.input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/><input style={styles.input} type="date" value={form.meeting_date} onChange={(event) => setForm({ ...form, meeting_date: event.target.value })}/><input style={styles.input} type="date" value={form.deadline} onChange={(event) => setForm({ ...form, deadline: event.target.value })}/><textarea style={styles.input} rows={2} placeholder="会议备注" value={form.notes} onChange={(event) => setForm({ ...form, notes: event.target.value })}/><button style={styles.primary} onClick={saveMeeting}>保存评审会设置</button></div><div style={styles.panel}><h3 style={{ margin: 0 }}>加入待评审项目</h3><div style={styles.choiceList}>{eligible.map((project: AnyRecord) => <label key={project.id} style={styles.choice}><input type="checkbox" checked={selected.includes(project.id)} onChange={() => setSelected((items) => items.includes(project.id) ? items.filter((id) => id !== project.id) : [...items, project.id])}/><span>{project.name}</span><small>{projectStatusLabel(project.status)}，{materialText(project)}</small></label>)}{eligible.length === 0 && <span style={styles.subtle}>当前没有可加入的合格项目。</span>}</div><button style={styles.primary} disabled={!selected.length || assignments.length >= 12} onClick={addSelected}>加入所选项目</button></div><h3>项目评审顺序（12 个槽位）</h3><div style={styles.slotGrid}>{Array.from({ length: 12 }, (_, index) => { const assignment = assignments[index]; return <div key={assignment?.id || index} style={styles.slot}>{assignment ? <><strong>{index + 1}. {assignment.name}</strong><span>{assignment.submitter} · 第 {assignment.attempt_no || 1} 次评审</span><span>{assignmentStatusLabel(assignment.assignment_status)}</span><div style={styles.actions}><button style={styles.iconButton} title="上移" disabled={index === 0} onClick={() => move(index, -1)}>上</button><button style={styles.iconButton} title="下移" disabled={index === assignments.length - 1} onClick={() => move(index, 1)}>下</button>{assignment.pool_project_id && <button style={styles.danger} onClick={() => removeAssignment(assignment)}>移出</button>}</div></> : <span style={styles.subtle}>{index + 1}. 空槽位</span>}</div>; })}</div><h3>本次评审结论与汇总</h3><div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['排名', '项目', '总分', '完成度', 'Walker 结论', '问题与建议'].map((text) => <th style={styles.cell} key={text}>{text}</th>)}</tr></thead><tbody>{summaryProjects.map((project: AnyRecord, index: number) => <tr key={project.id}><td style={styles.cell}>{index + 1}</td><td style={styles.cell}><button style={styles.link} onClick={() => onOpenProject({ id: project.pool_project_id })}>{project.name}</button></td><td style={styles.cell}>{Number(project.totalScore || 0).toFixed(1)} / 100</td><td style={styles.cell}>{project.completionRate || 0}%</td><td style={styles.cell}>{({ approved: '通过', recheck: '重评', rejected: '驳回' } as AnyRecord)[project.verdict] || '未定'}</td><td style={styles.cell}><div>{project.roundSummaries?.[project.currentRound]?.problemSummary || '-'}</div><div style={styles.subtle}>{project.roundSummaries?.[project.currentRound]?.actionSummary || ''}</div></td></tr>)}{summaryProjects.length === 0 && <tr><td colSpan={6} style={styles.empty}>本场评审会尚未形成可汇总的评审数据。</td></tr>}</tbody></table></div></div>;
}

function LegacyProjectDrawer({ project, onClose, onSaved, onArchive, onNotice }: AnyRecord) {
  const [form, setForm] = useState({ name: project.name || '', submitter: project.submitter || '', description: project.description || '' }); const [manualStatus, setManualStatus] = useState(project.status || 'materials_pending'); const [manualNote, setManualNote] = useState(''); const materials = new Map<string, AnyRecord>((project.project_materials || []).map((material: AnyRecord) => [material.item_key, material]));
  useEffect(() => { setForm({ name: project.name || '', submitter: project.submitter || '', description: project.description || '' }); setManualStatus(project.status || 'materials_pending'); }, [project]);
  const saveProject = async () => { const response = await fetch('/api/project-pool', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: project.id, ...form, operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '项目详情已保存，列表已同步更新。' : data.error || '保存失败'); if (response.ok) onSaved(project.id); };
  const saveMaterial = async (item: AnyRecord, status: string) => { const response = await fetch(`/api/project-pool/${project.id}/materials`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_key: item.item_key, status, operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '资料检查已保存，列表已同步更新。' : data.error || '保存失败'); if (response.ok) onSaved(project.id); };
  const changeStatus = async () => { const response = await fetch(`/api/project-pool/${project.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: manualStatus, note: manualNote, confirmed: true, operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '项目状态已人工调整。' : data.error || '调整失败'); if (response.ok) onSaved(project.id); };
  return <div style={styles.overlay}><aside style={styles.drawer}><div style={styles.actions}><button style={styles.secondary} onClick={onClose}>关闭</button><button style={styles.danger} onClick={onArchive}>归档项目</button></div><h2>{project.name}</h2><div style={styles.panel}><input style={styles.input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/><input style={styles.input} value={form.submitter} onChange={(event) => setForm({ ...form, submitter: event.target.value })}/><textarea style={styles.input} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })}/><button style={styles.primary} onClick={saveProject}>保存项目详情</button></div><h3>资料检查</h3>{MATERIAL_ITEMS.map((item) => <div key={item.item_key} style={styles.material}><span>{item.label}{item.required ? ' *' : ''}</span><select style={styles.select} value={materials.get(item.item_key)?.status || 'missing'} onChange={(event) => saveMaterial(item, event.target.value)}>{materialStatusOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select></div>)}<h3>人工调整状态</h3><div style={styles.panel}><select style={styles.select} value={manualStatus} onChange={(event) => setManualStatus(event.target.value)}>{statusOptions.map((status) => <option key={status} value={status}>{projectStatusLabel(status)}</option>)}</select><textarea style={styles.input} rows={2} placeholder="调整备注（可选）" value={manualNote} onChange={(event) => setManualNote(event.target.value)}/><button style={styles.secondary} onClick={changeStatus}>确认人工调整</button></div><h3>状态历史</h3>{(project.status_history || []).map((event: AnyRecord) => <div key={event.id} style={styles.assignment}>{new Date(event.created_at).toLocaleString('zh-CN')} · {projectStatusLabel(event.to_status)} · {event.operator_code || '系统'}{event.note ? ` · ${event.note}` : ''}</div>)}{!(project.status_history || []).length && <p style={styles.subtle}>暂无状态变更记录。</p>}<h3>评审历史</h3>{(project.projects || []).map((assignment: AnyRecord) => <div key={assignment.id} style={styles.assignment}><strong>第 {assignment.round_no || 1} 轮 / 第 {assignment.attempt_no || 1} 次 · {assignment.meetings?.name || '评审会'}</strong><div>{assignmentStatusLabel(assignment.assignment_status)}</div>{assignment.history_summary && <><div>历史总分：{Number(assignment.history_summary.totalScore || 0).toFixed(1)} / 100</div>{assignment.history_summary.problems?.length > 0 && <div>问题：{assignment.history_summary.problems.join('；')}</div>}{assignment.history_summary.actions?.length > 0 && <div>改进动作：{assignment.history_summary.actions.join('；')}</div>}</>}</div>)}{!(project.projects || []).length && <p style={styles.subtle}>尚无评审记录。</p>}</aside></div>;
}

const styles: AnyRecord = { page: { maxWidth: 1280, margin: '0 auto', padding: '28px 22px', color: '#172033', fontFamily: 'Arial, sans-serif' }, header: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start', marginBottom: 22 }, h1: { margin: 0, fontSize: 25 }, h2: { margin: 0, fontSize: 18 }, h3: { margin: '20px 0 10px', fontSize: 15 }, subtle: { color: '#64748b', fontSize: 13, margin: '6px 0' }, tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #d9e1ec', overflowX: 'auto' }, tab: { background: 'transparent', border: 'none', borderBottom: '3px solid transparent', padding: '10px 13px', color: '#536177', cursor: 'pointer', whiteSpace: 'nowrap' }, tabActive: { color: '#0f766e', borderBottomColor: '#0f766e', fontWeight: 700 }, toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '20px 0 14px' }, primary: { background: '#0f766e', color: '#fff', border: '1px solid #0f766e', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, iconButton: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '4px 7px', borderRadius: 4, cursor: 'pointer' }, panel: { display: 'grid', gap: 10, padding: 16, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff', marginBottom: 16 }, input: { width: '100%', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box', fontSize: 14 }, select: { padding: '8px', border: '1px solid #cbd5e1', borderRadius: 5, background: '#fff' }, notice: { margin: '16px 0', padding: '10px 12px', background: '#ecfeff', color: '#155e75', border: '1px solid #a5f3fc', borderRadius: 6 }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e7edf5', verticalAlign: 'top' }, empty: { padding: 20, color: '#8591a5', textAlign: 'center' }, link: { border: 0, padding: 0, background: 'transparent', color: '#0f766e', cursor: 'pointer', fontWeight: 700, textAlign: 'left' }, resultGrid: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 12 }, listButton: { display: 'flex', justifyContent: 'space-between', width: '100%', marginTop: 8, background: '#fff', border: '1px solid #d9e1ec', padding: 9, borderRadius: 5, cursor: 'pointer', textAlign: 'left' }, overlay: { position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(15,23,42,.34)', display: 'flex', justifyContent: 'flex-end' }, drawer: { width: 620, maxWidth: '100%', background: '#fff', padding: 24, overflowY: 'auto' }, material: { display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #edf2f7' }, assignment: { padding: 10, background: '#f7fafc', marginBottom: 6, borderRadius: 4, display: 'grid', gap: 4 }, actions: { display: 'flex', flexWrap: 'wrap', gap: 7, alignItems: 'center' }, bulkBar: { display: 'flex', flexWrap: 'wrap', gap: 8, alignItems: 'center', padding: '10px 0 14px' }, currentBadge: { display: 'inline-block', marginRight: 8, padding: '3px 7px', borderRadius: 999, background: '#0f766e', color: '#fff', fontSize: 12, fontWeight: 700 }, currentRow: { background: '#f0fdfa' }, choiceList: { display: 'grid', gap: 7, maxHeight: 220, overflowY: 'auto' }, choice: { display: 'grid', gridTemplateColumns: 'auto 1fr auto', alignItems: 'center', gap: 8, padding: 8, background: '#fff', border: '1px solid #e2e8f0', borderRadius: 4 }, slotGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 10 }, slot: { minHeight: 100, padding: 11, border: '1px solid #d9e1ec', borderRadius: 5, display: 'grid', gap: 6, alignContent: 'start', background: '#fff' } };
