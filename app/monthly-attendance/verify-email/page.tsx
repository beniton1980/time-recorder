"use client";

import { useState } from "react";
import styles from "./verify-email.module.css";

type State = "idle" | "working" | "success" | "error";

export default function VerifyMonthlyReportEmailPage() {
  const [state, setState] = useState<State>("idle");
  const [consent, setConsent] = useState(false);

  async function verify() {
    if (state === "working" || !consent) return;
    const params = new URLSearchParams(window.location.search);
    const storeId = params.get("store_id");
    const token = params.get("token");
    if (!storeId || !token) {
      setState("error");
      return;
    }

    setState("working");
    try {
      const response = await fetch("/api/monthly-attendance/email-verification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ storeId, token, consent: true }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("verification failed");
      window.history.replaceState({}, "", window.location.pathname);
      setState("success");
    } catch {
      setState("error");
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <p className={styles.brand}>ONOGAMI</p>
        <h1>月次勤怠表の送信先確認</h1>
        {state === "success" ? (
          <>
            <p className={styles.success}>送信先メールの確認と、月次勤怠表の受信同意が完了しました。</p>
            <p className={styles.help}>次回の締め日翌朝から、このメールアドレスへ月次勤怠表をお送りします。</p>
          </>
        ) : (
          <>
            <p className={styles.lead}>月次勤怠表には、スタッフ氏名、打刻時刻、勤務・休憩時間、勤怠の要確認状態が含まれます。</p>
            <label className={styles.consent}>
              <span>
                <input type="checkbox" checked={consent} onChange={(event) => setConsent(event.target.checked)} />
                このメールアドレスで月次勤怠表を受け取ることに同意します
              </span>
            </label>
            {state === "error" && <p className={styles.error} role="alert">リンクが無効か、有効期限が切れています。管理者画面から確認メールを再送してください。</p>}
            <button className={styles.primary} type="button" disabled={state === "working" || !consent} onClick={() => void verify()}>
              {state === "working" ? "確認中…" : "確認して同意する"}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
