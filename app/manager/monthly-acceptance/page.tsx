"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import styles from "./monthly-acceptance.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";

type Membership = {
  store_id: string;
  store_name: string;
};

type Dashboard = {
  manager: {
    store_id: string;
    store_name: string;
    monthly_report_email: string | null;
    monthly_report_email_verified_at: string | null;
    monthly_report_email_consented_at: string | null;
  };
};

function monthEndToday() {
  const now = new Date();
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
  });
  const parts = formatter.formatToParts(now);
  const year = Number(parts.find((part) => part.type === "year")?.value ?? now.getFullYear());
  const month = Number(parts.find((part) => part.type === "month")?.value ?? now.getMonth() + 1);
  const end = new Date(Date.UTC(year, month, 0));
  return end.toISOString().slice(0, 10);
}

export default function MonthlyAcceptancePage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [periodEnd, setPeriodEnd] = useState(monthEndToday);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const recipientConfirmed = useMemo(() => Boolean(
    dashboard?.manager.monthly_report_email
    && dashboard.manager.monthly_report_email_verified_at
    && dashboard.manager.monthly_report_email_consented_at
  ), [dashboard]);

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
        if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
        const response = await fetch("/api/manager/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error("管理者権限を確認できませんでした。");
        if (!active) return;
        const items = data.manager.memberships as Membership[];
        const requested = new URLSearchParams(window.location.search).get("store_id");
        const initial = items.find((item) => item.store_id === requested)?.store_id ?? items[0]?.store_id ?? "";
        setMemberships(items);
        setStoreId(initial);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "画面を読み込めませんでした。");
      } finally {
        if (active) setLoading(false);
      }
    }

    void start();
    return () => { active = false; };
  }, []);

  useEffect(() => {
    let active = true;
    async function loadStore() {
      if (!storeId || !liff.isLoggedIn()) return;
      try {
        const idToken = liff.getIDToken();
        if (!idToken) return;
        const response = await fetch("/api/manager/dashboard", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeId }),
        });
        const data = await response.json();
        if (active && response.ok && data.ok) setDashboard(data as Dashboard);
      } catch {
        if (active) setDashboard(null);
      }
    }
    void loadStore();
    return () => { active = false; };
  }, [storeId]);

  async function sendAcceptanceTest() {
    if (!storeId || !recipientConfirmed) return;
    if (!window.confirm("本番の月次配信履歴には記録せず、現在の実データから受入テストメールを送信します。よろしいですか？")) return;
    setSending(true);
    setMessage(null);
    setError(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/monthly-attendance/acceptance-test", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId,
          periodEnd,
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const messages: Record<string, string> = {
          MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED: "月次メールの送信先確認が完了していません。管理画面で送信先を確認してください。",
          INVALID_PERIOD_END: "入力した締め日が、この店舗の締め日設定と一致していません。",
          EMAIL_DELIVERY_FAILED: "メール送信に失敗しました。",
          EMAIL_NOT_CONFIGURED: "メール送信設定を確認できませんでした。",
        };
        throw new Error(messages[data.code] ?? "受入テストメールを送信できませんでした。");
      }
      setMessage(`送信しました。対象期間 ${data.period.start} 〜 ${data.period.end}、スタッフ ${data.staffCount}名、勤怠要確認 ${data.attendanceIssueDays}日分、GPS確認 ${data.gpsIssueCount}件です。`);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "受入テストメールを送信できませんでした。");
    } finally {
      setSending(false);
    }
  }

  if (loading) return <main className={styles.page}><p>読み込み中です…</p></main>;

  return (
    <main className={styles.page}>
      <section className={styles.card}>
        <p className={styles.eyebrow}>ONOGAMI勤怠</p>
        <h1>月次メール受入テスト</h1>
        <p className={styles.note}>現在の実データを、本番と同じ集計・PDF・メール生成経路で確認します。通常の月次自動送信や配信履歴には影響しません。</p>

        {memberships.length > 1 && (
          <label className={styles.field}>店舗
            <select value={storeId} onChange={(event) => setStoreId(event.target.value)} disabled={sending}>
              {memberships.map((item) => <option key={item.store_id} value={item.store_id}>{item.store_name}</option>)}
            </select>
          </label>
        )}

        <div className={styles.summary}>
          <strong>{dashboard?.manager.store_name ?? "店舗を確認中"}</strong>
          <span>送信先：{dashboard?.manager.monthly_report_email ?? "未設定"}</span>
          <span>{recipientConfirmed ? "送信先確認済み" : "送信先の確認が必要です"}</span>
        </div>

        <label className={styles.field}>締め日
          <input type="date" value={periodEnd} onChange={(event) => setPeriodEnd(event.target.value)} disabled={sending} />
        </label>
        <p className={styles.hint}>月末締め店舗は月末日を指定してください。今回の8月度確認なら 2026-08-31 です。</p>

        <button className={styles.primary} type="button" onClick={() => void sendAcceptanceTest()} disabled={sending || !recipientConfirmed || !storeId}>
          {sending ? "送信中…" : "受入テストメールを送信"}
        </button>

        {message && <p className={styles.success} role="status">{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}
      </section>
    </main>
  );
}
