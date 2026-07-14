'use client';

import { useEffect, useMemo, useState, type CSSProperties } from 'react';
import { useRouter } from 'next/navigation';
import { MATERIAL_ITEMS } from '@/lib/projectPoolWorkflow';

type PoolProject = any;
type Meeting = { id: string; name: string; meeting_date: string; deadline?: string | null; status: string };

const tabs = [
  ['pending', '待评审项目池'], ['meetings', '评审会管理'], ['reports', '结论与报告'], ['reviewed', '已评审项目池'], ['results', '结果池']
] as const;

function adminCode() {
  try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; }
}

export default function V2AdminPage() {
  const router = useRouter();
  const [tab, setTab] = useState<(typeof tabs)[number][0]>('pending');
  const [projects, setProjects] = useState<PoolProject[]>([]);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [selected, setSelected] = useState<PoolProject | null>(null);
  const [notice, setNotice] = useState('');
  const [creating, setCreating] = useState(false);
  const [form, setForm] = useState({ name: '', submitter: '', description: '' });
  const [newMeeting, setNewMeeting] = useState({ name: '', meeting_date: '', deadline: '' });

  const load = async () => {
    const [poolRes, meetingRes] = await Promise.all([fetch('/api/project-pool?scope=all', { cache: 'no-store' }), fetch('/api/meetings', { cache: 'no-store' })]);
    const pool = await poolRes.json(); const meeting = await meetingRes.json();
    if (poolRes.ok) setProjects(pool.projects || []); else setNotice(pool.error || '读取项目池失败');
    if (meetingRes.ok) setMeetings((meeting.meetings || []).filter((m: any) => !m.deleted_at));
  };

  useEffect(() => {
    const stored = localStorage.getItem('reviewer');
    if (!stored) { router.push('/'); return; }
    if (!JSON.parse(stored).is_admin) { router.push('/scoring'); return; }
    load();
  }, []);

  const pending = useMemo(() => projects.filter((p) => ['draft', 'materials_pending', 'ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready'].includes(p.status)), [projects]);
  const reviewed = useMemo(() => projects.filter((p) => p.latest_verdict), [projects]);
  const result = useMemo(() => projects.filter((p) => tab === 'results' ? Boolean(p.latest_verdict) : true), [projects, tab]);

  const createProject = async () => {
    const res = await fetch('/api/project-pool', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, operator_code: adminCode() }) });
    const data = await res.json();
    setNotice(res.ok ? '项目已建立，请完成资料检查。' : data.error || '创建失败');
    if (res.ok) { setForm({ name: '', submitter: '', description: '' }); setCreating(false); await load(); }
  };

  const saveMaterial = async (item: any, status: string) => {
    if (!selected) return;
    const res = await fetch(`/api/project-pool/${selected.id}/materials`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ item_key: item.item_key, status, operator_code: adminCode() }) });
    const data = await res.json(); setNotice(res.ok ? '资料检查已保存。' : data.error || '保存失败');
    if (res.ok) { await load(); const fresh = (await (await fetch('/api/project-pool?scope=all')).json()).projects.find((p: any) => p.id === selected.id); setSelected(fresh || null); }
  };

  const schedule = async (project: PoolProject, meetingId: string, round: number) => {
    const res = await fetch('/api/meeting-assignments', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ meeting_id: meetingId, pool_project_id: project.id, round_no: round, operator_code: adminCode() }) });
    const data = await res.json(); setNotice(res.ok ? '项目已安排入会。' : data.error || '安排失败'); if (res.ok) await load();
  };

  const createMeeting = async () => {
    const res = await fetch('/api/meetings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(newMeeting) });
    const data = await res.json(); setNotice(res.ok ? '评审会已创建，可从项目池安排项目。' : data.error || '创建失败'); if (res.ok) { setNewMeeting({ name: '', meeting_date: '', deadline: '' }); await load(); }
  };

  const visible = tab === 'pending' ? pending : tab === 'reviewed' ? reviewed : tab === 'results' ? result : projects;
  return <main style={{ maxWidth: 1280, margin: '0 auto', padding: '28px 22px', color: '#172033', fontFamily: 'Arial, sans-serif' }}>
    <header style={{ display: 'flex', alignItems: 'end', justifyContent: 'space-between', gap: 20, marginBottom: 22 }}><div><h1 style={{ margin: 0, fontSize: 25 }}>立项评审管理</h1><p style={{ margin: '6px 0 0', color: '#627089', fontSize: 14 }}>项目池为主档，评审会承载独立轮次评分。</p></div><button onClick={() => { localStorage.removeItem('reviewer'); router.push('/'); }} style={button('#f1f5f9', '#334155')}>退出</button></header>
    <nav style={{ display: 'flex', gap: 4, borderBottom: '1px solid #d9e1ec', overflowX: 'auto' }}>{tabs.map(([id, label]) => <button key={id} onClick={() => setTab(id)} style={{ ...button(tab === id ? '#ffffff' : 'transparent', tab === id ? '#155e75' : '#536177'), border: 'none', borderBottom: tab === id ? '3px solid #0e7490' : '3px solid transparent', borderRadius: 0 }}>{label}</button>)}</nav>
    {notice && <div style={{ margin: '16px 0', padding: '10px 12px', background: '#ecfeff', color: '#155e75', border: '1px solid #a5f3fc', borderRadius: 6, fontSize: 14 }}>{notice}</div>}
    {tab === 'pending' && <section><div style={{ display: 'flex', justifyContent: 'space-between', margin: '18px 0' }}><h2 style={heading}>待评审项目 ({pending.length})</h2><button onClick={() => setCreating(!creating)} style={button('#0f766e', '#fff')}>新建项目</button></div>{creating && <div style={panel}><input placeholder="项目名称" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} style={input}/><input placeholder="提报人" value={form.submitter} onChange={(e) => setForm({ ...form, submitter: e.target.value })} style={input}/><textarea placeholder="项目说明" value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} style={{ ...input, minHeight: 76 }}/><button onClick={createProject} style={button('#0f766e', '#fff')}>建立并进入资料检查</button></div>}<ProjectTable projects={visible} meetings={meetings} onSelect={setSelected} onSchedule={schedule}/></section>}
    {tab === 'meetings' && <section><h2 style={{ ...heading, marginTop: 20 }}>评审会管理</h2><div style={panel}><input placeholder="评审会名称" value={newMeeting.name} onChange={(e) => setNewMeeting({ ...newMeeting, name: e.target.value })} style={input}/><input type="date" value={newMeeting.meeting_date} onChange={(e) => setNewMeeting({ ...newMeeting, meeting_date: e.target.value })} style={input}/><input type="datetime-local" value={newMeeting.deadline} onChange={(e) => setNewMeeting({ ...newMeeting, deadline: e.target.value })} style={input}/><button onClick={createMeeting} style={button('#0f766e', '#fff')}>创建评审会</button></div><ProjectTable projects={projects} meetings={meetings} onSelect={setSelected} onSchedule={schedule}/></section>}
    {tab === 'reports' && <section><h2 style={{ ...heading, marginTop: 20 }}>结论与报告</h2><p style={{ color: '#627089' }}>选择具体评审会后，报告页会按本轮独立 100 分排序；项目池会同步保留 Walker 结论、问题与改进建议。</p><select style={input} onChange={(e) => e.target.value && router.push(`/report?meetingId=${e.target.value}`)}><option value="">打开一场评审会报告</option>{meetings.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></section>}
    {tab === 'reviewed' && <section><h2 style={{ ...heading, marginTop: 20 }}>已评审项目池 ({reviewed.length})</h2><ProjectTable projects={reviewed} meetings={meetings} onSelect={setSelected} onSchedule={schedule}/></section>}
    {tab === 'results' && <section><h2 style={{ ...heading, marginTop: 20 }}>结果池</h2><div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))', gap: 12 }}>{['approved', 'recheck', 'rejected'].map((bucket) => <div key={bucket} style={panel}><strong>{({ approved: '通过项目', recheck: '待重评项目', rejected: '驳回项目' } as any)[bucket]}</strong>{projects.filter((p) => p.latest_verdict === bucket).map((p) => <button key={p.id} onClick={() => setSelected(p)} style={{ ...button('#fff', '#334155'), width: '100%', textAlign: 'left', marginTop: 8 }}>{p.name} · {p.status}</button>) || null}</div>)}</div></section>}
    {selected && <ProjectDrawer project={selected} meetings={meetings} onClose={() => setSelected(null)} onSaveMaterial={saveMaterial} onSchedule={schedule}/>}
  </main>;
}

function ProjectTable({ projects, meetings, onSelect, onSchedule }: any) { return <div style={{ overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }}><table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 14 }}><thead><tr style={{ background: '#f7fafc', textAlign: 'left' }}>{['项目', '提报人', '资料', '当前状态', '轮次', '安排'].map((x) => <th key={x} style={cell}>{x}</th>)}</tr></thead><tbody>{projects.map((p: any) => <tr key={p.id} style={{ borderTop: '1px solid #e7edf5' }}><td style={cell}><button onClick={() => onSelect(p)} style={{ border: 0, background: 'transparent', padding: 0, color: '#0f766e', cursor: 'pointer', fontWeight: 700 }}>{p.name}</button></td><td style={cell}>{p.submitter}</td><td style={cell}>{p.material_status === 'complete' ? '资料齐全' : '待补充'}</td><td style={cell}>{p.status}</td><td style={cell}>{p.current_round ? `第 ${p.current_round} 轮 / 第 ${p.current_attempt || 1} 次` : '-'}</td><td style={cell}>{['ready_r1', 'r1_recheck_ready', 'ready_r2', 'r2_recheck_ready'].includes(p.status) && meetings.length ? <select defaultValue="" onChange={(e) => { const [meetingId, round] = e.target.value.split('|'); if (meetingId) onSchedule(p, meetingId, Number(round)); }} style={{ padding: 6 }}><option value="">安排入会</option>{meetings.filter((m: any) => m.status === 'active').map((m: any) => <option key={m.id} value={`${m.id}|${p.status.includes('r2') || p.status === 'ready_r2' ? 2 : 1}`}>{m.name}</option>)}</select> : '-'}</td></tr>)}{projects.length === 0 && <tr><td colSpan={6} style={{ ...cell, color: '#8591a5' }}>暂无项目</td></tr>}</tbody></table></div>; }

function ProjectDrawer({ project, meetings, onClose, onSaveMaterial, onSchedule }: any) { const materials = new Map<string, any>((project.project_materials || []).map((m: any) => [m.item_key, m] as [string, any])); return <div style={{ position: 'fixed', inset: 0, background: 'rgba(15,23,42,.34)', display: 'flex', justifyContent: 'flex-end', zIndex: 10 }}><aside style={{ width: 520, maxWidth: '100%', background: '#fff', padding: 24, overflowY: 'auto' }}><button onClick={onClose} style={button('#f1f5f9', '#334155')}>关闭</button><h2 style={{ marginBottom: 4 }}>{project.name}</h2><p style={{ color: '#627089' }}>{project.submitter}</p><p style={{ whiteSpace: 'pre-wrap' }}>{project.description || '暂无说明'}</p><h3>资料检查</h3>{MATERIAL_ITEMS.map((item) => { const material = materials.get(item.item_key); return <div key={item.item_key} style={{ display: 'grid', gridTemplateColumns: '1fr 130px', gap: 10, alignItems: 'center', padding: '10px 0', borderBottom: '1px solid #edf2f7' }}><span>{item.label}{item.required ? ' *' : ''}</span><select value={material?.status || 'missing'} onChange={(e) => onSaveMaterial(item, e.target.value)} style={{ padding: 7 }}><option value="missing">缺失</option><option value="submitted">已提交</option><option value="approved">已通过</option><option value="needs_revision">需修改</option></select></div>; })}<h3>评审历史</h3>{(project.projects || []).map((a: any) => <div key={a.id} style={{ padding: 9, background: '#f7fafc', marginBottom: 6 }}>第 {a.round_no} 轮 / 第 {a.attempt_no} 次 · {a.meetings?.name || '评审会'} · {a.assignment_status}</div>)}</aside></div>; }

const heading: CSSProperties = { margin: 0, fontSize: 18 };
const panel: CSSProperties = { display: 'grid', gap: 10, padding: 16, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff', marginBottom: 16 };
const input: CSSProperties = { width: '100%', padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, boxSizing: 'border-box', fontSize: 14 };
const cell: CSSProperties = { padding: '11px 12px', verticalAlign: 'middle' };
function button(background: string, color: string) { return { background, color, border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, fontSize: 13, cursor: 'pointer' } as any; }
