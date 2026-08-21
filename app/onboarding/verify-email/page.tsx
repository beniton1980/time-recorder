"use client";

import { useState } from "react";
import styles from "../onboarding.module.css";

type State = "idle" | "working" | "success" | "error";

export default function VerifyOnboardingEmailPage() {
  const [state, setState] = useState<State>("idle");

  async function verify() {
    if (state === "working") return;
    const params = new URLSearchParams(window.location.search);
    const clientRequestId = params.get("request_id");
    const token = params.get("token");
    if (!clientRequestId || !token) {
      setState("error");
      return;
    }

    setState("working");
    try {
      const response = await fetch("/api/onboarding/email-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clientRequestId, token }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("verification failed");
      window.history.replaceState({}, "", window.location.pathname);
      setState("success");
    } catch {
      setState("error");
    }
  }

  return <main className={styles.page}><section className={[styles.shell, styles.center].join(" ")}>
    <p className={styles.brand}>ONOGAMI</p>
    <h1>メールアドレス確認</h1>
    {state === "success" ? <>
      <p className={styles.success}>メールアドレスを確認しました。</p>
      <p className={styles.help}>ONOGAMIでの審査後、管理者登録のご案内をお送りします。</p>
    </> : <>
      <p className={styles.lead}>このメールアドレスを店舗の連絡先として確認します。確認完了後に管理者招待を発行できます。</p>
      {state === "error" && <p className={styles.error} role="alert">リンクが無効か、有効期限が切れています。ONOGAMI運営者へ確認メールの再送をご依頼ください。</p>}
      <button className={styles.primary} type="button" disabled={state === "working"} onClick={()=>void verify()}>
        {state === "working" ? "確認中…" : "メールアドレスを確認する"}
      </button>
    </>}
  </section></main>;
}
