'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { SCORING_DIMENSIONS, computeRoundBaseScoreFromScoreMap, roundScoreKey, specialScoreKey } from '@/lib/scoringRules';
import { ROUND_LABELS, ROUND_TITLES, VERDICT_OPTIONS, getReviewStatus } from '@/lib/reviewWorkflow';
import { createSaveFeedback } from '@/lib/saveFeedback';

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
  round_no?: number;
  attempt_no?: number;
  scoring_version?: string;
  currentRound?: string;
  reviewStatus?: string;
  materialStatus?: string;
  roundSummaries?: Record<string, any>;
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

type FeedbackTone = 'saving' | 'success' | 'error';

interface SaveFeedback {
  tone: FeedbackTone;
  text: string;
}

export default function ScoringPage() {
  const router = useRouter();
  const [reviewer, setReviewer] = useState<Reviewer | null>(null);
  const [meetings, setMeetings] = useState<Meeting[]>([]);
  const [activeMeeting, setActiveMeeting] = useState<Meeting | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [activeProject, setActiveProject] = useState<Project | null>(null);
  const [scores, setScores] = useState<Record<string, Record<string, number>>>({});
  const [scoreDrafts, setScoreDrafts] = useState<Record<string, Record<string, string>>>({});
  const [projectProblems, setProjectProblems] = useState<Record<string, string>>({});
  const [projectActions, setProjectActions] = useState<Record<string, string>>({});
  const [projectVerdicts, setProjectVerdicts] = useState<Record<string, string | null>>({});
  const [bonusReason, setBonusReason] = useState<Record<string, string>>({});
  const [bonusValue, setBonusValue] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveFeedback, setSaveFeedback] = useState<SaveFeedback | null>(null);
  const saveTimers = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  const saveVersions = useRef<Record<string, number>>({});
  const feedbackTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const isWalker = reviewer?.code?.toUpperCase() === 'W';
  const getActiveRound = (project = activeProject) => project?.round_no ? `r${project.round_no}` : project?.currentRound || 'r1';
  const roundFieldKey = (projectId: string, roundId: string) => `${projectId}:${roundId}`;
  const reviewerRules = useMemo(() => {
    const roundId = getActiveRound();
    return SCORING_DIMENSIONS.filter((rule: any) => rule.roundId === roundId);
  }, [activeProject?.currentRound, activeProject?.round_no]);

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
      const res = await fetch(`/api/summary?meetingId=${meetingId}`, { cache: 'no-store' });
      const data = await res.json();
      const nextProjects = (data.projects || []).filter((project: Project) => (
        project.name
        && project.submitter
        && !['cancelled', 'initiation', 'r1_rejected', 'r2_rejected', 'rejected'].includes(project.reviewStatus || '')
      ));
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
    const scoreDraftMap: Record<string, Record<string, string>> = {};
    const probMap: Record<string, string> = {};
    const actMap: Record<string, string> = {};
    const verdictMap: Record<string, string | null> = {};
    const bonusReasonMap: Record<string, string> = {};
    const bonusValueMap: Record<string, string> = {};

    (data.scores || []).forEach((s: Score) => {
      const parts = String(s.dim_name).split('::');
      const roundId = parts[0] === 'r1' || parts[0] === 'r2' ? parts[0] : 'legacy';
      const baseDimName = roundId === 'legacy' ? s.dim_name : parts.slice(1).join('::');
      const scopedKey = roundFieldKey(s.project_id, roundId);
      if (baseDimName === '__bonus__') {
        bonusValueMap[scopedKey] = String(Number(s.score));
        bonusReasonMap[scopedKey] = s.comment || '';
      } else if (baseDimName === '__problems__') {
        probMap[scopedKey] = s.comment || '';
      } else if (baseDimName === '__actions__') {
        actMap[scopedKey] = s.comment || '';
      } else if (baseDimName === '__verdict__') {
        verdictMap[scopedKey] = s.comment || null;
      } else {
        if (!scoreMap[s.project_id]) scoreMap[s.project_id] = {};
        if (!scoreDraftMap[s.project_id]) scoreDraftMap[s.project_id] = {};
        scoreMap[s.project_id][s.dim_name] = Number(s.score);
        scoreDraftMap[s.project_id][s.dim_name] = String(Number(s.score));
      }
    });

    setScores(scoreMap);
    setScoreDrafts(scoreDraftMap);
    setProjectProblems(probMap);
    setProjectActions(actMap);
    setProjectVerdicts(verdictMap);
    setBonusReason(bonusReasonMap);
    setBonusValue(bonusValueMap);
  };

  const showFeedback = (feedback: SaveFeedback, duration = 2200) => {
    if (feedbackTimer.current) clearTimeout(feedbackTimer.current);
    setSaveFeedback(feedback);
    if (duration > 0) {
      feedbackTimer.current = setTimeout(() => setSaveFeedback(null), duration);
    }
  };

  const showSaveFeedback = (state: FeedbackTone, action: string, errorMessage = '') => {
    showFeedback(createSaveFeedback(state, action, errorMessage), state === 'saving' ? 0 : 2400);
  };

  const showMessage = (text: string) => {
    showFeedback({ tone: 'error', text }, 3000);
  };

  const getSaveAction = (dimName: string) => {
    const baseDimName = String(dimName).replace(/^r[12]::/, '');
    if (baseDimName === '__bonus__') return '加分';
    if (baseDimName === '__problems__' || baseDimName === '__actions__') return '评审意见';
    if (baseDimName === '__verdict__') return '评审结论';
    return '评分';
  };

  const legacyHandleScoreChange = async (dimName: string, value: number, comment?: string | null) => {
    if (!activeMeeting || !activeProject || !reviewer || Number.isNaN(value)) return;
    setSaving(true);
    showSaveFeedback('saving', '评分');
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
        showSaveFeedback('error', '评分', data.error || '请稍后重试');
      } else {
        setScores((prev) => ({
          ...prev,
          [activeProject.id]: { ...prev[activeProject.id], [dimName]: value }
        }));
        showSaveFeedback('success', '评分');
      }
    } catch (err: any) {
      showSaveFeedback('error', '评分', err.message || '请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const persistScore = async (projectId: string, dimName: string, value: number, comment?: string | null) => {
    if (!activeMeeting || !reviewer || Number.isNaN(value)) return;
    const saveKey = `${projectId}:${dimName}`;
    const version = (saveVersions.current[saveKey] || 0) + 1;
    saveVersions.current[saveKey] = version;
    setSaving(true);
    const action = getSaveAction(dimName);
    showSaveFeedback('saving', action);
    try {
      const res = await fetch('/api/scores', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          meeting_id: activeMeeting.id,
          project_id: projectId,
          reviewer_code: reviewer.code,
          dim_name: dimName,
          score: value,
          comment: comment || null
        })
      });
      const data = await res.json();
      if (saveVersions.current[saveKey] !== version) return;
      if (!res.ok) showSaveFeedback('error', action, data.error || '请稍后重试');
      else showSaveFeedback('success', action);
    } catch (err: any) {
      if (saveVersions.current[saveKey] === version) showSaveFeedback('error', action, err.message || '请稍后重试');
    } finally {
      if (saveVersions.current[saveKey] === version) setSaving(false);
    }
  };

  const schedulePersistScore = (projectId: string, dimName: string, value: number, comment?: string | null, delay = 450) => {
    const saveKey = `${projectId}:${dimName}`;
    if (saveTimers.current[saveKey]) clearTimeout(saveTimers.current[saveKey]);
    saveTimers.current[saveKey] = setTimeout(() => {
      persistScore(projectId, dimName, value, comment);
    }, delay);
  };

  const setLocalScore = (projectId: string, dimName: string, value: number) => {
    setScores((prev) => ({
      ...prev,
      [projectId]: { ...prev[projectId], [dimName]: value }
    }));
    setScoreDrafts((prev) => ({
      ...prev,
      [projectId]: { ...prev[projectId], [dimName]: String(value) }
    }));
  };

  const handleScoreChange = (dimName: string, value: number, comment?: string | null, immediate = false) => {
    if (!activeProject || Number.isNaN(value)) return;
    setLocalScore(activeProject.id, dimName, value);
    schedulePersistScore(activeProject.id, dimName, value, comment, immediate ? 0 : 450);
  };

  const handleNumericDraftChange = (dimName: string, raw: string) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    setScoreDrafts((prev) => ({
      ...prev,
      [projectId]: { ...prev[projectId], [dimName]: raw }
    }));
    if (raw === '') return;
    const value = Math.max(0, Math.min(10, Number(raw)));
    if (Number.isNaN(value)) return;
    setScores((prev) => ({
      ...prev,
      [projectId]: { ...prev[projectId], [dimName]: value }
    }));
    schedulePersistScore(projectId, dimName, value);
  };

  const commitNumericDraft = (dimName: string) => {
    if (!activeProject) return;
    const projectId = activeProject.id;
    const raw = scoreDrafts[projectId]?.[dimName] ?? '';
    const value = raw === '' ? 0 : Math.max(0, Math.min(10, Number(raw)));
    if (Number.isNaN(value)) return;
    setLocalScore(projectId, dimName, value);
    schedulePersistScore(projectId, dimName, value, null, 0);
  };

  const legacyHandleBonusSave = async () => {
    if (!activeProject) return;
    const reason = (bonusReason[activeProject.id] || '').trim();
    const value = Number(bonusValue[activeProject.id]);
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

  const handleBonusSave = async () => {
    if (!activeProject) return;
    const roundId = getActiveRound();
    const scopedKey = roundFieldKey(activeProject.id, roundId);
    const reason = (bonusReason[scopedKey] || '').trim();
    const rawValue = bonusValue[scopedKey] ?? '';
    const value = rawValue === '' ? 0 : Math.max(0, Math.min(5, Number(rawValue)));
    if (Number.isNaN(value)) {
      showMessage('加分值必须是 0-5');
      return;
    }
    if (value > 0 && !reason) {
      showMessage('请填写加分原因');
      return;
    }
    setBonusValue((prev) => ({ ...prev, [scopedKey]: String(value) }));
    await persistScore(activeProject.id, specialScoreKey(roundId, '__bonus__'), value, reason);
  };

  const handleProblemsActionsSave = async () => {
    if (!activeMeeting || !activeProject || !reviewer) return;
    const roundId = getActiveRound();
    const scopedKey = roundFieldKey(activeProject.id, roundId);
    const problemsText = (projectProblems[scopedKey] || '').trim();
    const actionsText = (projectActions[scopedKey] || '').trim();
    const payloadBase = {
      meeting_id: activeMeeting.id,
      project_id: activeProject.id,
      reviewer_code: reviewer.code,
      score: 0
    };

    setSaving(true);
    showSaveFeedback('saving', '评审意见');
    try {
      const [problemsRes, actionsRes] = await Promise.all([
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payloadBase, dim_name: specialScoreKey(roundId, '__problems__'), comment: problemsText || null })
        }),
        fetch('/api/scores', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ...payloadBase, dim_name: specialScoreKey(roundId, '__actions__'), comment: actionsText || null })
        })
      ]);
      if (problemsRes.ok && actionsRes.ok) {
        showSaveFeedback('success', '评审意见');
      } else {
        const failedRes = problemsRes.ok ? actionsRes : problemsRes;
        const failedData = await failedRes.json().catch(() => ({}));
        showSaveFeedback('error', '评审意见', failedData.error || '请稍后重试');
      }
    } catch (err: any) {
      showSaveFeedback('error', '评审意见', err.message || '请稍后重试');
    } finally {
      setSaving(false);
    }
  };

  const persistTextField = (projectId: string, dimName: '__problems__' | '__actions__', comment: string, delay = 650) => {
    const roundId = getActiveRound();
    schedulePersistScore(projectId, specialScoreKey(roundId, dimName), 0, comment.trim() || null, delay);
  };

  const handleVerdictChange = (value: string) => {
    if (!activeProject) return;
    const roundId = getActiveRound();
    const scopedKey = roundFieldKey(activeProject.id, roundId);
    const next = projectVerdicts[scopedKey] === value ? null : value;
    setProjectVerdicts((prev) => ({ ...prev, [scopedKey]: next }));
    schedulePersistScore(activeProject.id, specialScoreKey(roundId, '__verdict__'), 0, next, 0);
  };

  const getExpectedCount = () => reviewerRules.reduce((sum: number, rule: any) => {
    return sum + (rule.type === 'level' ? 1 : rule.items.length);
  }, 0);

  const getProjectCompletion = (project: Project) => {
    const roundId = getActiveRound(project);
    const rules = SCORING_DIMENSIONS.filter((rule: any) => rule.roundId === roundId);
    const projectId = project.id;
    const current = scores[projectId] || {};
    const expected = rules.reduce((sum: number, rule: any) => sum + (rule.type === 'level' ? 1 : rule.items.length), 0);
    if (!expected) return 0;
    const filled = rules.reduce((sum: number, rule: any) => {
      if (rule.type === 'level') return sum + (current[roundScoreKey(roundId, rule.name, 'level')] !== undefined ? 1 : 0);
      return sum + rule.items.filter((item: any) => current[roundScoreKey(roundId, rule.name, item.key)] !== undefined).length;
    }, 0);
    return Math.round((filled / expected) * 100);
  };

  const getLocalWeightedBaseScore = (project: Project) => computeRoundBaseScoreFromScoreMap(getActiveRound(project), scores[project.id] || {});

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
              setScoreDrafts({});
              setProjectProblems({});
              setProjectActions({});
              setProjectVerdicts({});
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
            const completion = getProjectCompletion(project);
            const active = activeProject?.id === project.id;
            const status = getReviewStatus(project.reviewStatus);
            const roundId = getActiveRound(project);
            return (
              <button key={project.id} onClick={() => setActiveProject(project)} style={{ display: 'block', width: '100%', textAlign: 'left', padding: '14px 20px', border: 'none', borderBottom: '1px solid #f1f5f9', cursor: 'pointer', background: active ? '#eff6ff' : 'white', borderLeft: active ? '3px solid #3b82f6' : '3px solid transparent' }}>
                <div style={{ fontSize: 14, fontWeight: 700, color: active ? '#1e40af' : '#0f172a', marginBottom: 4 }}>{project.seq_no}. {project.name}</div>
                <div style={{ fontSize: 12, color: '#64748b', marginBottom: 8 }}>提报人：{project.submitter}</div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
                  <span style={{ fontSize: 11, fontWeight: 800, color: '#1e40af', background: '#eff6ff', padding: '2px 8px', borderRadius: 999 }}>{ROUND_LABELS[roundId as keyof typeof ROUND_LABELS]}</span>
                  <span style={{ fontSize: 11, fontWeight: 800, color: status.color, background: status.bg, padding: '2px 8px', borderRadius: 999 }}>{status.label}</span>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <div style={{ flex: 1, height: 5, background: '#e2e8f0', borderRadius: 3, overflow: 'hidden' }}><div style={{ width: `${completion}%`, height: '100%', background: completion === 100 ? '#10b981' : '#3b82f6' }} /></div>
                  <span style={{ fontSize: 12, fontWeight: 700, color: completion === 100 ? '#10b981' : '#64748b' }}>{completion}%</span>
                </div>
                {completion === 100 && <div style={{ marginTop: 6, fontSize: 12, color: '#64748b' }}>已填本轮基础分：{getLocalWeightedBaseScore(project).toFixed(1)}/100（不含加分）</div>}
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
                <div style={{ display: 'flex', gap: 8, marginTop: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 12, fontWeight: 800, color: '#1e40af', background: '#eff6ff', padding: '4px 10px', borderRadius: 999 }}>{ROUND_LABELS[getActiveRound() as keyof typeof ROUND_LABELS]} · {ROUND_TITLES[getActiveRound() as keyof typeof ROUND_TITLES]}</span>
                  <span style={{ fontSize: 12, fontWeight: 800, color: getReviewStatus(activeProject.reviewStatus).color, background: getReviewStatus(activeProject.reviewStatus).bg, padding: '4px 10px', borderRadius: 999 }}>{getReviewStatus(activeProject.reviewStatus).label}</span>
                </div>
              </div>

              <div style={{ background: '#eef2ff', border: '1px solid #c7d2fe', color: '#3730a3', padding: '12px 16px', borderRadius: 10, fontSize: 13, lineHeight: 1.7, marginBottom: 20 }}>
                评分方法：当前轮次独立 100 分；打分型子项均为 0-10 分，五位评委取平均后计入大维度；创新性按 10/16/24/30/40 档位计入 40 分满分。
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
                          <div style={{ fontSize: 12, color: '#64748b', marginTop: 2 }}>{rule.type === 'level' ? '档位型，汇总取中位档' : `子项均分 × ${rule.multiplier}`}</div>
                        </div>
                        <div style={{ background: '#eff6ff', color: '#1e40af', padding: '4px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700 }}>满分 {rule.maxScore}</div>
                      </div>

                      {rule.type === 'level' ? (
                        <div style={{ display: 'grid', gap: 8 }}>
                          {rule.levels.map((level: number) => {
                            const key = roundScoreKey(getActiveRound(), rule.name, 'level');
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
                            const key = roundScoreKey(getActiveRound(), rule.name, item.key);
                            const current = ruleScores[key];
                            return (
                              <div key={item.key}>
                                <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 6 }}>
                                  <label style={{ fontSize: 13, fontWeight: 700, color: '#334155' }}>{item.label}</label>
                                  <span style={{ fontSize: 12, color: '#64748b' }}>{current ?? '-'} / 10</span>
                                </div>
                                <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
                                  <input type="range" min="0" max="10" step="1" value={current ?? 0} onChange={(event) => handleScoreChange(key, Number(event.target.value))} onMouseUp={() => commitNumericDraft(key)} onTouchEnd={() => commitNumericDraft(key)} style={{ flex: 1, accentColor: '#3b82f6' }} />
                                  <input type="number" min="0" max="10" step="1" value={scoreDrafts[activeProject.id]?.[key] ?? ''} placeholder="0" onChange={(event) => handleNumericDraftChange(key, event.target.value)} onBlur={() => commitNumericDraft(key)} style={{ width: 70, padding: '8px 10px', fontSize: 16, fontWeight: 800, border: '1.5px solid #cbd5e1', borderRadius: 8, textAlign: 'center' }} />
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
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#92400e', marginBottom: 12 }}>Walker 本轮加分项</div>
                  <textarea value={bonusReason[roundFieldKey(activeProject.id, getActiveRound())] || ''} onChange={(event) => setBonusReason((prev) => ({ ...prev, [roundFieldKey(activeProject.id, getActiveRound())]: event.target.value }))} placeholder="填写本轮加分原因" rows={2} style={{ width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid #fbbf24', borderRadius: 8, marginBottom: 10 }} />
                  <div style={{ display: 'flex', gap: 10 }}>
                    <input type="number" min="0" max="5" step="1" value={bonusValue[roundFieldKey(activeProject.id, getActiveRound())] ?? ''} placeholder="0-5" onChange={(event) => setBonusValue((prev) => ({ ...prev, [roundFieldKey(activeProject.id, getActiveRound())]: event.target.value }))} onBlur={handleBonusSave} style={{ width: 100, padding: 10, border: '1px solid #f59e0b', borderRadius: 8, fontWeight: 800 }} />
                    <button onClick={handleBonusSave} disabled={saving} style={{ padding: '10px 18px', border: 'none', borderRadius: 8, background: '#f59e0b', color: 'white', fontWeight: 800, cursor: 'pointer' }}>保存加分</button>
                  </div>
                </section>
              )}

              <section style={{ background: 'white', borderRadius: 12, padding: 20, border: '1px solid #e2e8f0' }}>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0f172a', marginBottom: 14 }}>评审意见</div>
                <label style={{ display: 'block', fontSize: 13, color: '#dc2626', fontWeight: 700, marginBottom: 6 }}>存在问题（每行一条）</label>
                <textarea value={projectProblems[roundFieldKey(activeProject.id, getActiveRound())] || ''} onChange={(event) => { const value = event.target.value; const scopedKey = roundFieldKey(activeProject.id, getActiveRound()); setProjectProblems((prev) => ({ ...prev, [scopedKey]: value })); persistTextField(activeProject.id, '__problems__', value); }} onBlur={() => persistTextField(activeProject.id, '__problems__', projectProblems[roundFieldKey(activeProject.id, getActiveRound())] || '', 0)} rows={4} style={{ width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid #fecaca', borderRadius: 8, background: '#fef2f2', marginBottom: 14 }} />
                <label style={{ display: 'block', fontSize: 13, color: '#16a34a', fontWeight: 700, marginBottom: 6 }}>整改意见（每行一条）</label>
                <textarea value={projectActions[roundFieldKey(activeProject.id, getActiveRound())] || ''} onChange={(event) => { const value = event.target.value; const scopedKey = roundFieldKey(activeProject.id, getActiveRound()); setProjectActions((prev) => ({ ...prev, [scopedKey]: value })); persistTextField(activeProject.id, '__actions__', value); }} onBlur={() => persistTextField(activeProject.id, '__actions__', projectActions[roundFieldKey(activeProject.id, getActiveRound())] || '', 0)} rows={4} style={{ width: '100%', boxSizing: 'border-box', padding: 10, border: '1px solid #bbf7d0', borderRadius: 8, background: '#f0fdf4', marginBottom: 14 }} />
                <button onClick={handleProblemsActionsSave} style={{ padding: '9px 18px', border: 'none', borderRadius: 8, background: '#0f172a', color: 'white', fontWeight: 700, cursor: 'pointer' }}>保存评审意见</button>
              </section>

              {isWalker && (
                <section style={{ background: 'white', borderRadius: 12, padding: 20, border: '1.5px solid #8b5cf6', marginTop: 24 }}>
                  <div style={{ fontSize: 16, fontWeight: 800, color: '#5b21b6', marginBottom: 12 }}>Walker 评审结论</div>
                  <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
                    {VERDICT_OPTIONS.filter((option) => !(activeProject.attempt_no === 2 && option.value === 'recheck')).map((option) => {
                      const selected = projectVerdicts[roundFieldKey(activeProject.id, getActiveRound())] === option.value;
                      return (
                        <button key={option.value} onClick={() => handleVerdictChange(option.value)} style={{ padding: '10px 16px', borderRadius: 8, border: selected ? `2px solid ${option.color}` : '1px solid #e2e8f0', background: selected ? option.bg : 'white', color: selected ? option.color : '#475569', fontWeight: 800, cursor: 'pointer' }}>
                          {option.label}
                        </button>
                      );
                    })}
                  </div>
                </section>
              )}
            </>
          )}
        </main>
      </div>
      {saveFeedback && (
        <div
          role="status"
          aria-live="polite"
          style={{
            position: 'fixed', top: 16, right: 16, zIndex: 50,
            minWidth: 190, maxWidth: 360, padding: '11px 14px', borderRadius: 8,
            fontSize: 13, fontWeight: 700, boxShadow: '0 10px 24px rgba(15, 23, 42, 0.16)',
            color: saveFeedback.tone === 'error' ? '#b91c1c' : saveFeedback.tone === 'saving' ? '#1d4ed8' : '#047857',
            background: saveFeedback.tone === 'error' ? '#fef2f2' : saveFeedback.tone === 'saving' ? '#eff6ff' : '#ecfdf5',
            border: `1px solid ${saveFeedback.tone === 'error' ? '#fecaca' : saveFeedback.tone === 'saving' ? '#bfdbfe' : '#a7f3d0'}`
          }}
        >
          {saveFeedback.text}
        </div>
      )}
    </div>
  );
}
