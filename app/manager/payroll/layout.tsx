"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

export default function PayrollLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return <>
    <div
      role="note"
      aria-label="給与集計 v1 の対応範囲"
      style={{
        maxWidth: 920,
        margin: "16px auto 0",
        padding: "12px 16px",
        borderRadius: 12,
        background: "#f6f7f8",
        color: "#333",
        fontSize: 14,
        lineHeight: 1.6,
      }}
    >
      <strong style={{ display: "block", marginBottom: 2 }}>給与集計 v1 は時給制スタッフ専用です</strong>
      <span>アルバイト・パート等の時給制を対象に、勤怠と時給から控除前の総支給額まで集計します。日給制・月給制は現在対象外です。</span>
    </div>
    {children}
    {pathname === "/manager/payroll" && (
      <a
        href="/manager/payroll/preview"
        style={{
          position: "fixed",
          right: 16,
          bottom: 20,
          zIndex: 20,
          borderRadius: 999,
          background: "#111",
          color: "#fff",
          padding: "12px 18px",
          textDecoration: "none",
          fontWeight: 700,
          boxShadow: "0 6px 20px rgba(0,0,0,.18)",
        }}
      >
        給与プレビューを見る
      </a>
    )}
  </>;
}
