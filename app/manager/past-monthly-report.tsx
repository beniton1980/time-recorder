"use client";

import liff from "@line/liff";
import { useRef, useState } from "react";
import styles from "./manager.module.css";

class ReportActionError extends Error {}

type Props = {
  storeId: string;
  storeName: string;
  recipient: string | null;
  disabled: boolean;
  onWorkingChange: (working: boolean) => void;
  onSent: () => Promise<void>;
};

export default function PastMonthlyReport({ storeId, storeName, recipient, disabled, onWorkingChange, onSent }: Props) {
  const [start, setStart] = useState("");
  const [end, setEnd] = useState("");
  const [working, setWorking] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const busy = useRef(false);

  async function run(action: "pdf" | "csv" | "send") {
    if (busy.current || disabled || !start || !end) return;
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
    <summary>一覧にない過去期間の帳票を取得</summary>
    <p className={styles.sectionNote}>送信先確認前に過ぎた期間も、PDF・CSVを取得できます。当時の開始日・終了日を指定してください（昨日以前の1〜31日間）。最新の訂正内容を反映します。</p>
    <div className={styles.pastPeriodDates}>
      <label>開始日<input type="date" value={start} disabled={disabled || working !== null} onChange={event => { setStart(event.target.value); setMessage(null); }} /></label>
      <label>終了日<input type="date" value={end} disabled={disabled || working !== null} onChange={event => { setEnd(event.target.value); setMessage(null); }} /></label>
    </div>
    <div className={styles.pastPeriodActions}>
      <button type="button" disabled={disabled || working !== null || !start || !end} onClick={() => void run("pdf")}>{working === "pdf" ? "作成中…" : "PDFを取得"}</button>
      <button type="button" disabled={disabled || working !== null || !start || !end} onClick={() => void run("csv")}>{working === "csv" ? "作成中…" : "補助CSVを取得"}</button>
    </div>
    <p className={styles.sectionNote}>取得だけではメールは送信されません。{recipient ? "必要な場合だけ、確認済みの送信先へ送信できます。" : "メール送信には、上の送信先確認・受信同意が必要です。"}</p>
    <button type="button" className={styles.pastPeriodSend} disabled={disabled || working !== null || !start || !end || !recipient} onClick={() => void run("send")}>{working === "send" ? "送信中…" : "この期間をメール送信"}</button>
    {message && <p className={styles.reissueMessage} role="status">{message}</p>}
  </details>;
}
