"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import styles from "../../onboarding/onboarding.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_URL = `https://liff.line.me/${LIFF_ID}/manager`;

export default function StoreManagerInvitePage() {
  const [token, setToken] = useState("");
  const [ready, setReady] = useState(false);
  const [claiming, setClaiming] = useState(false);
  const [storeName, setStoreName] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    async function start() {
      const inviteToken = new URLSearchParams(window.location.search).get("token") ?? "";
      if (inviteToken.length < 40 || inviteToken.length > 100) { setError("この招待リンクは利用できません。"); return; }
      setToken(inviteToken);
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
        setReady(true);
      } catch { setError("LINE認証を開始できませんでした。"); }
    }
    void start();
  }, []);
  async function claim() {
    const idToken = liff.getIDToken();
    if (!idToken || claiming) return;
    setClaiming(true); setError(null);
    try {
      const response = await fetch("/api/manager/co-managers/claim", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, inviteToken: token }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.code === "MANAGER_INVITE_INVALID" ? "この招待リンクは期限切れ、使用済み、または無効です。" : "共同管理者登録を完了できませんでした。");
      setStoreName(String(data.manager.store_name));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "共同管理者登録を完了できませんでした。"); }
    finally { setClaiming(false); }
  }
  return <main className={styles.page}><section className={[styles.shell, styles.center].join(" ")}>
    <p className={styles.brand}>ONOGAMI</p>
    {storeName ? <><h1>共同管理者登録が完了しました</h1><p className={styles.success}>{storeName}の管理画面を利用できます。</p><a className={styles.primary} href={MANAGER_URL}>管理者画面へ</a></> : <><h1>共同管理者の登録</h1><p className={styles.lead}>招待された店舗だけを管理できるようになります。</p>{error && <p className={styles.error} role="alert">{error}</p>}{ready && <button className={styles.primary} type="button" disabled={claiming} onClick={() => void claim()}>{claiming ? "登録中…" : "このLINEで登録"}</button>}</>}
  </section></main>;
}
