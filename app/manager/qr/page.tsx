"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useRef, useState } from "react";
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
  const [issuedAt, setIssuedAt] = useState<string | null>(null);
  const [issued, setIssued] = useState<IssuedQr | null>(null);
  const [message, setMessage] = useState("管理者権限を確認しています");
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const [a4PngDataUrl, setA4PngDataUrl] = useState<string | null>(null);
  const qrResultRef = useRef<HTMLElement>(null);
  const a4PreviewRef = useRef<HTMLDivElement>(null);
  const managerUrl = storeId
    ? `${MANAGER_LIFF_URL}?store_id=${encodeURIComponent(storeId)}`
    : MANAGER_LIFF_URL;

  const storeName = useMemo(
    () => memberships.find((item) => item.store_id === storeId)?.store_name ?? "",
    [memberships, storeId],
  );

  useEffect(() => {
    if (!issued) return;
    const frame = window.requestAnimationFrame(() => {
      qrResultRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [issued]);

  useEffect(() => {
    if (!a4PngDataUrl) return;
    const frame = window.requestAnimationFrame(() => {
      a4PreviewRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [a4PngDataUrl]);

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
        setIssuedAt(status.token.issuedAt ?? null);
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
    setA4PngDataUrl(null);
    setError(null);
    try {
      const status = await requestStoreQr("STATUS", nextStoreId);
      setHasActiveQr(status.token.active);
      setIssuedAt(status.token.issuedAt ?? null);
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
      setIssuedAt(new Date().toISOString());
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
      setIssuedAt(null);
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

  async function saveA4Guide() {
    if (!issued) return;
    setError(null);
    try {
      const canvas = document.createElement("canvas");
      canvas.width = 1240;
      canvas.height = 1754;
      const context = canvas.getContext("2d");
      if (!context) throw new Error("CANVAS_UNAVAILABLE");
      context.fillStyle = "#ffffff";
      context.fillRect(0, 0, canvas.width, canvas.height);
      context.textAlign = "center";
      context.fillStyle = "#207a45";
      context.font = "700 36px sans-serif";
      context.fillText("ONOGAMI 勤怠", 620, 110);
      context.fillStyle = "#17221b";
      context.font = "700 52px sans-serif";
      context.fillText(issued.storeName, 620, 195, 1080);
      context.font = "32px sans-serif";
      context.fillText("スタッフ打刻用QRコード", 620, 255);
      const qrImage = new Image();
      qrImage.src = issued.qrPngDataUrl;
      await new Promise<void>((resolve, reject) => {
        qrImage.onload = () => resolve();
        qrImage.onerror = () => reject(new Error("QR_IMAGE_UNAVAILABLE"));
      });
      context.drawImage(qrImage, 260, 310, 720, 720);
      context.textAlign = "left";
      context.font = "34px sans-serif";
      ["1. LINEでQRコードを読み取る", "2. 店舗名を確認する", "3. 出勤・休憩・退勤を打刻する"]
        .forEach((line, index) => context.fillText(line, 245, 1130 + index * 72));
      context.fillStyle = "#526057";
      context.font = "28px sans-serif";
      context.fillText("QRが読み取れない場合は管理者へお知らせください。", 245, 1390);
      const guideDataUrl = canvas.toDataURL("image/png");
      setA4PngDataUrl(guideDataUrl);
      const guideBlob = await (await fetch(guideDataUrl)).blob();
      const safeFileName = issued.storeName.replace(/[\\/:*?"<>|]/g, "-");
      const guideFile = new File([guideBlob], `${safeFileName}-A4打刻案内.png`, { type: "image/png" });
      if (typeof navigator.share === "function" && typeof navigator.canShare === "function" && navigator.canShare({ files: [guideFile] })) {
        await navigator.share({ files: [guideFile], title: `${issued.storeName}のA4打刻案内` });
        return;
      }
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") return;
      setError("共有画面を開けませんでした。下のA4案内画像を長押しして保存してください。");
    }
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
              <div>
                <strong>{storeName}</strong>
                {hasActiveQr && issuedAt && <small>
                  発行日時：{new Intl.DateTimeFormat("ja-JP", { dateStyle: "medium", timeStyle: "short" }).format(new Date(issuedAt))}
                </small>}
              </div>
              <span className={hasActiveQr ? styles.active : styles.inactive}>{hasActiveQr ? "利用中" : "QRなし"}</span>
            </div>
            {hasActiveQr && !issued && <p className={styles.securityNote}>
              現在のQRは安全のためサーバーに元データを保存しておらず、再表示できません。保存済みのQRを紛失した場合のみ再発行してください。
            </p>}
            {issued && (
              <section ref={qrResultRef} className={styles.result}>
                <h2>現在のQR</h2>
                <p className={styles.warning}>このQRはこの画面を閉じると再表示できません。今すぐ保存してください。</p>
                <div className={styles.qr}>
                  {/* The generated PNG must remain directly saveable on iPhone. */}
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={issued.qrPngDataUrl} alt={`${issued.storeName}の打刻QRコード`} />
                </div>
                <button type="button" onClick={() => void savePng()}>QR画像を保存・共有</button>
                <p className={styles.saveHelp}>保存画面が開かない場合は、上のQR画像を長押しして保存してください。</p>
                <button type="button" onClick={() => void saveA4Guide()}>A4案内画像を保存・共有</button>
                {a4PngDataUrl && <div ref={a4PreviewRef} className={styles.a4Preview}>
                  <p role="status">A4案内画像を作成しました。下の画像を長押しして保存してください。</p>
                  {/* eslint-disable-next-line @next/next/no-img-element */}
                  <img src={a4PngDataUrl} alt={`${issued.storeName}のA4打刻案内`} />
                </div>}
              </section>
            )}
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
        <a className={styles.back} href={managerUrl}>管理者画面へ戻る</a>
      </section>
    </main>
  );
}
