'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { MATERIAL_ITEMS } from '@/lib/projectPoolWorkflow';

type PoolProject = any;
type Meeting = any;
const tabs = [['pending', '待评审项目池'], ['meetings', '评审会管理'], ['reports', '结论与报告'], ['reviewed', '已评审项目池'], ['results', '结果池']] as const;
const readyStatuses = ['ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready'];

function adminCode() { try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; } }

export default function V2AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('pending');
  const [projects, setProjects] = useState<PoolProject[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selectedProject, setSelectedProject] = useState<PoolProject | null>(null);
  const [selectedMeeting, setSelectedMeeting] = useState<Meeting | null>(null);
  const [notice, setNotice] = useState('');
  const [showCreateProject, setShowCreateProject] = useState(false);
  const [projectForm, setProjectForm] = useState({ name: '', submitter: '', description: '' });
  const [meetingForm, setMeetingForm] = useState({ name: '', meeting_date: '', deadline: '' });

  const load = async () => {
    const [poolResponse, meetingResponse] = await Promise.all([fetch('/api/project-pool?scope=all', { cache: 'no-store' }), fetch('/api/meetings', { cache: 'no-store' })]);
    const pool = await poolResponse.json(); const meeting = await meetingResponse.json();
    if (poolResponse.ok) setProjects(pool.projects || []); else setNotice(pool.error || '读取项目池失败');
    if (meetingResponse.ok) setMeetings((meeting.meetings || []).filter((item: any) => !item.deleted_at));
  };

  useEffect(() => {
    const stored = localStorage.getItem('reviewer');
    if (!stored) { router.push('/'); return; }
    if (!JSON.parse(stored).is_admin) { router.push('/scoring'); return; }
    load();
  }, [router]);

  const pendingProjects = useMemo(() => projects.filter((project) => !project.latest_verdict && !project.archived_at), [projects]);
  const reviewedProjects = useMemo(() => projects.filter((project) => project.latest_verdict), [projects]);
  const assignmentsForMeeting = (meetingId: string) => projects.flatMap((project) => project.projects || []).filter((assignment: any) => assignment.meeting_id === meetingId);

  const createProject = async () => {
    const response = await fetch('/api/project-pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...projectForm, operator_code: adminCode() }) });
    const data = await response.json(); setNotice(response.ok ? '待评审项目已创建。' : data.error || '创建失败');
    if (response.ok) { setProjectForm({ name: '', submitter: '', description: '' }); setShowCreateProject(false); await load(); }
  };

  const createMeeting = async () => {
    const response = await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(meetingForm) });
    const data = await response.json(); setNotice(response.ok ? '评审会已创建。请从项目池安排合格项目入会。' : data.error || '创建失败');
    if (response.ok) { setMeetingForm({ name: '', meeting_date: '', deadline: '' }); await load(); }
  };

  const schedule = async (project: PoolProject, meetingId: string) => {
    const round = project.status.includes('r2') || project.status === 'ready_r2' ? 2 : 1;
    const response = await fetch('/api/meeting-assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: meetingId, pool_project_id: project.id, round_no: round, operator_code: adminCode() }) });
    const data = await response.json(); setNotice(response.ok ? '项目已安排入会。' : data.error || '安排失败'); if (response.ok) await load();
  };

  const refreshProject = async (id: string) => {
    await load();
    const data = await (await fetch('/api/project-pool?scope=all', { cache: 'no-store' })).json();
    setSelectedProject((data.projects || []).find((project: any) => project.id === id) || null);
  };

  const openProject = async (project: PoolProject) => {
    const id = project.id || project.pool_project_id;
    if (!id) return;
    const data = await (await fetch('/api/project-pool?scope=all', { cache: 'no-store' })).json();
    setSelectedProject((data.projects || []).find((item: any) => item.id === id) || project);
  };

  return <main style={styles.page}>
    <header style={styles.header}><div><h1 style={styles.h1}>立项评审管理</h1><p style={styles.subtle}>项目池管理项目本身；每次评审会只承载一个轮次的评审记录。</p></div><button style={styles.secondary} onClick={() => { localStorage.removeItem('reviewer'); router.push('/'); }}>退出</button></header>
    <nav style={styles.tabs}>{tabs.map(([id, label]) => <button key={id} style={{ ...styles.tab, ...(tab === id ? styles.tabActive : {}) }} onClick={() => { setTab(id); setSelectedMeeting(null); }}>{label}</button>)}</nav>
    {notice && <div style={styles.notice}>{notice}</div>}

    {tab === 'pending' && <section>
      <Toolbar title={`待评审项目池 (${pendingProjects.length})`} action="新建项目" onAction={() => setShowCreateProject((value) => !value)} />
      {showCreateProject && <div style={styles.panel}><input style={styles.input} placeholder="项目名称" value={projectForm.name} onChange={(event) => setProjectForm({ ...projectForm, name: event.target.value })}/><input style={styles.input} placeholder="提报人" value={projectForm.submitter} onChange={(event) => setProjectForm({ ...projectForm, submitter: event.target.value })}/><textarea style={styles.input} rows={3} placeholder="项目说明" value={projectForm.description} onChange={(event) => setProjectForm({ ...projectForm, description: event.target.value })}/><button style={styles.primary} onClick={createProject}>建立项目</button></div>}
      <ProjectTable projects={pendingProjects} meetings={meetings} onOpen={openProject} onSchedule={schedule}/>
    </section>}

    {tab === 'meetings' && <section>
      <Toolbar title="评审会管理" action="创建评审会" onAction={createMeeting}/>
      <div style={styles.panel}><input style={styles.input} placeholder="评审会名称" value={meetingForm.name} onChange={(event) => setMeetingForm({ ...meetingForm, name: event.target.value })}/><input style={styles.input} type="date" value={meetingForm.meeting_date} onChange={(event) => setMeetingForm({ ...meetingForm, meeting_date: event.target.value })}/><input style={styles.input} type="datetime-local" value={meetingForm.deadline} onChange={(event) => setMeetingForm({ ...meetingForm, deadline: event.target.value })}/></div>
      <MeetingTable meetings={meetings} assignmentsForMeeting={assignmentsForMeeting} onOpen={(meeting) => { setSelectedMeeting(meeting); setTab('reports'); }}/>
    </section>}

    {tab === 'reports' && <section>
      <Toolbar title="结论与报告" />
      {!selectedMeeting ? <MeetingTable meetings={meetings} assignmentsForMeeting={assignmentsForMeeting} onOpen={setSelectedMeeting}/> : <MeetingSummary meeting={selectedMeeting} onBack={() => setSelectedMeeting(null)} onOpenProject={openProject} onOpenReport={() => router.push(`/report?meetingId=${selectedMeeting.id}&from=admin`)}/>} 
    </section>}

    {tab === 'reviewed' && <section><Toolbar title={`已评审项目池 (${reviewedProjects.length})`}/><ProjectTable projects={reviewedProjects} meetings={meetings} onOpen={openProject} onSchedule={schedule}/></section>}
    {tab === 'results' && <section><Toolbar title="结果池"/><div style={styles.resultGrid}>{['approved', 'recheck', 'rejected'].map((bucket) => <div key={bucket} style={styles.panel}><strong>{({ approved: '通过项目', recheck: '待重评项目', rejected: '驳回项目' } as any)[bucket]}</strong>{projects.filter((project) => project.latest_verdict === bucket).map((project) => <button key={project.id} style={styles.listButton} onClick={() => openProject(project)}>{project.name}<span>{project.status}</span></button>)}</div>)}</div></section>}

    {selectedProject && <ProjectDrawer project={selectedProject} onClose={() => setSelectedProject(null)} onSaved={refreshProject} onNotice={setNotice}/>} 
  </main>;
}

function Toolbar({ title, action, onAction }: any) { return <div style={styles.toolbar}><h2 style={styles.h2}>{title}</h2>{action && <button style={styles.primary} onClick={onAction}>{action}</button>}</div>; }

function ProjectTable({ projects, meetings, onOpen, onSchedule }: any) { return <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['项目', '提报人', '资料', '状态', '评审历史', '安排'].map((text) => <th style={styles.cell} key={text}>{text}</th>)}</tr></thead><tbody>{projects.map((project: any) => <tr key={project.id}><td style={styles.cell}><button style={styles.link} onClick={() => onOpen(project)}>{project.name}</button></td><td style={styles.cell}>{project.submitter}</td><td style={styles.cell}>{project.material_status === 'complete' ? '资料齐全' : '待补充'}</td><td style={styles.cell}>{project.status}</td><td style={styles.cell}>{(project.projects || []).length ? `${(project.projects || []).length} 次` : '-'}</td><td style={styles.cell}>{readyStatuses.includes(project.status) ? <select defaultValue="" style={styles.select} onChange={(event) => event.target.value && onSchedule(project, event.target.value)}><option value="">安排入会</option>{meetings.filter((meeting: any) => meeting.status === 'active').map((meeting: any) => <option key={meeting.id} value={meeting.id}>{meeting.name}</option>)}</select> : '-'}</td></tr>)}{projects.length === 0 && <tr><td colSpan={6} style={styles.empty}>暂无项目</td></tr>}</tbody></table></div>; }

function MeetingTable({ meetings, assignmentsForMeeting, onOpen }: any) { return <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['评审会', '日期', '截止时间', '已安排项目', '操作'].map((text) => <th style={styles.cell} key={text}>{text}</th>)}</tr></thead><tbody>{meetings.map((meeting: any) => { const assignments = assignmentsForMeeting(meeting.id); return <tr key={meeting.id}><td style={styles.cell}>{meeting.name}</td><td style={styles.cell}>{meeting.meeting_date || '-'}</td><td style={styles.cell}>{meeting.deadline || '-'}</td><td style={styles.cell}>{assignments.length}/12</td><td style={styles.cell}><button style={styles.secondary} onClick={() => onOpen(meeting)}>进入会议汇总</button></td></tr>; })}{meetings.length === 0 && <tr><td colSpan={5} style={styles.empty}>暂无评审会</td></tr>}</tbody></table></div>; }

function MeetingSummary({ meeting, onBack, onOpenProject, onOpenReport }: any) {
  const [data, setData] = useState<any>(null); const [message, setMessage] = useState('');
  useEffect(() => { fetch(`/api/summary?meetingId=${meeting.id}&_=${Date.now()}`, { cache: 'no-store' }).then((response) => response.json()).then(setData).catch(() => setMessage('会议汇总读取失败')); }, [meeting.id]);
  const projects = [...(data?.projects || [])].filter((project: any) => project.name && project.submitter).sort((a: any, b: any) => b.totalScore - a.totalScore);
  return <div><div style={styles.toolbar}><div><button style={styles.secondary} onClick={onBack}>返回会议列表</button><h2 style={{ ...styles.h2, marginTop: 12 }}>{meeting.name}</h2></div><button style={styles.secondary} onClick={onOpenReport}>打开打印报告</button></div>{message && <div style={styles.notice}>{message}</div>}<div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['排名', '项目', '轮次', '总分', '完成度', 'Walker 结论', '问题与建议'].map((text) => <th style={styles.cell} key={text}>{text}</th>)}</tr></thead><tbody>{projects.map((project: any, index: number) => <tr key={project.id}><td style={styles.cell}>{index + 1}</td><td style={styles.cell}><button style={styles.link} onClick={() => onOpenProject({ id: project.pool_project_id, name: project.name, submitter: project.submitter })}>{project.name}</button></td><td style={styles.cell}>第 {project.round_no || 1} 轮 / 第 {project.attempt_no || 1} 次</td><td style={styles.cell}>{Number(project.totalScore || 0).toFixed(1)} / 100</td><td style={styles.cell}>{project.completionRate || 0}%</td><td style={styles.cell}>{({ approved: '通过', recheck: '重评', rejected: '驳回' } as any)[project.verdict] || '未定'}</td><td style={styles.cell}><div>{project.roundSummaries?.[project.currentRound]?.problemSummary || '—'}</div><div style={styles.subtle}>{project.roundSummaries?.[project.currentRound]?.actionSummary || ''}</div></td></tr>)}{projects.length === 0 && <tr><td colSpan={7} style={styles.empty}>本场评审会尚未安排项目</td></tr>}</tbody></table></div></div>;
}

function ProjectDrawer({ project, onClose, onSaved, onNotice }: any) {
  const [form, setForm] = useState({ name: project.name || '', submitter: project.submitter || '', description: project.description || '' });
  const [manualStatus, setManualStatus] = useState(project.status || 'materials_pending');
  const [manualNote, setManualNote] = useState('');
  const materials = new Map<string, any>((project.project_materials || []).map((material: any) => [material.item_key, material]));
  const saveProject = async () => { const response = await fetch('/api/project-pool', { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: project.id, ...form, operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '项目信息已保存。' : data.error || '保存失败'); if (response.ok) onSaved(project.id); };
  const saveMaterial = async (item: any, status: string) => { const response = await fetch(`/api/project-pool/${project.id}/materials`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_key: item.item_key, status, operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '资料检查已保存。' : data.error || '保存失败'); if (response.ok) onSaved(project.id); };
  const changeStatus = async () => { const response = await fetch(`/api/project-pool/${project.id}/status`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: manualStatus, note: manualNote, confirmed: true, operator_code: adminCode() }) }); const data = await response.json(); onNotice(response.ok ? '项目状态已人工调整。' : data.error || '调整失败'); if (response.ok) onSaved(project.id); };
  return <div style={styles.overlay}><aside style={styles.drawer}><button style={styles.secondary} onClick={onClose}>关闭</button><h2>{project.name}</h2><div style={styles.panel}><input style={styles.input} value={form.name} onChange={(event) => setForm({ ...form, name: event.target.value })}/><input style={styles.input} value={form.submitter} onChange={(event) => setForm({ ...form, submitter: event.target.value })}/><textarea style={styles.input} rows={3} value={form.description} onChange={(event) => setForm({ ...form, description: event.target.value })}/><button style={styles.primary} onClick={saveProject}>保存项目信息</button></div><h3>资料检查</h3>{MATERIAL_ITEMS.map((item) => <div key={item.item_key} style={styles.material}><span>{item.label}{item.required ? ' *' : ''}</span><select style={styles.select} value={materials.get(item.item_key)?.status || 'missing'} onChange={(event) => saveMaterial(item, event.target.value)}><option value="missing">缺失</option><option value="submitted">已提交</option><option value="approved">已通过</option><option value="needs_revision">需修改</option></select></div>)}<h3>人工调整状态</h3><div style={styles.panel}><select style={styles.select} value={manualStatus} onChange={(event) => setManualStatus(event.target.value)}>{['materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready', 'initiation', 'rejected'].map((status) => <option key={status} value={status}>{status}</option>)}</select><textarea style={styles.input} rows={2} placeholder="调整原因（必填）" value={manualNote} onChange={(event) => setManualNote(event.target.value)}/><button style={styles.secondary} onClick={changeStatus}>确认人工调整</button></div><h3>评审历史</h3>{(project.projects || []).map((assignment: any) => <div key={assignment.id} style={styles.assignment}>第 {assignment.round_no} 轮 / 第 {assignment.attempt_no} 次 · {assignment.meetings?.name || '评审会'} · {assignment.assignment_status}</div>)}</aside></div>;
}

const styles: Record<string, any> = { page: { maxWidth: 1280, margin: '0 auto', padding: '28px 22px', color: '#172033', fontFamily: 'Arial, sans-serif' }, header: { display: 'flex', justifyContent: 'space-between', gap: 16, alignItems: 'start', marginBottom: 22 }, h1: { margin: 0, fontSize: 25 }, h2: { margin: 0, fontSize: 18 }, h3: { margin: '20px 0 10px', fontSize: 15 }, subtle: { color: '#64748b', fontSize: 13, margin: '6px 0' }, tabs: { display: 'flex', gap: 4, borderBottom: '1px solid #d9e1ec', overflowX: 'auto' }, tab: { background: 'transparent', border: 'none', borderBottom: '3px solid transparent', padding: '10px 13px', color: '#536177', cursor: 'pointer', whiteSpace: 'nowrap' }, tabActive: { color: '#0f766e', borderBottomColor: '#0f766e', fontWeight: 700 }, toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, margin: '20px 0 14px' }, primary: { background: '#0f766e', color: '#fff', border: '1px solid #0f766e', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, panel: { display: 'grid', gap: 10, padding: 16, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff', marginBottom: 16 }, input: { width: '100%', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box', fontSize: 14 }, select: { padding: '8px', border: '1px solid #cbd5e1', borderRadius: 5 }, notice: { margin: '16px 0', padding: '10px 12px', background: '#ecfeff', color: '#155e75', border: '1px solid #a5f3fc', borderRadius: 6 }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e7edf5', verticalAlign: 'top' }, empty: { padding: 20, color: '#8591a5', textAlign: 'center' }, link: { border: 0, padding: 0, background: 'transparent', color: '#0f766e', cursor: 'pointer', fontWeight: 700, textAlign: 'left' }, resultGrid: { display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }, listButton: { display: 'flex', justifyContent: 'space-between', width: '100%', marginTop: 8, background: '#fff', border: '1px solid #d9e1ec', padding: 9, borderRadius: 5, cursor: 'pointer', textAlign: 'left' }, overlay: { position: 'fixed', inset: 0, zIndex: 20, background: 'rgba(15,23,42,.34)', display: 'flex', justifyContent: 'flex-end' }, drawer: { width: 560, maxWidth: '100%', background: '#fff', padding: 24, overflowY: 'auto' }, material: { display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #edf2f7' }, assignment: { padding: 9, background: '#f7fafc', marginBottom: 6, borderRadius: 4 } };
