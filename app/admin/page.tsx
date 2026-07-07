'use client';

import { useEffect, useState, useCallback } from 'react';
import { useRouter } from 'next/navigation';

interface Project {
  id: string;
  seq_no: number;
  name: string;
  submitter: string;
  description: string;
  is_template: boolean;
  is_pending: boolean;
}

interface ReviewerStat {
  code: string;
  name: string;
  role: string;
  scoresGiven: number;
  projectsScored: number;
  totalGiven: number;
  expectedScores: number;
  dimensions: string[];
  dimMaxTotal: number;
}

interface Meeting {
  id: string;
  name: string;
  meeting_date: string;
  deadline: string | null;
  status: string;
  notes: string;
  is_current: boolean;
  deleted_at: string | null;
  scheduled_purge_at: string | null;
}

interface SummaryProject {
  id: string;
  seq_no: number;
  name: string;
  submitter: string;
  is_pending: boolean;
  problems: string[];
  actions: string[];
  reviewerProblems: { reviewer_code: string; reviewer_name: string; problems: string[] }[];
  reviewerActions: { reviewer_code: string; reviewer_name: string; actions: string[] }[];
  totalScore: number;
  scoreCount: number;
  completionRate: number;
  baseScore: number;
  bonusScore: number;
  bonusDetails: { reviewer: string; value: number; reason: string }[];
  dimTotals: Record<string, { total: number; avg: number; count: number; maxScore: number; percentage: number; reviewers: string[] }>;
  verdict: string | null;
}

export default function AdminPage() {
  const router = useRouter();
  const [reviewer, setReviewer] = useState<any>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [deletedMeetings, setDeletedMeetings] = useState<Meeting[]>([]);
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [summaryProjects, setSummaryProjects] = useState<SummaryProject[]>([]);
  const [reviewers, setReviewers] = useState<ReviewerStat[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [showNewMeeting, setShowNewMeeting] = useState(false);
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [showTrash, setShowTrash] = useState(false);

  useEffect(() => {
    const stored = localStorage.getItem('reviewer');
    if (!stored) { router.push('/'); return; }
    const r = JSON.parse(stored);
    if (!r.is_admin) { router.push('/scoring'); return; }
    setReviewer(r);
    loadMeetings();
  }, []);

  const loadMeetings = async () => {
    try {
      const res = await fetch('/api/meetings?includeDeleted=true', { cache: 'no-store' });
      const data = await res.json();
      const all = data.meetings || [];
      setMeetings(all.filter((m: Meeting) => !m.deleted_at));
      setDeletedMeetings(all.filter((m: Meeting) => m.deleted_at));
      // 默认选当前评审会
      const current = all.find((m: Meeting) => m.is_current) || all.filter((m: Meeting) => !m.deleted_at)[0];
      if (current) {
        setActiveMeeting(current);
        loadData(current.id);
      }
    } catch (err) {
      console.error('loadMeetings error:', err);
    }
  };

  const loadData = async (meetingId: string) => {
    setLoading(true);
    try {
      // 加载项目（管理员看所有）
      const projRes = await fetch(`/api/projects?meetingId=${meetingId}&role=admin`, { cache: 'no-store' });
      const projData = await projRes.json();
      setProjects(projData.projects || []);

      // 加载汇总
      const sumRes = await fetch(`/api/summary?meetingId=${meetingId}`, { cache: 'no-store' });
      const sumData = await sumRes.json();
      setSummaryProjects(sumData.projects || []);
      setReviewers(sumData.reviewers || []);
    } catch (err) {
      console.error('loadData error:', err);
    } finally {
      setLoading(false);
    }
  };

  const switchMeeting = (m: Meeting) => {
    setActiveMeeting(m);
    loadData(m.id);
  };

  const handleSetCurrent = async () => {
    if (!activeMeeting) return;
    const res = await fetch('/api/meetings', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeMeeting.id, is_current: true })
    });
    if (res.ok) {
      setMessage('✓ 已设为当前评审会');
      loadMeetings();
    } else {
      const data = await res.json();
      setMessage('❌ ' + data.error);
    }
    setTimeout(() => setMessage(''), 3000);
  };

  const handleSoftDelete = async () => {
    if (!activeMeeting) return;
    if (!confirm(`确定要删除「${activeMeeting.name}」吗？\n\n删除后数据保留 3 天，可在此期间恢复。3天后将自动清理。`)) return;
    const res = await fetch('/api/meetings/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: activeMeeting.id, action: 'soft_delete' })
    });
    if (res.ok) {
      setMessage('✓ 已标记删除，3天后将自动清理（可在『回收站』恢复）');
      loadMeetings();
    }
    setTimeout(() => setMessage(''), 5000);
  };

  const handleRestore = async (id: string) => {
    if (!confirm('确定要恢复这个评审会吗？')) return;
    const res = await fetch('/api/meetings/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'restore' })
    });
    if (res.ok) {
      setMessage('✓ 已恢复');
      loadMeetings();
    }
  };

  const handlePurge = async (id: string, name: string) => {
    if (!confirm(`确定要彻底删除「${name}」吗？此操作不可撤销！所有项目、评分数据都将永久删除。`)) return;
    const res = await fetch('/api/meetings/delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id, action: 'purge' })
    });
    if (res.ok) {
      setMessage('✓ 已彻底删除');
      loadMeetings();
    }
  };

  const handleResetScores = async () => {
    if (!activeMeeting) return;
    if (!confirm(`确定要清空「${activeMeeting.name}」的所有评分吗？此操作不可撤销！`)) return;
    const res = await fetch(`/api/scores?meetingId=${activeMeeting.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) {
      setMessage('✓ 已清空所有评分');
      loadData(activeMeeting.id);
    } else {
      setMessage('❌ ' + data.error);
    }
    setTimeout(() => setMessage(''), 3000);
  };

  const exportJSON = () => {
    if (!activeMeeting) return;
    const data = {
      meeting: activeMeeting,
      projects: summaryProjects.map(p => ({
        seq_no: p.seq_no,
        name: p.name,
        submitter: p.submitter,
        baseScore: p.baseScore,
        bonusScore: p.bonusScore,
        totalScore: p.totalScore,
        bonusDetails: p.bonusDetails,
        completionRate: p.completionRate,
        dimTotals: p.dimTotals,
        reviewerProblems: p.reviewerProblems,
        reviewerActions: p.reviewerActions
      })),
      reviewers,
      exportedAt: new Date().toISOString()
    };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeMeeting.name}-${new Date().toISOString().slice(0,10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const exportCSV = () => {
    if (!activeMeeting || summaryProjects.length === 0) return;
    const dims = ['可玩性', '创新性', '项目规划', '技术&美术', '风险性'];
    const lines: string[] = [];
    lines.push(['编号', '项目名', '提报人', ...dims, '基础分(均值)', '加分', '总分', '完成度', '问题', '意见'].join(','));
    summaryProjects.forEach(p => {
      // 汇总所有评委的 problems 和 actions
      const allProblems = (p.reviewerProblems || []).flatMap(rp => rp.problems);
      const allActions = (p.reviewerActions || []).flatMap(ra => ra.actions);
      const row = [
        p.seq_no,
        p.name,
        p.submitter,
        ...dims.map(d => p.dimTotals[d]?.avg?.toFixed(1) ?? ''),
        p.baseScore,
        p.bonusScore || 0,
        p.totalScore,
        p.completionRate + '%',
        allProblems.join('; '),
        allActions.join('; ')
      ];
      lines.push(row.map(v => `"${v}"`).join(','));
    });
    lines.push('');
    lines.push('评委贡献度');
    lines.push(['账号', '姓名', '角色', '已评维度数', '已评项目数', '总分'].join(','));
    reviewers.forEach(r => {
      lines.push([r.code, r.name, r.role, r.scoresGiven, r.projectsScored, r.totalGiven].join(','));
    });
    const csv = '\ufeff' + lines.join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${activeMeeting.name}-${new Date().toISOString().slice(0,10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const generateReportHTML = () => {
    if (!activeMeeting) return;
    const params = new URLSearchParams({ meetingId: activeMeeting.id, fromAdmin: 'true' });
    window.open(`/report?${params}`, '_blank');
  };

  if (!reviewer) return <div style={{ padding: 40 }}>加载中...</div>;

  return (
    <div style={{
      minHeight: '100vh',
      background: '#f8fafc',
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif'
    }}>
      {/* 顶部栏 */}
      <div style={{
        background: 'white',
        borderBottom: '1px solid #e2e8f0',
        padding: '14px 32px',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: '36px', height: '36px',
            background: 'linear-gradient(135deg, #8b5cf6, #ec4899)',
            borderRadius: '8px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontSize: '18px'
          }}>⚙</div>
          <div>
            <div style={{ fontSize: '16px', fontWeight: '700', color: '#0f172a' }}>管理员看板</div>
            <div style={{ fontSize: '12px', color: '#64748b' }}>{reviewer.name} · 管理员</div>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button onClick={() => setShowTrash(!showTrash)} style={{
            padding: '8px 14px', background: showTrash ? '#fee2e2' : '#f1f5f9',
            color: showTrash ? '#991b1b' : '#475569',
            border: 'none', borderRadius: '8px',
            fontSize: '13px', cursor: 'pointer', fontWeight: '600'
          }}>
            🗑 回收站 {deletedMeetings.length > 0 && `(${deletedMeetings.length})`}
          </button>
          <button onClick={() => { localStorage.removeItem('reviewer'); router.push('/'); }} style={{
            padding: '8px 16px', background: '#f1f5f9',
            color: '#475569', border: 'none', borderRadius: '8px',
            fontSize: '13px', cursor: 'pointer'
          }}>退出登录</button>
        </div>
      </div>

      <div style={{ maxWidth: '1400px', margin: '0 auto', padding: '24px 32px' }}>
        {showTrash ? (
          <TrashView
            meetings={deletedMeetings}
            onRestore={handleRestore}
            onPurge={handlePurge}
            onBack={() => { setShowTrash(false); loadMeetings(); }}
          />
        ) : (
          <>
            {/* 评审会切换 + 操作 */}
            <div style={{
              background: 'white',
              borderRadius: '14px',
              padding: '20px',
              marginBottom: '20px',
              display: 'flex',
              gap: '12px',
              alignItems: 'center',
              flexWrap: 'wrap'
            }}>
              <div style={{ flex: 1, minWidth: '220px' }}>
                <label style={{ fontSize: '12px', color: '#64748b', display: 'block', marginBottom: '4px' }}>
                  当前评审会
                </label>
                <select
                  value={activeMeeting?.id || ''}
                  onChange={(e) => {
                    const m = meetings.find(x => x.id === e.target.value);
                    if (m) switchMeeting(m);
                  }}
                  style={{
                    width: '100%', padding: '10px 14px',
                    border: '1.5px solid #e2e8f0', borderRadius: '8px',
                    fontSize: '14px', fontWeight: '600', color: '#0f172a'
                  }}
                >
                  {meetings.map(m => (
                    <option key={m.id} value={m.id}>
                      {m.is_current ? '📍 ' : ''}{m.name}
                    </option>
                  ))}
                </select>
              </div>

              {activeMeeting && !activeMeeting.is_current && (
                <button onClick={handleSetCurrent} style={{
                  padding: '10px 16px', background: '#10b981', color: 'white',
                  border: 'none', borderRadius: '8px', cursor: 'pointer',
                  fontSize: '13px', fontWeight: '600'
                }}>📍 设为当前评审会</button>
              )}

              {activeMeeting?.is_current && (
                <div style={{
                  padding: '10px 16px', background: '#d1fae5', color: '#065f46',
                  borderRadius: '8px', fontSize: '12px', fontWeight: '700'
                }}>📍 当前评审会</div>
              )}

              <button onClick={() => setShowNewMeeting(true)} style={{
                padding: '10px 18px', background: '#3b82f6', color: 'white',
                border: 'none', borderRadius: '8px', cursor: 'pointer',
                fontSize: '13px', fontWeight: '600'
              }}>+ 新建评审会</button>

              <button onClick={generateReportHTML} style={{
                padding: '10px 18px', background: '#8b5cf6', color: 'white',
                border: 'none', borderRadius: '8px', cursor: 'pointer',
                fontSize: '13px', fontWeight: '600'
              }}>📄 生成报告</button>

              <button onClick={() => { if (activeMeeting) loadData(activeMeeting.id); }} style={{
                padding: '10px 18px', background: '#0ea5e9', color: 'white',
                border: 'none', borderRadius: '8px', cursor: 'pointer',
                fontSize: '13px', fontWeight: '600'
              }}>🔄 刷新数据</button>

              <button onClick={exportCSV} style={{
                padding: '10px 18px', background: '#10b981', color: 'white',
                border: 'none', borderRadius: '8px', cursor: 'pointer',
                fontSize: '13px', fontWeight: '600'
              }}>📊 导出CSV</button>

              <button onClick={exportJSON} style={{
                padding: '10px 18px', background: '#06b6d4', color: 'white',
                border: 'none', borderRadius: '8px', cursor: 'pointer',
                fontSize: '13px', fontWeight: '600'
              }}>📋 导出JSON</button>

              {activeMeeting?.status === 'active' && (
                <>
                  <button onClick={handleResetScores} style={{
                    padding: '10px 18px', background: '#f59e0b', color: 'white',
                    border: 'none', borderRadius: '8px', cursor: 'pointer',
                    fontSize: '13px', fontWeight: '600'
                  }}>🔄 重置评分</button>
                  <button onClick={handleSoftDelete} style={{
                    padding: '10px 18px', background: '#ef4444', color: 'white',
                    border: 'none', borderRadius: '8px', cursor: 'pointer',
                    fontSize: '13px', fontWeight: '600'
                  }}>🗑 删除评审会</button>
                </>
              )}
            </div>

            {message && (
              <div style={{
                background: message.startsWith('✓') ? '#d1fae5' : '#fee2e2',
                color: message.startsWith('✓') ? '#065f46' : '#991b1b',
                padding: '10px 16px', borderRadius: '8px', marginBottom: '16px',
                fontSize: '13px', fontWeight: '600'
              }}>{message}</div>
            )}

            {/* 项目管理 - 8个模板 */}
            <div style={{
              background: 'white',
              borderRadius: '14px',
              padding: '24px',
              marginBottom: '20px'
            }}>
              <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                📝 项目模板（8个）
              </h2>
              <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '12px' }}>
                填写项目名和提报人后，评委才能在项目列表中看到。未填的项不会出现在评委页面。
              </div>
              {loading ? (
                <div style={{ padding: 20, color: '#94a3b8' }}>加载中...</div>
              ) : (
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: '10px' }}>
                  {projects.sort((a, b) => a.seq_no - b.seq_no).map(p => {
                    const isFilled = p.name && p.submitter;
                    return (
                      <div key={p.id} style={{
                        padding: '14px',
                        background: isFilled ? '#f0fdf4' : '#f8fafc',
                        border: isFilled ? '1.5px solid #bbf7d0' : '1.5px dashed #cbd5e1',
                        borderRadius: '10px',
                        cursor: 'pointer',
                        position: 'relative'
                      }}
                      onClick={() => setEditingProject(p)}
                      >
                        <div style={{
                          position: 'absolute', top: 8, right: 10,
                          fontSize: '11px', fontWeight: '700',
                          color: isFilled ? '#10b981' : '#94a3b8'
                        }}>#{p.seq_no}</div>
                        <div style={{ fontSize: '14px', fontWeight: '600', color: isFilled ? '#0f172a' : '#94a3b8', marginBottom: '4px' }}>
                          {p.name || '(未填写)'}
                        </div>
                        <div style={{ fontSize: '12px', color: isFilled ? '#475569' : '#94a3b8' }}>
                          {p.submitter ? `提报人: ${p.submitter}` : '点击编辑 →'}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* 项目得分排名 */}
            <div style={{
              background: 'white',
              borderRadius: '14px',
              padding: '24px',
              marginBottom: '20px'
            }}>
              <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                项目得分总览
              </h2>
              {loading ? (
                <div style={{ padding: 20, color: '#94a3b8' }}>加载中...</div>
              ) : summaryProjects.length === 0 ? (
                <div style={{ padding: 20, color: '#94a3b8', textAlign: 'center' }}>暂无项目评分</div>
              ) : (
                <div style={{ overflowX: 'auto' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                    <thead>
                      <tr style={{ background: '#f8fafc' }}>
                        <th style={{ padding: '12px 10px', textAlign: 'left', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>编号</th>
                        <th style={{ padding: '12px 10px', textAlign: 'left', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>项目名</th>
                        <th style={{ padding: '12px 10px', textAlign: 'left', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>提报人</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>可玩</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>创新</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>规划</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>技美</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>风险</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>基础</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#f59e0b' }}>加分</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>总分</th>
                        <th style={{ padding: '12px 10px', textAlign: 'center', fontSize: '12px', fontWeight: '700', color: '#64748b' }}>完成度</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...summaryProjects].sort((a, b) => a.seq_no - b.seq_no).map((p) => {
                        return (
                          <tr key={p.id} style={{ borderTop: '1px solid #f1f5f9' }}>
                            <td style={{ padding: '12px 10px', fontSize: '14px', color: '#64748b' }}>{p.seq_no}</td>
                            <td style={{ padding: '12px 10px', fontSize: '14px', fontWeight: '600', color: '#0f172a' }}>{p.name}</td>
                            <td style={{ padding: '12px 10px', fontSize: '13px', color: '#64748b' }}>{p.submitter}</td>
                            {['可玩性', '创新性', '项目规划', '技术&美术', '风险性'].map(d => (
                              <td key={d} style={{ padding: '12px 10px', textAlign: 'center', fontSize: '13px', color: '#475569' }}>
                                {p.dimTotals[d] ? p.dimTotals[d].avg.toFixed(1) : '-'}
                              </td>
                            ))}
                            <td style={{ padding: '12px 10px', textAlign: 'center', fontSize: '14px', fontWeight: '600', color: '#475569' }}>{p.baseScore}</td>
                            <td style={{ padding: '12px 10px', textAlign: 'center', fontSize: '14px', fontWeight: '600', color: p.bonusScore > 0 ? '#f59e0b' : '#cbd5e1' }}>
                              {p.bonusScore > 0 ? `+${p.bonusScore}` : '-'}
                            </td>
                            <td style={{ padding: '12px 10px', textAlign: 'center', fontSize: '18px', fontWeight: '700', color: '#1e40af' }}>{p.totalScore}</td>
                            <td style={{ padding: '12px 10px', textAlign: 'center' }}>
                              <div style={{
                                display: 'inline-block', padding: '3px 10px',
                                background: p.completionRate === 100 ? '#d1fae5' : '#fef3c7',
                                color: p.completionRate === 100 ? '#065f46' : '#92400e',
                                borderRadius: '12px', fontSize: '12px', fontWeight: '600'
                              }}>{p.completionRate}%</div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
            </div>

            {/* 项目评审详情（问题/意见/加分/结论） */}
            {!loading && summaryProjects.filter(p => p.name && p.submitter).length > 0 && (
              <div style={{
                background: 'white',
                borderRadius: '14px',
                padding: '24px',
                marginBottom: '20px'
              }}>
                <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                  📋 项目评审详情
                </h2>
                {[...summaryProjects].filter(p => p.name && p.submitter).sort((a, b) => a.seq_no - b.seq_no).map(p => (
                  <ProjectDetailCard
                    key={p.id}
                    project={p}
                    meetingId={activeMeeting!.id}
                  />
                ))}
              </div>
            )}

            {/* 评委贡献度 */}
            <div style={{
              background: 'white',
              borderRadius: '14px',
              padding: '24px'
            }}>
              <h2 style={{ margin: '0 0 16px', fontSize: '18px', fontWeight: '700', color: '#0f172a' }}>
                评委贡献度
              </h2>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: '12px' }}>
                {reviewers.map(r => {
                  const expected = r.expectedScores || 0;
                  const progress = expected > 0 ? Math.min(100, Math.round((r.scoresGiven / expected) * 100)) : 0;
                  return (
                    <div key={r.code} style={{
                      padding: '14px 16px', background: '#f8fafc',
                      borderRadius: '10px', border: '1px solid #e2e8f0'
                    }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '8px' }}>
                        <div style={{ fontWeight: '600', fontSize: '14px', color: '#0f172a' }}>
                          {r.name} <span style={{ color: '#64748b', fontSize: '12px', fontWeight: '500' }}>· {r.role}</span>
                        </div>
                        <div style={{
                          background: progress === 100 ? '#10b981' : '#3b82f6',
                          color: 'white', padding: '2px 8px',
                          borderRadius: '10px', fontSize: '11px', fontWeight: '600'
                        }}>{progress}%</div>
                      </div>
                      <div style={{ fontSize: '12px', color: '#64748b', lineHeight: '1.6' }}>
                        已评 {r.scoresGiven} 项<br/>
                        覆盖 {r.projectsScored} 个项目
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>

      {showNewMeeting && (
        <NewMeetingModal
          meetings={meetings}
          onClose={() => setShowNewMeeting(false)}
          onSuccess={() => { setShowNewMeeting(false); loadMeetings(); }}
        />
      )}

      {editingProject && (
        <EditProjectModal
          project={editingProject}
          onClose={() => setEditingProject(null)}
          onSuccess={() => { setEditingProject(null); loadData(activeMeeting!.id); }}
        />
      )}
    </div>
  );
}

function TrashView({ meetings, onRestore, onPurge, onBack }: any) {
  const getDaysLeft = (purgeAt: string) => {
    const ms = new Date(purgeAt).getTime() - Date.now();
    const days = Math.floor(ms / (24 * 60 * 60 * 1000));
    const hours = Math.floor((ms % (24 * 60 * 60 * 1000)) / (60 * 60 * 1000));
    return `${days}天${hours}小时`;
  };

  return (
    <div style={{
      background: 'white',
      borderRadius: '14px',
      padding: '24px'
    }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '20px' }}>
        <h2 style={{ margin: 0, fontSize: '20px', fontWeight: '700', color: '#0f172a' }}>
          🗑 回收站（{meetings.length}）
        </h2>
        <button onClick={onBack} style={{
          padding: '8px 16px', background: '#f1f5f9',
          color: '#475569', border: 'none', borderRadius: '8px',
          fontSize: '13px', cursor: 'pointer'
        }}>← 返回</button>
      </div>
      {meetings.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '40px', color: '#94a3b8' }}>
          回收站为空
        </div>
      ) : (
        <div style={{ display: 'grid', gap: '12px' }}>
          {meetings.map((m: Meeting) => (
            <div key={m.id} style={{
              padding: '16px 20px',
              background: '#fef2f2',
              border: '1.5px solid #fecaca',
              borderRadius: '10px',
              display: 'flex',
              justifyContent: 'space-between',
              alignItems: 'center'
            }}>
              <div>
                <div style={{ fontSize: '15px', fontWeight: '600', color: '#991b1b' }}>{m.name}</div>
                <div style={{ fontSize: '12px', color: '#7f1d1d', marginTop: '4px' }}>
                  删除于 {new Date(m.deleted_at!).toLocaleString('zh-CN')} ·
                  距离清理还有 <strong>{getDaysLeft(m.scheduled_purge_at!)}</strong>
                </div>
              </div>
              <div style={{ display: 'flex', gap: '8px' }}>
                <button onClick={() => onRestore(m.id)} style={{
                  padding: '8px 16px', background: '#10b981', color: 'white',
                  border: 'none', borderRadius: '8px', fontSize: '13px',
                  cursor: 'pointer', fontWeight: '600'
                }}>♻ 恢复</button>
                <button onClick={() => onPurge(m.id, m.name)} style={{
                  padding: '8px 16px', background: '#dc2626', color: 'white',
                  border: 'none', borderRadius: '8px', fontSize: '13px',
                  cursor: 'pointer', fontWeight: '600'
                }}>永久删除</button>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function NewMeetingModal({ meetings, onClose, onSuccess }: any) {
  const [name, setName] = useState('');
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [deadline, setDeadline] = useState('');
  const [copyFrom, setCopyFrom] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleCreate = async () => {
    if (!name.trim()) { setError('请输入评审会名称'); return; }
    setLoading(true);
    setError('');
    const res = await fetch('/api/meetings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: name.trim(),
        meeting_date: date,
        deadline: deadline || null,
        copy_from_meeting_id: copyFrom || undefined
      })
    });
    const data = await res.json();
    if (data.success) {
      onSuccess();
    } else {
      setError(data.error || '创建失败');
    }
    setLoading(false);
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: 'white', borderRadius: '14px', padding: '32px',
        width: '480px', maxWidth: '90%'
      }}>
        <h2 style={{ margin: '0 0 20px', fontSize: '20px', fontWeight: '700', color: '#0f172a' }}>
          新建评审会
        </h2>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>评审会名称 *</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="如：2026-07-15 立项评审会议"
            style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>会议日期 *</label>
          <input
            type="date" value={date} onChange={(e) => setDate(e.target.value)}
            style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>打分截止日期（可选）</label>
          <input
            type="date" value={deadline} onChange={(e) => setDeadline(e.target.value)}
            style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>复制项目自（可选）</label>
          <select value={copyFrom} onChange={(e) => setCopyFrom(e.target.value)} style={{
            width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0',
            borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box'
          }}>
            <option value="">不复制（创建空模板）</option>
            {meetings.map((m: Meeting) => (
              <option key={m.id} value={m.id}>{m.name}</option>
            ))}
          </select>
        </div>
        <div style={{ fontSize: '12px', color: '#64748b', background: '#f0f9ff', padding: '10px', borderRadius: '6px', marginBottom: '14px' }}>
          💡 创建后会自动生成 8 个空模板项目。管理员编辑项目名+提报人后，评委才能在项目列表中看到。
        </div>
        {error && <div style={{ color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>⚠ {error}</div>}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={{ padding: '10px 18px', background: '#f1f5f9', color: '#475569', border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px' }}>取消</button>
          <button onClick={handleCreate} disabled={loading} style={{
            padding: '10px 18px', background: '#3b82f6', color: 'white', border: 'none',
            borderRadius: '8px', cursor: loading ? 'not-allowed' : 'pointer',
            fontSize: '13px', fontWeight: '600', opacity: loading ? 0.6 : 1
          }}>{loading ? '创建中...' : '创建'}</button>
        </div>
      </div>
    </div>
  );
}

function ProjectDetailCard({ project, meetingId }: { project: SummaryProject; meetingId: string }) {
  const [expanded, setExpanded] = useState(false);
  const [saving, setSaving] = useState(false);
  const [msg, setMsg] = useState('');
  const [localVerdict, setLocalVerdict] = useState<string | null>(project.verdict);

  // 当外部数据刷新时同步本地状态
  useEffect(() => {
    setLocalVerdict(project.verdict);
  }, [project.verdict]);

  const verdictOptions = [
    { value: 'approved', label: '评审通过', color: '#10b981', bg: '#d1fae5' },
    { value: 'needs_rework', label: '待修改', color: '#f59e0b', bg: '#fef3c7' },
    { value: 'needs_review', label: '待重评', color: '#ef4444', bg: '#fee2e2' }
  ];

  const currentVerdict = verdictOptions.find(v => v.value === localVerdict);

  const saveVerdict = async (e: React.MouseEvent, value: string) => {
    e.stopPropagation();
    e.preventDefault();
    setSaving(true);
    setMsg('');
    try {
      const stored = localStorage.getItem('reviewer');
      const admin = stored ? JSON.parse(stored) : null;
      const code = admin?.code || 'W';
      const newVerdict = localVerdict === value ? null : value;
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_id: meetingId, project_id: project.id, reviewer_code: code,
          dim_name: '__verdict__', score: 0, comment: newVerdict
        })
      });
      if (res.ok) {
        setLocalVerdict(newVerdict);
        setMsg('✓ 已保存');
        setTimeout(() => setMsg(''), 1500);
      } else {
        const d = await res.json();
        setMsg('❌ ' + d.error);
      }
    } catch (e: any) { setMsg('❌ ' + e.message); }
    setSaving(false);
  };

  const allProblems: { reviewer: string; text: string }[] = [];
  (project.reviewerProblems || []).forEach(rp => rp.problems.forEach(t => allProblems.push({ reviewer: rp.reviewer_name, text: t })));
  const allActions: { reviewer: string; text: string }[] = [];
  (project.reviewerActions || []).forEach(ra => ra.actions.forEach(t => allActions.push({ reviewer: ra.reviewer_name, text: t })));

  return (
    <div style={{
      background: '#f8fafc', borderRadius: '12px',
      border: `1.5px solid ${currentVerdict ? currentVerdict.color + '40' : '#e2e8f0'}`,
      marginBottom: '10px', overflow: 'hidden'
    }}>
      <div onClick={() => setExpanded(!expanded)} style={{
        padding: '14px 18px', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: '12px'
      }}>
        <div style={{ fontSize: '13px', color: '#94a3b8' }}>{expanded ? '▼' : '▶'}</div>
        <div style={{ flex: 1 }}>
          <span style={{ fontSize: '14px', fontWeight: '600', color: '#0f172a' }}>#{project.seq_no} {project.name}</span>
          <span style={{ fontSize: '12px', color: '#64748b', marginLeft: '8px' }}>
            {project.submitter} · {project.totalScore.toFixed(1)}分
            {project.bonusScore > 0 && <span style={{ color: '#f59e0b' }}> (含+{project.bonusScore}加分)</span>}
          </span>
        </div>
        {currentVerdict && (
          <div style={{ padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: '600', background: currentVerdict.bg, color: currentVerdict.color }}>{currentVerdict.label}</div>
        )}
        {!currentVerdict && (
          <div style={{ padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: '500', background: '#f1f5f9', color: '#94a3b8' }}>未定</div>
        )}
        <div style={{ display: 'flex', gap: '6px' }}>
          {allProblems.length > 0 && <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: '#fee2e2', color: '#dc2626' }}>⚠ {allProblems.length}</span>}
          {allActions.length > 0 && <span style={{ fontSize: '11px', padding: '2px 8px', borderRadius: '10px', background: '#dcfce7', color: '#059669' }}>✓ {allActions.length}</span>}
        </div>
      </div>
      {expanded && (
        <div style={{ padding: '0 18px 18px', borderTop: '1px solid #e2e8f0' }}>
          <div style={{ marginTop: '14px', marginBottom: '14px' }}>
            <div style={{ fontSize: '12px', fontWeight: '700', color: '#475569', marginBottom: '8px' }}>📌 评审结论</div>
            <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' }}>
              {verdictOptions.map(opt => {
                const isActive = localVerdict === opt.value;
                return (
                  <button type="button" key={opt.value} onClick={(e) => saveVerdict(e, opt.value)} disabled={saving} style={{
                    padding: '8px 16px', borderRadius: '8px', fontSize: '13px', fontWeight: '600',
                    cursor: saving ? 'not-allowed' : 'pointer',
                    border: isActive ? `2px solid ${opt.color}` : '2px solid #e2e8f0',
                    background: isActive ? opt.bg : 'white', color: isActive ? opt.color : '#64748b'
                  }}>{isActive ? '● ' : '○ '}{opt.label}</button>
                );
              })}
              {msg && <span style={{ fontSize: '12px', color: msg.startsWith('✓') ? '#10b981' : '#ef4444', fontWeight: '600' }}>{msg}</span>}
            </div>
          </div>
          {project.bonusDetails && project.bonusDetails.length > 0 && (
            <div style={{ marginBottom: '14px' }}>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#f59e0b', marginBottom: '6px' }}>🎁 Walker 加分明细</div>
              {project.bonusDetails.map((b, i) => (
                <div key={i} style={{ padding: '8px 12px', background: '#fef3c7', borderRadius: '8px', border: '1px solid #fde68a', marginBottom: '4px', fontSize: '13px', color: '#78350f' }}>
                  <strong>+{b.value}分</strong> · {b.reason || '(无原因)'}
                </div>
              ))}
            </div>
          )}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
            <div>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#dc2626', marginBottom: '6px' }}>⚠ 存在问题（{allProblems.length}条）</div>
              {allProblems.length > 0 ? allProblems.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '6px 10px', background: 'white', borderRadius: '6px', border: '1px solid #fecaca', marginBottom: '4px' }}>
                  <span style={{ fontSize: '10px', fontWeight: '600', background: '#fee2e2', color: '#991b1b', padding: '1px 6px', borderRadius: '8px', whiteSpace: 'nowrap', flexShrink: 0, marginTop: '1px' }}>{item.reviewer}</span>
                  <span style={{ fontSize: '12px', color: '#475569' }}>{item.text}</span>
                </div>
              )) : <div style={{ fontSize: '12px', color: '#cbd5e1' }}>暂无</div>}
            </div>
            <div>
              <div style={{ fontSize: '12px', fontWeight: '700', color: '#059669', marginBottom: '6px' }}>✓ 改进动作（{allActions.length}条）</div>
              {allActions.length > 0 ? allActions.map((item, i) => (
                <div key={i} style={{ display: 'flex', alignItems: 'flex-start', gap: '6px', padding: '6px 10px', background: 'white', borderRadius: '6px', border: '1px solid #bbf7d0', marginBottom: '4px' }}>
                  <span style={{ fontSize: '10px', fontWeight: '600', background: '#dcfce7', color: '#065f46', padding: '1px 6px', borderRadius: '8px', whiteSpace: 'nowrap', flexShrink: 0, marginTop: '1px' }}>{item.reviewer}</span>
                  <span style={{ fontSize: '12px', color: '#475569' }}>{item.text}</span>
                </div>
              )) : <div style={{ fontSize: '12px', color: '#cbd5e1' }}>暂无</div>}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function EditProjectModal({ project, onClose, onSuccess }: any) {
  const [name, setName] = useState(project.name || '');
  const [submitter, setSubmitter] = useState(project.submitter || '');
  const [description, setDescription] = useState(project.description || '');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const handleSave = async () => {
    if (!name.trim() || !submitter.trim()) {
      setError('项目名和提报人都必填');
      return;
    }
    setLoading(true);
    setError('');
    const res = await fetch('/api/projects', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        id: project.id,
        name: name.trim(),
        submitter: submitter.trim(),
        description: description.trim(),
        is_template: false
      })
    });
    const data = await res.json();
    if (data.success) {
      onSuccess();
    } else {
      setError(data.error || '保存失败');
    }
    setLoading(false);
  };

  const handleDelete = async () => {
    if (!confirm(`确定要删除「${project.name || '项目'+project.seq_no}」吗？\n\n将清空项目名和提报人，评委无法再看到此项目。`)) return;
    setLoading(true);
    const res = await fetch(`/api/projects?id=${project.id}`, { method: 'DELETE' });
    const data = await res.json();
    if (data.success) onSuccess();
    setLoading(false);
  };

  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
      background: 'rgba(0,0,0,0.5)', display: 'flex',
      alignItems: 'center', justifyContent: 'center', zIndex: 1000
    }}>
      <div style={{
        background: 'white', borderRadius: '14px', padding: '32px',
        width: '480px', maxWidth: '90%'
      }}>
        <h2 style={{ margin: '0 0 20px', fontSize: '20px', fontWeight: '700', color: '#0f172a' }}>
          编辑项目 #{project.seq_no}
        </h2>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>项目名 *</label>
          <input
            type="text" value={name} onChange={(e) => setName(e.target.value)}
            placeholder="如：消消乐大冒险"
            style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>提报人 *</label>
          <input
            type="text" value={submitter} onChange={(e) => setSubmitter(e.target.value)}
            placeholder="如：张三"
            style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box' }}
          />
        </div>
        <div style={{ marginBottom: '14px' }}>
          <label style={{ fontSize: '13px', fontWeight: '600', color: '#334155', display: 'block', marginBottom: '6px' }}>项目简介（可选）</label>
          <textarea
            value={description} onChange={(e) => setDescription(e.target.value)}
            rows={3} placeholder="简单描述项目"
            style={{ width: '100%', padding: '10px 14px', border: '1.5px solid #e2e8f0', borderRadius: '8px', fontSize: '14px', boxSizing: 'border-box', fontFamily: 'inherit' }}
          />
        </div>
        {error && <div style={{ color: '#dc2626', fontSize: '13px', marginBottom: '12px' }}>⚠ {error}</div>}
        <div style={{ display: 'flex', gap: '8px', justifyContent: 'space-between' }}>
          <button onClick={handleDelete} style={{
            padding: '10px 18px', background: 'transparent', color: '#dc2626',
            border: '1px solid #fecaca', borderRadius: '8px', cursor: 'pointer', fontSize: '13px'
          }}>删除</button>
          <div style={{ display: 'flex', gap: '8px' }}>
            <button onClick={onClose} style={{
              padding: '10px 18px', background: '#f1f5f9', color: '#475569',
              border: 'none', borderRadius: '8px', cursor: 'pointer', fontSize: '13px'
            }}>取消</button>
            <button onClick={handleSave} disabled={loading} style={{
              padding: '10px 18px', background: '#3b82f6', color: 'white', border: 'none',
              borderRadius: '8px', cursor: loading ? 'not-allowed' : 'pointer',
              fontSize: '13px', fontWeight: '600', opacity: loading ? 0.6 : 1
            }}>{loading ? '保存中...' : '保存'}</button>
          </div>
        </div>
      </div>
    </div>
  );
}
