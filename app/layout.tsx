import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Onogami Time Recorder v2",
  description: "Onogami Time Recorder v2",
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
