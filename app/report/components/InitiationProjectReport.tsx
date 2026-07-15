type Report = Record<string, any>;

const verdictLabel = (value: string) => ({ approved: '通过', recheck: '待重评', rejected: '驳回' } as Record<string, string>)[value] || '未形成结论';
const score = (value: unknown) => Number(value || 0).toFixed(1);
const dateTime = (value: unknown) => value ? String(value).replace('T', ' ').slice(0, 16) : '-';

function dimensionRows(item: Report) {
  return Object.entries(item.dimTotals || {}).map(([name, value]: [string, any]) => ({
    name,
    score: Number(value?.score || 0),
    max: Number(value?.maxScore || value?.max || 0)
  }));
}

export default function InitiationProjectReport({ report }: { report: Report }) {
  const project = report?.project || {}; const history = report?.roundHistory || [];
  const finalEntry = history[history.length - 1];
  return <article style={styles.page}>
    <header style={styles.header}>
      <div><p style={styles.kicker}>PROJECT REVIEW DOSSIER</p><h1 style={styles.h1}>立项项目评审报告</h1><p style={styles.subtle}>{project.name || '-'} · 提报人：{project.submitter || '-'}</p></div>
      <div style={styles.statusBox}><span>当前状态</span><strong>{project.status || '-'}</strong><small>{finalEntry ? `最终结论：${verdictLabel(finalEntry.verdict)}` : '尚未形成最终结论'}</small></div>
    </header>
    <section style={styles.overview}><div><span>项目说明</span><p>{project.description || '未填写项目说明'}</p></div><div><span>完成评审</span><strong>{history.length} 次</strong></div><div><span>最终得分</span><strong>{finalEntry ? `${score(finalEntry.totalScore)} / ${finalEntry.totalMaxScore || 100}` : '-'}</strong></div><div><span>最终排名</span><strong>{finalEntry?.rank ? `第 ${finalEntry.rank} 名` : '-'}</strong></div></section>

    <section><h2 style={styles.h2}>评审决策总览</h2><div style={styles.tableWrap}><table style={styles.table}><thead><tr><th>轮次 / 次数</th><th>评审会与时间</th><th>评分与排名</th><th>完成度</th><th>Walker 结论</th><th>参与评委</th></tr></thead><tbody>{history.map((item: Report) => <tr key={item.id || `${item.round_no}-${item.attempt_no}`}><td>第 {item.round_no} 轮<br/><small>第 {item.attempt_no || 1} 次</small></td><td><strong>{item.meeting?.name || '-'}</strong><br/><small>{dateTime(item.meeting?.meeting_date)} · 截止 {dateTime(item.meeting?.deadline)}</small></td><td>{score(item.totalScore)} / {item.totalMaxScore || 100}<br/><small>{item.rank ? `本场第 ${item.rank} 名` : '排名以当场汇总为准'}</small></td><td>{item.completionRate || 0}%</td><td><strong>{verdictLabel(item.verdict)}</strong></td><td>{item.reviewerCount || 0} 人</td></tr>)}{!history.length && <tr><td colSpan={6} style={styles.empty}>暂无 Walker 已确认结论的评审记录。</td></tr>}</tbody></table></div></section>

    <section><h2 style={styles.h2}>单维度评分对比</h2><div style={styles.dimensionGrid}>{history.map((item: Report) => <div style={styles.dimensionCard} key={`dimensions-${item.id || item.round_no}`}><h3 style={styles.h3}>第 {item.round_no} 轮 / 第 {item.attempt_no || 1} 次</h3>{dimensionRows(item).map((dimension) => <div key={dimension.name} style={styles.dimension}><div style={styles.dimensionLine}><span>{dimension.name}</span><strong>{score(dimension.score)} / {dimension.max || '-'}</strong></div><div style={styles.track}><i style={{ ...styles.bar, width: `${dimension.max ? Math.min(100, dimension.score / dimension.max * 100) : 0}%` }} /></div></div>)}{!dimensionRows(item).length && <p style={styles.muted}>本轮没有可用的维度汇总。</p>}</div>)}</div></section>

    <section><h2 style={styles.h2}>问题与行动闭环</h2><div style={styles.issueGrid}>{history.map((item: Report) => <div style={styles.issueCard} key={`issues-${item.id || item.round_no}`}><h3 style={styles.h3}>第 {item.round_no} 轮 / {item.meeting?.name || '评审会'}</h3><div><strong>主要问题</strong><p>{item.problemSummary || '无'}</p></div><div><strong>改进行动</strong><p>{item.actionSummary || '无'}</p></div></div>)}</div></section>

    <section><h2 style={styles.h2}>评审会与评委明细</h2>{history.map((item: Report) => <div style={styles.meetingDetail} key={`meeting-${item.id || item.round_no}`}><div><strong>{item.meeting?.name || '-'}</strong><p style={styles.muted}>会议日期：{dateTime(item.meeting?.meeting_date)}　截止：{dateTime(item.meeting?.deadline)}</p><p style={styles.muted}>会议备注：{item.meeting?.notes || '无'}</p></div><p style={styles.reviewerText}>{(item.reviewers || []).map((reviewer: Report) => `${reviewer.name}${reviewer.role ? `（${reviewer.role}）` : ''} ${reviewer.scoresGiven || 0}/${reviewer.expectedScores || 0}`).join('　') || '未记录评委明细'}</p></div>)}</section>

    <section><h2 style={styles.h2}>项目状态时间线</h2><ol style={styles.timeline}>{(report?.timeline || []).map((item: Report, index: number) => <li key={`${item.created_at}-${index}`}><time>{dateTime(item.created_at)}</time><span>{item.note || item.to_status || item.event_type}</span></li>)}{!(report?.timeline || []).length && <li style={styles.muted}>暂无状态变更记录。</li>}</ol></section>
  </article>;
}

const styles: Record<string, React.CSSProperties> = {
  page: { maxWidth: 1100, margin: '0 auto', padding: 32, background: '#fff', color: '#172033', fontFamily: 'Arial, "Microsoft YaHei", sans-serif' }, header: { display: 'flex', justifyContent: 'space-between', gap: 24, alignItems: 'flex-start', borderBottom: '3px solid #0f766e', paddingBottom: 20, marginBottom: 18 }, kicker: { color: '#0f766e', fontSize: 12, fontWeight: 700, letterSpacing: 1, margin: '0 0 8px' }, h1: { margin: 0, fontSize: 30 }, h2: { fontSize: 18, margin: '28px 0 12px' }, h3: { fontSize: 14, margin: '0 0 12px' }, subtle: { color: '#52606d', margin: '8px 0 0' }, muted: { color: '#64748b', fontSize: 13 }, statusBox: { minWidth: 150, display: 'grid', gap: 5, padding: 14, border: '1px solid #b7d9d5', background: '#f0fdfa' }, overview: { display: 'grid', gridTemplateColumns: '2fr repeat(3, 1fr)', gap: 12 }, tableWrap: { border: '1px solid #d9e1ec', overflowX: 'auto' }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 13 }, empty: { padding: 18, textAlign: 'center', color: '#64748b' }, dimensionGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }, dimensionCard: { border: '1px solid #d9e1ec', padding: 16 }, dimension: { marginTop: 12 }, dimensionLine: { display: 'flex', justifyContent: 'space-between', gap: 8, fontSize: 13 }, track: { height: 7, background: '#e8eef3', marginTop: 6 }, bar: { display: 'block', height: '100%', background: '#0f766e' }, issueGrid: { display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }, issueCard: { borderLeft: '4px solid #0f766e', padding: '4px 14px', background: '#f8fafc' }, meetingDetail: { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 20, padding: 14, borderTop: '1px solid #d9e1ec' }, reviewerText: { margin: 0, fontSize: 13, lineHeight: 1.7 }, timeline: { display: 'grid', gap: 9, paddingLeft: 20 },
};
