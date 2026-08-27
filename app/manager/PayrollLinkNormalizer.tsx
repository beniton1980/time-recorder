"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

function normalizePayrollLink() {
  const section = document.querySelector<HTMLElement>('[data-dashboard-key="payroll"]');
  const link = section?.querySelector<HTMLAnchorElement>("a[href]");
  if (!link) return;
  link.href = "/manager/payroll";
  link.setAttribute("aria-label", "給与集計画面を開く");
}

export default function PayrollLinkNormalizer() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname !== "/manager") return;
    let frame = window.requestAnimationFrame(normalizePayrollLink);
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(normalizePayrollLink);
    });
    observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["href"] });
    return () => { window.cancelAnimationFrame(frame); observer.disconnect(); };
  }, [pathname]);
  return null;
}
