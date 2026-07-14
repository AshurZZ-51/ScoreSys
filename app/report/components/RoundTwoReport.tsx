import { ReportTable } from './RoundOneReport';

export default function RoundTwoReport({ report }: { report: Record<string, any> }) {
  return <ReportTable title="第二轮评审报告" subtitle="项目规划、技术与美术、风险评估" report={report} dimensions={['项目规划', '技术&美术', '风险评估']} />;
}
