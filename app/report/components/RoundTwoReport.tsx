import { ReportTable } from './RoundOneReport';
import { ROUND_BY_ID } from '@/lib/scoringRules';

export default function RoundTwoReport({ report }: { report: Record<string, any> }) {
  return <ReportTable title="第二轮评审报告" subtitle="项目规划、技术与美术、风险预估" report={report} dimensions={ROUND_BY_ID.r2.dimensions} />;
}
