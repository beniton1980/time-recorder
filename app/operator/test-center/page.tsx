"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import styles from "./test-center.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const TEST_CENTER_LIFF_URL = `https://liff.line.me/${LIFF_ID}?entry=test-center`;
const REAUTH_ATTEMPT_KEY = "onogami-test-center-reauth-attempted";
type Result = { id: string; category: string; label: string; status: "PASS" | "REVIEW" | "MANUAL"; detail: string };
type Run = { generatedAt: string; environment: string; results: Result[]; summary: { pass: number; review: number; manual: number } };
type ArtifactType = "email" | "csv" | "pdf" | "onboarding-contact" | "onboarding-manager" | "onboarding-start" | "onboarding-poster";

const labels = { PASS: "正常", REVIEW: "要確認", MANUAL: "実機確認" } as const;

export default function TestCenterPage() {
  const [ready, setReady] = useState(false);
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [email, setEmail] = useState<{ subject: string; html: string; attachments?: string[] } | null>(null);
  const categories = useMemo(() => [...new Set(run?.results.map((item) => item.category) ?? [])], [run]);

  function openViaLiff() {
    window.location.replace(TEST_CENTER_LIFF_URL);
  }

  useEffect(() => {
    let active = true;
    void liff.init({ liffId: LIFF_ID }).then(() => {
      if (!liff.isLoggedIn()) { openViaLiff(); return; }
      if (active) setReady(true);
    }).catch(() => active && setError("運営者認証を開始できませんでした。LINEから開き直してください。"));
    return () => { active = false; };
  }, []);

  function token() {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    return idToken;
  }

  function restartLineLogin() {
    if (window.sessionStorage.getItem(REAUTH_ATTEMPT_KEY) === "1") {
      throw new Error("LINE認証を更新できませんでした。画面を再読み込みして、もう一度お試しください。");
    }
    window.sessionStorage.setItem(REAUTH_ATTEMPT_KEY, "1");
    if (liff.isLoggedIn()) liff.logout();
    openViaLiff();
    throw new Error("LINE認証を更新しています…");
  }

  async function operatorPost(path: string, payload: Record<string, unknown>) {
    const response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken: token(), ...payload }),
    });
    if (response.status === 401) {
      const data = await response.clone().json().catch(() => null) as { code?: string } | null;
      if (data?.code === "INVALID_ID_TOKEN") restartLineLogin();
    }
    if (response.ok) window.sessionStorage.removeItem(REAUTH_ATTEMPT_KEY);
    return response;
  }

  async function execute() {
    setRunning(true); setError(null); setEmail(null);
    try {
      const response = await operatorPost("/api/operator/test-center/run", {});
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error(data.code === "OPERATOR_ACCESS_REQUIRED" ? "この画面を利用できる運営者権限がありません。" : "一括検証を完了できませんでした。");
      setRun(data as Run);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "一括検証を完了できませんでした。"); }
    finally { setRunning(false); }
  }

  async function preview(type: ArtifactType) {
    setError(null);
    try {
      const response = await operatorPost("/api/operator/test-center/artifact", { type });
      if (!response.ok) throw new Error("プレビューを生成できませんでした。");
      if (type !== "csv" && type !== "pdf" && type !== "onboarding-poster") { setEmail(await response.json()); return; }
      const url = URL.createObjectURL(await response.blob());
      window.open(url, "_blank", "noopener,noreferrer");
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "プレビューを生成できませんでした。"); }
  }

  return <main className={styles.page}><section className={styles.shell}>
    <p className={styles.brand}>ONOGAMI OPERATOR</p>
    <div className={styles.hero}><div><h1>Test Center</h1><p>実店舗データを変更せず、共通の模擬データで主要機能をまとめて確認します。</p></div><span className={styles.safe}>安全モード</span></div>
    <div className={styles.guard}><strong>この画面が行わないこと</strong><span>実メール送信・QR再発行・店舗や打刻の作成/変更・月次配信履歴の更新</span></div>
    <button className={styles.run} type="button" disabled={!ready || running} onClick={() => void execute()}>{running ? "検証中…" : "安全な全自動テストを実行"}</button>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {run && <>
      <section className={styles.summary} aria-label="検証結果"><div><b>{run.summary.pass}</b><span>正常</span></div><div><b>{run.summary.review}</b><span>要確認</span></div><div><b>{run.summary.manual}</b><span>実機確認</span></div></section>
      <p className={styles.meta}>{run.environment}環境・{new Date(run.generatedAt).toLocaleString("ja-JP")} 実行</p>
      <section className={styles.previewGroup}><h2>登録・案内メール</h2><div className={styles.previews}><button onClick={() => void preview("onboarding-contact")}>① メール確認</button><button onClick={() => void preview("onboarding-manager")}>② 管理者登録</button><button onClick={() => void preview("onboarding-start")}>③ 利用開始</button><button onClick={() => void preview("onboarding-poster")}>掲示用チラシ</button></div></section>
      <section className={styles.previewGroup}><h2>月次成果物</h2><div className={styles.previews}><button onClick={() => void preview("email")}>月次メール</button><button onClick={() => void preview("pdf")}>PDF表示</button><button onClick={() => void preview("csv")}>CSV表示</button></div></section>
      {email && <section className={styles.email}><strong>{email.subject}</strong>{email.attachments && <p className={styles.attachments}>添付予定：{email.attachments.join("、")}</p>}<div dangerouslySetInnerHTML={{ __html: email.html }} /></section>}
      {categories.map((category) => <section className={styles.category} key={category}><h2>{category}</h2><ul>{run.results.filter((item) => item.category === category).map((item) => <li key={item.id}><span className={`${styles.badge} ${styles[item.status.toLowerCase()]}`}>{labels[item.status]}</span><div><strong>{item.label}</strong><p>{item.detail}</p></div></li>)}</ul></section>)}
    </>}
  </section></main>;
}
