"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import styles from "./qr.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_LIFF_URL = `https://liff.line.me/${LIFF_ID}/manager`;

type Membership = {
  store_id: string;
  store_name: string;
};

type IssuedQr = {
  storeName: string;
  entryUrl: string;
  qrSvg: string;
  qrPngDataUrl: string;
};

function escapeHtml(value: string) {
  return value.replace(/[&<>"']/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;",
  })[character] as string);
}

async function requestStoreQr(
  action: "STATUS" | "ROTATE" | "REVOKE",
  selectedStoreId: string,
) {
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
  const response = await fetch("/api/manager/store-qr", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ idToken, storeId: selectedStoreId, action }),
  });
  const data = await response.json();
  if (!response.ok || !data.ok) {
    if (data.code === "MANAGER_ACCESS_REQUIRED") {
      throw new Error("この店舗のQRを管理する権限がありません。");
    }
    throw new Error("店舗QRを処理できませんでした。");
  }
  return data;
}

export default function StoreQrPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [hasActiveQr, setHasActiveQr] = useState(false);
  const [issued, setIssued] = useState<IssuedQr | null>(null);
  const [message, setMessage] = useState("管理者権限を確認しています");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const managerUrl = storeId
    ? `${MANAGER_LIFF_URL}?store_id=${encodeURIComponent(storeId)}`
    : MANAGER_LIFF_URL;

  const storeName = useMemo(
    () => memberships.find((item) => item.store_id === storeId)?.store_name ?? "",
    [memberships, storeId],
  );

  useEffect(() => {
    let active = true;
    async function start() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const idToken = liff.getIDToken();
        const response = await fetch("/api/manager/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          throw new Error("管理者権限を確認できませんでした。");
        }
        const items = data.manager.memberships as Membership[];
        if (!active) return;
        const requestedStoreId = new URLSearchParams(window.location.search)
          .get("store_id");
        const selectedStoreId = items.find(
          (item) => item.store_id === requestedStoreId,
        )?.store_id ?? items[0].store_id;
        setMemberships(items);
        setStoreId(selectedStoreId);
        const status = await requestStoreQr("STATUS", selectedStoreId);
        if (!active) return;
        setHasActiveQr(status.token.active);
        setMessage("");
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "画面を読み込めませんでした。");
      }
    }
    void start();
    return () => { active = false; };
  }, []);

  async function changeStore(nextStoreId: string) {
    setStoreId(nextStoreId);
    setIssued(null);
    setError(null);
    try {
      const status = await requestStoreQr("STATUS", nextStoreId);
      setHasActiveQr(status.token.active);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "状態を確認できませんでした。");
    }
  }

  async function rotate() {
    const confirmation = hasActiveQr
      ? "新しいQRを発行すると、現在掲示中のQRはすぐに使えなくなります。続けますか？"
      : "この店舗の打刻QRを発行しますか？";
    if (!window.confirm(confirmation)) return;
    setWorking(true);
    setError(null);
    setIssued(null);
    try {
      const data = await requestStoreQr("ROTATE", storeId);
      setIssued({
        storeName: data.store.store_name,
        entryUrl: data.entryUrl,
        qrSvg: data.qrSvg,
        qrPngDataUrl: data.qrPngDataUrl,
      });
      setHasActiveQr(true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "QRを発行できませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function revoke() {
    if (!window.confirm("現在のQRを無効にします。スタッフは新しいQRが発行されるまで打刻できません。続けますか？")) return;
    setWorking(true);
    setError(null);
    try {
      await requestStoreQr("REVOKE", storeId);
      setHasActiveQr(false);
      setIssued(null);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "QRを無効にできませんでした。");
    } finally {
      setWorking(false);
    }
  }

  async function savePng() {
    if (!issued) return;
    const safeFileName = issued.storeName.replace(/[\\/:*?"<>|]/g, "-");
    setError(null);
    try {
      const imageBlob = await (await fetch(issued.qrPngDataUrl)).blob();
      const imageFile = new File([imageBlob], `${safeFileName}-打刻QR.png`, {
        type: "image/png",
      });
      if (
        typeof navigator.share === "function"
        && typeof navigator.canShare === "function"
        && navigator.canShare({ files: [imageFile] })
      ) {
        await navigator.share({ files: [imageFile], title: `${issued.storeName}の店舗QR` });
        return;
      }
      const imageWindow = window.open(issued.qrPngDataUrl, "_blank");
      if (imageWindow) return;
      const anchor = document.createElement("a");
      anchor.href = issued.qrPngDataUrl;
      anchor.download = imageFile.name;
      anchor.target = "_blank";
      anchor.rel = "noopener";
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError("QR画像を保存できませんでした。表示中のQR画像を長押しして保存してください。");
    }
  }

  function printA4() {
    if (!issued) return;
    const popup = window.open("", "_blank");
    if (!popup) {
      setError("印刷画面を開けませんでした。ポップアップを許可してください。");
      return;
    }
    popup.opener = null;
    const safeStoreName = escapeHtml(issued.storeName);
    popup.document.write(`<!doctype html><html lang="ja"><head><meta charset="utf-8"><title>${safeStoreName} 打刻QR</title><style>@page{size:A4;margin:18mm}body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","Noto Sans JP",sans-serif;text-align:center;color:#17221b}h1{font-size:30px;margin:8mm 0 3mm}.brand{font-weight:800;letter-spacing:.16em;color:#207a45}.qr{width:120mm;height:120mm;margin:8mm auto 5mm}.steps{font-size:18px;line-height:1.8;text-align:left;display:inline-block}.note{font-size:14px;color:#526057;margin-top:8mm}@media print{button{display:none}}</style></head><body><p class="brand">ONOGAMI 勤怠</p><h1>${safeStoreName}</h1><p>スタッフ打刻用QRコード</p><div class="qr">${issued.qrSvg}</div><ol class="steps"><li>LINEでQRコードを読み取る</li><li>店舗名を確認する</li><li>出勤・休憩・退勤を打刻する</li></ol><p class="note">QRが読み取れない場合は管理者へお知らせください。</p><button onclick="window.print()">A4 PDFとして保存・印刷</button><script>window.onload=()=>window.print()<\/script></body></html>`);
    popup.document.close();
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <p className={styles.brand}>ONOGAMI</p>
        <h1>店舗QR管理</h1>
        {message && !error && <p>{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
        {memberships.length > 0 && (
          <>
            <label className={styles.field}>
              店舗
              <select value={storeId} onChange={(event) => void changeStore(event.target.value)}>
                {memberships.map((item) => <option key={item.store_id} value={item.store_id}>{item.store_name}</option>)}
              </select>
            </label>
            <div className={styles.status}>
              <strong>{storeName}</strong>
              <span className={hasActiveQr ? styles.active : styles.inactive}>
                {hasActiveQr ? "有効なQRがあります" : "有効なQRはありません"}
              </span>
            </div>
            <button className={styles.primary} type="button" disabled={working} onClick={() => void rotate()}>
              {working ? "処理中…" : hasActiveQr ? "QRを再発行" : "QRを発行"}
            </button>
            {hasActiveQr && (
              <button className={styles.danger} type="button" disabled={working} onClick={() => void revoke()}>
                現在のQRを無効化
              </button>
            )}
          </>
        )}
        {issued && (
          <section className={styles.result}>
            <h2>発行しました</h2>
            <p className={styles.warning}>このQRはこの画面を閉じると再表示できません。今すぐ保存してください。</p>
            <div className={styles.qr}>
              {/* The generated PNG must remain directly saveable on iPhone. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={issued.qrPngDataUrl} alt={`${issued.storeName}の打刻QRコード`} />
            </div>
            <button type="button" onClick={() => void savePng()}>QR画像を保存・共有</button>
            <p className={styles.saveHelp}>保存画面が開かない場合は、上のQR画像を長押しして保存してください。</p>
            <button type="button" onClick={printA4}>A4案内をPDF保存・印刷</button>
          </section>
        )}
        <a className={styles.back} href={managerUrl}>管理者画面へ戻る</a>
      </section>
    </main>
  );
}
