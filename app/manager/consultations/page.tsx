"use client";

import liff from "@line/liff";
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Consultation, ConsultationEvent } from "@/lib/consultation";
import { withAttendanceDeadline } from "@/lib/attendance-request";
import styles from "./consultations.module.css";

const subscribe = (f: () => void) => { window.addEventListener("popstate", f); return () => window.removeEventListener("popstate", f); };
const locationSearch = () => window.location.search;
const serverSearch = () => "";
const labels: Record<string, string> = { CHECK_IN: "出勤", CHECK_OUT: "退勤", BREAK_START: "休憩開始", BREAK_END: "休憩終了" };
const reasons: Record<string, string> = { PENDING_CORRECTION: "未処理の申請があります", LOGICAL_CONTRADICTION: "打刻の順序・時刻を確認してください", UNCLOSED_SHIFT: "退勤がありません", UNCLOSED_BREAK: "休憩終了がありません", UNUSUALLY_LONG_WORK: "勤務が16時間を超えています", UNUSUALLY_LONG_BREAK: "休憩時間を確認してください" };
const dateTime = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", year: "numeric", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(value));
type Data = { consultation: Consultation; days: { businessDate: string; status: string | null; reasons: string[] }[] };
function EventSummary({ event }: { event: ConsultationEvent | null }) {
  return event ? <span>{labels[event.type]} {dateTime(event.at)}<small>（{event.day}の勤務）</small></span> : <span>記録なし</span>;
}

export default function ConsultationPage() {
  const search = useSyncExternalStore(subscribe, locationSearch, serverSearch);
  const params = new URLSearchParams(search), storeId = params.get("store_id") ?? "", id = params.get("id") ?? "";
  const [data, setData] = useState<Data | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [noChange, setNoChange] = useState(false);
  const [reason, setReason] = useState("");
  const [notice, setNotice] = useState("");
  const generation = useRef({ value: 0 });
  const pending = useRef(false);
  const load = useCallback(() => {
    const state = generation.current, current = ++state.value;
    return liff.init({ liffId: process.env.NEXT_PUBLIC_MANAGER_LIFF_ID || "2010761826-6FNSE1PD" }).then(async () => {
      if (current !== state.value) return;
      setLoading(true); setError(""); setData(null);
      if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
      const { response, result } = await withAttendanceDeadline(async signal => {
      const response = await fetch("/api/manager/consultations", { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: liff.getIDToken(), storeId, requestId: id, action: "detail" }) });
      return { response, result: await response.json() };
      });
      if (!response.ok || !result.ok || result.consultation?.id !== id || result.consultation?.storeId !== storeId) throw new Error("相談を取得できませんでした。管理画面から対象を確認するか、もう一度読み込んでください。");
      if (current === state.value) setData(result);
    }).catch(() => { if (current === state.value) setError("相談を取得できませんでした。管理画面から対象を確認するか、もう一度読み込んでください。"); })
      .finally(() => { if (current === state.value) setLoading(false); });
  }, [id, storeId]);
  useEffect(() => { const state = generation.current; if (id && storeId) void load(); return () => { state.value++; }; }, [id, storeId, load]);
  const c = data?.consultation.id === id && data.consultation.storeId === storeId ? data.consultation : null;
  const workDates = new Set([c?.targetDay, ...(c?.changes.flatMap(change => [change.before?.day, change.after?.day]) ?? [])].filter(Boolean));
  const workDays = data?.days.filter(day => workDates.has(day.businessDate)) ?? [];
  const requestDisplayDay = data?.days.find(day => day.businessDate === c?.requestDay && !workDates.has(day.businessDate)
    && (c.status === "PENDING" || day.status === "NEEDS_REVIEW"));
  const attendanceHref = (day?: string, edit = false) => {
    if (!c) return "#";
    const query = new URLSearchParams({ store_id: c.storeId, staff_id: c.staffId, month: (day || c.targetDay || c.requestDay).slice(0, 7) });
    if (day) query.set("focus", day);
    if (edit && c.status === "PENDING") query.set("consultation", c.id);
    return `/manager/staff-attendance?${query}`;
  };
  async function resolve() {
    if (!c || pending.current || (!c.changes.length && !reason.trim())) return;
    pending.current = true; setSaving(true); setError(""); setNotice("");
    try {
      const { response, result } = await withAttendanceDeadline(async signal => {
      const response = await fetch("/api/manager/consultations", { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: liff.getIDToken(), storeId, requestId: id, action: "resolve", expectedVersion: c.version, reason: c.changes.length ? null : reason }) });
      return { response, result: await response.json() };
      }).catch(() => { throw new Error("完了したか確認できませんでした。「最新の状態を確認」で結果を確認してください。"); });
      if (!response.ok || !result.ok) {
        if (result.code === "ATTENDANCE_CHANGED") { await load(); throw new Error("打刻が更新されています。最新の対応内容を確認してから、もう一度完了してください。"); }
        throw new Error("完了したか確認できませんでした。「最新の状態を確認」で結果を確認してください。");
      }
      setNotice("相談を対応済みにしました。");
      await load();
    } catch (caught) { setError(caught instanceof Error ? caught.message : "完了したか確認できませんでした。最新の状態を確認してください。"); }
    finally { pending.current = false; setSaving(false); }
  }
  return <main className={styles.page}><div className={styles.shell}>
    <header><a href={`/manager?${new URLSearchParams({ store_id: storeId })}`}>← 管理画面へ戻る</a><p className={styles.eyebrow}>ONOGAMI 勤怠</p><h1>打刻の相談</h1>
      {c && <p>{c.storeName} ／ {c.staffName}さん</p>}</header>
    {notice && <p className={styles.notice} role="status">{notice}</p>}
    {error && <p className={styles.error} role="alert">{error}</p>}
    {!id || !storeId ? <p role="alert">管理画面から相談を選んでください。</p> : loading && <p role="status">相談を確認しています…</p>}
    <button className={styles.secondary} disabled={loading || saving} onClick={() => void load()}>最新の状態を確認</button>
    {c && <>
      <section className={styles.card}><div className={styles.heading}><h2>相談内容</h2><span className={styles.badge}>{c.status === "RESOLVED" ? "対応済み" : c.status === "PENDING" ? c.changes.length ? "修正保存済み・未完了" : "確認待ち" : "処理済み"}</span></div>
        <p className={styles.muted}>相談受付：{dateTime(c.requestedAt)}</p><p className={styles.reason}>{c.reason}</p>
        {c.status === "PENDING" && <><p>{c.targetDay ? `対象勤務：${c.targetDay}` : c.changes.length ? "相談受付時の対象勤務は未指定です。保存した修正の勤務日は下に表示しています。" : "対象未指定。相談受付日と勤務日は異なる場合があります。"}</p>
          <a className={styles.primary} href={attendanceHref(c.targetDay ?? undefined, true)}>対象の打刻を確認・修正</a></>}
      </section>
      <section className={styles.card}><h2>この相談で保存した修正</h2>
        {c.changes.length === 0 ? <p className={styles.muted}>{c.status === "RESOLVED" ? "この相談では打刻を変更していません。" : "この相談に結び付いた修正はまだありません。"}</p> : <>
          {c.status === "PENDING" && <p className={styles.notice}>打刻の修正を保存しました。相談はまだ完了していません。</p>}
          <ol className={styles.changes}>{c.changes.map(change => <li key={change.id}>
            <strong>{change.operation === "VOID" ? "打刻を取消" : change.operation === "ADD" ? "打刻を追加" : "打刻を変更"}</strong>
            <dl><div><dt>変更前</dt><dd><EventSummary event={change.before} /></dd></div><div><dt>変更後</dt><dd><EventSummary event={change.after} /></dd></div></dl>
            <p>理由：{change.reason}</p><p className={styles.muted}>保存：{dateTime(change.at)}</p>
          </li>)}</ol>
        </>}
      </section>
      <section className={styles.card}><h2>対象・修正した勤務の現在の状態</h2><p className={styles.muted}>相談の完了と勤怠の確定は別です。残る要確認事項は対象の勤務で確認してください。</p>
        {workDays.length === 0 && <p className={styles.muted}>{c.status === "RESOLVED" ? "対象勤務の指定・修正履歴はありません。確認した勤務は下の対応内容を参照してください。" : "対象の勤務は未指定です。相談内容と実際の勤務を確認してください。"}</p>}
        <ul className={styles.days}>{workDays.map(day => <li key={day.businessDate}><a href={attendanceHref(day.businessDate)}>{day.businessDate}の勤務を確認</a>
          <span>{day.status === "NEEDS_REVIEW" ? "要確認" : day.status === "CONFIRMED" ? "確定" : "記録なし"}</span>
          {day.reasons.length > 0 && <p>{day.reasons.map(r => reasons[r] || "勤怠を確認してください").join("／")}</p>}</li>)}</ul>
      </section>
      {requestDisplayDay && <section className={styles.card}><h2>申請待ちの表示日</h2>
        <p className={styles.muted}>{c.status === "PENDING" ? "この相談の申請待ちを表示する日です。対象の勤務日とは限りません。" : "この相談が申請待ちとして表示されていた日です。他の要確認事項が残っています。"}</p>
        <ul className={styles.days}><li><a href={attendanceHref(requestDisplayDay.businessDate)}>{requestDisplayDay.businessDate}の勤怠を確認</a>
          <span>{requestDisplayDay.status === "NEEDS_REVIEW" ? "要確認" : requestDisplayDay.status === "CONFIRMED" ? "確定" : "記録なし"}</span>
          {requestDisplayDay.reasons.length > 0 && <p>{requestDisplayDay.reasons.map(r => reasons[r] || "勤怠を確認してください").join("／")}</p>}</li></ul>
      </section>}
      {c.status === "PENDING" ? <section className={styles.card}><h2>相談を完了する</h2>
        {c.changes.length > 0 ? <><p>保存した修正を確認して、この相談を対応済みにします。</p><button className={styles.primary} disabled={saving} onClick={() => void resolve()}>{saving ? "確認中…" : "対応済みにする"}</button></> : <>
          <button className={styles.secondary} aria-expanded={noChange} onClick={() => setNoChange(!noChange)}>修正せず確認を終える</button>
          {noChange && <div className={styles.closeForm}><label>確認した内容・修正しない理由<textarea maxLength={500} value={reason} onChange={e => setReason(e.target.value)} placeholder="例：8/31の勤務は以前の修正で対応済みと確認" /></label><p className={styles.muted}>確認した勤務日も記録してください。対象や実際の勤務が未確認の場合は、相談を未対応のまま残してください。</p>
            <button className={styles.primary} disabled={saving || !reason.trim()} onClick={() => void resolve()}>{saving ? "確認中…" : "修正なしで対応済みにする"}</button></div>}
        </>}
      </section> : c.status === "RESOLVED" && <section className={styles.card}><h2>対応済み</h2><p>{c.outcome === "CORRECTED" ? "打刻を修正しました。" : "確認しました。打刻の変更はありません。"}</p>
        {c.resolvedAt && <p>対応完了：{dateTime(c.resolvedAt)}</p>}{c.resolutionReason && <p className={styles.reason}>確認内容：{c.resolutionReason}</p>}</section>}
    </>}
  </div></main>;
}
