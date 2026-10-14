"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { consumeCorrectionReceipt, isAttendanceDate, type CorrectionReceipt } from "@/lib/manager-attendance-return";
import { attendanceDisplayTimes, type AttendanceDisplayEvent } from "@/lib/manager-attendance-display";
import styles from "./staff-attendance.module.css";

const LIFF_ID = process.env.NEXT_PUBLIC_MANAGER_LIFF_ID || "2010761826-6FNSE1PD";

type Day = {
  businessDate: string;
  status: "CONFIRMED" | "NEEDS_REVIEW";
  workedMinutes: number | null;
  breakMinutes: number | null;
  lateNightMinutes: number | null;
  attendanceReasons: string[];
  reviewReasons: string[];
  gpsIssueCount: number;
  hasCorrection: boolean;
  checkIn: string;
  checkOut: string;
  breakPeriods: string[];
  workedDuration?: string;
  breakDuration?: string;
};

type DisplayDay = Day | { businessDate: string; noRecord: true };

type StaffOption = { id: string; legalName: string; status: string };

type Payload = {
  ok: true;
  store: { id: string; name: string; timezone?: string };
  staff: { id: string; legalName: string };
  staffOptions: StaffOption[];
  month: string;
  period: { start: string; end: string; displayThrough: string | null };
  summary: { workDays: number; workDuration: string; breakDuration: string; issueDays: number; gpsIssueCount: number };
  days: Day[];
  events?: AttendanceDisplayEvent[];
};

const reasonLabels: Record<string, string> = {
  UNCLOSED_SHIFT: "退勤がありません",
  UNCLOSED_BREAK: "休憩終了がありません",
  LOGICAL_CONTRADICTION: "打刻の順序または時刻に不整合があります",
  PENDING_CORRECTION: "未処理の修正申請があります",
  UNUSUALLY_LONG_BREAK: "勤務時間に対して休憩が長すぎます",
  UNUSUALLY_LONG_WORK: "勤務時間が16時間を超えています",
  MISSING_CHECK_IN: "出勤がありません",
  MISSING_CHECK_OUT: "退勤がありません",
  OPEN_BREAK: "休憩終了がありません",
  INVALID_SEQUENCE: "打刻の順序を確認してください",
  MISSING_DAILY_ATTENDANCE: "勤怠を確認してください",
};

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" }).format(new Date());
}
function monthLabel(value: string) { const [year, month] = value.split("-"); return `${year}年${Number(month)}月`; }
function dateLabel(value: string) {
  const date = new Date(`${value}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).format(date);
}
function displayReason(reason: string) { return reasonLabels[reason] ?? "勤怠の内容を確認してください"; }
function dateRange(start: string, end: string | null) {
  if (!end || end < start) return [];
  const values: string[] = [];
  const cursor = new Date(`${start}T00:00:00Z`);
  const last = new Date(`${end}T00:00:00Z`);
  while (cursor <= last) { values.push(cursor.toISOString().slice(0, 10)); cursor.setUTCDate(cursor.getUTCDate() + 1); }
  return values;
}
function isRecordedDay(day: DisplayDay): day is Day { return !("noRecord" in day); }

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
const locationSearch = () => window.location.search;
const serverLocationSearch = () => null;

function updateView(values: Record<string, string | null>) {
  const url = new URL(window.location.href);
  for (const [key, value] of Object.entries(values)) {
    if (value === null) url.searchParams.delete(key); else url.searchParams.set(key, value);
  }
  window.history.replaceState(null, "", url);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export default function StaffAttendancePage() {
  const search = useSyncExternalStore(subscribeLocation, locationSearch, serverLocationSearch);
  const params = useMemo(() => new URLSearchParams(search ?? ""), [search]);
  const storeId = params.get("store_id") ?? "";
  const staffId = params.get("staff_id") ?? "";
  const requestedMonth = params.get("month") ?? "";
  const month = /^\d{4}-(0[1-9]|1[0-2])$/.test(requestedMonth) ? requestedMonth : currentMonth();
  const reviewOnly = params.get("review") === "1";
  const requestedFocus = params.get("focus") ?? "";
  const focusDate = isAttendanceDate(requestedFocus) && requestedFocus.startsWith(`${month}-`) ? requestedFocus : "";
  const receiptId = params.get("saved") ?? "";
  const [payload, setPayload] = useState<Payload | null>(null);
  const [message, setMessage] = useState("勤怠を読み込んでいます");
  const [error, setError] = useState<string | null>(null);
  const [retry, setRetry] = useState(0);
  const [receipt, setReceipt] = useState<CorrectionReceipt | null>(null);
  const receiptCache = useRef<{ id: string; value: CorrectionReceipt | null } | null>(null);
  const liffReady = useRef<Promise<void> | null>(null);
  const returnTarget = useRef<HTMLElement | null>(null);
  const lastFocused = useRef("");
  const payloadMatches = payload?.store.id === storeId && payload?.staff.id === staffId && payload?.month === month;
  const ready = payloadMatches && !message && !error;
  const notice = receiptId && receipt?.storeId === storeId && receipt?.staffId === staffId && receipt?.businessDate === focusDate ? receipt : null;
  const returnMessage = notice
    ? `${dateLabel(focusDate)}の打刻を${{ ADD: "追加", REPLACE: "変更", VOID: "取消" }[notice.operation]}しました。`
    : `${focusDate ? dateLabel(focusDate) : ""}の勤怠に戻りました。`;

  useEffect(() => {
    if (!storeId || !staffId) return;
    let active = true;
    async function load() {
      try {
        setMessage("勤怠を読み込んでいます"); setError(null);
        if (receiptCache.current?.id !== receiptId) {
          receiptCache.current = { id: receiptId, value: consumeCorrectionReceipt(receiptId, { storeId, staffId, businessDate: focusDate }) };
        }
        setReceipt(receiptCache.current.value);
        if (!liffReady.current) liffReady.current = liff.init({ liffId: LIFF_ID }).catch((caught: unknown) => {
          liffReady.current = null;
          throw caught;
        });
        await liffReady.current;
        if (!active) return;
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("対象スタッフを確認できませんでした。");
        const response = await fetch("/api/manager/staff-attendance", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId, staffId, month }) });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          if (data.code === "MANAGER_ACCESS_REQUIRED") throw new Error("この店舗の管理者権限を確認できませんでした。");
          if (data.code === "STAFF_NOT_FOUND") throw new Error("この店舗に対象スタッフが見つかりませんでした。");
          throw new Error("個人の勤怠を読み込めませんでした。");
        }
        if (data.store?.id !== storeId || data.staff?.id !== staffId || data.month !== month) throw new Error("対象の勤怠を確認できませんでした。もう一度読み込んでください。");
        if (active) setPayload(data as Payload);
      } catch (caught) { if (active) setError(caught instanceof Error ? caught.message : "個人の勤怠を読み込めませんでした。"); }
      finally { if (active) setMessage(""); }
    }
    void load();
    return () => { active = false; };
  }, [month, staffId, storeId, focusDate, receiptId, retry]);

  const selectedStaffName = useMemo(() => payload?.staffOptions.find((staff) => staff.id === staffId)?.legalName ?? payload?.staff.legalName ?? "個人の勤怠", [payload, staffId]);
  const displayTimes = useMemo(() => attendanceDisplayTimes(payload?.events, payload?.store.timezone), [payload]);
  const allDays = useMemo<DisplayDay[]>(() => {
    if (!payload) return [];
    const recordedByDate = new Map(payload.days.map((day) => [day.businessDate, day]));
    return dateRange(payload.period.start, payload.period.displayThrough).map((businessDate) => recordedByDate.get(businessDate) ?? { businessDate, noRecord: true as const });
  }, [payload]);
  const visibleDays = useMemo(() => {
    const selected = reviewOnly ? allDays.filter((day) => isRecordedDay(day) && (day.status === "NEEDS_REVIEW" || day.attendanceReasons.length > 0 || day.reviewReasons.length > 0 || day.gpsIssueCount > 0)) : allDays;
    return [...selected].sort((a, b) => b.businessDate.localeCompare(a.businessDate));
  }, [allDays, reviewOnly]);

  const focusExists = allDays.some(day => day.businessDate === focusDate);
  const focusHidden = focusExists && !visibleDays.some(day => day.businessDate === focusDate);
  useEffect(() => {
    if (!ready || !focusExists || !returnTarget.current) return;
    const key = `${storeId}:${staffId}:${month}:${focusDate}:${reviewOnly}:${retry}`;
    if (lastFocused.current === key) return;
    lastFocused.current = key;
    returnTarget.current.focus({ preventScroll: true });
    returnTarget.current.scrollIntoView({ block: "start", behavior: "instant" });
  }, [ready, focusExists, storeId, staffId, month, focusDate, reviewOnly, retry]);

  function editHref(businessDate: string) { return `/manager/staff-attendance/edit?store_id=${encodeURIComponent(storeId)}&staff_id=${encodeURIComponent(staffId)}&date=${encodeURIComponent(businessDate)}${reviewOnly ? "&review=1" : ""}`; }
  function changeStaff(nextStaffId: string) {
    if (nextStaffId === staffId) return;
    setMessage("スタッフを切り替えています"); setError(null);
    updateView({ staff_id: nextStaffId, month, review: null, focus: null, saved: null });
  }
  function changeMonth(nextMonth: string) {
    if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(nextMonth) || nextMonth === month) return;
    setMessage("勤怠を読み込んでいます"); setError(null);
    updateView({ month: nextMonth, focus: null, saved: null });
  }
  const routeError = search !== null && (!storeId || !staffId) ? "対象スタッフを確認できませんでした。" : null;

  return (
    <main className={styles.page}><section className={styles.shell}>
      <header className={styles.header}><a className={styles.back} href="/manager">← 管理画面へ戻る</a><p className={styles.eyebrow}>ONOGAMI 勤怠</p><h1>{selectedStaffName}</h1>{payload && <p className={styles.store}>{payload.store.name}</p>}</header>
      {process.env.NEXT_PUBLIC_MANAGER_LIFF_ID && <p className="manager-preview-notice">検証用の勤怠画面です。</p>}
      {payload && payload.staffOptions.length > 0 && <label className={styles.staffSelector}>スタッフを選択<select value={staffId} onChange={(event) => changeStaff(event.target.value)}>{payload.staffOptions.map((staff) => <option key={staff.id} value={staff.id}>{staff.legalName}{staff.status === "departed" ? "（退社）" : staff.status === "inactive" ? "（一時停止中）" : ""}</option>)}</select></label>}
      <label className={styles.monthSelector}>表示する月<input type="month" value={month} onChange={(event) => changeMonth(event.target.value)} /></label>
      {!routeError && message && <p className={styles.loading} role="status">{message}</p>}
      {(routeError || error) && <div className={styles.error} role="alert"><p>{notice ? "打刻の保存は完了しましたが、最新の勤怠を読み込めませんでした。" : routeError ?? error}</p>{!routeError && <button type="button" className={styles.retry} onClick={() => { setMessage("勤怠を読み込んでいます"); setError(null); setRetry(value => value + 1); }}>もう一度読み込む</button>}</div>}
      {payload && ready && <>
        <section className={styles.summary} aria-busy={Boolean(message)}><div><span>出勤日数</span><strong>{payload.summary.workDays}日</strong></div><div><span>実働</span><strong>{payload.summary.workDuration}</strong></div><div><span>休憩</span><strong>{payload.summary.breakDuration}</strong></div><div><span>要確認</span><strong>{payload.summary.issueDays}日</strong></div></section>
        <div className={styles.toolbar}><strong>{monthLabel(payload.month)}</strong><div role="group" aria-label="表示する勤怠"><button type="button" aria-pressed={!reviewOnly} className={!reviewOnly ? styles.activeFilter : ""} onClick={() => updateView({ review: null, focus: null, saved: null })}>すべて</button><button type="button" aria-pressed={reviewOnly} className={reviewOnly ? styles.activeFilter : ""} onClick={() => updateView({ review: "1", focus: null, saved: null })}>要確認のみ</button></div></div>
        {focusHidden && <section className={styles.returnNotice} ref={returnTarget} tabIndex={-1} aria-label="戻った日の確認"><p role="status">{returnMessage}</p><p>この日は「要確認のみ」の対象外です。</p><button type="button" className={styles.retry} onClick={() => updateView({ review: null })}>{notice ? "修正した日を確認" : "この日を確認"}</button></section>}
        {visibleDays.length === 0 ? <p className={styles.empty}>{reviewOnly ? "要確認の勤怠はありません" : "表示できる営業日はまだありません"}</p> : <ol className={styles.dayList}>{visibleDays.map((day) => {
          const returned = day.businessDate === focusDate;
          const returnProps = returned ? { ref: (element: HTMLLIElement | null) => { returnTarget.current = element; }, tabIndex: -1, "data-returned-day": day.businessDate } : {};
          const savedMessage = returned && <p className={styles.returnMessage} role="status">{returnMessage}</p>;
          if (!isRecordedDay(day)) return <li key={day.businessDate} {...returnProps} className={styles.noRecordDay}><div className={styles.dayHeader}><strong>{dateLabel(day.businessDate)}</strong></div>{savedMessage}<p className={styles.noRecord}>勤務記録なし</p><a className={styles.editDay} href={editHref(day.businessDate)}>この日の打刻を修正</a></li>;
          const reasons = [...day.attendanceReasons, ...day.reviewReasons]; const needsReview = day.status === "NEEDS_REVIEW" || reasons.length > 0;
          const times = displayTimes.get(day.businessDate) ?? day;
          return <li key={day.businessDate} {...returnProps} className={needsReview ? styles.reviewDay : undefined}><div className={styles.dayHeader}><strong>{dateLabel(day.businessDate)}</strong><div className={styles.badges}>{needsReview && <span className={styles.reviewBadge}>要確認</span>}{day.hasCorrection && <span className={styles.correctionBadge}>訂正あり</span>}{day.gpsIssueCount > 0 && <span className={styles.gpsBadge}>GPS確認</span>}</div></div>{savedMessage}<dl className={styles.times}><div><dt>出勤</dt><dd>{times.checkIn || "—"}</dd></div><div><dt>退勤</dt><dd>{times.checkOut || "—"}</dd></div><div><dt>実働</dt><dd>{day.workedDuration || "—"}</dd></div><div><dt>休憩</dt><dd>{day.breakDuration || "—"}</dd></div></dl>{times.breakPeriods.length > 0 && <div className={styles.breaks}>{times.breakPeriods.map((period, index) => <p key={index}>休憩 {period}</p>)}</div>}{reasons.length > 0 && <ul className={styles.reasons}>{reasons.map((reason, index) => <li key={`${reason}-${index}`}>{displayReason(reason)}</li>)}</ul>}<a className={styles.editDay} href={editHref(day.businessDate)}>この日の打刻を修正</a></li>;
        })}</ol>}
      </>}
    </section></main>
  );
}
