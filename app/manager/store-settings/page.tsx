"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./store-settings.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_LIFF_URL = `https://liff.line.me/${LIFF_ID}/manager`;

type ClosingRule = "month_end" | "day_15" | "day_25";
type StoreSettings = {
  id: string;
  name: string;
  closing_rule: ClosingRule;
  business_day_start_minute: number;
  monthly_report_email: string | null;
};

const closingLabels: Record<ClosingRule, string> = {
  month_end: "月末",
  day_15: "15日",
  day_25: "25日",
};

function minuteToTime(minute: number) {
  const hour = String(Math.floor(minute / 60)).padStart(2, "0");
  const min = String(minute % 60).padStart(2, "0");
  return `${hour}:${min}`;
}

function timeToMinute(value: string) {
  const [hour, minute] = value.split(":").map(Number);
  return hour * 60 + minute;
}

export default function StoreSettingsPage() {
  const searchParams = useSearchParams();
  const storeId = searchParams.get("store_id") ?? "";
  const [settings, setSettings] = useState<StoreSettings | null>(null);
  const [closingRule, setClosingRule] = useState<ClosingRule>("month_end");
  const [businessDayStart, setBusinessDayStart] = useState("05:00");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changed = useMemo(() => {
    if (!settings) return false;
    return (
      settings.closing_rule !== closingRule ||
      settings.business_day_start_minute !== timeToMinute(businessDayStart)
    );
  }, [settings, closingRule, businessDayStart]);

  useEffect(() => {
    let active = true;

    async function start() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        if (!storeId) throw new Error("店舗を特定できませんでした。管理画面から開き直してください。");
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
        const response = await fetch("/api/manager/store-settings", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeId }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          if (data.code === "MANAGER_ACCESS_REQUIRED") {
            throw new Error("この店舗の設定を変更できる管理者権限がありません。");
          }
          throw new Error("店舗設定を読み込めませんでした。");
        }
        if (!active) return;
        const store = data.store as StoreSettings;
        setSettings(store);
        setClosingRule(store.closing_rule);
        setBusinessDayStart(minuteToTime(store.business_day_start_minute));
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "店舗設定を読み込めませんでした。");
      } finally {
        if (active) setLoading(false);
      }
    }

    void start();
    return () => { active = false; };
  }, [storeId]);

  async function save() {
    if (!settings || saving || !changed) return;

    const closingChanged = settings.closing_rule !== closingRule;
    const prompt = closingChanged
      ? `締め日を「${closingLabels[settings.closing_rule]}」から「${closingLabels[closingRule]}」へ変更します。\n\n今後の月次集計期間と自動送信日に影響します。変更してよろしいですか？`
      : "営業日の切替時刻を変更します。日付の扱いに影響します。変更してよろしいですか？";
    if (!window.confirm(prompt)) return;

    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/store-settings", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId,
          closingRule,
          businessDayStartMinute: timeToMinute(businessDayStart),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("店舗設定を保存できませんでした。");
      const store = data.store as StoreSettings;
      setSettings(store);
      setClosingRule(store.closing_rule);
      setBusinessDayStart(minuteToTime(store.business_day_start_minute));
      setMessage("店舗設定を更新しました。次回以降の集計に新しい設定が反映されます。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "店舗設定を保存できませんでした。");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <a className={styles.back} href={MANAGER_LIFF_URL}>← 管理画面へ戻る</a>
        <p className={styles.brand}>ONOGAMI</p>
        <h1>店舗設定</h1>
        <p className={styles.lead}>店舗の運用状況が変わったときに、現在の登録内容を確認・変更できます。</p>

        {loading && <p className={styles.notice}>店舗設定を読み込んでいます…</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {settings && (
          <>
            <div className={styles.summary}>
              <span>店舗名</span>
              <strong>{settings.name}</strong>
            </div>

            <div className={styles.card}>
              <label>
                <span className={styles.label}>締め日</span>
                <select value={closingRule} onChange={(event) => setClosingRule(event.target.value as ClosingRule)}>
                  <option value="month_end">月末</option>
                  <option value="day_15">15日</option>
                  <option value="day_25">25日</option>
                </select>
              </label>
              <p className={styles.help}>月次勤怠表の対象期間と、自動送信されるタイミングに使用します。</p>
            </div>

            <div className={styles.card}>
              <label>
                <span className={styles.label}>営業日の切替時刻</span>
                <input type="time" value={businessDayStart} onChange={(event) => setBusinessDayStart(event.target.value)} />
              </label>
              <p className={styles.help}>深夜営業などで、日付を切り替える時刻を設定します。現在の標準は 05:00 です。</p>
            </div>

            <div className={styles.readOnly}>
              <span>月次集計メール送信先</span>
              <strong>{settings.monthly_report_email || "未設定"}</strong>
              <small>送信先メールは管理画面の「月次勤怠表」から変更できます。</small>
            </div>

            {settings.closing_rule !== closingRule && (
              <p className={styles.warning}>
                締め日を {closingLabels[settings.closing_rule]} から {closingLabels[closingRule]} に変更します。保存後は次回以降の月次集計に新しい締め日が使われます。
              </p>
            )}

            {message && <p className={styles.success}>{message}</p>}
            <button className={styles.primary} type="button" disabled={!changed || saving} onClick={() => void save()}>
              {saving ? "保存中…" : changed ? "変更内容を保存" : "変更はありません"}
            </button>
          </>
        )}
      </section>
    </main>
  );
}
