"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

const SECTION_CONFIG: Record<string, { key: string; order: number; collapsible: boolean }> = {
  "未処理の訂正申請": { key: "review", order: 1, collapsible: false },
  "勤務状況": { key: "attendance", order: 2, collapsible: false },
  "月次勤怠表": { key: "monthly", order: 3, collapsible: true },
  "スタッフ管理": { key: "staff", order: 4, collapsible: true },
  "共同管理者": { key: "co-managers", order: 5, collapsible: true },
  "店舗の打刻位置": { key: "store-location", order: 6, collapsible: true },
};

function enhanceDashboard() {
  const shell = document.querySelector<HTMLElement>("main section");
  if (!shell) return;

  shell.dataset.dashboardRenewal = "true";

  const sections = Array.from(shell.children).filter(
    (node): node is HTMLElement => node instanceof HTMLElement && node.tagName === "SECTION",
  );

  for (const section of sections) {
    const heading = section.querySelector<HTMLElement>("h2");
    if (!heading) continue;

    const config = SECTION_CONFIG[heading.textContent?.trim() ?? ""];
    if (!config) continue;

    section.dataset.dashboardKey = config.key;
    section.style.order = String(config.order);

    const headingRow = heading.parentElement as HTMLElement | null;
    if (!config.collapsible || !headingRow) continue;

    section.dataset.dashboardCollapsible = "true";
    if (!section.dataset.dashboardInitialized) {
      section.dataset.dashboardInitialized = "true";
      section.dataset.dashboardCollapsed = "true";
      headingRow.setAttribute("role", "button");
      headingRow.setAttribute("tabindex", "0");
      headingRow.setAttribute("aria-expanded", "false");
      headingRow.setAttribute("aria-label", `${heading.textContent?.trim()}を開閉`);

      const toggle = () => {
        const collapsed = section.dataset.dashboardCollapsed === "true";
        section.dataset.dashboardCollapsed = collapsed ? "false" : "true";
        headingRow.setAttribute("aria-expanded", collapsed ? "true" : "false");
      };

      headingRow.addEventListener("click", toggle);
      headingRow.addEventListener("keydown", (event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          toggle();
        }
      });
    }
  }
}

export default function ManagerDashboardEnhancer() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/manager") return;

    let frame = window.requestAnimationFrame(enhanceDashboard);
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(enhanceDashboard);
    });

    observer.observe(document.body, { childList: true, subtree: true });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
