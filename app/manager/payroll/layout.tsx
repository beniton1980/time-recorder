"use client";

import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import PayrollWeekBoundaryCard from "./PayrollWeekBoundaryCard";

export default function PayrollLayout({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  return <>
    {children}
    {pathname === "/manager/payroll" && <PayrollWeekBoundaryCard />}
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
