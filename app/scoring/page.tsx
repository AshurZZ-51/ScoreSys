'use client';

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';

interface Reviewer {
  code: string;
  name: string;
  role: string;
  is_admin: boolean;
  dimensions: { dim_name: string; max_score: number }[];
}

interface Project {
  id: string;
  seq_no: number;
  name: string;
  submitter: string;
  description?: string;
}

interface Meeting {
  id: string;
  name: string;
  meeting_date: string;
  deadline: string | null;
  status: string;
  is_current?: boolean;
}

interface Score {
  meeting_id: string;
  project_id: string;
  reviewer_code: string;
  dim_name: string;
  score: number;
  comment?: string;
}

export default function ScoringPage() {
  const router = useRouter();
  const [reviewer, setReviewer] = useState<Reviewer | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [scores, setScores] = useState<Record<string, Record<string, number>>>({});
  const [comments, setComments] = useState<Record<string, string>>({});
  const [projectProblems, setProjectProblems] = useState<Record<string, string>>({});
  const [projectActions, setProjectActions] = useState<Record<string, string>>({});
  const [bonusReason, setBonusReason] = useState<Record<string, string>>({});
  const [bonusValue, setBonusValue] = useState<Record<string, number>>({});
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const isWalker = reviewer?.code?.toUpperCase() === 'W';

  useEffect(() => {
    const stored = localStorage.getItem('reviewer');
    if (!stored) {
      router.push('/');
      return;
    }
    const r = JSON.parse(stored);
    if (r.is_admin) {
      router.push('/admin');
      return;
    }
    setReviewer(r);
    loadMeetings();
  }, []);

  const loadMeetings = async () => {
    try {
      const res = await fetch('/api/meetings', { cache: 'no-store' });
      const data = await res.json();
      const all = data.meetings || [];
      setMeetings(all);
      if (all.length > 0) {
        // 优先：is_current=true 的评审会；否则取最近一个
        const current = all.find((m: Meeting) => m.is_current) || all[0];
        setActiveMeeting(current);
        loadProjects(current.id);
      }
    } catch (err) {
      console.error('loadMeetings error:', err);
    }
  };

  const loadProjects = async (meetingId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects?meetingId=${meetingId}&role=reviewer`, { cache: 'no-store' });
      const data = await res.json();
      setProjects(data.projects || []);

      if (data.projects && data.projects.length > 0) {
        setActiveProject(data.projects[0]);
      }
      await loadScores(meetingId);
    } catch (err) {
      console.error('loadProjects error:', err);
    } finally {
      setLoading(false);
    }
  };

  const loadScores = async (meetingId: string) => {
    try {
      const r = JSON.parse(localStorage.getItem('reviewer')!);
      const res = await fetch(`/api/scores?meetingId=${meetingId}&reviewerCode=${r.code}`, { cache: 'no-store' });
      const data = await res.json();
      const map: Record<string, Record<string, number>> = {};
      const cmtMap: Record<string, string> = {};
      const bonusReasonMap: Record<string, string> = {};
      const bonusValueMap: Record<string, number> = {};
      const probMap: Record<string, string> = {};
      const actMap: Record<string, string> = {};

      (data.scores || []).forEach((s: Score) => {
        if (s.dim_name === '__bonus__') {
          // 加分项
          bonusValueMap[s.project_id] = s.score;
          if (s.comment) bonusReasonMap[s.project_id] = s.comment;
        } else if (s.dim_name === '__problems__') {
          // 评审问题（每个评委独立）
          probMap[s.project_id] = s.comment || '';
        } else if (s.dim_name === '__actions__') {
          // 整改意见（每个评委独立）
          actMap[s.project_id] = s.comment || '';
        } else {
          if (!map[s.project_id]) map[s.project_id] = {};
          map[s.project_id][s.dim_name] = s.score;
          if (s.comment) cmtMap[`${s.project_id}|${s.dim_name}`] = s.comment;
        }
      });
      setScores(map);
      setComments(cmtMap);
      setBonusReason(bonusReasonMap);
      setBonusValue(bonusValueMap);
      setProjectProblems(probMap);
      setProjectActions(actMap);
    } catch (err) {
      console.error('loadScores error:', err);
    }
  };

  const handleScoreChange = async (dimName: string, value: number, comment?: string) => {
    if (!activeMeeting || !activeProject || !reviewer) return;
    if (isNaN(value)) return;

    setSaving(true);
    setMessage('');

    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_id: activeMeeting.id,
          project_id: activeProject.id,
          reviewer_code: reviewer.code,
          dim_name: dimName,
          score: value,
          comment: comment || null
        })
      });

      const data = await res.json();
      if (!res.ok) {
        setMessage('❌ ' + data.error);
      } else {
        setScores(prev => ({
          ...prev,
          [activeProject.id]: { ...prev[activeProject.id], [dimName]: value }
        }));
        if (comment !== undefined) {
          setComments(prev => ({ ...prev, [`${activeProject.id}|${dimName}`]: comment }));
        }
        setMessage('✓ 已保存');
        setTimeout(() => setMessage(''), 1500);
      }
    } catch (err: any) {
      setMessage('❌ ' + err.message);
    }
    setSaving(false);
  };

  const handleBonusSave = async () => {
    if (!activeMeeting || !activeProject || !reviewer) return;
    const reason = bonusReason[activeProject.id] || '';
    const val = bonusValue[activeProject.id];

    if (!val || val < 1 || val > 5) {
      setMessage('❌ 加分值必须在 1-5 之间');
      return;
    }
    if (!reason.trim()) {
      setMessage('❌ 请填写加分原因');
      return;
    }

    await handleScoreChange('__bonus__', val, reason);
    setMessage('✓ 加分已保存');
  };

  const handleProblemsActionsSave = async () => {
    if (!activeProject || !activeMeeting || !reviewer) return;
    const problemsText = (projectProblems[activeProject.id] || '').trim();
    const actionsText = (projectActions[activeProject.id] || '').trim();

    try {
      const [res1, res2] = await Promise.all([
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meeting_id: activeMeeting.id,
            project_id: activeProject.id,
            reviewer_code: reviewer.code,
            dim_name: '__problems__',
            score: 0,
            comment: problemsText || null
          })
        }),
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            meeting_id: activeMeeting.id,
            project_id: activeProject.id,
            reviewer_code: reviewer.code,
            dim_name: '__actions__',
            score: 0,
            comment: actionsText || null
          })
        })
      ]);

      const d1 = await res1.json();
      const d2 = await res2.json();

      if (!res1.ok) {
        setMessage('❌ ' + d1.error);
      } else if (!res2.ok) {
        setMessage('❌ ' + d2.error);
      } else {
        setMessage('✓ 评审意见已保存');
        setTimeout(() => setMessage(''), 1500);
      }
    } catch (err: any) {
      setMessage('❌ ' + err.message);
    }
  };

  const getProjectTotal = (projectId: string) => {
    const dims = scores[projectId] || {};
    const baseTotal = Object.values(dims).reduce((a, b) => a + b, 0);
    const bonus = bonusValue[projectId] || 0;
    return baseTotal + bonus;
  };

  const getProjectBaseScore = (projectId: string) => {
    const dims = scores[projectId] || {};
    return Object.values(dims).reduce((a, b) => a + b, 0);
  };

  const getProjectCompletion = (projectId: string) => {
    if (!reviewer) return 0;
    const dims = scores[projectId] || {};
    const filled = reviewer.dimensions.filter(d => dims[d.dim_name] !== undefined).length;
    return Math.round((filled / reviewer.dimensions.length) * 100);
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
        alignItems: 'center',
        boxShadow: '0 1px 3px rgba(0,0,0,0.03)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <div style={{
            width: '36px', height: '36px',
            background: 'linear-gradient(135deg, #3b82f6, #06b6d4)',
            borderRadius: '8px',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            color: 'white', fontSize: '18px'
          }}>★</div>
          <div>
            <div style={{ fontSize: '16px', fontWeight: '700', color: '#0f172a' }}>
              {reviewer.name} <span style={{ color: '#64748b', fontWeight: '500', fontSize: '13px' }}>· {reviewer.role}</span>
            </div>
            <div style={{ fontSize: '12px', color: '#64748b', display: 'flex', alignItems: 'center', gap: 6 }}>
              <select
                value={activeMeeting?.id || ''}
                onChange={(e) => {
                  const m = meetings.find(x => x.id === e.target.value);
                  if (m) {
                    setActiveMeeting(m);
                    setActiveProject(null);
                    setScores({});
                    setComments({});
                    setProjectProblems({});
                    setProjectActions({});
                    setBonusReason({});
                    setBonusValue({});
                    loadProjects(m.id);
                  }
                }}
                style={{
                  padding: '3px 8px',
                  fontSize: '12px',
                  border: '1px solid #e2e8f0',
                  borderRadius: '6px',
                  background: 'white',
                  cursor: 'pointer',
                  outline: 'none'
                }}
              >
                {meetings.map(m => (
                  <option key={m.id} value={m.id}>
                    {m.is_current ? '📍 ' : ''}{m.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
        </div>
        <button
          onClick={() => {
            localStorage.removeItem('reviewer');
            router.push('/');
          }}
          style={{
            padding: '8px 16px',
            background: '#f1f5f9',
            color: '#475569',
            border: 'none',
            borderRadius: '8px',
            fontSize: '13px',
            cursor: 'pointer'
          }}
        >退出登录</button>
      </div>

      <div style={{ display: 'flex', maxWidth: '1400px', margin: '0 auto' }}>
        {/* 左侧项目列表 */}
        <div style={{
          width: '300px',
          background: 'white',
          borderRight: '1px solid #e2e8f0',
          minHeight: 'calc(100vh - 65px)'
        }}>
          <div style={{
            padding: '16px 20px',
            borderBottom: '1px solid #e2e8f0',
            fontSize: '13px',
            fontWeight: '600',
            color: '#64748b'
          }}>
            项目列表 ({projects.length})
          </div>
          {loading ? (
            <div style={{ padding: 20, color: '#94a3b8' }}>加载中...</div>
          ) : projects.map(p => {
            const total = getProjectTotal(p.id);
            const baseTotal = getProjectBaseScore(p.id);
            const bonus = bonusValue[p.id] || 0;
            const completion = getProjectCompletion(p.id);
            const isActive = activeProject?.id === p.id;
            return (
              <div
                key={p.id}
                onClick={() => setActiveProject(p)}
                style={{
                  padding: '14px 20px',
                  borderBottom: '1px solid #f1f5f9',
                  cursor: 'pointer',
                  background: isActive ? '#eff6ff' : 'white',
                  borderLeft: isActive ? '3px solid #3b82f6' : '3px solid transparent',
                  transition: 'all 0.15s'
                }}
              >
                <div style={{
                  fontSize: '14px',
                  fontWeight: '600',
                  color: isActive ? '#1e40af' : '#0f172a',
                  marginBottom: '4px'
                }}>
                  {p.seq_no}. {p.name}
                </div>
                <div style={{ fontSize: '12px', color: '#64748b', marginBottom: '8px' }}>
                  提报人: {p.submitter}
                </div>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                  <div style={{
                    flex: 1,
                    height: '4px',
                    background: '#e2e8f0',
                    borderRadius: '2px',
                    marginRight: '8px',
                    overflow: 'hidden'
                  }}>
                    <div style={{
                      width: `${completion}%`,
                      height: '100%',
                      background: completion === 100 ? '#10b981' : '#3b82f6',
                      transition: 'width 0.3s'
                    }}/>
                  </div>
                  <span style={{
                    fontSize: '12px',
                    fontWeight: '600',
                    color: completion === 100 ? '#10b981' : '#64748b'
                  }}>
                    {completion}%
                  </span>
                </div>
                {completion === 100 && (
                  <div style={{
                    marginTop: '6px',
                    fontSize: '12px',
                    color: '#10b981',
                    fontWeight: '600'
                  }}>
                    合计: {baseTotal.toFixed(1)}
                    {bonus > 0 && (
                      <span style={{ color: '#f59e0b' }}> + ✨{bonus}</span>
                    )}
                    <span style={{ color: '#94a3b8', fontWeight: '400' }}> = {total.toFixed(1)}</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* 右侧打分区 */}
        <div style={{ flex: 1, padding: '32px 40px' }}>
          {!activeProject ? (
            <div style={{ textAlign: 'center', color: '#94a3b8', marginTop: 100 }}>请选择左侧项目开始打分</div>
          ) : (
            <>
              <div style={{ marginBottom: '24px' }}>
                <h1 style={{
                  fontSize: '28px',
                  fontWeight: '700',
                  color: '#0f172a',
                  margin: '0 0 8px'
                }}>
                  {activeProject.seq_no}. {activeProject.name}
                </h1>
                <div style={{ fontSize: '14px', color: '#64748b' }}>
                  提报人: {activeProject.submitter}
                </div>
              </div>

              {activeMeeting?.deadline && (
                <div style={{
                  background: '#fef3c7',
                  border: '1px solid #fde68a',
                  color: '#92400e',
                  padding: '10px 16px',
                  borderRadius: '8px',
                  fontSize: '13px',
                  marginBottom: '20px'
                }}>
                  ⏰ 打分截止日期: {activeMeeting.deadline}（截止后可读不可改）
                </div>
              )}

              {/* 维度打分 */}
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
                gap: '16px',
                marginBottom: '24px'
              }}>
                {reviewer.dimensions.map(dim => {
                  const currentScore = scores[activeProject.id]?.[dim.dim_name];
                  return (
                    <div key={dim.dim_name} style={{
                      background: 'white',
                      borderRadius: '14px',
                      padding: '20px',
                      border: '1.5px solid #e2e8f0',
                      transition: 'all 0.2s'
                    }}>
                      <div style={{
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        marginBottom: '14px'
                      }}>
                        <div style={{ fontSize: '15px', fontWeight: '600', color: '#0f172a' }}>
                          {dim.dim_name}
                        </div>
                        <div style={{
                          background: '#eff6ff',
                          color: '#1e40af',
                          padding: '4px 10px',
                          borderRadius: '20px',
                          fontSize: '12px',
                          fontWeight: '600'
                        }}>
                          满分 {dim.max_score}
                        </div>
                      </div>

                      {/* 数字输入框 + 滑块 */}
                      <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '8px' }}>
                        <input
                          type="number"
                          min="0"
                          max={dim.max_score}
                          step="1"
                          value={currentScore ?? ''}
                          placeholder="0"
                          onChange={(e) => {
                            const v = Math.max(0, Math.min(dim.max_score, Number(e.target.value) || 0));
                            handleScoreChange(dim.dim_name, v);
                          }}
                          style={{
                            width: '80px',
                            padding: '10px 12px',
                            fontSize: '20px',
                            fontWeight: '700',
                            color: '#1e40af',
                            border: '2px solid #3b82f6',
                            borderRadius: '8px',
                            textAlign: 'center',
                            outline: 'none'
                          }}
                        />
                        <span style={{ fontSize: '14px', color: '#94a3b8' }}>/ {dim.max_score}</span>
                      </div>

                      {/* 滑块（辅助） */}
                      <input
                        type="range"
                        min="0"
                        max={dim.max_score}
                        step="1"
                        value={currentScore || 0}
                        onChange={(e) => handleScoreChange(dim.dim_name, Number(e.target.value))}
                        style={{
                          width: '100%',
                          accentColor: '#3b82f6',
                          cursor: 'pointer'
                        }}
                      />
                    </div>
                  );
                })}
              </div>

              {/* Walker 加分项 */}
              {isWalker && (
                <div style={{
                  background: 'linear-gradient(135deg, #fef3c7, #fde68a)',
                  borderRadius: '14px',
                  padding: '20px 24px',
                  border: '2px solid #f59e0b',
                  marginBottom: '24px'
                }}>
                  <div style={{
                    fontSize: '16px',
                    fontWeight: '700',
                    color: '#92400e',
                    marginBottom: '14px',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '8px'
                  }}>
                    🎁 Walker 加分项
                    <span style={{
                      fontSize: '12px',
                      fontWeight: '500',
                      color: '#a16207',
                      background: 'rgba(255,255,255,0.5)',
                      padding: '2px 8px',
                      borderRadius: '10px'
                    }}>专属</span>
                  </div>

                  <div style={{ marginBottom: '12px' }}>
                    <label style={{ fontSize: '13px', color: '#78350f', fontWeight: '600', display: 'block', marginBottom: '6px' }}>
                      加分原因
                    </label>
                    <textarea
                      value={bonusReason[activeProject.id] || ''}
                      onChange={(e) => setBonusReason(prev => ({ ...prev, [activeProject.id]: e.target.value }))}
                      placeholder="例如：玩法有突破性创新 / 团队执行力强 / 战略价值高..."
                      rows={2}
                      style={{
                        width: '100%',
                        padding: '10px 12px',
                        fontSize: '14px',
                        border: '1.5px solid #fbbf24',
                        borderRadius: '8px',
                        resize: 'vertical',
                        outline: 'none',
                        background: 'white',
                        boxSizing: 'border-box'
                      }}
                    />
                  </div>

                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: '12px' }}>
                    <div style={{ flex: 1 }}>
                      <label style={{ fontSize: '13px', color: '#78350f', fontWeight: '600', display: 'block', marginBottom: '6px' }}>
                        加分值（1-5 分）
                      </label>
                      <input
                        type="number"
                        min="1"
                        max="5"
                        step="1"
                        value={bonusValue[activeProject.id] ?? ''}
                        placeholder="1-5"
                        onChange={(e) => {
                          const v = Math.max(1, Math.min(5, Number(e.target.value) || 1));
                          setBonusValue(prev => ({ ...prev, [activeProject.id]: v }));
                        }}
                        style={{
                          width: '100%',
                          padding: '10px 12px',
                          fontSize: '16px',
                          fontWeight: '600',
                          color: '#92400e',
                          border: '2px solid #f59e0b',
                          borderRadius: '8px',
                          textAlign: 'center',
                          outline: 'none',
                          boxSizing: 'border-box'
                        }}
                      />
                    </div>
                    <button
                      onClick={handleBonusSave}
                      disabled={saving}
                      style={{
                        padding: '10px 24px',
                        background: '#f59e0b',
                        color: 'white',
                        border: 'none',
                        borderRadius: '8px',
                        fontSize: '14px',
                        fontWeight: '700',
                        cursor: saving ? 'not-allowed' : 'pointer',
                        opacity: saving ? 0.6 : 1,
                        whiteSpace: 'nowrap'
                      }}
                    >
                      ✨ 保存加分
                    </button>
                  </div>

                  {bonusValue[activeProject.id] && (
                    <div style={{
                      marginTop: '12px',
                      padding: '10px 14px',
                      background: 'rgba(255,255,255,0.7)',
                      borderRadius: '8px',
                      fontSize: '13px',
                      color: '#78350f',
                      fontWeight: '600'
                    }}>
                      ✨ 当前加分: +{bonusValue[activeProject.id]} 分
                      {bonusReason[activeProject.id] && `（${bonusReason[activeProject.id].substring(0, 30)}${bonusReason[activeProject.id].length > 30 ? '...' : ''}）`}
                    </div>
                  )}
                </div>
              )}

              {/* 存在问题 / 整改意见 */}
              <div style={{
                background: 'white',
                borderRadius: '14px',
                padding: '20px 24px',
                border: '1.5px solid #e2e8f0',
                marginBottom: '24px'
              }}>
                <div style={{
                  fontSize: '15px',
                  fontWeight: '700',
                  color: '#0f172a',
                  marginBottom: '16px'
                }}>
                  📝 评审意见
                </div>

                <div style={{ marginBottom: '14px' }}>
                  <label style={{
                    fontSize: '13px',
                    color: '#dc2626',
                    fontWeight: '600',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '6px'
                  }}>
                    ⚠️ 存在问题
                    <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '400' }}>每行一条</span>
                  </label>
                  <textarea
                    value={projectProblems[activeProject.id] || ''}
                    onChange={(e) => setProjectProblems(prev => ({ ...prev, [activeProject.id]: e.target.value }))}
                    placeholder="例如：&#10;核心玩法深度不足&#10;美术风格未统一&#10;商业化路径不清晰"
                    rows={4}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      fontSize: '13px',
                      border: '1.5px solid #fecaca',
                      borderRadius: '8px',
                      resize: 'vertical',
                      outline: 'none',
                      background: '#fef2f2',
                      boxSizing: 'border-box',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>

                <div style={{ marginBottom: '14px' }}>
                  <label style={{
                    fontSize: '13px',
                    color: '#16a34a',
                    fontWeight: '600',
                    display: 'flex',
                    alignItems: 'center',
                    gap: '6px',
                    marginBottom: '6px'
                  }}>
                    ✅ 整改意见
                    <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '400' }}>每行一条</span>
                  </label>
                  <textarea
                    value={projectActions[activeProject.id] || ''}
                    onChange={(e) => setProjectActions(prev => ({ ...prev, [activeProject.id]: e.target.value }))}
                    placeholder="例如：&#10;补充可玩性深度规划&#10;统一美术风格定位&#10;制定明确的商业化方案"
                    rows={4}
                    style={{
                      width: '100%',
                      padding: '10px 12px',
                      fontSize: '13px',
                      border: '1.5px solid #bbf7d0',
                      borderRadius: '8px',
                      resize: 'vertical',
                      outline: 'none',
                      background: '#f0fdf4',
                      boxSizing: 'border-box',
                      fontFamily: 'inherit'
                    }}
                  />
                </div>

                <button
                  onClick={handleProblemsActionsSave}
                  style={{
                    padding: '8px 20px',
                    background: '#0f172a',
                    color: 'white',
                    border: 'none',
                    borderRadius: '8px',
                    fontSize: '13px',
                    fontWeight: '600',
                    cursor: 'pointer'
                  }}
                >
                  💾 保存评审意见
                </button>
              </div>

              {message && (
                <div style={{
                  marginTop: '20px',
                  textAlign: 'center',
                  color: message.startsWith('✓') ? '#10b981' : '#dc2626',
                  fontSize: '13px',
                  fontWeight: '600',
                  padding: '10px',
                  background: message.startsWith('✓') ? '#f0fdf4' : '#fef2f2',
                  borderRadius: '8px'
                }}>
                  {message}
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}