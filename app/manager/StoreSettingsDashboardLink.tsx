"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";

function ensureStoreSettingsSection() {
  const shell = document.querySelector<HTMLElement>("main section");
  if (!shell || shell.querySelector('[data-dashboard-key="store-settings"]')) return;

  const qrLink = shell.querySelector<HTMLAnchorElement>('a[href*="/manager/qr"]');
  if (!qrLink) return;
  const storeId = new URL(qrLink.href).searchParams.get("store_id");
  if (!storeId) return;

  const reference = Array.from(shell.children).find(
    (node): node is HTMLElement => node instanceof HTMLElement && node.tagName === "SECTION",
  );
  if (!reference) return;

  const section = document.createElement("section");
  section.className = reference.className;
  section.dataset.dashboardKey = "store-settings";
  section.style.order = "9";

  const referenceHeadingRow = reference.querySelector<HTMLElement>(":scope > div:first-child");
  const headingRow = document.createElement("div");
  if (referenceHeadingRow) headingRow.className = referenceHeadingRow.className;

  const heading = document.createElement("h2");
  heading.textContent = "店舗設定";
  const status = document.createElement("span");
  status.textContent = "登録情報";
  headingRow.append(heading, status);

  const note = document.createElement("p");
  note.textContent = "締め日や営業日の切替時刻など、店舗の運用設定を確認・変更できます。";

  const link = document.createElement("a");
  const referenceLink = shell.querySelector<HTMLAnchorElement>("a[href]");
  if (referenceLink) link.className = referenceLink.className;
  link.href = `/manager/store-settings?store_id=${encodeURIComponent(storeId)}`;
  link.textContent = "店舗設定を確認・変更";
  link.setAttribute("aria-label", "店舗の登録情報と運用設定を確認・変更する");

  section.append(headingRow, note, link);
  shell.append(section);
}

export default function StoreSettingsDashboardLink() {
  const pathname = usePathname();

  useEffect(() => {
    if (pathname !== "/manager") return;
    let frame = window.requestAnimationFrame(ensureStoreSettingsSection);
    const observer = new MutationObserver(() => {
      window.cancelAnimationFrame(frame);
      frame = window.requestAnimationFrame(ensureStoreSettingsSection);
    });
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      window.cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [pathname]);

  return null;
}
