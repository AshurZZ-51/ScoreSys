'use client';

import { useEffect, useMemo, useState } from 'react';

type Item = Record<string, any>;
type Snapshot = { id: string; version: number; generated_at?: string };

const verdictLabels: Record<string, string> = {
  approved: '通过',
  recheck: '待复评',
  rejected: '驳回'
};

export default function LiveReportPanel({ meeting }: { meeting: Item }) {
  const [summary, setSummary] = useState<Item | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [creatingSnapshot, setCreatingSnapshot] = useState(false);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null);

  useEffect(() => {
    let active = true;
    const load = async (silent = false) => {
      if (!silent) setLoading(true);
      try {
        const response = await fetch(`/api/summary?meetingId=${encodeURIComponent(meeting.id)}&_=${Date.now()}`, { cache: 'no-store' });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || '无法读取实时报告数据');
        if (active) {
          setSummary(data);
          setError('');
        }
      } catch (reason: any) {
        if (active) setError(reason.message || '无法读取实时报告数据');
      } finally {
        if (active && !silent) setLoading(false);
      }
    };

    load();
    const interval = window.setInterval(() => load(true), 10000);
    return () => {
      active = false;
      window.clearInterval(interval);
    };
  }, [meeting.id]);

  const projects = useMemo(() => [...(summary?.projects || [])]
    .filter((project: Item) => project.name && project.submitter)
    .sort((left: Item, right: Item) => Number(right.totalScore || 0) - Number(left.totalScore || 0)), [summary]);
  const roundNo = useMemo(() => Number(projects.find((project: Item) => Number(project.round_no) === 2)?.round_no || projects[0]?.round_no || 1), [projects]);
  const reportType = roundNo === 2 ? 'round_2' : 'round_1';
  const stats = useMemo(() => {
    const counts = { approved: 0, recheck: 0, rejected: 0, pending: 0 };
    projects.forEach((project: Item) => {
      const verdict = project.walkerVerdict || project.verdict;
      if (verdict === 'approved' || verdict === 'recheck' || verdict === 'rejected') counts[verdict] += 1;
      else counts.pending += 1;
    });
    return counts;
  }, [projects]);

  const createSnapshot = async () => {
    setCreatingSnapshot(true);
    setError('');
    try {
      const response = await fetch('/api/reports', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope_type: 'meeting', scope_id: meeting.id, report_type: reportType })
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || '生成报告快照失败');
      setSnapshot(data.snapshot);
      window.open(`/report?meetingId=${encodeURIComponent(meeting.id)}&fromAdmin=true`, '_blank', 'noopener,noreferrer');
    } catch (reason: any) {
      setError(reason.message || '生成报告快照失败');
    } finally {
      setCreatingSnapshot(false);
    }
  };

  return <div style={styles.section}>
    <div style={styles.heading}><div><h3 style={styles.title}>{meeting.name}</h3><p style={styles.help}>实时数据每 10 秒更新一次</p></div><span style={styles.round}>第 {roundNo} 轮评审</span></div>
    {error && <p style={styles.error}>{error}</p>}
    {loading ? <div style={styles.empty}>正在读取实时评审数据...</div> : <>
      <div style={styles.stats}>
        <Stat label="通过" value={stats.approved} tone="#0f766e" />
        <Stat label="待复评" value={stats.recheck} tone="#b45309" />
        <Stat label="驳回" value={stats.rejected} tone="#b42318" />
        <Stat label="待 Walker 结论" value={stats.pending} tone="#475569" />
      </div>
      <div style={styles.tableWrap}><table style={styles.table}><thead><tr>{['排名', '项目', '本轮总分', '完成度', 'Walker 结论', '问题与行动'].map((label) => <th key={label} style={styles.cell}>{label}</th>)}</tr></thead><tbody>
        {projects.map((project: Item, index: number) => {
          const round = project.roundSummaries?.[project.currentRound];
          const problems = round?.problemSummary || project.problemSummary || '-';
          const actions = round?.actionSummary || project.actionSummary || '';
          const verdict = project.walkerVerdict || project.verdict;
          return <tr key={project.id}><td style={styles.cell}>{index + 1}</td><td style={styles.cell}><strong>{project.name}</strong><div style={styles.subtle}>{project.submitter} · 第 {project.round_no || roundNo} 轮</div></td><td style={styles.cell}>{Number(project.totalScore || 0).toFixed(1)} / 100</td><td style={styles.cell}>{project.completionRate || 0}%</td><td style={styles.cell}>{verdictLabels[verdict] || '待 Walker 结论'}</td><td style={styles.cell}><div>{problems}</div>{actions && <div style={styles.subtle}>行动：{actions}</div>}</td></tr>;
        })}
        {!projects.length && <tr><td colSpan={6} style={styles.empty}>本场评审会尚未形成可汇总的评审数据。</td></tr>}
      </tbody></table></div>
      <div style={styles.snapshot}><div><strong>快照报告</strong><p style={styles.help}>生成后会保存当前第 {roundNo} 轮的报告版本，并打开可打印报告。</p>{snapshot && <p style={styles.version}>已生成快照 v{snapshot.version}</p>}</div><button type="button" style={styles.primary} disabled={creatingSnapshot} onClick={createSnapshot}>{creatingSnapshot ? '生成中...' : '生成快照并打开打印报告'}</button></div>
    </>}
  </div>;
}

function Stat({ label, value, tone }: { label: string; value: number; tone: string }) {
  return <div style={styles.stat}><span style={styles.subtle}>{label}</span><strong style={{ color: tone, fontSize: 24 }}>{value}</strong></div>;
}

const styles: Record<string, React.CSSProperties> = {
  section: { marginTop: 20 }, heading: { display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'flex-start', marginBottom: 14 }, title: { margin: 0, fontSize: 18 }, help: { margin: '5px 0 0', color: '#64748b', fontSize: 13 }, round: { padding: '5px 8px', background: '#f0fdfa', color: '#0f766e', borderRadius: 4, fontSize: 13, fontWeight: 700 }, error: { color: '#b42318', margin: '0 0 12px' }, stats: { display: 'grid', gridTemplateColumns: 'repeat(4, minmax(0, 1fr))', gap: 10, marginBottom: 14 }, stat: { display: 'grid', gap: 5, padding: 12, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff' }, tableWrap: { overflowX: 'auto', border: '1px solid #d9e1ec', borderRadius: 6 }, table: { width: '100%', borderCollapse: 'collapse', fontSize: 14 }, cell: { padding: '11px 12px', textAlign: 'left', verticalAlign: 'top', borderBottom: '1px solid #e7edf5' }, subtle: { color: '#64748b', fontSize: 13, marginTop: 4 }, empty: { padding: 20, textAlign: 'center', color: '#64748b' }, snapshot: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16, flexWrap: 'wrap', padding: 16, marginTop: 14, border: '1px solid #d9e1ec', borderRadius: 6, background: '#fbfdff' }, primary: { background: '#0f766e', color: '#fff', border: '1px solid #0f766e', padding: '8px 12px', borderRadius: 5, cursor: 'pointer' }, version: { margin: '6px 0 0', color: '#0f766e', fontSize: 13, fontWeight: 700 }
};
