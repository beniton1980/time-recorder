"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import { managerApiAuthError } from "@/lib/manager-api-auth-error";
import { isConfirmedMonthlyReportRecipient } from "@/lib/monthly-report-recipient";
import styles from "./store-settings.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
type ClosingRule = "month_end" | "day_15" | "day_25";
type StoreSettings = {
  id: string;
  name: string;
  closing_rule: ClosingRule;
  business_day_start_minute: number;
  monthly_report_email: string | null;
  monthly_report_email_verified_at: string | null;
  monthly_report_email_consented_at: string | null;
  monthly_report_email_consent_version: string | null;
  monthly_report_email_verification_sent_at: string | null;
};
const closingLabels: Record<ClosingRule, string> = { month_end: "月末", day_15: "15日", day_25: "25日" };
function minuteToTime(minute: number) {
  return `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
}
function entryUrl(storeId: string) {
  return `https://liff.line.me/${LIFF_ID}?entry=store-settings&store_id=${encodeURIComponent(storeId)}`;
}

export default function StoreSettingsPage() {
  const [storeId, setStoreId] = useState("");
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [closingRule, setClosingRule] = useState<ClosingRule>("month_end");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [reauthRequired, setReauthRequired] = useState(false);
  const [reloadRequired, setReloadRequired] = useState(false);
  const changed = settings !== null && settings.closing_rule !== closingRule;
  const managerUrl = storeId ? `/manager?store_id=${encodeURIComponent(storeId)}` : "/manager";

  useEffect(() => {
    let active = true;
    async function start() {
      try {
        const resolvedStoreId = new URLSearchParams(window.location.search).get("store_id") ?? "";
        if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(resolvedStoreId)) {
          throw new Error("店舗を特定できませんでした。管理画面から開き直してください。");
        }
        if (active) setStoreId(resolvedStoreId);
        await liff.init({ liffId: LIFF_ID });
        if (!active) return;
        if (!liff.isLoggedIn()) {
          window.location.replace(entryUrl(resolvedStoreId));
          return;
        }
        const idToken = liff.getIDToken();
        if (!idToken) { setReauthRequired(true); throw new Error("LINEの認証情報を取得できませんでした。再ログインしてください。"); }
        const response = await fetch("/api/manager/store-settings", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeId: resolvedStoreId }),
        });
        const data = await response.json();
        if (!active) return;
        if (!response.ok || !data.ok) {
          setReauthRequired(response.status === 401);
          throw managerApiAuthError(response.status, data) ?? new Error("店舗設定を読み込めませんでした。");
        }
        setSettings(data.store as StoreSettings);
        setClosingRule(data.store.closing_rule);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "店舗設定を読み込めませんでした。");
      } finally {
        if (active) setLoading(false);
      }
    }
    void start();
    return () => { active = false; };
  }, []);

  async function save() {
    if (!settings || !storeId || saving || !changed || reloadRequired) return;
    if (!window.confirm(`締め日を「${closingLabels[settings.closing_rule]}」から「${closingLabels[closingRule]}」へ変更します。\n\n今後の月次集計期間と自動送信日に影響します。変更時は、前回の集計期間との重複・抜けを確認してください。送信済み帳票・保存済み給与はそのまま残ります。\n\n変更してよろしいですか？`)) return;
    setSaving(true); setError(null); setMessage(null);
    const selectedRule = closingRule;
    try {
      const idToken = liff.getIDToken();
      if (!idToken) { setReauthRequired(true); throw new Error("LINEの認証期限を確認してください。"); }
      const response = await fetch("/api/manager/store-settings", {
        method: "PATCH", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, storeId, closingRule: selectedRule, expectedClosingRule: settings.closing_rule }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        setReauthRequired(response.status === 401);
        if (data.code === "STORE_SETTINGS_CHANGED") {
          setReloadRequired(true);
          throw new Error("別の操作で締め日が変更されています。最新の設定を読み直してください。");
        }
        throw managerApiAuthError(response.status, data) ?? new Error("店舗設定を保存できませんでした。");
      }
      setSettings(data.store as StoreSettings);
      setClosingRule(data.store.closing_rule);
      setMessage("締め日を更新しました。新しく開く集計と今後の自動送信に反映されます。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "店舗設定を保存できませんでした。");
    } finally { setSaving(false); }
  }

  return (
    <main className={styles.page}><section className={styles.shell}>
      <a className={styles.back} href={managerUrl}>← 管理画面へ戻る</a>
      <p className={styles.brand}>ONOGAMI</p><h1>店舗設定</h1>
      <p className={styles.lead}>店舗の締め日と、月次勤怠表を受け取るための設定を確認できます。</p>
      {loading && <p className={styles.notice}>店舗設定を読み込んでいます…</p>}
      {error && <p className={styles.error} role="alert">{error}</p>}
      {reauthRequired && <button className={styles.primary} onClick={() => { liff.logout(); window.location.replace(entryUrl(storeId)); }}>LINEで再ログイン</button>}
      {reloadRequired && <button className={styles.primary} onClick={() => window.location.reload()}>最新の設定を読み直す</button>}
      {settings && <>
        <div className={styles.summary}><span>店舗名</span><strong>{settings.name}</strong></div>
        <div className={styles.card}>
          <label><span className={styles.label}>締め日</span>
            <select disabled={saving || reloadRequired} value={closingRule} onChange={(event) => { setClosingRule(event.target.value as ClosingRule); setMessage(null); }}>
              <option value="month_end">月末</option><option value="day_15">15日</option><option value="day_25">25日</option>
            </select>
          </label>
          <p className={styles.help}>月次勤怠表の対象期間と、自動送信されるタイミングに使用します。</p>
        </div>
        {changed && <p className={styles.warning}>締め日を {closingLabels[settings.closing_rule]} から {closingLabels[closingRule]} に変更します。前回の集計期間との重複・抜けをご確認ください。</p>}
        {message && <p className={styles.success} role="status">{message}</p>}
        <button className={styles.primary} type="button" disabled={!changed || saving || reloadRequired || reauthRequired} onClick={() => void save()}>{saving ? "保存中…" : changed ? "変更内容を保存" : "変更はありません"}</button>
        <div className={styles.readOnly} style={{ marginTop: 20 }}>
          <span>営業日の切替時刻</span><strong>{minuteToTime(settings.business_day_start_minute)}</strong>
          <small>この時刻より前の勤務開始は、前日の営業日として扱います。過去の勤怠を保つため、この画面では変更できません。</small>
        </div>
        <div className={styles.readOnly}>
          <span>月次集計メール送信先</span><strong>{settings.monthly_report_email || "未設定"}</strong>
          <p className={isConfirmedMonthlyReportRecipient(settings) ? styles.success : styles.warning}>
            {isConfirmedMonthlyReportRecipient(settings) ? "メール確認・受信同意済みです。" : "送信先の確認が必要です。確認完了まで月次勤怠表は送信されません。"}
          </p>
          {!isConfirmedMonthlyReportRecipient(settings) && <small>管理画面で送信先を確認し、届いた確認メールから受信に同意してください。</small>}
          <a href={`${managerUrl}#monthly-report`}>月次メールの送信先を確認・変更</a>
        </div>
      </>}
    </section></main>
  );
}
