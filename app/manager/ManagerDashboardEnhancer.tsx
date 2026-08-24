"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

type SectionConfig = {
  key: string;
  order: number;
  collapsible: boolean;
  collapseWhenEmpty?: boolean;
};

const SECTION_CONFIG: Record<string, SectionConfig> = {
  "未処理の訂正申請": { key: "review", order: 1, collapsible: true, collapseWhenEmpty: true },
  "勤務状況": { key: "attendance", order: 2, collapsible: false },
  "勤怠確認": { key: "attendance", order: 2, collapsible: false },
  "月次勤怠表": { key: "monthly", order: 3, collapsible: true },
  "スタッフ管理": { key: "staff", order: 4, collapsible: true },
  "QR・掲示物": { key: "qr", order: 5, collapsible: true },
  "共同管理者": { key: "co-managers", order: 6, collapsible: true },
  "店舗の打刻位置": { key: "store-location", order: 7, collapsible: true },
};

function ensureQrSection(shell: HTMLElement) {
  const header = shell.querySelector<HTMLElement>(":scope > header");
  const qrLink = shell.querySelector<HTMLAnchorElement>('a[href*="/manager/qr"]');
  if (!header || !qrLink) return;

  let section = shell.querySelector<HTMLElement>('[data-dashboard-key="qr"]');
  if (!section) {
    const referenceSection = Array.from(shell.children).find(
      (node): node is HTMLElement => node instanceof HTMLElement && node.tagName === "SECTION",
    );
    if (!referenceSection) return;

    const referenceHeadingRow = referenceSection.querySelector<HTMLElement>(":scope > div:first-child");
    section = document.createElement("section");
    section.className = referenceSection.className;
    section.dataset.dashboardKey = "qr";

    const headingRow = document.createElement("div");
    if (referenceHeadingRow) headingRow.className = referenceHeadingRow.className;

    const heading = document.createElement("h2");
    heading.textContent = "QR・掲示物";
    const status = document.createElement("span");
    status.textContent = "使用中";
    headingRow.append(heading, status);

    const note = document.createElement("p");
    note.dataset.dashboardQrNote = "true";
    note.textContent = "店舗で掲示するQRの表示・保存・再発行はこちらから行えます。";

    section.append(headingRow, note);
    shell.append(section);
  }

  if (qrLink.parentElement !== section) {
    qrLink.textContent = "QR・掲示物を開く";
    qrLink.setAttribute("aria-label", "店舗QRと掲示物の管理画面を開く");
    section.append(qrLink);
  }
}

function replaceAttendanceSection(section: HTMLElement, shell: HTMLElement) {
  if (section.dataset.attendanceUnified === "true") return;

  const originalSelect = Array.from(section.querySelectorAll<HTMLSelectElement>("select"))
    .find((select) => Array.from(select.options).some((option) => option.value === "ALL"));
  if (!originalSelect) return;

  const staffOptions = Array.from(originalSelect.options)
    .filter((option) => option.value && option.value !== "ALL")
    .map((option) => ({ value: option.value, label: option.textContent?.trim() || "スタッフ" }));
  const qrLink = shell.querySelector<HTMLAnchorElement>('a[href*="/manager/qr"]');
  const storeId = qrLink ? new URL(qrLink.href).searchParams.get("store_id") : null;
  if (!storeId) return;

  const headingRow = section.querySelector<HTMLElement>(":scope > div:first-child");
  const headingClass = headingRow?.className || "";
  const sectionNote = section.querySelector<HTMLElement>("p")?.className || "";
  const selectorLabel = originalSelect.closest("label");
  const selectorClass = selectorLabel?.className || "";

  section.innerHTML = "";
  section.dataset.attendanceUnified = "true";

  const newHeadingRow = document.createElement("div");
  newHeadingRow.className = headingClass;
  const heading = document.createElement("h2");
  heading.textContent = "勤怠確認";
  const count = document.createElement("span");
  count.textContent = `${staffOptions.length}名`;
  newHeadingRow.append(heading, count);

  const note = document.createElement("p");
  note.className = sectionNote;
  note.textContent = "スタッフを選択すると、その人の今月の勤怠・要確認・打刻修正をまとめて確認できます。";

  const label = document.createElement("label");
  label.className = selectorClass;
  label.textContent = "スタッフを選択";
  const select = document.createElement("select");
  for (const optionData of staffOptions) {
    const option = document.createElement("option");
    option.value = optionData.value;
    option.textContent = optionData.label;
    select.append(option);
  }
  label.append(select);

  const link = document.createElement("a");
  link.dataset.staffAttendanceLink = "true";
  link.textContent = "個人の勤怠を開く";
  link.setAttribute("aria-label", "選択したスタッフの個人勤怠を開く");

  const refresh = () => {
    const selectedStaffId = select.value;
    if (!selectedStaffId) {
      link.hidden = true;
      link.removeAttribute("href");
      return;
    }
    link.hidden = false;
    link.href = `/manager/staff-attendance?store_id=${encodeURIComponent(storeId)}&staff_id=${encodeURIComponent(selectedStaffId)}`;
  };

  select.addEventListener("change", refresh);
  refresh();

  section.append(newHeadingRow, note, label, link);
}

function reviewCount(section: HTMLElement) {
  const headingRow = section.querySelector<HTMLElement>(":scope > div:first-child");
  const countText = headingRow?.querySelector("span")?.textContent?.trim() ?? "";
  const match = /^(\d+)件$/.exec(countText);
  return match ? Number(match[1]) : null;
}

function setCollapsed(section: HTMLElement, headingRow: HTMLElement, collapsed: boolean) {
  section.dataset.dashboardCollapsed = collapsed ? "true" : "false";
  headingRow.setAttribute("aria-expanded", collapsed ? "false" : "true");
}

function enhanceDashboard() {
  const shell = document.querySelector<HTMLElement>("main section");
  if (!shell) return;

  shell.dataset.dashboardRenewal = "true";
  ensureQrSection(shell);

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

    if (config.key === "attendance") replaceAttendanceSection(section, shell);

    const refreshedHeading = section.querySelector<HTMLElement>("h2");
    const headingRow = refreshedHeading?.parentElement as HTMLElement | null;
    if (!config.collapsible || !headingRow) continue;

    section.dataset.dashboardCollapsible = "true";

    const count = config.collapseWhenEmpty ? reviewCount(section) : null;
    if (config.collapseWhenEmpty && count !== null) {
      section.dataset.dashboardReviewEmpty = count === 0 ? "true" : "false";
      setCollapsed(section, headingRow, count === 0);
    }

    if (!section.dataset.dashboardInitialized) {
      section.dataset.dashboardInitialized = "true";
      if (!config.collapseWhenEmpty) setCollapsed(section, headingRow, true);
      headingRow.setAttribute("role", "button");
      headingRow.setAttribute("tabindex", "0");
      headingRow.setAttribute("aria-label", `${refreshedHeading?.textContent?.trim()}を開閉`);

      const toggle = () => {
        const collapsed = section.dataset.dashboardCollapsed === "true";
        setCollapsed(section, headingRow, !collapsed);
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

    observer.observe(document.body, { childList: true, subtree: true, characterData: true });

    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
