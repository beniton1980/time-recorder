"use client";

import liff from "@line/liff";
import { useEffect, useRef, useState } from "react";
import { withAttendanceDeadline } from "@/lib/attendance-request";
import type { EventType } from "@/lib/attendance-operation";
import styles from "./correction-history.module.css";

type Cursor = { id: string; requestedAt: string };
type Correction = Cursor & {
  status: "PENDING" | "APPROVED" | "REJECTED";
  operation: "ADD" | "REPLACE" | "VOID" | "REVIEW";
  category: string | null;
  eventType: EventType | null;
  occurredAt: string | null;
  breakEndedAt: string | null;
  decidedAt: string | null;
  reason: string | null;
  automatic: boolean;
  unattributed: boolean;
};
const events: Record<EventType, string> = { CHECK_IN: "出勤", CHECK_OUT: "退勤", BREAK_START: "休憩開始", BREAK_END: "休憩終了" };
const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", {
  timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false,
}).format(new Date(value));

export default function CorrectionHistory({ getStoreToken }: { getStoreToken: () => string | null }) {
  const [open, setOpen] = useState(false);
  const [requests, setRequests] = useState<Correction[] | null>(null);
  const [next, setNext] = useState<Cursor | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const lifecycle = useRef({ active: true, pending: false });
  useEffect(() => {
    const state = lifecycle.current;
    state.active = true;
    return () => { state.active = false; };
  }, []);

  async function load(before: Cursor | null = null) {
    const state = lifecycle.current;
    if (state.pending) return;
    state.pending = true;
    setLoading(true);
    setError(false);
    // A failed refresh must not present a formerly pending/approved result as current.
    if (!before) { setRequests(null); setNext(null); }
    try {
      const idToken = liff.getIDToken(), storeToken = getStoreToken();
      if (!idToken || !storeToken) throw new Error("AUTH_REQUIRED");
      const data = await withAttendanceDeadline(async signal => {
        const response = await fetch("/api/correction-requests/history", {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeToken, before }),
        });
        if (!response.ok) throw new Error("HISTORY_UNAVAILABLE");
        const result = await response.json();
        if (!result.ok || !Array.isArray(result.requests)) throw new Error("INVALID_HISTORY");
        return result;
      });
      if (!state.active) return;
      setRequests(previous => before ? [...(previous ?? []), ...data.requests] : data.requests);
      setNext(data.next);
    } catch {
      if (state.active) setError(true);
    } finally {
      state.pending = false;
      if (state.active) setLoading(false);
    }
  }

  return <section className={styles.panel} aria-label="修正申請の状況">
    <button className={styles.toggle} type="button" aria-expanded={open} aria-controls="correction-history-content"
      onClick={() => { setOpen(!open); if (!open) void load(); }}>
      <span>修正申請の状況</span><span aria-hidden="true">{open ? "−" : "＋"}</span>
    </button>
    {open && <div id="correction-history-content" className={styles.content}>
      <div className={styles.toolbar}><p>この店舗での申請を新しい順に表示します。</p>
        <button type="button" disabled={loading} onClick={() => void load()}>最新の状況を確認</button></div>
      {error && <p className={styles.error} role="alert">申請の状況を取得できませんでした。通信を確認して、もう一度お試しください。</p>}
      {loading && <p role="status">確認中…</p>}
      {requests?.length === 0 && <p>修正申請はありません。</p>}
      {requests && requests.length > 0 && <ol className={styles.list}>{requests.map(item => <li key={item.id}>
        <div className={styles.heading}><strong>{item.unattributed ? "過去の修正記録" : item.category === "MISTAKE" || item.automatic ? "押し間違いの修正" : item.category === "OTHER" || item.operation === "REVIEW" ? "その他の修正申請" : "押し忘れの申請"}</strong>
          <span className={styles[item.status]}>{item.status === "PENDING" ? "承認待ち" : item.status === "REJECTED" ? "却下" : item.automatic || item.unattributed ? "修正済み" : "承認済み"}</span></div>
        <p className={styles.date}>{item.unattributed ? "記録" : "申請"}：<time dateTime={item.requestedAt}>{dateTime(item.requestedAt)}</time></p>
        {item.eventType && item.occurredAt && <p>{item.operation === "VOID" ? "取消：" : ""}{events[item.eventType]}：{dateTime(item.occurredAt)}{item.breakEndedAt && <> 〜 {dateTime(item.breakEndedAt)}</>}</p>}
        {item.reason && <p className={styles.reason}>{item.reason}</p>}
        {item.decidedAt && <p className={styles.date}>{item.status === "REJECTED" ? "却下" : "反映"}：{dateTime(item.decidedAt)}</p>}
        <p className={styles.guidance}>{item.status === "PENDING" ? "管理者の確認をお待ちください。まだ勤怠には反映されていません。" : item.status === "REJECTED" ? "勤怠には反映されていません。内容を管理者に確認し、必要なら「打刻修正」から申請してください。" : item.unattributed ? "管理者による直接修正など、申請者を区別できない過去の記録も含みます。" : "勤怠への反映が完了しています。"}</p>
      </li>)}</ol>}
      {next && <button className={styles.more} type="button" disabled={loading} onClick={() => void load(next)}>以前の記録を見る</button>}
    </div>}
  </section>;
}
