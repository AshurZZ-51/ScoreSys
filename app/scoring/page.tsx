'use client';

import { useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { DIMENSION_BY_NAME, SCORING_DIMENSIONS, scoreKey } from '@/lib/scoringRules';

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
  project_id: string;
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
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [scores, setScores] = useState<Record<string, Record<string, number>>>({});
  const [projectProblems, setProjectProblems] = useState<Record<string, string>>({});
  const [projectActions, setProjectActions] = useState<Record<string, string>>({});
  const [bonusReason, setBonusReason] = useState<Record<string, string>>({});
  const [bonusValue, setBonusValue] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const isWalker = reviewer?.code?.toUpperCase() === 'W';
  const reviewerRules = useMemo(() => {
    if (!reviewer) return [];
    const names = new Set(reviewer.dimensions.map((dim) => dim.dim_name));
    return SCORING_DIMENSIONS.filter((rule: any) => names.has(rule.name));
  }, [reviewer]);

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
    const res = await fetch('/api/meetings', { cache: 'no-store' });
    const data = await res.json();
    const all = data.meetings || [];
    setMeetings(all);
    if (all.length > 0) {
      const current = all.find((m: Meeting) => m.is_current) || all[0];
      setActiveMeeting(current);
      await loadProjects(current.id);
    }
  };

  const loadProjects = async (meetingId: string) => {
    setLoading(true);
    try {
      const res = await fetch(`/api/projects?meetingId=${meetingId}&role=reviewer`, { cache: 'no-store' });
      const data = await res.json();
      const nextProjects = data.projects || [];
      setProjects(nextProjects);
      setActiveProject(nextProjects[0] || null);
      await loadScores(meetingId);
    } finally {
      setLoading(false);
    }
  };

  const loadScores = async (meetingId: string) => {
    const stored = localStorage.getItem('reviewer');
    if (!stored) return;
    const r = JSON.parse(stored);
    const res = await fetch(`/api/scores?meetingId=${meetingId}&reviewerCode=${r.code}`, { cache: 'no-store' });
    const data = await res.json();
    const scoreMap: Record<string, Record<string, number>> = {};
    const probMap: Record<string, string> = {};
    const actMap: Record<string, string> = {};
    const bonusReasonMap: Record<string, string> = {};
    const bonusValueMap: Record<string, number> = {};

    (data.scores || []).forEach((s: Score) => {
      if (s.dim_name === '__bonus__') {
        bonusValueMap[s.project_id] = Number(s.score);
        bonusReasonMap[s.project_id] = s.comment || '';
      } else if (s.dim_name === '__problems__') {
        probMap[s.project_id] = s.comment || '';
      } else if (s.dim_name === '__actions__') {
        actMap[s.project_id] = s.comment || '';
      } else {
        if (!scoreMap[s.project_id]) scoreMap[s.project_id] = {};
        scoreMap[s.project_id][s.dim_name] = Number(s.score);
      }
    });

    setScores(scoreMap);
    setProjectProblems(probMap);
    setProjectActions(actMap);
    setBonusReason(bonusReasonMap);
    setBonusValue(bonusValueMap);
  };

  const showMessage = (text: string) => {
    setMessage(text);
    setTimeout(() => setMessage(''), 1800);
  };

  const handleScoreChange = async (dimName: string, value: number, comment?: string | null) => {
    if (!activeMeeting || !activeProject || !reviewer || Number.isNaN(value)) return;
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
        showMessage(data.error || '保存失败');
      } else {
        setScores((prev) => ({
          ...prev,
          [activeProject.id]: { ...prev[activeProject.id], [dimName]: value }
        }));
        showMessage('已保存');
      }
    } catch (err: any) {
      showMessage(err.message);
    } finally {
      setSaving(false);
    }
  };

  const handleBonusSave = async () => {
    if (!activeProject) return;
    const reason = (bonusReason[activeProject.id] || '').trim();
    const value = bonusValue[activeProject.id];
    if (!value || value < 1 || value > 5) {
      showMessage('加分值必须在 1-5 之间');
      return;
    }
    if (!reason) {
      showMessage('请填写加分原因');
      return;
    }
    await handleScoreChange('__bonus__', value, reason);
  };

  const handleProblemsActionsSave = async () => {
    if (!activeMeeting || !activeProject || !reviewer) return;
    const problemsText = (projectProblems[activeProject.id] || '').trim();
    const actionsText = (projectActions[activeProject.id] || '').trim();
    const payloadBase = {
      meeting_id: activeMeeting.id,
      project_id: activeProject.id,
      reviewer_code: reviewer.code,
      score: 0
    };

    const [problemsRes, actionsRes] = await Promise.all([
      fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payloadBase, dim_name: '__problems__', comment: problemsText || null })
      }),
      fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payloadBase, dim_name: '__actions__', comment: actionsText || null })
      })
    ]);

    if (problemsRes.ok && actionsRes.ok) showMessage('评审意见已保存');
    else showMessage('评审意见保存失败');
  };

  const getExpectedCount = () => reviewerRules.reduce((sum: number, rule: any) => {
    return sum + (rule.type === 'level' ? 1 : rule.items.length);
  }, 0);

  const getProjectCompletion = (projectId: string) => {
    const current = scores[projectId] || {};
    const expected = getExpectedCount();
    if (!expected) return 0;
    const filled = reviewerRules.reduce((sum: number, rule: any) => {
      if (rule.type === 'level') return sum + (current[scoreKey(rule.name, 'level')] !== undefined ? 1 : 0);
      return sum + rule.items.filter((item: any) => current[scoreKey(rule.name, item.key)] !== undefined).length;
    }, 0);
    return Math.round((filled / expected) * 100);
  };

  const getLocalRawTotal = (projectId: string) => Object.values(scores[projectId] || {}).reduce((sum, value) => sum + value, 0);

  if (!reviewer) return <div style={{ padding: 40 }}>加载中...</div>;

  return (
    <div style={{ minHeight: '100vh', background: '#f8fafc', fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", sans-serif' }}>
      <div style={{ background: 'white', borderBottom: '1px solid #e2e8f0', padding: '14px 32px', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <div>
          <div style={{ fontSize: 16, fontWeight: 700, color: '#0f172a' }}>{reviewer.name} <span style={{ color: '#64748b', fontWeight: 500, fontSize: 13 }}>· {reviewer.role}</span></div>
          <select
            value={activeMeeting?.id || ''}
            onChange={(event) => {
              const meeting = meetings.find((m) => m.id === event.target.value);
              if (!meeting) return;
              setActiveMeeting(meeting);
              setScores({});
              setProjectProblems({});
              setProjectActions({});
              setBonusReason({});
              setBonusValue({});
              loadProjects(meeting.id);
            }}
            style={{ marginTop: 6, padding: '4px 8px', border: '1px solid #e2e8f0', borderRadius: 6, background: 'white' }}
          >
            {meetings.map((meeting) => <option key={meeting.id} value={meeting.id}>{meeting.is_current ? '当前 · ' : ''}{meeting.name}</option>)}
          </select>
        </div>
        <button onClick={() => { localStorage.removeItem('reviewer'); router.push('/'); }} style={{ padding: '8px 16px', border: 'none', borderRadius: 8, background: '#f1f5f9', color: '#475569', cursor: 'pointer' }}>退出登录</button>
      </div>

      <div style={{ display: 'flex', maxWidth: 1420, margin: '0 auto' }}>
        <aside style={{ width: 320, background: 'white', borderRight: '1px solid #e2e8f0', minHeight: 'calc(100vh - 65px)' }}>
          <div style={{ padding: '16px 20px', borderBottom: '1px solid #e2e8f0', fontSize: 13, fontWeight: 700, color: '#64748b' }}>项目列表 ({projects.length})</div>
          {loading ? <div style={{ padding: 20, color: '#94a3b8' }}>加载中...</div> : projects.map((project) => {
            const completion = getProjectCompletion(project.id);
            const active = activeProject?.id === project.id;
            return (
              <button key={project.id} onClick={() => setActiveProject(project)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '14px 20px', border: 'none', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: active ? '#eff6ff' : 'white', borderLeft: active ? '3px solid #3b82f6' : '3px solid transparent' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: active ? '#1e40af' : '#0f172a', marginBottom: 4 }}>{project.seq_no}. {project.name}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>提报人：{project.submitter}</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}><div style={{ width: `${completion}%`, height: '100%', background: completion === 100 ? '#10b981' : '#3b82f6' }} /></div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: completion === 100 ? '#10b981' : '#64748b' }}>{completion}%</span>
                </div>
                {completion === 100 && <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>已填原始项合计：{getLocalRawTotal(project.id).toFixed(1)}</div>}
              </button>
            );
          })}
        </aside>

        <main style={{ flex: 1, padding: '32px 40px' }}>
          {!activeProject ? <div style={{ textAlign: 'center', color: '#94a3b8', marginTop: 100 }}>请选择左侧项目开始打分</div> : (
            <>
              <div style={{ marginBottom: 22 }}>
                <h1 style={{ margin: '0 0 8px', fontSize: 28, color: '#0f172a' }}>{activeProject.seq_no}. {activeProject.name}</h1>
                <div style={{ fontSize: 14, color: '#64748b' }}>提报人：{activeProject.submitter}</div>
              </div>

              <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3', padding: '12px 16px', borderRadius: 10, fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
                评分方法：打分型子项均为 0-10 分，按维度权重换算；创新性直接选择 4/6/10/14/20 档。管理员汇总时按多评委平均或中位档计算项目总分。
              </div>

              {activeMeeting?.deadline && <div style={{ background: '#fef3c7', border: '1px solid #fde68a', color: '#92400e', padding: '10px 16px', borderRadius: 8, fontSize: 13, marginBottom: 20 }}>打分截止日期：{activeMeeting.deadline}</div>}

              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))', gap: 16, marginBottom: 24 }}>
                {reviewerRules.map((rule: any) => {
                  const ruleScores = scores[activeProject.id] || {};
                  return (
                    <section key={rule.name} style={{ background: 'white', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 14 }}>
                        <div>
                          <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a' }}>{rule.name}</div>
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{rule.type === 'level' ? '档位型，汇总取中位档' : `子项平均 × ${rule.multiplier}`}</div>
                        </div>
                        <div style={{ background: '#eff6ff', color: '#1e40af', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>满分 {rule.maxScore}</div>
                      </div>

                      {rule.type === 'level' ? (
                        <div style={{ display: 'grid', gap: 8 }}>
                          {rule.levels.map((level: number) => {
                            const key = scoreKey(rule.name, 'level');
                            const selected = ruleScores[key] === level;
                            return (
                              <button key={level} onClick={() => handleScoreChange(key, level)} disabled={saving} style={{ padding: '10px 12px', textAlign: 'left', borderRadius: 9, border: selected ? '2px solid #8b5cf6' : '1px solid #e2e8f0', background: selected ? '#f5f3ff' : 'white', color: selected ? '#6d28d9' : '#334155', cursor: 'pointer', fontWeight: selected ? 800 : 600 }}>
                                <span style={{ display: 'inline-block', minWidth: 42 }}>{level}分</span>{rule.levelLabels[level]}
                              </button>
                            );
                          })}
                        </div>
                      ) : (
                        <div style={{ display: 'grid', gap: 14 }}>
                          {rule.items.map((item: any) => {
                            const key = scoreKey(rule.name, item.key);
                            const current = ruleScores[key];
                            return (
                              <div key={item.key}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                  <label style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{item.label}</label>
                                  <span style={{ fontSize: 12, color: '#64748b' }}>{current ?? '-'} / 10</span>
                                </div>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                  <input type="range" min="0" max="10" step="1" value={current ?? 0} onChange={(event) => handleScoreChange(key, Number(event.target.value))} style={{ flex: 1, accentColor: '#3b82f6' }} />
                                  <input type="number" min="0" max="10" step="1" value={current ?? ''} placeholder="0" onChange={(event) => handleScoreChange(key, Math.max(0, Math.min(10, Number(event.target.value) || 0)))} style={{ width: 70, padding: '8px 10px', fontSize: 16, fontWeight: 800, border: '1.5px solid #cbd5e1', borderRadius: 8, textAlign: 'center' }} />
                                </div>
                              </div>
                            );
                          })}
                        </div>
                      )}
                    </section>
                  );
                })}
              </div>

              {isWalker && (
                <section style={{ background: '#fffbeb', border: '1.5px solid #f59e0b', borderRadius: 12, padding: 20, marginBottom: 24 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#92400e', marginBottom: 12 }}>Walker 加分项</div>
                  <textarea value={bonusReason[activeProject.id] || ''} onChange={(event) => setBonusReason((prev) => ({ ...prev, [activeProject.id]: event.target.value }))} placeholder="填写加分原因" rows={2} style={{ width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid #fbbf24', borderRadius: 8, marginBottom: 10 }} />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input type="number" min="1" max="5" step="1" value={bonusValue[activeProject.id] ?? ''} placeholder="1-5" onChange={(event) => setBonusValue((prev) => ({ ...prev, [activeProject.id]: Math.max(1, Math.min(5, Number(event.target.value) || 1)) }))} style={{ width: 100, padding: 10, border: '1px solid #f59e0b', borderRadius: 8, fontWeight: 800 }} />
                    <button onClick={handleBonusSave} disabled={saving} style={{ padding: '10px 18px', border: 'none', borderRadius: 8, background: '#f59e0b', color: 'white', fontWeight: 800, cursor: 'pointer' }}>保存加分</button>
                  </div>
                </section>
              )}

              <section style={{ background: 'white', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', marginBottom: 14 }}>评审意见</div>
                <label style={{ display: 'block', fontSize: 13, color: '#dc2626', fontWeight: 700, marginBottom: 6 }}>存在问题（每行一条）</label>
                <textarea value={projectProblems[activeProject.id] || ''} onChange={(event) => setProjectProblems((prev) => ({ ...prev, [activeProject.id]: event.target.value }))} rows={4} style={{ width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', marginBottom: 14 }} />
                <label style={{ display: 'block', fontSize: 13, color: '#16a34a', fontWeight: 700, marginBottom: 6 }}>整改意见（每行一条）</label>
                <textarea value={projectActions[activeProject.id] || ''} onChange={(event) => setProjectActions((prev) => ({ ...prev, [activeProject.id]: event.target.value }))} rows={4} style={{ width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid #bbf7d0', borderRadius: 8, background: '#f0fdf4', marginBottom: 14 }} />
                <button onClick={handleProblemsActionsSave} style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: '#0f172a', color: 'white', fontWeight: 700, cursor: 'pointer' }}>保存评审意见</button>
              </section>

              {message && <div style={{ marginTop: 18, padding: 10, textAlign: 'center', borderRadius: 8, fontSize: 13, fontWeight: 700, color: message.includes('失败') || message.includes('必须') || message.includes('请') ? '#dc2626' : '#059669', background: message.includes('失败') || message.includes('必须') || message.includes('请') ? '#fef2f2' : '#f0fdf4' }}>{message}</div>}
            </>
          )}
        </main>
      </div>
    </div>
  );
}
