import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ONOGAMI 勤怠",
  description: "ONOGAMIの勤怠打刻・訂正管理",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}
