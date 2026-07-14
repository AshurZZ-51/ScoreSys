type Report = Record<string, any>;

export default function RoundOneReport({ report }: { report: Report }) {
  return <ReportTable title="第一轮评审报告" subtitle="游戏性与创新性评审" report={report} dimensions={['游戏性', '创新性']} />;
}

export function ReportTable({ title, subtitle, report, dimensions }: { title: string; subtitle: string; report: Report; dimensions: string[] }) {
  const projects = report?.projects || [];
  return <article style={styles.page}><header style={styles.header}><h1 style={styles.h1}>{title}</h1><p style={styles.subtle}>{subtitle}</p><p style={styles.subtle}>{report?.meeting?.name} · {report?.meeting?.meeting_date || '未设置日期'}</p></header>
    <table style={styles.table}><thead><tr><th>排名</th><th>项目</th><th>总分</th>{dimensions.map((name) => <th key={name}>{name}</th>)}<th>完成度</th><th>Walker 结论</th></tr></thead><tbody>{projects.map((project: any) => <tr key={project.id}><td>{project.rank || '-'}</td><td><strong>{project.name}</strong><br/><small>{project.submitter}</small></td><td>{Number(project.totalScore || 0).toFixed(1)} / {project.totalMaxScore || 100}</td>{dimensions.map((name) => <td key={name}>{Number(project.dimTotals?.[name]?.score || 0).toFixed(1)} / {project.dimTotals?.[name]?.maxScore || 0}</td>)}<td>{project.completionRate || 0}%</td><td>{verdictLabel(project.verdict)}</td></tr>)}{!projects.length && <tr><td colSpan={dimensions.length + 5} style={styles.empty}>本轮没有已完成 Walker 结论的项目。</td></tr>}</tbody></table>
    <Details projects={projects}/><ReviewerCompletion reviewers={report?.reviewers || []}/>
  </article>;
}

export function Details({ projects }: { projects: any[] }) { return <section style={styles.details}>{projects.map((project) => <div key={project.id} style={styles.detail}><h2 style={styles.h2}>{project.name}：问题与建议</h2><p><strong>问题：</strong>{project.problemSummary || flatten(project.reviewerProblems) || '无'}</p><p><strong>建议：</strong>{project.actionSummary || flatten(project.reviewerActions) || '无'}</p></div>)}</section>; }
export function ReviewerCompletion({ reviewers }: { reviewers: any[] }) { return <section><h2 style={styles.h2}>评委完成情况</h2><table style={styles.table}><thead><tr><th>评委</th><th>角色</th><th>已填写</th><th>应填写</th></tr></thead><tbody>{reviewers.filter((reviewer) => !reviewer.is_admin).map((reviewer) => <tr key={reviewer.code}><td>{reviewer.name || reviewer.code}</td><td>{reviewer.role || '-'}</td><td>{reviewer.scoresGiven || 0}</td><td>{reviewer.expectedScores || 0}</td></tr>)}</tbody></table></section>; }
function flatten(entries: any[]) { return (entries || []).flatMap((entry) => entry.problems || entry.actions || []).join('；'); }
function verdictLabel(verdict: string) { return ({ approved: '通过', recheck: '重评', rejected: '驳回' } as Record<string, string>)[verdict] || '待结论'; }
const styles: Record<string, React.CSSProperties> = { page: { maxWidth: 1040, margin: '0 auto', padding: 28, background: '#fff', color: '#172033', fontFamily: 'Arial, "Microsoft YaHei", sans-serif' }, header: { borderBottom: '2px solid #0f766e', marginBottom: 20 }, h1: { margin: '0 0 8px', fontSize: 28 }, h2: { fontSize: 16, margin: '18px 0 8px' }, subtle: { margin: '4px 0', color: '#52606d' }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }, empty: { padding: 18, color: '#64748b', textAlign: 'center' }, details: { display: 'grid', gap: 10, marginTop: 14 }, detail: { borderTop: '1px solid #d9e1ec' } };
export const reportStyles = styles;
