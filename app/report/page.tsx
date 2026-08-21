import { Suspense } from 'react';
import ReportClient from './ReportClient';

export const dynamic = 'force-dynamic';

export default function ReportPage() {
  return (
    <Suspense fallback={<div style={{ padding: 40, textAlign: 'center', color: '#999' }}>加载报告数据...</div>}>
      <ReportClient />
    </Suspense>
  );
}
