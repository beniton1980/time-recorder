"use client";

import { FormEvent, useState } from "react";
import {
  businessCategoryOptions,
  priorAttendanceMethodOptions,
  reportedAcquisitionSourceOptions,
  staffCountRangeOptions,
  storeCountRangeOptions,
} from "@/lib/onboarding/business-attributes";
import styles from "../onboarding.module.css";

type FormState = {
  storeName: string;
  managerLegalName: string;
  contactEmail: string;
  storeAddress: string;
  businessCategory: string;
  staffCountRange: string;
  storeCountRange: string;
  priorAttendanceMethod: string;
  reportedAcquisitionSource: string;
  closingRule: string;
  termsAccepted: boolean;
};

const initial: FormState = {
  storeName: "",
  managerLegalName: "",
  contactEmail: "",
  storeAddress: "",
  businessCategory: "",
  staffCountRange: "",
  storeCountRange: "",
  priorAttendanceMethod: "",
  reportedAcquisitionSource: "",
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
    try {
      const response = await fetch("/api/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clientRequestId,
          businessName: form.storeName,
          storeName: form.storeName,
          managerLegalName: form.managerLegalName,
          contactEmail: form.contactEmail,
          storeAddress: form.storeAddress,
          businessCategory: form.businessCategory,
          staffCountRange: form.staffCountRange,
          storeCountRange: form.storeCountRange || null,
          priorAttendanceMethod: form.priorAttendanceMethod,
          reportedAcquisitionSource: form.reportedAcquisitionSource || null,
          timezone: "Asia/Tokyo",
          businessDayStartMinute: 300,
          closingRule: form.closingRule,
          termsAccepted: form.termsAccepted,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const messages: Record<string, string> = {
          REQUIRED_FIELD_MISSING: "未入力の必須項目があります。",
          INVALID_CONTACT_EMAIL: "メールアドレスを確認してください。",
          INVALID_BUSINESS_ATTRIBUTE: "業種・人数規模・導入前の管理方法を確認してください。",
          TERMS_ACCEPTANCE_REQUIRED: "利用条件への同意が必要です。",
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
      <p className={styles.success}>内容を審査後、連絡先メールアドレスの確認メールをお送りします。確認が完了するまで、管理者招待や店舗QRは作成されません。</p>
      <p className={styles.help}>受付番号：{requestId}</p>
    </section></main>;
  }

  return <main className={styles.page}><section className={styles.shell}>
    <p className={styles.brand}>ONOGAMI</p>
    <h1>店舗利用申請</h1>
    <p className={styles.lead}>ONOGAMI 勤怠の限定提供版をご利用になる店舗の情報を入力してください。申請内容はONOGAMI側で審査し、承認後にメールでご案内します。</p>
    <p className={styles.notice}><strong>ONOGAMI勤怠のご利用にはLINEアカウントが必要です。</strong><br />管理者登録・管理画面の利用には、管理者ご本人のLINEアカウントを使用します。スタッフも打刻時に各自のLINEアカウントを使用します。</p>
    <form className={styles.form} onSubmit={submit}>
      <label className={styles.field}>店舗名<input required maxLength={120} value={form.storeName} onChange={(e)=>update("storeName",e.target.value)} /></label>
      <div className={styles.grid}>
        <label className={styles.field}>管理者氏名<input required maxLength={120} value={form.managerLegalName} onChange={(e)=>update("managerLegalName",e.target.value)} /><span className={styles.help}>後ほどLINE本人確認を行う方</span></label>
        <label className={styles.field}>連絡先メール<input required type="email" maxLength={254} value={form.contactEmail} onChange={(e)=>update("contactEmail",e.target.value)} /><span className={styles.help}>審査後に所有確認を行い、確認済みアドレスだけへ管理者招待を送信します</span></label>
      </div>
      <label className={styles.field}>店舗住所<textarea required maxLength={300} rows={3} value={form.storeAddress} onChange={(e)=>update("storeAddress",e.target.value)} /></label>
      <div className={styles.grid}>
        <label className={styles.field}>業種<select required value={form.businessCategory} onChange={(e)=>update("businessCategory",e.target.value)}><option value="">選択してください</option>{businessCategoryOptions.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className={styles.field}>事業所で働く人数規模<select required value={form.staffCountRange} onChange={(e)=>update("staffCountRange",e.target.value)}><option value="">選択してください</option>{staffCountRangeOptions.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
      <div className={styles.grid}>
        <label className={styles.field}>導入前の勤怠管理方法<select required value={form.priorAttendanceMethod} onChange={(e)=>update("priorAttendanceMethod",e.target.value)}><option value="">選択してください</option>{priorAttendanceMethodOptions.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
        <label className={styles.field}>運営事業所数（任意）<select value={form.storeCountRange} onChange={(e)=>update("storeCountRange",e.target.value)}><option value="">回答しない</option>{storeCountRangeOptions.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      </div>
      <label className={styles.field}>ONOGAMIを知ったきっかけ（任意）<select value={form.reportedAcquisitionSource} onChange={(e)=>update("reportedAcquisitionSource",e.target.value)}><option value="">回答しない</option>{reportedAcquisitionSourceOptions.map((option)=><option key={option.value} value={option.value}>{option.label}</option>)}</select></label>
      <label className={styles.field}>締め日<select value={form.closingRule} onChange={(e)=>update("closingRule",e.target.value)}><option value="month_end">月末</option><option value="day_15">15日</option><option value="day_25">25日</option></select></label>
      <label className={styles.check}><input required type="checkbox" checked={form.termsAccepted} onChange={(e)=>update("termsAccepted",e.target.checked)} /><span>入力した情報を店舗登録の審査・連絡・サービス提供のために利用することに同意します。</span></label>
      {error && <p className={styles.error} role="alert">{error}</p>}
      <button className={styles.primary} type="submit" disabled={submitting}>{submitting ? "送信中…" : "この内容で申請"}</button>
    </form>
  </section></main>;
}
