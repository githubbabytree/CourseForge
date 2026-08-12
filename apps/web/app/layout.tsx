import type { Metadata } from "next";
import "./globals.css";
import "./revisions.css";

export const metadata: Metadata = {
  title: "CourseForge · AI 安全培训工坊",
  description: "从培训点子到 WebPPT 与视频的一站式 AI 创作平台",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
