'use client';

import { useState } from 'react';
import { projectStatusLabel } from '@/lib/projectPoolWorkflow';

type Project = Record<string, any>;
function adminCode() { try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; } }
function purgeRequest(project: Project) { return Array.isArray(project.project_deletion_requests) ? project.project_deletion_requests[0] : project.project_deletion_requests; }
function recoveryText(project: Project) { const request = purgeRequest(project); if (!request?.purge_after) return ''; const remaining = Math.max(0, Math.ceil((new Date(request.purge_after).getTime() - Date.now()) / 86400000)); return `可恢复至 ${new Date(request.purge_after).toLocaleString('zh-CN')}（剩余 ${remaining} 天）`; }

export default function ProjectArchivePanel({ archivedProjects, purgePendingProjects, onRefresh, onOpenProject }: { archivedProjects: Project[]; purgePendingProjects: Project[]; onRefresh: () => Promise<void> | void; onOpenProject: (project: Project) => void; }) {
  const [feedback, setFeedback] = useState('');
  const [busyId, setBusyId] = useState('');
  const action = async (project: Project, nextAction: 'restore' | 'request_purge' | 'restore_purge', confirmation: string) => {
    if (!window.confirm(confirmation)) return;
    setBusyId(project.id);
    try {
      const response = await fetch('/api/project-pool/archive', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ id: project.id, action: nextAction, operator_code: adminCode() }) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '归档操作失败');
      setFeedback(nextAction === 'restore' ? '项目已从归档恢复。' : nextAction === 'request_purge' ? '已进入 15 天恢复期。' : '已撤销清除请求，项目保留在归档区。');
      await onRefresh();
    } catch (error: any) { setFeedback(error.message || '归档操作失败'); } finally { setBusyId(''); }
  };
  return <section>{feedback && <div role="status" style={styles.feedback}>{feedback}</div>}<div style={styles.section}><h2 style={styles.heading}>已归档项目</h2><p style={styles.muted}>归档项目可以恢复。发起清除后会进入 15 天恢复期。</p><ProjectList projects={archivedProjects} busyId={busyId} onOpenProject={onOpenProject} actions={(project) => <><button type="button" style={styles.secondary} disabled={Boolean(busyId)} onClick={() => action(project, 'restore', `恢复“${project.name}”到项目池？`)}>恢复项目</button><button type="button" style={styles.danger} disabled={Boolean(busyId)} onClick={() => action(project, 'request_purge', `将“${project.name}”进入 15 天恢复期？期满后将由清理任务永久删除。`)}>发起清除</button></>} /></div><div style={styles.section}><h2 style={styles.heading}>15 天恢复期</h2><p style={styles.muted}>在到期前撤销清除请求，项目会继续保留在归档区。</p><ProjectList projects={purgePendingProjects} busyId={busyId} onOpenProject={onOpenProject} recoveryText={recoveryText} actions={(project) => <button type="button" style={styles.secondary} disabled={Boolean(busyId)} onClick={() => action(project, 'restore_purge', `撤销“${project.name}”的清除请求并保留归档记录？`)}>撤销清除请求</button>} /></div></section>;
}

function ProjectList({ projects, busyId, onOpenProject, actions, recoveryText: getRecoveryText }: { projects: Project[]; busyId: string; onOpenProject: (project: Project) => void; actions: (project: Project) => React.ReactNode; recoveryText?: (project: Project) => string; }) {
  return <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['项目', '提报人', '归档状态', '操作'].map((label) => <th key={label} style={styles.cell}>{label}</th>)}</tr></thead><tbody>{projects.map((project) => <tr key={project.id}><td style={styles.cell}><button type="button" style={styles.link} onClick={() => onOpenProject(project)}>{project.name}</button></td><td style={styles.cell}>{project.submitter}</td><td style={styles.cell}><div>{projectStatusLabel(project.status)}</div>{getRecoveryText?.(project) && <small style={styles.muted}>{getRecoveryText(project)}</small>}</td><td style={styles.cell}><div style={styles.actions}>{busyId === project.id ? <span style={styles.muted}>处理中…</span> : actions(project)}</div></td></tr>)}{!projects.length && <tr><td colSpan={4} style={styles.empty}>暂无项目</td></tr>}</tbody></table></div>;
}

const styles: Record<string, React.CSSProperties> = { section: { marginTop: 20 }, heading: { margin: '0 0 6px', fontSize: 18 }, muted: { color: '#64748b', fontSize: 13 }, feedback: { margin: '16px 0', padding: '9px 11px', color: '#155e75', background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 5 }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e7edf5', verticalAlign: 'top' }, empty: { padding: 20, color: '#8591a5', textAlign: 'center' }, link: { border: 0, padding: 0, background: 'transparent', color: '#0f766e', cursor: 'pointer', fontWeight: 700, textAlign: 'left' }, actions: { display: 'flex', flexWrap: 'wrap', gap: 7 }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' } };
