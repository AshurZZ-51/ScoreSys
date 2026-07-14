import { Details, reportStyles } from './RoundOneReport';

export default function InitiationProjectReport({ report }: { report: Record<string, any> }) {
  const project = report?.project || {}; const history = report?.roundHistory || [];
  return <article style={reportStyles.page}><header style={reportStyles.header}><h1 style={reportStyles.h1}>立项项目报告</h1><p style={reportStyles.subtle}>{project.name} · {project.submitter}</p><p style={reportStyles.subtle}>{project.description || '无项目说明'}</p></header>
    <h2 style={reportStyles.h2}>两轮已完成评审历史</h2><table style={reportStyles.table}><thead><tr><th>轮次</th><th>评审会</th><th>总分</th><th>Walker 结论</th></tr></thead><tbody>{history.map((item: any) => <tr key={item.id}><td>第 {item.round_no} 轮</td><td>{item.meeting?.name || '-'}</td><td>{Number(item.totalScore || 0).toFixed(1)} / {item.totalMaxScore || 100}</td><td>{item.verdict === 'approved' ? '通过' : item.verdict === 'recheck' ? '重评' : '驳回'}</td></tr>)}{!history.length && <tr><td colSpan={4} style={reportStyles.empty}>暂无已完成的两轮评审历史。</td></tr>}</tbody></table>
    <Details projects={history}/><h2 style={reportStyles.h2}>状态时间线</h2><ol>{(report?.timeline || []).map((item: any, index: number) => <li key={`${item.created_at}-${index}`}>{String(item.created_at || '').replace('T', ' ').slice(0, 16)} · {item.event_type} · {item.note || item.to_status || ''}</li>)}</ol>
  </article>;
}
