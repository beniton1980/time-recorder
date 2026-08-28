"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import styles from "../payroll.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
type Membership = { store_id: string; store_name: string };
type PreviewStaff = {
  staffId: string; legalName: string; payableDayCount: number; status: "CONFIRMED" | "NEEDS_REVIEW";
  reviewReasons: string[]; grossPay: number;
  minutes: { worked: number; statutoryOvertime: number; highOvertime: number; statutoryHoliday: number; lateNight: number };
  components: { basePay: number; overtimePremium: number; highOvertimePremium: number; statutoryHolidayPremium: number; lateNightPremium: number; adjustments: number };
};
type Preview = { period: { start: string; end: string }; staff: PreviewStaff[]; summary: { staffCount: number; confirmedCount: number; needsReviewCount: number; grossPay: number } };
type PayrollPeriod = { start: string; end: string };
type PeriodResponse = { period: PayrollPeriod; payrollMonth: string };

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date());
}
function hours(minutes: number) { return `${Math.floor(minutes / 60)}時間${minutes % 60}分`; }
function monthLabel(value: string) {
  const [year, month] = value.split("-");
  return `${Number(year)}年${Number(month)}月度`;
}
function regularMinutes(member: PreviewStaff) {
  return Math.max(0, member.minutes.worked - member.minutes.statutoryOvertime - member.minutes.statutoryHoliday);
}
function reasonLabel(code: string) {
  const labels: Record<string, string> = {
    UNSUPPORTED_WORK_TIME_SYSTEM: "勤務制度が未確定",
    WEEK_CONTEXT_INCOMPLETE: "週の判定期間が不足",
    OVERTIME_MONTH_CONTEXT_INCOMPLETE: "月60時間判定の期間が不足",
    PAY_PERIOD_CROSSES_OVERTIME_MONTH_BOUNDARY: "給与期間が残業判定月をまたいでいる",
    STATUTORY_HOLIDAY_RULE_MISSING: "法定休日が未確定",
    OVERTIME_MONTH_RULE_MISSING: "月60時間の区切りが未確定",
    WEEK_START_RULE_MISSING: "1週間の区切りが未確定",
    ATTENDANCE_NEEDS_REVIEW: "勤怠に要確認あり",
    COMPENSATION_TERM_MISSING_OR_AMBIGUOUS: "時給設定が不足または重複",
  };
  return labels[code] ?? code;
}

export default function PayrollPreviewPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [payrollMonth, setPayrollMonth] = useState(currentMonth());
  const [periodStart, setPeriodStart] = useState("");
  const [periodEnd, setPeriodEnd] = useState("");
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function previewApi(targetStore: string, period: PayrollPeriod) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId: targetStore, periodStart: period.start, periodEnd: period.end }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error(result.code === "PAYROLL_PREVIEW_UNAVAILABLE" ? "給与プレビューを計算できませんでした。" : "対象期間を確認してください。");
    return result as Preview;
  }

  async function periodApi(targetStore: string, targetMonth?: string) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/default-period", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId: targetStore, payrollMonth: targetMonth }) });
    const result = await response.json();
    if (!response.ok || !result.ok) throw new Error("店舗の締め期間を読み込めませんでした。");
    return result as PeriodResponse;
  }

  async function loadPayrollMonth(targetStore: string, targetMonth?: string) {
    setLoading(true); setError(null); setPreview(null);
    try {
      const resolved = await periodApi(targetStore, targetMonth);
      setPayrollMonth(resolved.payrollMonth); setPeriodStart(resolved.period.start); setPeriodEnd(resolved.period.end);
      setPreview(await previewApi(targetStore, resolved.period));
    } catch (caught) { setError(caught instanceof Error ? caught.message : "給与プレビューを読み込めませんでした。"); }
    finally { setLoading(false); }
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
        const response = await fetch("/api/manager/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
        const session = await response.json();
        if (!response.ok || !session.ok) throw new Error("管理者権限を確認できませんでした。");
        if (!active) return;
        const next = session.manager.memberships as Membership[];
        setMemberships(next);
        const first = next[0]?.store_id ?? "";
        if (!first) throw new Error("対象店舗がありません。");
        setStoreId(first); await loadPayrollMonth(first);
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "読み込めませんでした。"); }
    })();
    return () => { active = false; };
  }, []);

  async function changeStore(nextStoreId: string) { setStoreId(nextStoreId); await loadPayrollMonth(nextStoreId); }
  async function changePayrollMonth(nextMonth: string) { setPayrollMonth(nextMonth); await loadPayrollMonth(storeId, nextMonth); }

  return <main className={`${styles.page} ${styles.previewPage}`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>ONOGAMI 給与集計</p><h1>給与プレビュー</h1><p className={styles.lead}>実際の勤怠と時給設定から控除前の総支給額を試算します。ここでは保存・確定しません。</p></div><a className={styles.backLink} href="/manager/payroll">給与設定へ戻る</a></header>
    {error && <p className={styles.error}>{error}</p>}
    <section className={styles.card}>
      <h2>対象期間</h2>
      {memberships.length > 1 && <><label className={styles.label}>店舗</label><select className={styles.select} value={storeId} onChange={(e) => void changeStore(e.target.value)}>{memberships.map((m) => <option value={m.store_id} key={m.store_id}>{m.store_name}</option>)}</select></>}
      <div className={styles.monthSelector}><label>給与月度<input type="month" value={payrollMonth} onChange={(e) => void changePayrollMonth(e.target.value)} /></label><div className={styles.periodSummary}><strong>{monthLabel(payrollMonth)}</strong><span>{periodStart && periodEnd ? `${periodStart} 〜 ${periodEnd}` : "締め期間を確認中…"}</span></div></div>
      <p className={styles.revisionNote}>月度を選ぶだけで、店舗の締め日に合わせた集計期間へ自動変換します。</p>
    </section>
    {loading && <p className={styles.message}>給与を計算しています…</p>}
    {preview && <>
      <section className={`${styles.card} ${styles.summaryCard}`}><h2>集計結果</h2><div className={styles.registered}><span>{monthLabel(payrollMonth)} / {preview.period.start} 〜 {preview.period.end}</span><strong>{preview.summary.grossPay.toLocaleString("ja-JP")}円</strong><small>要確認なし {preview.summary.confirmedCount}名 / 要確認 {preview.summary.needsReviewCount}名</small></div></section>
      <section className={styles.card}><h2>スタッフ別</h2><div className={styles.staffGrid}>{preview.staff.map((member) => <article className={styles.staffResultCard} key={member.staffId}>
        <div className={styles.staffIdentity}><strong>{member.legalName}</strong><span className={styles.inactive}>{member.status === "CONFIRMED" ? "要確認なし" : `要確認 ${member.reviewReasons.length}件`}</span></div>
        <div className={styles.registered}><span>控除前の総支給額</span><strong>{member.grossPay.toLocaleString("ja-JP")}円</strong><small>{member.payableDayCount}日 / 実働 {hours(member.minutes.worked)}</small></div>
        <div className={styles.revisionBox}><strong>時間内訳</strong><ul className={styles.historyList}><li><span>実働</span><strong>{hours(member.minutes.worked)}</strong></li><li><span>通常労働</span><strong>{hours(regularMinutes(member))}</strong></li><li><span>法定時間外</span><strong>{hours(member.minutes.statutoryOvertime)}</strong></li>{member.minutes.highOvertime > 0 && <li><span>うち月60時間超</span><strong>{hours(member.minutes.highOvertime)}</strong></li>}<li><span>法定休日労働</span><strong>{hours(member.minutes.statutoryHoliday)}</strong></li><li><span>深夜労働</span><strong>{hours(member.minutes.lateNight)}</strong></li></ul><p className={styles.revisionNote}>深夜労働は、通常労働・法定時間外・法定休日労働と重複する場合があります。</p></div>
        <div className={styles.revisionBox}><strong>金額内訳</strong><ul className={styles.historyList}><li><span>基本給 <small>実働 {hours(member.minutes.worked)}</small></span><strong>{member.components.basePay.toLocaleString("ja-JP")}円</strong></li><li><span>時間外割増 <small>法定時間外 {hours(member.minutes.statutoryOvertime)}</small></span><strong>{(member.components.overtimePremium + member.components.highOvertimePremium).toLocaleString("ja-JP")}円</strong></li><li><span>深夜割増 <small>深夜 {hours(member.minutes.lateNight)}</small></span><strong>{member.components.lateNightPremium.toLocaleString("ja-JP")}円</strong></li><li><span>法定休日割増 <small>法定休日 {hours(member.minutes.statutoryHoliday)}</small></span><strong>{member.components.statutoryHolidayPremium.toLocaleString("ja-JP")}円</strong></li>{member.components.adjustments !== 0 && <li><span>調整額</span><strong>{member.components.adjustments.toLocaleString("ja-JP")}円</strong></li>}</ul>{member.reviewReasons.length > 0 && <><strong>要確認</strong><ul className={styles.historyList}>{member.reviewReasons.map((reason) => <li key={reason}><span>{reasonLabel(reason)}</span></li>)}</ul></>}</div>
      </article>)}</div></section>
    </>}
  </main>;
}
