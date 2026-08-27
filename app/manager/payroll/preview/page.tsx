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

function currentMonth() {
  const now = new Date();
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);
  const [year, month] = parts.split("-");
  const end = new Date(Date.UTC(Number(year), Number(month), 0)).toISOString().slice(0, 10);
  return { start: `${year}-${month}-01`, end };
}
function hours(minutes: number) { return `${Math.floor(minutes / 60)}時間${minutes % 60}分`; }
function reasonLabel(code: string) {
  const labels: Record<string, string> = {
    UNSUPPORTED_WORK_TIME_SYSTEM: "勤務制度が未確定",
    WEEK_CONTEXT_INCOMPLETE: "週の判定期間が不足",
    OVERTIME_MONTH_CONTEXT_INCOMPLETE: "月60時間判定の期間が不足",
    PAY_PERIOD_CROSSES_OVERTIME_MONTH_BOUNDARY: "給与期間が残業判定月をまたいでいる",
    STATUTORY_HOLIDAY_RULE_MISSING: "法定休日が未確定",
    OVERTIME_MONTH_RULE_MISSING: "月60時間の区切りが未確定",
    ATTENDANCE_NEEDS_REVIEW: "勤怠に要確認あり",
    COMPENSATION_TERM_MISSING_OR_AMBIGUOUS: "時給設定が不足または重複",
  };
  return labels[code] ?? code;
}

export default function PayrollPreviewPage() {
  const initial = currentMonth();
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [periodStart, setPeriodStart] = useState(initial.start);
  const [periodEnd, setPeriodEnd] = useState(initial.end);
  const [preview, setPreview] = useState<Preview | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function loadPreview(targetStore = storeId) {
    if (!targetStore) return;
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    setLoading(true); setError(null);
    try {
      const response = await fetch("/api/manager/payroll/preview", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId: targetStore, periodStart, periodEnd }) });
      const result = await response.json();
      if (!response.ok || !result.ok) throw new Error(result.code === "PAYROLL_PREVIEW_UNAVAILABLE" ? "給与プレビューを計算できませんでした。" : "対象期間を確認してください。");
      setPreview(result as Preview);
    } finally { setLoading(false); }
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
        setStoreId(first);
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "読み込めませんでした。"); }
    })();
    return () => { active = false; };
  }, []);

  return <main className={styles.page}>
    <header className={styles.header}><div><p className={styles.eyebrow}>ONOGAMI 給与集計</p><h1>給与プレビュー</h1><p className={styles.lead}>実際の勤怠と時給設定から控除前の総支給額を試算します。ここでは保存・確定しません。</p></div><a className={styles.backLink} href="/manager/payroll">給与設定へ戻る</a></header>
    {error && <p className={styles.error}>{error}</p>}
    <section className={styles.card}>
      <h2>対象期間</h2>
      {memberships.length > 1 && <><label className={styles.label}>店舗</label><select className={styles.select} value={storeId} onChange={(e) => { setStoreId(e.target.value); setPreview(null); }}>{memberships.map((m) => <option value={m.store_id} key={m.store_id}>{m.store_name}</option>)}</select></>}
      <div className={styles.inputs}><label>開始日<input type="date" value={periodStart} onChange={(e) => setPeriodStart(e.target.value)} /></label><label>終了日<input type="date" value={periodEnd} onChange={(e) => setPeriodEnd(e.target.value)} /></label><button className={styles.secondaryButton} disabled={loading || !storeId} onClick={() => void loadPreview()}>{loading ? "計算中…" : "再計算"}</button></div>
      <p className={styles.revisionNote}>まず実データを検算するため期間を指定します。給与額はまだDBへ保存されません。</p>
    </section>
    {preview && <>
      <section className={styles.card}><h2>集計結果</h2><div className={styles.registered}><span>{preview.period.start} 〜 {preview.period.end}</span><strong>{preview.summary.grossPay.toLocaleString("ja-JP")}円</strong><small>確認不要 {preview.summary.confirmedCount}名 / 要確認 {preview.summary.needsReviewCount}名</small></div></section>
      <section className={styles.card}><h2>スタッフ別</h2><div className={styles.staffList}>{preview.staff.map((member) => <article className={styles.staffRow} key={member.staffId}><div className={styles.staffIdentity}><strong>{member.legalName}</strong><span className={styles.inactive}>{member.status === "CONFIRMED" ? "確認不要" : `要確認 ${member.reviewReasons.length}件`}</span></div><div className={styles.registered}><span>控除前の総支給額</span><strong>{member.grossPay.toLocaleString("ja-JP")}円</strong><small>{member.payableDayCount}日 / 実働 {hours(member.minutes.worked)}</small></div><div className={styles.revisionBox}><strong>内訳</strong><ul className={styles.historyList}><li><span>基本給</span><strong>{member.components.basePay.toLocaleString("ja-JP")}円</strong></li><li><span>時間外割増</span><strong>{(member.components.overtimePremium + member.components.highOvertimePremium).toLocaleString("ja-JP")}円</strong></li><li><span>深夜割増</span><strong>{member.components.lateNightPremium.toLocaleString("ja-JP")}円</strong></li><li><span>法定休日割増</span><strong>{member.components.statutoryHolidayPremium.toLocaleString("ja-JP")}円</strong></li></ul>{member.reviewReasons.length > 0 && <><strong>要確認</strong><ul className={styles.historyList}>{member.reviewReasons.map((reason) => <li key={reason}><span>{reasonLabel(reason)}</span></li>)}</ul></>}</div></article>)}</div></section>
    </>}
  </main>;
}
