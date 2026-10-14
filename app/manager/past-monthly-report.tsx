"use client";

import liff from "@line/liff";
import { useEffect, useRef, useState } from "react";
import { payrollPeriodForMonth } from "@/lib/payroll-default-period.mjs";
import styles from "./manager.module.css";

class ReportActionError extends Error {}
type SavedPeriod = { id: string; period_start: string; period_end: string };
type MonthContext = { reportMonth: string; closingRule: string; today: string; reports: SavedPeriod[] };
const monthPattern = /^[1-9]\d{3}-(0[1-9]|1[0-2])$/;
const dateLabel = (date: string) => date.replaceAll("-", "/");

type Props = {
  storeId: string;
  storeName: string;
  recipient: string | null;
  disabled: boolean;
  onWorkingChange: (working: boolean) => void;
  onSent: () => Promise<void>;
};

export default function PastMonthlyReport({ storeId, storeName, recipient, disabled, onWorkingChange, onSent }: Props) {
  const [month, setMonth] = useState("");
  const [context, setContext] = useState<MonthContext | null>(null);
  const [loading, setLoading] = useState(false);
  const [closingRule, setClosingRule] = useState("month_end");
  const [reportId, setReportId] = useState("");
  const [adjusting, setAdjusting] = useState(false);
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);
  const sequence = useRef(0);
  useEffect(() => () => { sequence.current += 1; }, []);

  const saved = context?.reports.find(report => report.id === reportId);
  const monthlyPeriod = !context ? null : saved ? { start: saved.period_start, end: saved.period_end }
    : context.reports.length === 0 ? payrollPeriodForMonth(closingRule, month) : null;
  const period = adjusting ? { start, end } : monthlyPeriod;
  const validPeriod = Boolean(context && period?.start && period.end && period.start <= period.end
    && period.end < context.today && Date.parse(period.end) - Date.parse(period.start) <= 30 * 86400000);
  const locked = disabled || working !== null;

  async function loadMonth(value: string) {
    if (busy.current) return;
    const request = ++sequence.current;
    setMonth(value); setContext(null); setReportId(""); setAdjusting(false);
    setStart(""); setEnd(""); setMessage(null);
    setLoading(monthPattern.test(value));
    if (!monthPattern.test(value)) return;
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("IDENTITY_UNAVAILABLE");
      const response = await fetch("/api/manager/monthly-attendance/reports", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, storeId, reportMonth: value }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok || data.reportMonth !== value) throw new Error("MONTH_UNAVAILABLE");
      if (request !== sequence.current) return;
      setContext(data); setClosingRule(data.closingRule);
      if (data.reports.length === 1) setReportId(data.reports[0].id);
    } catch {
      if (request === sequence.current) setMessage("この月の送信履歴を確認できませんでした。再試行してください。");
    } finally {
      if (request === sequence.current) setLoading(false);
    }
  }

  async function run(action: "pdf" | "csv" | "send") {
    if (busy.current || locked || loading || !validPeriod || !period) return;
    const { start, end } = period;
    if (action === "send" && (!recipient || !window.confirm(
      `${storeName}\n${start.replaceAll("-", "/")}〜${end.replaceAll("-", "/")}の勤怠表を、確認済みの ${recipient} へ送信しますか？\n\n同じ期間を初回送信済みの場合は重複送信しません。`,
    ))) return;
    busy.current = true;
    setWorking(action); onWorkingChange(true); setMessage(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new ReportActionError("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/monthly-attendance/period", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, storeId, periodStart: start, periodEnd: end, action }),
      });
      if (!response.ok) {
        const data = await response.json();
        if (data.code === "INVALID_PERIOD") throw new ReportActionError("開始日と終了日を確認してください。昨日以前の1〜31日間を指定できます。");
        if (data.code === "MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED" || data.code === "MONTHLY_REPORT_RECIPIENT_CHANGED") throw new ReportActionError("送信先の確認状況が変わりました。画面を再読み込みし、確認・同意済みの送信先を確かめてください。");
        throw new ReportActionError(action === "send" ? "送信を完了できませんでした。同じ期間で再試行しても重複送信しません。" : "帳票を取得できませんでした。期間を保持していますので、再度お試しください。");
      }
      if (action === "send") {
        const data = await response.json();
        setMessage(data.status === "SENT" ? "指定した期間の勤怠表を送信しました。"
          : data.status === "ALREADY_SENT" ? "この期間は初回送信済みです。修正後の帳票は送信済み一覧から再発行できます。"
            : "この期間は送信処理中です。時間をおいて同じ期間で確認してください。");
        // A list refresh failure must not turn a confirmed send into a send-failure message.
        if (data.status !== "PROCESSING") await onSent().catch(() => undefined);
      } else {
        const url = URL.createObjectURL(await response.blob());
        const anchor = document.createElement("a");
        anchor.href = url; anchor.download = `${storeName}-${start}-${end}-勤怠.${action}`;
        document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
        setMessage(`${action === "pdf" ? "PDF" : "補助CSV"}を作成しました。ダウンロードをご確認ください。メールは送信していません。`);
      }
    } catch (caught) {
      setMessage(caught instanceof ReportActionError ? caught.message
        : action === "send" ? "送信結果を確認できませんでした。同じ期間で再試行しても重複送信しません。"
          : "帳票を取得できませんでした。期間を保持していますので、再度お試しください。");
    } finally {
      busy.current = false; setWorking(null); onWorkingChange(false);
    }
  }

  return <details className={styles.pastMonthlyReport}>
    <summary>過去の月次帳票を取得</summary>
    <p className={styles.sectionNote}>対象月を選ぶと、締め日までの1か月分を取得できます。送信先が未確認でも取得でき、最新の訂正内容を反映します。</p>
    <div className={styles.pastPeriodDates}>
      <label>対象月<input type="month" min="1000-01" value={month} disabled={locked} onChange={event => void loadMonth(event.target.value)} /></label>
      {context?.reports.length === 0 && <label>この帳票の締め日<select value={closingRule} disabled={locked || adjusting} onChange={event => { setClosingRule(event.target.value); setMessage(null); }}>
        <option value="month_end">月末締め</option><option value="day_15">15日締め</option><option value="day_25">25日締め</option>
      </select></label>}
    </div>
    {loading && <p role="status">この月の送信履歴を確認しています…</p>}
    {!loading && !context && monthPattern.test(month) && <button type="button" disabled={locked} onClick={() => void loadMonth(month)}>この月を再確認</button>}
    {context && <>
      {context.reports.length > 0 ? <>
        <p className={styles.sectionNote}>送信済みの期間を使用します。現在の締め日へ置き換えません。</p>
        {context.reports.length > 1 && <label className={styles.pastPeriodChoice}>送信済みの期間<select value={reportId} disabled={locked || adjusting} onChange={event => { setReportId(event.target.value); setMessage(null); }}>
          <option value="">この月には複数の期間があります。選択してください</option>
          {context.reports.map(report => <option key={report.id} value={report.id}>{dateLabel(report.period_start)}〜{dateLabel(report.period_end)}</option>)}
        </select></label>}
      </> : <p className={styles.sectionNote}>この月の送信履歴はありません。現在の店舗の締め日を初期表示しています。当時と違う場合は変更してください。店舗設定は変更しません。</p>}
      {period?.start && period.end && <p className={styles.pastPeriodRange}>出力期間：{dateLabel(period.start)}〜{dateLabel(period.end)}</p>}
      {period?.end && period.end >= context.today && <p className={styles.sectionNote}>締め日の翌日から取得できます。過去の対象月を選んでください。</p>}
      {monthlyPeriod && <button type="button" className={styles.pastPeriodAdjust} aria-expanded={adjusting} disabled={locked} onClick={() => {
        setStart(monthlyPeriod.start); setEnd(monthlyPeriod.end); setAdjusting(!adjusting); setMessage(null);
      }}>{adjusting ? "月単位の期間に戻す" : "期間を調整"}</button>}
      {adjusting && <>
        <p className={styles.sectionNote}>例外的な期間は、昨日以前の1〜31日間で指定できます。送信済みの履歴は書き換えません。</p>
        <div className={styles.pastPeriodDates}>
          <label>開始日<input type="date" value={start} disabled={locked} onChange={event => { setStart(event.target.value); setMessage(null); }} /></label>
          <label>終了日<input type="date" value={end} disabled={locked} onChange={event => { setEnd(event.target.value); setMessage(null); }} /></label>
        </div>
        {!validPeriod && <p className={styles.sectionNote}>開始日と終了日を確認してください。昨日以前の1〜31日間を指定できます。</p>}
      </>}
    </>}
    <div className={styles.pastPeriodActions}>
      <button type="button" disabled={locked || loading || !validPeriod} onClick={() => void run("pdf")}>{working === "pdf" ? "作成中…" : "PDFを取得"}</button>
      <button type="button" disabled={locked || loading || !validPeriod} onClick={() => void run("csv")}>{working === "csv" ? "作成中…" : "補助CSVを取得"}</button>
    </div>
    <p className={styles.sectionNote}>取得だけではメールは送信されません。{recipient ? "必要な場合だけ、確認済みの送信先へ送信できます。" : "メール送信には、上の送信先確認・受信同意が必要です。"}</p>
    <button type="button" className={styles.pastPeriodSend} disabled={locked || loading || !validPeriod || !recipient} onClick={() => void run("send")}>{working === "send" ? "送信中…" : "この期間をメール送信"}</button>
    {message && <p className={styles.reissueMessage} role="status">{message}</p>}
  </details>;
}
