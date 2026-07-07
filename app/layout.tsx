import './globals.css';

export const metadata = {
  title: '立项评审在线打分系统',
  description: '游戏项目立项评审在线打分与管理系统'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}