'use client';

import { useEffect, useState, useMemo } from 'react';
import { useSearchParams } from 'next/navigation';

export default function ReportClient() {
  const params = useSearchParams();
  const meetingId = params.get('meetingId');
  const [data, setData] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [showMethod, setShowMethod] = useState(false);

  useEffect(() => {
    if (meetingId) {
      fetch(`/api/summary?meetingId=${meetingId}`, { cache: 'no-store' })
        .then(r => r.json())
        .then(d => { setData(d); setLoading(false); })
        .catch(() => setLoading(false));
    }
  }, [meetingId]);

  const rankedProjects = useMemo(() => {
    if (!data) return [];
    return [...data.projects]
      .filter((p: any) => p.name && p.submitter)
      .sort((a: any, b: any) => a.seq_no - b.seq_no);
  }, [data]);

  const allDimNames = useMemo(() => {
    if (!data?.dimConfig) return [];
    return data.dimConfig.map((d: any) => d.name);
  }, [data]);

  if (loading) return <div style={{ padding: 40, textAlign: 'center', color: '#64748b' }}>加载中...</div>;
  if (!data) return <div style={{ padding: 40, textAlign: 'center', color: '#ef4444' }}>数据加载失败</div>;

  const { meeting, reviewers, dimConfig, totalMaxScore } = data;
  const nonAdminReviewers = reviewers.filter((r: any) => !r.is_admin);
  const filledProjects = data.projects.filter((p: any) => p.name && p.submitter);
  const completedProjects = filledProjects.filter((p: any) => p.completionRate === 100);
  const pendingProjects = data.projects.filter((p: any) => p.is_pending);

  // 结论统计
  const verdictCounts = {
    total: filledProjects.length,
    approved: filledProjects.filter((p: any) => p.verdict === 'approved').length,
    needs_rework: filledProjects.filter((p: any) => p.verdict === 'needs_rework').length,
    needs_review: filledProjects.filter((p: any) => p.verdict === 'needs_review').length,
    totalProblems: filledProjects.reduce((sum: number, p: any) => {
      return sum + (p.reviewerProblems || []).reduce((s: number, rp: any) => s + rp.problems.length, 0);
    }, 0)
  };

  const dimColors: Record<string, string> = {
    '可玩性': '#3b82f6',
    '创新性': '#8b5cf6',
    '项目规划': '#06b6d4',
    '技术&美术': '#ec4899',
    '风险性': '#f59e0b'
  };

  const getColor = (dimName: string) => dimColors[dimName] || '#64748b';

  return (
    <div style={{
      minHeight: '100vh',
      background: 'linear-gradient(135deg, #f0f9ff 0%, #e0f2fe 50%, #f0fdf4 100%)',
      fontFamily: '-apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif',
      padding: '40px 20px'
    }}>
      <div style={{ maxWidth: '1100px', margin: '0 auto' }}>
        {/* 操作栏 - 打印时隐藏 */}
        <div className="no-print" style={{ display: 'flex', justifyContent: 'flex-end', gap: '10px', marginBottom: '20px' }}>
          <button onClick={() => window.print()} style={{
            padding: '10px 20px', background: 'linear-gradient(135deg, #3b82f6, #2563eb)', color: 'white',
            border: 'none', borderRadius: '10px', cursor: 'pointer', fontSize: '14px', fontWeight: '600',
            boxShadow: '0 2px 8px rgba(59,130,246,0.3)'
          }}>🖨 打印 / 导出PDF</button>
          <button onClick={() => window.close()} style={{
            padding: '10px 20px', background: '#f1f5f9', color: '#475569',
            border: 'none', borderRadius: '10px', cursor: 'pointer', fontSize: '14px'
          }}>关闭</button>
        </div>

        {/* 报告主体 */}
        <div style={{
          background: 'white',
          borderRadius: '24px',
          padding: '48px',
          boxShadow: '0 20px 60px rgba(0,0,0,0.08)'
        }}>

          {/* ===== 1. 标题区 ===== */}
          <div style={{ textAlign: 'center', marginBottom: '48px' }}>
            <div style={{
              display: 'inline-block',
              background: 'linear-gradient(135deg, #eff6ff, #f0fdf4)',
              padding: '6px 20px',
              borderRadius: '20px',
              fontSize: '12px',
              color: '#3b82f6',
              fontWeight: '600',
              marginBottom: '16px'
            }}>立项评审报告</div>
            <h1 style={{
              fontSize: '36px',
              fontWeight: '800',
              background: 'linear-gradient(135deg, #1e40af 0%, #0891b2 100%)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
              margin: '0 0 12px',
              lineHeight: '1.3'
            }}>{meeting.name}</h1>
            <div style={{ color: '#64748b', fontSize: '14px', lineHeight: '1.6' }}>
              会议日期: {meeting.meeting_date}
              {meeting.deadline && <span> · 截止日期: {meeting.deadline}</span>}
            </div>
          </div>

          {/* ===== 2. 概览统计 ===== */}
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(4, 1fr)',
            gap: '16px',
            marginBottom: '40px'
          }}>
            <StatCard label="候选项目" value={filledProjects.length} icon="📋" color="#3b82f6" />
            <StatCard label="评审评委" value={nonAdminReviewers.length} icon="👥" color="#8b5cf6" />
            <StatCard label="已评项目" value={completedProjects.length} icon="✅" color="#10b981" />
            <StatCard label="维度满分" value={totalMaxScore || 100} icon="🎯" color="#f59e0b" />
          </div>

          {/* ===== 3. 评审方法 & 计算公式（可折叠）===== */}
          <div style={{
            background: '#f8fafc',
            borderRadius: '16px',
            border: '1px solid #e2e8f0',
            marginBottom: '40px',
            overflow: 'hidden'
          }}>
            <div
              onClick={() => setShowMethod(!showMethod)}
              style={{
                padding: '16px 24px',
                cursor: 'pointer',
                display: 'flex',
                justifyContent: 'space-between',
                alignItems: 'center'
              }}
            >
              <div style={{ fontSize: '16px', fontWeight: '700', color: '#0f172a' }}>
                📐 评审方法 & 计算公式
              </div>
              <div style={{ fontSize: '14px', color: '#94a3b8' }}>
                {showMethod ? '▲ 收起' : '▼ 展开'}
              </div>
            </div>
            {showMethod && (
              <div style={{ padding: '0 24px 20px', fontSize: '13px', color: '#475569', lineHeight: '2' }}>
                <div style={{ marginBottom: '12px' }}>
                  <strong>评分维度：</strong>
                  {dimConfig?.map((d: any, i: number) => (
                    <span key={d.name} style={{
                      display: 'inline-block',
                      background: `${getColor(d.name)}15`,
                      color: getColor(d.name),
                      padding: '2px 10px',
                      borderRadius: '10px',
                      margin: '2px 4px',
                      fontSize: '12px',
                      fontWeight: '600'
                    }}>
                      {d.name}（满分 {d.maxScore / d.reviewerCount}）
                    </span>
                  ))}
                </div>
                <div style={{
                  background: '#e0f2fe',
                  padding: '14px 18px',
                  borderRadius: '10px',
                  fontFamily: 'monospace',
                  fontSize: '13px',
                  color: '#0369a1'
                }}>
                  <div><strong>计算公式：</strong></div>
                  <div>维度得分 = AVG(所有评委该维度打分)</div>
                  <div>基础总分 = Σ 各维度得分</div>
                  <div>最终总分 = 基础总分 + Walker 加分</div>
                </div>
              </div>
            )}
          </div>

          {/* ===== 4. 各项目评审结果明细 ===== */}
          <SectionTitle icon="📊" title="各项目评审结果明细" />
          <div style={{ marginBottom: '40px' }}>
            {rankedProjects.map((p: any) => {
              const scorePercent = totalMaxScore > 0 ? Math.round((p.baseScore / totalMaxScore) * 100) : 0;

              return (
                <div key={p.id} style={{
                  background: '#fafbfc',
                  borderRadius: '16px',
                  padding: '20px 24px',
                  marginBottom: '14px',
                  border: '1px solid #e2e8f0',
                  transition: 'all 0.2s'
                }}>
                  {/* 项目头部 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: '14px', marginBottom: '16px' }}>
                    <div style={{
                      fontSize: '16px',
                      fontWeight: '700',
                      color: '#3b82f6',
                      minWidth: '44px',
                      textAlign: 'center',
                      background: '#eff6ff',
                      borderRadius: '8px',
                      padding: '6px 0'
                    }}>#{p.seq_no}</div>
                    <div style={{ flex: 1 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                        <span style={{ fontSize: '17px', fontWeight: '700', color: '#0f172a' }}>{p.name}</span>
                        {p.verdict && (() => {
                          const vMap: Record<string, { label: string; color: string; bg: string }> = {
                            approved: { label: '评审通过', color: '#10b981', bg: '#d1fae5' },
                            needs_rework: { label: '待修改', color: '#f59e0b', bg: '#fef3c7' },
                            needs_review: { label: '待重评', color: '#ef4444', bg: '#fee2e2' }
                          };
                          const v = vMap[p.verdict];
                          return v ? <span style={{ padding: '2px 10px', borderRadius: '10px', fontSize: '11px', fontWeight: '600', background: v.bg, color: v.color }}>{v.label}</span> : null;
                        })()}
                      </div>
                      <div style={{ fontSize: '12px', color: '#64748b', marginTop: '2px' }}>
                        提报人: {p.submitter}
                        {p.is_pending && <span style={{ color: '#f59e0b', fontWeight: '600' }}> · 待补评</span>}
                      </div>
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: '28px', fontWeight: '800', color: '#1e40af' }}>
                        {p.baseScore.toFixed(1)}
                        {p.bonusScore > 0 && (
                          <span style={{ fontSize: '16px', color: '#f59e0b', marginLeft: '4px' }}>+✨{p.bonusScore}</span>
                        )}
                      </div>
                      <div style={{ fontSize: '11px', color: '#94a3b8' }}>
                        {p.bonusScore > 0
                          ? `总分 ${p.totalScore.toFixed(1)}（含加分）`
                          : `总分 ${p.totalScore.toFixed(1)} · ${scorePercent}%`
                        }
                      </div>
                    </div>
                  </div>

                  {/* 维度得分条 */}
                  <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap', marginBottom: '8px' }}>
                    {allDimNames.map((dim: string) => {
                      const d = p.dimTotals[dim];
                      const color = getColor(dim);
                      return (
                        <div key={dim} style={{
                          flex: '1 1 0',
                          minWidth: '120px',
                          background: 'white',
                          borderRadius: '10px',
                          padding: '10px 12px',
                          border: `1px solid ${color}25`,
                          textAlign: 'center'
                        }}>
                          <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '4px' }}>{dim}</div>
                          <div style={{ fontSize: '18px', fontWeight: '700', color }}>
                            {d ? d.avg.toFixed(1) : '-'}
                          </div>
                          {d && d.maxScore > 0 && (
                            <div style={{
                              marginTop: '4px',
                              height: '4px',
                              background: '#e2e8f0',
                              borderRadius: '2px',
                              overflow: 'hidden'
                            }}>
                              <div style={{
                                width: `${d.percentage}%`,
                                height: '100%',
                                background: color,
                                borderRadius: '2px'
                              }} />
                            </div>
                          )}
                          {d && <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '2px' }}>
                            {d.percentage}% · {d.count}人评
                          </div>}
                        </div>
                      );
                    })}
                  </div>

                  {/* Walker 加分明细 */}
                  {p.bonusDetails && p.bonusDetails.length > 0 && (
                    <div style={{
                      marginTop: '10px',
                      padding: '10px 14px',
                      background: '#fef3c7',
                      borderRadius: '10px',
                      border: '1px solid #fde68a'
                    }}>
                      <div style={{ fontSize: '11px', fontWeight: '700', color: '#92400e', marginBottom: '4px' }}>
                        🎁 Walker 额外加分
                      </div>
                      {p.bonusDetails.map((b: any, i: number) => (
                        <div key={i} style={{ fontSize: '12px', color: '#78350f', marginTop: '2px' }}>
                          +{b.value} 分 · {b.reason}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ===== 5. 维度得分对比 ===== */}
          <SectionTitle icon="📈" title="维度得分对比" />
          <div style={{ marginBottom: '40px' }}>
            {allDimNames.map((dim: string) => {
              const color = getColor(dim);
              const dc = dimConfig?.find((d: any) => d.name === dim);
              const maxForDim = dc ? dc.maxScore / dc.reviewerCount : 20;

              return (
                <div key={dim} style={{
                  marginBottom: '20px',
                  background: '#fafbfc',
                  borderRadius: '12px',
                  padding: '16px 20px',
                  border: '1px solid #e2e8f0'
                }}>
                  <div style={{
                    fontSize: '14px', fontWeight: '700', color,
                    marginBottom: '12px',
                    display: 'flex', alignItems: 'center', gap: '8px'
                  }}>
                    <div style={{
                      width: '8px', height: '8px',
                      borderRadius: '50%', background: color
                    }} />
                    {dim}
                    <span style={{ fontSize: '11px', color: '#94a3b8', fontWeight: '500' }}>
                      满分 {maxForDim}
                    </span>
                  </div>
                  {rankedProjects.map((p: any) => {
                    const d = p.dimTotals[dim];
                    const avg = d ? d.avg : 0;
                    const pct = maxForDim > 0 ? (avg / maxForDim) * 100 : 0;
                    return (
                      <div key={p.id} style={{
                        display: 'flex', alignItems: 'center', gap: '10px',
                        marginBottom: '6px'
                      }}>
                        <div style={{
                          width: '120px', fontSize: '12px', color: '#475569',
                          textAlign: 'right', flexShrink: 0,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                        }}>{p.name}</div>
                        <div style={{
                          flex: 1, height: '20px',
                          background: '#e2e8f0',
                          borderRadius: '4px',
                          overflow: 'hidden'
                        }}>
                          <div style={{
                            width: `${Math.min(100, pct)}%`,
                            height: '100%',
                            background: `linear-gradient(90deg, ${color}cc, ${color})`,
                            borderRadius: '4px',
                            transition: 'width 0.5s',
                            display: 'flex', alignItems: 'center', justifyContent: 'flex-end',
                            paddingRight: '6px'
                          }}>
                            {pct > 20 && (
                              <span style={{ fontSize: '10px', color: 'white', fontWeight: '600' }}>
                                {avg.toFixed(1)}
                              </span>
                            )}
                          </div>
                        </div>
                        {pct <= 20 && (
                          <span style={{ fontSize: '11px', color: '#64748b', fontWeight: '600', minWidth: '30px' }}>
                            {avg.toFixed(1)}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              );
            })}
          </div>

          {/* ===== 6. 评委贡献度 & 评审矩阵 ===== */}
          <SectionTitle icon="👥" title="评委贡献度" />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))',
            gap: '12px',
            marginBottom: '24px'
          }}>
            {nonAdminReviewers.map((r: any) => {
              const expected = r.expectedScores || 0;
              const progress = expected > 0 ? Math.min(100, Math.round((r.scoresGiven / expected) * 100)) : 0;
              return (
                <div key={r.code} style={{
                  background: '#fafbfc',
                  padding: '16px',
                  borderRadius: '12px',
                  border: '1px solid #e2e8f0',
                  textAlign: 'center'
                }}>
                  <div style={{ fontSize: '16px', fontWeight: '700', color: '#0f172a' }}>{r.name}</div>
                  <div style={{ fontSize: '11px', color: '#64748b', marginBottom: '8px' }}>{r.role}</div>
                  <div style={{ display: 'flex', justifyContent: 'center', gap: '16px', marginBottom: '8px' }}>
                    <div>
                      <div style={{ fontSize: '22px', fontWeight: '700', color: '#1e40af' }}>{r.scoresGiven}</div>
                      <div style={{ fontSize: '10px', color: '#94a3b8' }}>已评维度</div>
                    </div>
                    <div>
                      <div style={{ fontSize: '22px', fontWeight: '700', color: '#10b981' }}>{r.projectsScored}</div>
                      <div style={{ fontSize: '10px', color: '#94a3b8' }}>覆盖项目</div>
                    </div>
                  </div>
                  {/* 进度条 */}
                  <div style={{
                    height: '6px', background: '#e2e8f0',
                    borderRadius: '3px', overflow: 'hidden'
                  }}>
                    <div style={{
                      width: `${progress}%`, height: '100%',
                      background: progress === 100 ? '#10b981' : '#3b82f6',
                      borderRadius: '3px'
                    }} />
                  </div>
                  <div style={{ fontSize: '10px', color: '#94a3b8', marginTop: '4px' }}>
                    完成 {progress}%（{r.scoresGiven}/{expected}）
                  </div>
                  {r.dimensions && r.dimensions.length > 0 && (
                    <div style={{ marginTop: '6px', display: 'flex', gap: '4px', flexWrap: 'wrap', justifyContent: 'center' }}>
                      {r.dimensions.map((d: string) => (
                        <span key={d} style={{
                          fontSize: '10px',
                          padding: '1px 6px',
                          borderRadius: '8px',
                          background: `${getColor(d)}15`,
                          color: getColor(d)
                        }}>{d}</span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* ===== 7. 待补评项目 ===== */}
          {pendingProjects.length > 0 && (
            <>
              <SectionTitle icon="⏳" title="待补评项目" />
              <div style={{ marginBottom: '40px' }}>
                {pendingProjects.map((p: any) => (
                  <div key={p.id} style={{
                    background: '#fffbeb',
                    border: '1px solid #fde68a',
                    borderRadius: '10px',
                    padding: '14px 18px',
                    marginBottom: '8px',
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center'
                  }}>
                    <div>
                      <div style={{ fontSize: '14px', fontWeight: '600', color: '#92400e' }}>{p.name}</div>
                      <div style={{ fontSize: '12px', color: '#a16207' }}>提报人: {p.submitter}</div>
                    </div>
                    <div style={{
                      background: '#fbbf24',
                      color: 'white',
                      padding: '4px 12px',
                      borderRadius: '12px',
                      fontSize: '11px',
                      fontWeight: '600'
                    }}>需要修改补充重评</div>
                  </div>
                ))}
              </div>
            </>
          )}

          {/* ===== 8. 各项目问题与改进动作（逐条带评委标签） ===== */}
          {rankedProjects.some((p: any) =>
            (p.reviewerProblems && p.reviewerProblems.length > 0) ||
            (p.reviewerActions && p.reviewerActions.length > 0)
          ) && (
            <>
              <SectionTitle icon="📝" title="各项目问题与改进动作" />
              <div style={{ marginBottom: '40px' }}>
                {rankedProjects.map((p: any) => {
                  const hasContent =
                    (p.reviewerProblems && p.reviewerProblems.length > 0) ||
                    (p.reviewerActions && p.reviewerActions.length > 0);
                  if (!hasContent) return null;

                  // 将所有评委的问题打散为逐条，每条带评委标签
                  const allProblems: { reviewer: string; text: string }[] = [];
                  (p.reviewerProblems || []).forEach((rp: any) => {
                    rp.problems.forEach((prob: string) => {
                      allProblems.push({ reviewer: rp.reviewer_name, text: prob });
                    });
                  });
                  const allActions: { reviewer: string; text: string }[] = [];
                  (p.reviewerActions || []).forEach((ra: any) => {
                    ra.actions.forEach((act: string) => {
                      allActions.push({ reviewer: ra.reviewer_name, text: act });
                    });
                  });

                  return (
                    <div key={p.id} style={{
                      background: '#fafbfc',
                      borderRadius: '14px',
                      padding: '20px 24px',
                      marginBottom: '14px',
                      border: '1px solid #e2e8f0'
                    }}>
                      <div style={{
                        fontSize: '15px', fontWeight: '700', color: '#0f172a',
                        marginBottom: '14px',
                        display: 'flex', alignItems: 'center', gap: '8px'
                      }}>
                        <span style={{
                          background: '#3b82f6', color: 'white',
                          padding: '2px 10px',
                          borderRadius: '6px',
                          fontSize: '12px', fontWeight: '700'
                        }}>#{p.seq_no}</span>
                        {p.name}
                      </div>

                      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '14px' }}>
                        {/* 问题列 */}
                        <div>
                          <div style={{
                            fontSize: '12px', fontWeight: '700', color: '#dc2626',
                            marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px'
                          }}>
                            ⚠ 存在问题（{allProblems.length}条）
                          </div>
                          {allProblems.length > 0 ? (
                            allProblems.map((item, i) => (
                              <div key={i} style={{
                                display: 'flex', alignItems: 'flex-start', gap: '8px',
                                padding: '8px 10px',
                                background: 'white',
                                borderRadius: '8px',
                                border: '1px solid #fecaca',
                                marginBottom: '6px'
                              }}>
                                <span style={{
                                  fontSize: '10px', fontWeight: '600',
                                  background: '#fee2e2', color: '#991b1b',
                                  padding: '2px 8px', borderRadius: '10px',
                                  whiteSpace: 'nowrap', flexShrink: 0
                                }}>{item.reviewer}</span>
                                <span style={{ fontSize: '12px', color: '#475569', lineHeight: '1.5' }}>{item.text}</span>
                              </div>
                            ))
                          ) : (
                            <div style={{ fontSize: '12px', color: '#cbd5e1' }}>无</div>
                          )}
                        </div>

                        {/* 改进动作列 */}
                        <div>
                          <div style={{
                            fontSize: '12px', fontWeight: '700', color: '#059669',
                            marginBottom: '8px', display: 'flex', alignItems: 'center', gap: '4px'
                          }}>
                            ✓ 改进动作（{allActions.length}条）
                          </div>
                          {allActions.length > 0 ? (
                            allActions.map((item, i) => (
                              <div key={i} style={{
                                display: 'flex', alignItems: 'flex-start', gap: '8px',
                                padding: '8px 10px',
                                background: 'white',
                                borderRadius: '8px',
                                border: '1px solid #bbf7d0',
                                marginBottom: '6px'
                              }}>
                                <span style={{
                                  fontSize: '10px', fontWeight: '600',
                                  background: '#dcfce7', color: '#065f46',
                                  padding: '2px 8px', borderRadius: '10px',
                                  whiteSpace: 'nowrap', flexShrink: 0
                                }}>{item.reviewer}</span>
                                <span style={{ fontSize: '12px', color: '#475569', lineHeight: '1.5' }}>{item.text}</span>
                              </div>
                            ))
                          ) : (
                            <div style={{ fontSize: '12px', color: '#cbd5e1' }}>无</div>
                          )}
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}

          {/* ===== 9. 结论统计 ===== */}
          <SectionTitle icon="📊" title="结论统计" />
          <div style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(5, 1fr)',
            gap: '12px',
            marginBottom: '32px'
          }}>
            <ConclusionBox label="参评项目" value={verdictCounts.total} color="#3b82f6" bg="#eff6ff" />
            <ConclusionBox label="评审通过" value={verdictCounts.approved} color="#10b981" bg="#d1fae5" />
            <ConclusionBox label="待修改" value={verdictCounts.needs_rework} color="#f59e0b" bg="#fef3c7" />
            <ConclusionBox label="待重评" value={verdictCounts.needs_review} color="#ef4444" bg="#fee2e2" />
            <ConclusionBox label="改进意见" value={verdictCounts.totalProblems} color="#8b5cf6" bg="#f3e8ff" />
          </div>

          {/* 各项目结论明细 */}
          {filledProjects.some((p: any) => p.verdict) && (
            <div style={{ marginBottom: '20px' }}>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: '13px' }}>
                  <thead>
                    <tr style={{ background: '#f8fafc' }}>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '700', color: '#475569' }}>编号</th>
                      <th style={{ padding: '10px 12px', textAlign: 'left', fontWeight: '700', color: '#475569' }}>项目名</th>
                      <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#475569' }}>总分</th>
                      <th style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#475569' }}>结论</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rankedProjects.map((p: any) => {
                      const vMap: Record<string, { label: string; color: string; bg: string }> = {
                        approved: { label: '评审通过', color: '#10b981', bg: '#d1fae5' },
                        needs_rework: { label: '待修改', color: '#f59e0b', bg: '#fef3c7' },
                        needs_review: { label: '待重评', color: '#ef4444', bg: '#fee2e2' }
                      };
                      const v = p.verdict ? vMap[p.verdict] : null;
                      return (
                        <tr key={p.id} style={{ borderTop: '1px solid #e2e8f0' }}>
                          <td style={{ padding: '10px 12px', color: '#64748b' }}>#{p.seq_no}</td>
                          <td style={{ padding: '10px 12px', fontWeight: '600', color: '#0f172a' }}>{p.name}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'center', fontWeight: '700', color: '#1e40af' }}>{p.totalScore.toFixed(1)}</td>
                          <td style={{ padding: '10px 12px', textAlign: 'center' }}>
                            {v ? (
                              <span style={{ padding: '4px 12px', borderRadius: '12px', fontSize: '12px', fontWeight: '600', background: v.bg, color: v.color }}>{v.label}</span>
                            ) : (
                              <span style={{ color: '#cbd5e1', fontSize: '12px' }}>未定</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>

        {/* 页脚 */}
        <div style={{
          textAlign: 'center', marginTop: '24px',
          color: '#94a3b8', fontSize: '12px', lineHeight: '1.8'
        }}>
          <div>报告生成时间: {new Date().toLocaleString('zh-CN')}</div>
          <div>共 {filledProjects.length} 个候选项目 · {nonAdminReviewers.length} 位评委 · {completedProjects.length} 个已完成评审</div>
        </div>
      </div>

      {/* 打印样式 */}
      <style>{`
        @media print {
          .no-print { display: none !important; }
          body { background: white !important; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
        }
      `}</style>
    </div>
  );
}

/* ===== 辅助组件 ===== */

function SectionTitle({ icon, title }: { icon: string; title: string }) {
  return (
    <h2 style={{
      fontSize: '20px',
      fontWeight: '700',
      color: '#0f172a',
      margin: '0 0 20px',
      display: 'flex',
      alignItems: 'center',
      gap: '8px',
      paddingBottom: '12px',
      borderBottom: '2px solid #e2e8f0'
    }}>
      {icon} {title}
    </h2>
  );
}

function ConclusionBox({ label, value, color, bg }: any) {
  return (
    <div style={{
      background: bg, borderRadius: '14px', padding: '20px',
      textAlign: 'center', border: `1px solid ${color}30`
    }}>
      <div style={{ fontSize: '32px', fontWeight: '800', color }}>{value}</div>
      <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>{label}</div>
    </div>
  );
}

function StatCard({ label, value, icon, color }: any) {
  return (
    <div style={{
      background: `linear-gradient(135deg, white, ${color}08)`,
      borderRadius: '16px',
      padding: '20px',
      border: `1px solid ${color}20`,
      textAlign: 'center'
    }}>
      <div style={{ fontSize: '24px', marginBottom: '6px' }}>{icon}</div>
      <div style={{ fontSize: '32px', fontWeight: '800', color }}>{value}</div>
      <div style={{ fontSize: '13px', color: '#64748b', marginTop: '4px' }}>{label}</div>
    </div>
  );
}
