"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useRef, useState } from "react";
import styles from "./edit.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";
type Operation = "ADD" | "REPLACE" | "VOID";
type StaffEvent = { effectiveId: string; businessDate: string; eventType: EventType; occurredAt: string; corrected: boolean };
type Payload = {
  ok: true;
  store: { id: string; name: string };
  staff: { id: string; legalName: string };
  month: string;
  events: StaffEvent[];
};
type EditState = {
  operation: Operation;
  targetEffectiveId?: string;
  eventType: EventType | "";
  date: string;
  time: string;
  reason: string;
  reasonChoice: string;
};
type RouteParams = { storeId: string; staffId: string; businessDate: string };

const eventLabels: Record<EventType, string> = {
  CHECK_IN: "出勤",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  CHECK_OUT: "退勤",
};

const reasonOptions: Record<Operation, string[]> = {
  ADD: ["打刻忘れ", "端末・通信の不具合", "管理者確認による追加", "その他"],
  REPLACE: ["打刻時刻の誤り", "管理者確認による訂正", "その他"],
  VOID: ["誤打刻", "重複打刻", "管理者確認による取消", "その他"],
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function dateLabel(value: string) {
  const date = new Date(`${value}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "numeric",
    day: "numeric",
    weekday: "short",
  }).format(date);
}

function eventTimeInput(value: string) {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function readRouteParams(): RouteParams {
  const params = new URLSearchParams(window.location.search);
  return {
    storeId: params.get("store_id") ?? "",
    staffId: params.get("staff_id") ?? "",
    businessDate: params.get("date") ?? "",
  };
}

export default function StaffAttendanceEditPage() {
  const [routeParams, setRouteParams] = useState<RouteParams | null>(null);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState("打刻を読み込んでいます");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);

  const storeId = routeParams?.storeId ?? "";
  const staffId = routeParams?.staffId ?? "";
  const businessDate = routeParams?.businessDate ?? "";

  useEffect(() => { setRouteParams(readRouteParams()); }, []);

  useEffect(() => {
    if (!routeParams) return;
    if (!storeId || !staffId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate)) {
      setMessage("");
      setError("修正対象の日付を確認できませんでした。");
      return;
    }

    let active = true;
    async function load() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
        const response = await fetch("/api/manager/staff-attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeId, staffId, month: businessDate.slice(0, 7) }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) throw new Error("この日の打刻を読み込めませんでした。");
        if (active) { setPayload(data as Payload); setError(null); }
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "この日の打刻を読み込めませんでした。");
      } finally {
        if (active) setMessage("");
      }
    }
    void load();
    return () => { active = false; };
  }, [businessDate, routeParams, staffId, storeId]);

  const dayEvents = useMemo(
    () => (payload?.events ?? []).filter((event) => event.businessDate === businessDate),
    [businessDate, payload],
  );
  const targetEvent = useMemo(
    () => edit?.targetEffectiveId ? dayEvents.find((event) => event.effectiveId === edit.targetEffectiveId) ?? null : null,
    [dayEvents, edit?.targetEffectiveId],
  );

  function attendanceHref(date = businessDate) {
    return `/manager/staff-attendance?store_id=${encodeURIComponent(storeId)}&staff_id=${encodeURIComponent(staffId)}&month=${encodeURIComponent(date.slice(0, 7))}`;
  }

  function goBackToAttendance() {
    window.location.replace(attendanceHref());
  }

  function scrollToEditor() {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })));
  }

  function startEdit(next: EditState) {
    setEdit(next);
    setReviewing(false);
    setSubmitMessage(null);
    scrollToEditor();
  }

  function startAdd() {
    startEdit({ operation: "ADD", eventType: "", date: businessDate, time: "", reason: "", reasonChoice: "" });
  }

  function startReplace(event: StaffEvent) {
    startEdit({ operation: "REPLACE", targetEffectiveId: event.effectiveId, eventType: event.eventType, date: businessDate, time: eventTimeInput(event.occurredAt), reason: "", reasonChoice: "" });
  }

  function startVoid(event: StaffEvent) {
    startEdit({ operation: "VOID", targetEffectiveId: event.effectiveId, eventType: event.eventType, date: businessDate, time: eventTimeInput(event.occurredAt), reason: "", reasonChoice: "" });
  }

  function finalReason() {
    if (!edit) return "";
    return edit.reasonChoice === "その他" ? edit.reason.trim() : edit.reasonChoice;
  }

  function validateEdit() {
    if (!edit) return false;
    if (!edit.reasonChoice) {
      setSubmitMessage(edit.operation === "VOID" ? "取消理由を選択してください。" : "修正理由を選択してください。");
      return false;
    }
    if (!finalReason()) {
      setSubmitMessage(edit.operation === "VOID" ? "その他の取消理由を入力してください。" : "その他の修正理由を入力してください。");
      return false;
    }
    if (edit.operation !== "VOID" && (!edit.eventType || !edit.time)) {
      setSubmitMessage("打刻種類と時刻を入力してください。");
      return false;
    }
    return true;
  }

  function openReview() {
    if (!validateEdit()) return;
    setSubmitMessage(null);
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.blur();
    setReviewing(true);
    scrollToEditor();
  }

  async function submit() {
    if (!edit || !payload || !validateEdit()) return;
    setSubmitting(true);
    setSubmitMessage(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/punch-corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId,
          staffId,
          operation: edit.operation,
          targetEffectiveId: edit.targetEffectiveId,
          eventType: edit.operation === "VOID" ? undefined : edit.eventType,
          occurredAt: edit.operation === "VOID" ? undefined : new Date(`${edit.date}T${edit.time}:00+09:00`).toISOString(),
          reason: finalReason(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        const messages: Record<string, string> = {
          DUPLICATE_PUNCH_TIME: "同じ時刻の打刻が既にあります。時刻を確認してください。",
          INVALID_PUNCH_SEQUENCE: "この修正では打刻の順序が正しくなりません。履歴を確認してください。",
          TARGET_NOT_FOUND: "選択した打刻が最新の履歴に見つかりません。画面を更新してください。",
        };
        throw new Error(messages[data.code] ?? "打刻を修正できませんでした。");
      }
      window.location.replace(attendanceHref(edit.date));
    } catch (caught) {
      setSubmitMessage(caught instanceof Error ? caught.message : "打刻を修正できませんでした。");
    } finally {
      setSubmitting(false);
    }
  }

  function operationLabel(operation: Operation) {
    if (operation === "ADD") return "打刻を追加";
    if (operation === "REPLACE") return "打刻を変更";
    return "打刻を取消";
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <button type="button" className={styles.back} onClick={goBackToAttendance}>← 個人勤怠へ戻る</button>
          <p className={styles.eyebrow}>ONOGAMI 勤怠</p>
          <h1>{payload ? `${payload.staff.legalName}さんの打刻修正` : "打刻修正"}</h1>
          {businessDate && <p className={styles.date}>{dateLabel(businessDate)}</p>}
        </header>

        {message && <p className={styles.status}>{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {payload && !error && (
          <>
            <section className={styles.history}>
              <div className={styles.sectionHeading}><h2>この日の打刻</h2><span>{dayEvents.length}件</span></div>
              {dayEvents.length === 0 ? <p className={styles.empty}>打刻記録はありません</p> : (
                <ol>{dayEvents.map((event) => (
                  <li key={event.effectiveId}>
                    <div><time>{formatTime(event.occurredAt)}</time><strong>{eventLabels[event.eventType]}</strong>{event.corrected && <small>訂正</small>}</div>
                    <div className={styles.eventActions}><button type="button" onClick={() => startReplace(event)}>変更</button><button type="button" onClick={() => startVoid(event)}>取消</button></div>
                  </li>
                ))}</ol>
              )}
              <button type="button" className={styles.addButton} onClick={startAdd}>打刻を追加</button>
            </section>

            {edit && (
              <section ref={editorRef} className={styles.editor}>
                {!reviewing ? (
                  <>
                    <h2>{operationLabel(edit.operation)}</h2>
                    {edit.operation !== "VOID" && (
                      <label>打刻種類<select value={edit.eventType} onChange={(event) => setEdit({ ...edit, eventType: event.target.value as EventType | "" })}><option value="">選択してください</option>{Object.entries(eventLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>
                    )}
                    <label>日付<input type="date" value={edit.date} onChange={(event) => setEdit({ ...edit, date: event.target.value })} /></label>
                    {edit.operation !== "VOID" && <label>時刻<input type="time" step="60" value={edit.time} onChange={(event) => setEdit({ ...edit, time: event.target.value })} /></label>}
                    <label>{edit.operation === "VOID" ? "取消理由" : "修正理由"}
                      <select value={edit.reasonChoice} onChange={(event) => setEdit({ ...edit, reasonChoice: event.target.value, reason: event.target.value === "その他" ? edit.reason : "" })}>
                        <option value="">選択してください</option>
                        {reasonOptions[edit.operation].map((reason) => <option key={reason} value={reason}>{reason}</option>)}
                      </select>
                    </label>
                    {edit.reasonChoice === "その他" && <label>その他の理由<input value={edit.reason} onChange={(event) => setEdit({ ...edit, reason: event.target.value })} placeholder={edit.operation === "VOID" ? "取消理由を入力してください" : "修正理由を入力してください"} /></label>}
                    {submitMessage && <p className={styles.formError} role="alert">{submitMessage}</p>}
                    <div className={styles.actions}><button type="button" className={styles.cancel} onClick={() => { setEdit(null); setSubmitMessage(null); }}>キャンセル</button><button type="button" className={styles.confirm} onClick={openReview}>修正内容を確認</button></div>
                  </>
                ) : (
                  <>
                    <div className={styles.reviewHeading}><p className={styles.eyebrow}>最終確認</p><h2>修正内容の確認</h2><p>入力内容を確認してから確定してください。</p></div>
                    <dl className={styles.reviewList}>
                      <div><dt>操作</dt><dd>{operationLabel(edit.operation)}</dd></div>
                      <div><dt>日付</dt><dd>{dateLabel(edit.date)}</dd></div>
                      <div><dt>打刻</dt><dd>{edit.eventType ? eventLabels[edit.eventType] : targetEvent ? eventLabels[targetEvent.eventType] : "—"}</dd></div>
                      {edit.operation === "ADD" && <div><dt>追加する時刻</dt><dd>{edit.time}</dd></div>}
                      {edit.operation === "REPLACE" && <div><dt>時刻</dt><dd>{targetEvent ? formatTime(targetEvent.occurredAt) : "—"} → {edit.time}</dd></div>}
                      {edit.operation === "VOID" && <div><dt>取り消す時刻</dt><dd>{targetEvent ? formatTime(targetEvent.occurredAt) : "—"}</dd></div>}
                      <div><dt>{edit.operation === "VOID" ? "取消理由" : "修正理由"}</dt><dd>{finalReason()}</dd></div>
                    </dl>
                    {submitMessage && <p className={styles.formError} role="alert">{submitMessage}</p>}
                    <div className={styles.actions}><button type="button" className={styles.cancel} disabled={submitting} onClick={() => { setReviewing(false); setSubmitMessage(null); }}>戻って修正</button><button type="button" className={styles.confirm} disabled={submitting} onClick={() => void submit()}>{submitting ? "処理中…" : "この内容で確定"}</button></div>
                  </>
                )}
              </section>
            )}
          </>
        )}
      </section>
    </main>
  );
}
