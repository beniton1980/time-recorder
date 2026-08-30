import type { ReactNode } from "react";

export default function PayrollLayout({ children }: { children: ReactNode }) {
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
  </>;
}
