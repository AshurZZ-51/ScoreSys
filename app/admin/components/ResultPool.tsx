'use client';

import { projectStatusLabel } from '@/lib/projectPoolWorkflow';

type Item = Record<string, any>;

const sections = [
  { key: 'approved', label: '通过/已通过', matches: (project: Item) => project.latest_verdict === 'approved', open: true },
  { key: 'recheck', label: '待复评', matches: (project: Item) => project.latest_verdict === 'recheck', open: false },
  { key: 'rejected', label: '已驳回', matches: (project: Item) => project.latest_verdict === 'rejected', open: false },
  { key: 'history', label: '历史/待整理', matches: (project: Item) => (project.projects || []).length > 0 && !project.latest_verdict, open: false }
];

export default function ResultPool({ projects, onOpenProject }: { projects: Item[]; onOpenProject: (project: Item) => void }) {
  return <div style={styles.list}>{sections.map((section) => {
    const items = projects.filter(section.matches);
    return <details key={section.key} open={section.open} style={styles.section}><summary style={styles.summary}><span>{section.label}</span><strong style={styles.count}>{items.length}</strong></summary><div style={styles.content}>{items.map((project) => <button key={project.id} type="button" style={styles.project} onClick={() => onOpenProject(project)}><span>{project.name}</span><span style={styles.status}>{projectStatusLabel(project.status)}</span></button>)}{!items.length && <p style={styles.empty}>暂无项目</p>}</div></details>;
  })}</div>;
}

const styles: Record<string, React.CSSProperties> = {
  list: { display: 'grid', gap: 10 }, section: { border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff' }, summary: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12, padding: '12px 14px', cursor: 'pointer', color: '#172033', fontWeight: 700 }, count: { minWidth: 28, padding: '2px 7px', borderRadius: 12, background: '#e2e8f0', color: '#334155', fontSize: 13, textAlign: 'center' }, content: { display: 'grid', gap: 8, padding: '0 14px 14px' }, project: { display: 'flex', justifyContent: 'space-between', gap: 12, width: '100%', padding: 10, border: '1px solid #d9e1ec', borderRadius: 5, background: '#fff', color: '#172033', cursor: 'pointer', textAlign: 'left' }, status: { color: '#64748b', fontSize: 13, whiteSpace: 'nowrap' }, empty: { margin: 0, padding: '6px 0', color: '#64748b', fontSize: 13 }
};
