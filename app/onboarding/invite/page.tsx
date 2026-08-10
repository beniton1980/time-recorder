"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import styles from "../onboarding.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_QR_LIFF_URL = `https://liff.line.me/${LIFF_ID}/manager/qr`;

export default function ManagerInvitePage() {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [storeName, setStoreName] = useState<string | null>(null);
  const [qrSvg, setQrSvg] = useState<string | null>(null);
  const [qrEmailSent, setQrEmailSent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    async function start() {
      const inviteToken = new URLSearchParams(window.location.search).get("token") ?? "";
      if (inviteToken.length < 40 || inviteToken.length > 100) {
        setError("この管理者招待リンクは利用できません。");
        return;
      }
      setToken(inviteToken);
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        window.history.replaceState({}, "", window.location.pathname);
        if (active) setReady(true);
      } catch {
        if (active) setError("LINE認証を開始できませんでした。");
      }
    }
    void start();
    return () => { active = false; };
  }, []);

  async function claim() {
    if (!ready || claiming) return;
    setClaiming(true);
    setError(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/onboarding/manager-invite/claim", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, inviteToken: token }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.code === "MANAGER_INVITE_INVALID") {
          throw new Error("この招待リンクは期限切れ、使用済み、または無効です。");
        }
        throw new Error("管理者登録を完了できませんでした。");
      }
      setStoreName(data.manager.storeName as string);
      setQrSvg((data.storeQr?.qrSvg as string | undefined) ?? null);
      setQrEmailSent(data.storeQrEmail?.sent === true);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "管理者登録を完了できませんでした。");
    } finally {
      setClaiming(false);
    }
  }

  function downloadQr() {
    if (!qrSvg || !storeName) return;
    const blob = new Blob([qrSvg], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${storeName.replace(/[\\/:*?"<>|]/g, "-")}-打刻QR.svg`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  return <main className={styles.page}><section className={[styles.shell, styles.center].join(" ")}>
    <p className={styles.brand}>ONOGAMI</p>
    {storeName ? <>
      <h1>管理者登録が完了しました</h1>
      <p className={styles.success}>{storeName}の店舗管理者として登録され、店舗が利用可能になりました。</p>
      {qrSvg ? <>
        <p className={styles.tokenWarning}>店舗の打刻QRを発行しました。この画面を閉じる前に保存してください。</p>
        <div className={styles.qrPreview} dangerouslySetInnerHTML={{ __html: qrSvg }} />
        {qrEmailSent && <p className={styles.notice}>同じQR画像を登録メールアドレスにも送信しました。</p>}
        <div className={styles.completionActions}>
          <button className={styles.primary} type="button" onClick={downloadQr}>店舗QRを保存</button>
          <a className={styles.secondary} href={MANAGER_QR_LIFF_URL}>{qrSvg ? "QR管理画面へ" : "QRを発行する"}</a>
        </div>
      </> : <>
        <p className={styles.tokenWarning}>QRの自動発行を完了できませんでした。QR管理画面から発行してください。</p>
        <div className={styles.completionActions}>
          <a className={styles.primary} href={MANAGER_QR_LIFF_URL}>QRを発行する</a>
        </div>
      </>}
    </> : <>
      <h1>店舗管理者の登録</h1>
      <p className={styles.lead}>このLINEアカウントを店舗管理者として登録します。登録後、店舗の打刻QRを発行できます。</p>
      <p className={styles.tokenWarning}>招待リンクは一度だけ利用できます。</p>
      {error && <p className={styles.error} role="alert">{error}</p>}
      {!error && !ready && <p className={styles.notice}>LINE認証を確認しています…</p>}
      {ready && <button className={styles.primary} type="button" disabled={claiming} onClick={()=>void claim()}>{claiming ? "登録中…" : "このLINEで管理者登録"}</button>}
    </>}
  </section></main>;
}
