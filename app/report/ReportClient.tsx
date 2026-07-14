'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import RoundOneReport from './components/RoundOneReport';
import RoundTwoReport from './components/RoundTwoReport';
import InitiationProjectReport from './components/InitiationProjectReport';

type Snapshot = { id: string; version: number; payload: Record<string, any>; generated_at: string };
const reportTypes = [{ value: 'round_1', label: '第一轮评审报告' }, { value: 'round_2', label: '第二轮评审报告' }];

export default function ReportClient() {
  const router = useRouter(); const params = useSearchParams(); const meetingId = params.get('meetingId');
  const [summary, setSummary] = useState<any>(null); const [reportType, setReportType] = useState('round_1'); const [snapshots, setSnapshots] = useState<Snapshot[]>([]); const [snapshotId, setSnapshotId] = useState(''); const [busy, setBusy] = useState(false); const [error, setError] = useState('');
  const load = async () => {
    if (!meetingId) return;
    const [summaryResponse, snapshotResponse] = await Promise.all([fetch(`/api/summary?meetingId=${encodeURIComponent(meetingId)}`, { cache: 'no-store' }), fetch(`/api/reports?scope_type=meeting&scope_id=${encodeURIComponent(meetingId)}&report_type=${reportType}`, { cache: 'no-store' })]);
    const summaryData = await summaryResponse.json(); const snapshotData = await snapshotResponse.json();
    if (summaryResponse.ok) setSummary(summaryData); else setError(summaryData.error || '无法读取报告数据');
    if (snapshotResponse.ok) { setSnapshots(snapshotData.snapshots || []); setSnapshotId((current) => current || snapshotData.snapshots?.[0]?.id || ''); }
  };
  useEffect(() => { setSnapshotId(''); load(); }, [meetingId, reportType]);
  const liveReport = useMemo(() => ({ meeting: summary?.meeting, reviewers: summary?.reviewers || [], projects: (summary?.projects || []).filter((project: any) => ['approved', 'recheck', 'rejected'].includes(project.walkerVerdict)).filter((project: any) => Number(project.round_no || 1) === (reportType === 'round_1' ? 1 : 2)).sort((left: any, right: any) => Number(right.totalScore || 0) - Number(left.totalScore || 0)).map((project: any, index: number) => ({ ...project, rank: index + 1, verdict: project.walkerVerdict })) }), [summary, reportType]);
  const selected = snapshots.find((snapshot) => snapshot.id === snapshotId); const report = selected?.payload || liveReport;
  const generate = async () => { if (!meetingId) return; setBusy(true); setError(''); try { const response = await fetch('/api/reports', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ scope_type: 'meeting', scope_id: meetingId, report_type: reportType, operator_code: 'ignored' }) }); const data = await response.json(); if (!response.ok) throw new Error(data.error || '生成失败'); setSnapshots((current) => [data.snapshot, ...current]); setSnapshotId(data.snapshot.id); } catch (reason: any) { setError(reason.message || '生成失败'); } finally { setBusy(false); } };
  const close = () => { if (params.get('fromAdmin') === 'true' && window.opener) { window.close(); return; } router.push('/admin'); };
  if (!meetingId) return <main style={styles.empty}>请选择一个评审会后再打开报告。</main>;
  return <main style={styles.shell}><style>{'@media print { .report-actions { display:none !important; } body { background:#fff; } }'}</style><div className="report-actions" style={styles.actions}><button type="button" onClick={close} style={styles.secondary}>返回</button><select aria-label="报告类型" value={reportType} onChange={(event) => setReportType(event.target.value)} style={styles.select}>{reportTypes.map((item) => <option key={item.value} value={item.value}>{item.label}</option>)}</select><select aria-label="报告版本" value={snapshotId} onChange={(event) => setSnapshotId(event.target.value)} style={styles.select}><option value="">实时数据（未保存）</option>{snapshots.map((snapshot) => <option key={snapshot.id} value={snapshot.id}>v{snapshot.version} · {String(snapshot.generated_at).replace('T', ' ').slice(0, 16)}</option>)}</select><button type="button" onClick={generate} disabled={busy} style={styles.primary}>{busy ? '生成中' : '生成新版本'}</button><button type="button" onClick={() => window.print()} style={styles.secondary}>打印</button></div>{error && <p style={styles.error}>{error}</p>}{reportType === 'round_1' ? <RoundOneReport report={report}/> : <RoundTwoReport report={report}/>}</main>;
}

const styles: Record<string, React.CSSProperties> = { shell: { minHeight: '100vh', background: '#eef4f5', padding: 24 }, actions: { maxWidth: 1040, margin: '0 auto 16px', display: 'flex', justifyContent: 'flex-end', gap: 8, flexWrap: 'wrap' }, primary: { padding: '9px 12px', border: '1px solid #0f766e', borderRadius: 5, background: '#0f766e', color: '#fff', cursor: 'pointer' }, secondary: { padding: '9px 12px', border: '1px solid #cbd5e1', borderRadius: 5, background: '#fff', color: '#334155', cursor: 'pointer' }, select: { padding: '9px 10px', border: '1px solid #cbd5e1', borderRadius: 5, background: '#fff' }, empty: { padding: 40, textAlign: 'center' }, error: { maxWidth: 1040, margin: '0 auto 12px', color: '#b42318' } };
