'use client';

import { useState } from 'react';
import { formatArchiveBulkFeedback } from '@/lib/projectArchiveBulk';
import { projectStatusLabel } from '@/lib/projectPoolWorkflow';

type Project = Record<string, any>;
type ArchiveAction = 'restore' | 'request_purge' | 'restore_purge';
type ActionResult = { project: Project; ok: boolean; error?: string };

function adminCode() { try { return JSON.parse(localStorage.getItem('reviewer') || '{}').code || ''; } catch { return ''; } }
function purgeRequest(project: Project) { return Array.isArray(project.project_deletion_requests) ? project.project_deletion_requests[0] : project.project_deletion_requests; }
function recoveryText(project: Project) { const request = purgeRequest(project); if (!request?.purge_after) return ''; const remaining = Math.max(0, Math.ceil((new Date(request.purge_after).getTime() - Date.now()) / 86400000)); return `可恢复至 ${new Date(request.purge_after).toLocaleString('zh-CN')}（剩余 ${remaining} 天）`; }

function confirmationText(action: ArchiveAction, projects: Project[]) {
  const subject = projects.length === 1 ? `“${projects[0].name}”` : `所选 ${projects.length} 个项目`;
  if (action === 'restore') return `恢复${subject}到项目池？`;
  if (action === 'request_purge') return `将${subject}进入 15 天恢复期？期满后将由清理任务永久删除。`;
  return `撤销${subject}的清除请求并保留归档记录？`;
}

export default function ProjectArchivePanel({ archivedProjects, purgePendingProjects, onRefresh, onOpenProject }: { archivedProjects: Project[]; purgePendingProjects: Project[]; onRefresh: () => Promise<void> | void; onOpenProject: (project: Project) => void; }) {
  const [feedback, setFeedback] = useState('');
  const [busyIds, setBusyIds] = useState<string[]>([]);
  const [archivedSelectedIds, setArchivedSelectedIds] = useState<string[]>([]);
  const [purgeSelectedIds, setPurgeSelectedIds] = useState<string[]>([]);
  const isBusy = busyIds.length > 0;

  const requestAction = async (project: Project, action: ArchiveAction) => {
    const response = await fetch('/api/project-pool/archive', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: project.id, action, operator_code: adminCode() })
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || '归档操作失败');
  };

  const runAction = async (projects: Project[], action: ArchiveAction) => {
    if (!projects.length || isBusy || !window.confirm(confirmationText(action, projects))) return;
    setBusyIds(projects.map((project) => project.id));
    const results = await Promise.all(projects.map(async (project): Promise<ActionResult> => {
      try {
        await requestAction(project, action);
        return { project, ok: true };
      } catch (error: any) {
        return { project, ok: false, error: error.message || '归档操作失败' };
      }
    }));
    const summary = formatArchiveBulkFeedback(action, results);
    setArchivedSelectedIds([]);
    setPurgeSelectedIds([]);
    try {
      await onRefresh();
      setFeedback(summary);
    } catch (error: any) {
      setFeedback(`${summary}\n列表刷新失败：${error.message || '请稍后重试'}`);
    } finally {
      setBusyIds([]);
    }
  };

  const toggleSelection = (id: string, setSelected: React.Dispatch<React.SetStateAction<string[]>>) => setSelected((selected) => selected.includes(id) ? selected.filter((selectedId) => selectedId !== id) : [...selected, id]);
  const toggleAll = (projects: Project[], selectedIds: string[], setSelected: React.Dispatch<React.SetStateAction<string[]>>) => setSelected(projects.length > 0 && projects.every((project) => selectedIds.includes(project.id)) ? [] : projects.map((project) => project.id));
  const selectedProjects = (projects: Project[], selectedIds: string[]) => projects.filter((project) => selectedIds.includes(project.id));

  return <section>
    {feedback && <div role="status" style={styles.feedback}>{feedback}</div>}
    <div style={styles.section}>
      <h2 style={styles.heading}>已归档项目</h2>
      <p style={styles.muted}>归档项目可以恢复。发起清除后会进入 15 天恢复期。</p>
      <ProjectList
        projects={archivedProjects}
        selectedIds={archivedSelectedIds}
        busyIds={busyIds}
        isBusy={isBusy}
        onOpenProject={onOpenProject}
        onToggle={(id) => toggleSelection(id, setArchivedSelectedIds)}
        onToggleAll={() => toggleAll(archivedProjects, archivedSelectedIds, setArchivedSelectedIds)}
        bulkActions={<><button type="button" style={styles.secondary} disabled={isBusy || !archivedSelectedIds.length} onClick={() => runAction(selectedProjects(archivedProjects, archivedSelectedIds), 'restore')}>批量恢复</button><button type="button" style={styles.danger} disabled={isBusy || !archivedSelectedIds.length} onClick={() => runAction(selectedProjects(archivedProjects, archivedSelectedIds), 'request_purge')}>批量发起清除</button></>}
        actions={(project) => <><button type="button" style={styles.secondary} disabled={isBusy} onClick={() => runAction([project], 'restore')}>恢复项目</button><button type="button" style={styles.danger} disabled={isBusy} onClick={() => runAction([project], 'request_purge')}>发起清除</button></>}
      />
    </div>
    <div style={styles.section}>
      <h2 style={styles.heading}>15 天恢复期</h2>
      <p style={styles.muted}>在到期前撤销清除请求，项目会继续保留在归档区。</p>
      <ProjectList
        projects={purgePendingProjects}
        selectedIds={purgeSelectedIds}
        busyIds={busyIds}
        isBusy={isBusy}
        onOpenProject={onOpenProject}
        onToggle={(id) => toggleSelection(id, setPurgeSelectedIds)}
        onToggleAll={() => toggleAll(purgePendingProjects, purgeSelectedIds, setPurgeSelectedIds)}
        recoveryText={recoveryText}
        bulkActions={<button type="button" style={styles.secondary} disabled={isBusy || !purgeSelectedIds.length} onClick={() => runAction(selectedProjects(purgePendingProjects, purgeSelectedIds), 'restore_purge')}>批量撤销清除请求</button>}
        actions={(project) => <button type="button" style={styles.secondary} disabled={isBusy} onClick={() => runAction([project], 'restore_purge')}>撤销清除请求</button>}
      />
    </div>
  </section>;
}

function ProjectList({ projects, selectedIds, busyIds, isBusy, onOpenProject, onToggle, onToggleAll, actions, bulkActions, recoveryText: getRecoveryText }: { projects: Project[]; selectedIds: string[]; busyIds: string[]; isBusy: boolean; onOpenProject: (project: Project) => void; onToggle: (id: string) => void; onToggleAll: () => void; actions: (project: Project) => React.ReactNode; bulkActions: React.ReactNode; recoveryText?: (project: Project) => string; }) {
  const allSelected = projects.length > 0 && projects.every((project) => selectedIds.includes(project.id));
  return <><div style={styles.bulkBar}><span style={styles.muted}>已选择 {selectedIds.length} 个项目</span>{bulkActions}</div><div style={styles.tableWrap}><table style={styles.table}><thead><tr><th style={styles.cell}><input aria-label="全选当前项目" type="checkbox" checked={allSelected} disabled={isBusy || !projects.length} onChange={onToggleAll}/></th><th style={styles.cell}>项目</th><th style={styles.cell}>提报人</th><th style={styles.cell}>归档状态</th><th style={styles.cell}>操作</th></tr></thead><tbody>{projects.map((project) => <tr key={project.id}><td style={styles.cell}><input aria-label={`选择${project.name}`} type="checkbox" checked={selectedIds.includes(project.id)} disabled={isBusy} onChange={() => onToggle(project.id)}/></td><td style={styles.cell}><button type="button" style={styles.link} onClick={() => onOpenProject(project)}>{project.name}</button></td><td style={styles.cell}>{project.submitter}</td><td style={styles.cell}><div>{projectStatusLabel(project.status)}</div>{getRecoveryText?.(project) && <small style={styles.muted}>{getRecoveryText(project)}</small>}</td><td style={styles.cell}><div style={styles.actions}>{busyIds.includes(project.id) ? <span style={styles.muted}>处理中...</span> : actions(project)}</div></td></tr>)}{!projects.length && <tr><td colSpan={5} style={styles.empty}>暂无项目</td></tr>}</tbody></table></div></>;
}

const styles: Record<string, React.CSSProperties> = { section: { marginTop: 20 }, heading: { margin: '0 0 6px', fontSize: 18 }, muted: { color: '#64748b', fontSize: 13 }, feedback: { margin: '16px 0', padding: '9px 11px', color: '#155e75', background: '#ecfeff', border: '1px solid #a5f3fc', borderRadius: 5, whiteSpace: 'pre-wrap' }, bulkBar: { display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 7, margin: '12px 0' }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', borderBottom: '1px solid #e7edf5', verticalAlign: 'top' }, empty: { padding: 20, color: '#8591a5', textAlign: 'center' }, link: { border: 0, padding: 0, background: 'transparent', color: '#0f766e', cursor: 'pointer', fontWeight: 700, textAlign: 'left' }, actions: { display: 'flex', flexWrap: 'wrap', gap: 7 }, secondary: { background: '#fff', color: '#334155', border: '1px solid #cbd5e1', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, danger: { background: '#fff', color: '#b42318', border: '1px solid #f3b1ab', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' } };
