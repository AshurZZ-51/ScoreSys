import { ReportTable } from './RoundOneReport';
import { getRoundDefinition } from '@/lib/scoringRules';

export default function RoundTwoReport({ report }: { report: Record<string, any> }) {
  const versionGroups = ['two_round_v3', 'two_round_v2'].map((scoringVersion) => ({
    scoringVersion,
    projects: (report?.projects || []).filter((project: Record<string, any>) => (
      (project.scoring_version === 'two_round_v3' ? 'two_round_v3' : 'two_round_v2') === scoringVersion
    ))
  })).filter((group) => group.projects.length > 0);

  return <>
    {versionGroups.map((versionGroup) => {
      const dimensions = getRoundDefinition('r2', versionGroup.scoringVersion)?.dimensions || [];
      const isV3 = versionGroup.scoringVersion === 'two_round_v3';
      return <ReportTable
        key={versionGroup.scoringVersion}
        title={isV3 ? '第二轮评审报告（五维规则）' : '第二轮评审报告（历史规则）'}
        subtitle={isV3 ? '游戏性、创新性、项目规划、技术与美术、风险预估' : '项目规划、技术与美术、风险预估'}
        report={{ ...report, projects: versionGroup.projects }}
        dimensions={dimensions}
      />;
    })}
    {!versionGroups.length && <ReportTable title="第二轮评审报告" subtitle="暂无项目" report={report} dimensions={[]} />}
  </>;
}
