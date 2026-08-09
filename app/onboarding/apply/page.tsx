"use client";

import { FormEvent, useState } from "react";
import styles from "../onboarding.module.css";

type FormState = {
  businessName: string;
  storeName: string;
  managerLegalName: string;
  contactEmail: string;
  storeAddress: string;
  businessDayStart: string;
  closingRule: string;
  termsAccepted: boolean;
};

const initial: FormState = {
  businessName: "",
  storeName: "",
  managerLegalName: "",
  contactEmail: "",
  storeAddress: "",
  businessDayStart: "05:00",
  closingRule: "month_end",
  termsAccepted: false,
};

export default function OnboardingApplyPage() {
  const [form, setForm] = useState(initial);
  const [submitting, setSubmitting] = useState(false);
  const [requestId, setRequestId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [clientRequestId] = useState(() => crypto.randomUUID());

  function update<K extends keyof FormState>(key: K, value: FormState[K]) {
    setForm((current) => ({ ...current, [key]: value }));
    setError(null);
  }

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (submitting) return;
    setSubmitting(true);
    setError(null);
    const [hours, minutes] = form.businessDayStart.split(":").map(Number);
    try {
      const response = await fetch("/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId,
          businessName: form.businessName,
          storeName: form.storeName,
          managerLegalName: form.managerLegalName,
          contactEmail: form.contactEmail,
          storeAddress: form.storeAddress,
          timezone: "Asia/Tokyo",
          businessDayStartMinute: hours * 60 + minutes,
          closingRule: form.closingRule,
          termsAccepted: form.termsAccepted,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const messages: Record<string, string> = {
          REQUIRED_FIELD_MISSING: "未入力の必須項目があります。",
          INVALID_CONTACT_EMAIL: "メールアドレスを確認してください。",
          TERMS_ACCEPTANCE_REQUIRED: "利用条件への同意が必要です。",
          INVALID_BUSINESS_DAY_START: "営業日の切替時刻を確認してください。",
        };
        throw new Error(messages[data.code] ?? "申請を送信できませんでした。");
      }
      setRequestId(data.request.id as string);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申請を送信できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  if (requestId) {
    return <main className={styles.page}><section className={[styles.shell, styles.center].join(" ")}>
      <p className={styles.brand}>ONOGAMI</p>
      <h1>申請を受け付けました</h1>
      <p className={styles.success}>内容を確認後、連絡先メールアドレスへご案内します。申請直後に店舗やQRが作成されることはありません。</p>
      <p className={styles.help}>受付番号：{requestId}</p>
    </section></main>;
  }

  return <main className={styles.page}><section className={styles.shell}>
    <p className={styles.brand}>ONOGAMI</p>
    <h1>店舗利用申請</h1>
    <p className={styles.lead}>ONOGAMI 勤怠の限定提供版をご利用になる店舗の情報を入力してください。申請内容はONOGAMI側で確認します。</p>
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>事業者名<input required maxLength={120} value={form.businessName} onChange={(e)=>update("businessName",e.target.value)} /></label>
      <label className={styles.field}>店舗名<input required maxLength={120} value={form.storeName} onChange={(e)=>update("storeName",e.target.value)} /></label>
      <div className={styles.grid}>
        <label className={styles.field}>管理者氏名<input required maxLength={120} value={form.managerLegalName} onChange={(e)=>update("managerLegalName",e.target.value)} /><span className={styles.help}>後ほどLINE本人確認を行う方</span></label>
        <label className={styles.field}>連絡先メール<input required type="email" maxLength={254} value={form.contactEmail} onChange={(e)=>update("contactEmail",e.target.value)} /></label>
      </div>
      <label className={styles.field}>店舗住所<textarea required maxLength={300} rows={3} value={form.storeAddress} onChange={(e)=>update("storeAddress",e.target.value)} /></label>
      <div className={styles.grid}>
        <label className={styles.field}>営業日の切替時刻<input required type="time" value={form.businessDayStart} onChange={(e)=>update("businessDayStart",e.target.value)} /><span className={styles.help}>深夜勤務を前日の勤務として扱う境界</span></label>
        <label className={styles.field}>締め日<select value={form.closingRule} onChange={(e)=>update("closingRule",e.target.value)}><option value="month_end">月末</option><option value="day_15">15日</option><option value="day_25">25日</option></select></label>
      </div>
      <label className={styles.check}><input required type="checkbox" checked={form.termsAccepted} onChange={(e)=>update("termsAccepted",e.target.checked)} /><span>入力した情報を店舗登録の審査・連絡・サービス提供のために利用することに同意します。</span></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} type="submit" disabled={submitting}>{submitting ? "送信中…" : "この内容で申請"}</button>
    </form>
  </section></main>;
}
