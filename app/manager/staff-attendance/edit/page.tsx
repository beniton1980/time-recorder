"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { managerCorrectionInputParts, managerCorrectionTimestamp } from "@/lib/manager-correction-datetime";
import { attendanceReturnHref, rememberCorrection } from "@/lib/manager-attendance-return";
import { consultationHref } from "@/lib/consultation";
import { withAttendanceDeadline } from "@/lib/attendance-request";
import styles from "./edit.module.css";

const LIFF_ID = process.env.NEXT_PUBLIC_MANAGER_LIFF_ID || "2010761826-6FNSE1PD";
type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";
type Operation = "ADD" | "REPLACE" | "VOID";
type StaffEvent = { effectiveId: string; businessDate: string; eventType: EventType; occurredAt: string; corrected: boolean };
type Payload = {
  consultation?: { id: string; reason: string; version: string } | null;
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
type RouteParams = { storeId: string; staffId: string; businessDate: string; reviewOnly: boolean; consultationId: string };

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

function eventDateTimeLabel(value: string) {
  const parts = managerCorrectionInputParts(value);
  return `${dateLabel(parts.date)} ${parts.time}`;
}

function subscribeLocation(onChange: () => void) {
  window.addEventListener("popstate", onChange);
  return () => window.removeEventListener("popstate", onChange);
}
const locationSearch = () => window.location.search;
const serverLocationSearch = () => null;

function readRouteParams(search: string): RouteParams {
  const params = new URLSearchParams(search);
  return {
    storeId: params.get("store_id") ?? "",
    staffId: params.get("staff_id") ?? "",
    businessDate: params.get("date") ?? "",
    reviewOnly: params.get("review") === "1",
    consultationId: params.get("consultation") ?? "",
  };
}

export default function StaffAttendanceEditPage() {
  const search = useSyncExternalStore(subscribeLocation, locationSearch, serverLocationSearch);
  const routeParams = useMemo(() => search === null ? null : readRouteParams(search), [search]);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [edit, setEdit] = useState<EditState | null>(null);
  const [reviewing, setReviewing] = useState(false);
  const [message, setMessage] = useState("打刻を読み込んでいます");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  const editorRef = useRef<HTMLElement | null>(null);
  const saveRequest = useRef<string | null>(null);

  const storeId = routeParams?.storeId ?? "";
  const staffId = routeParams?.staffId ?? "";
  const businessDate = routeParams?.businessDate ?? "";
  const consultationId = routeParams?.consultationId ?? "";

  const routeError = routeParams && (!storeId || !staffId || !/^\d{4}-\d{2}-\d{2}$/.test(businessDate))
    ? "修正対象の日付を確認できませんでした。" : null;
  const visibleError = routeError ?? error;

  useEffect(() => {
    if (!routeParams || routeError) return;

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
          body: JSON.stringify({ idToken, storeId, staffId, month: businessDate.slice(0, 7), ...(consultationId ? { consultationId } : {}) }),
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
  }, [businessDate, routeError, routeParams, staffId, storeId, consultationId]);

  const dayEvents = useMemo(
    () => (payload?.events ?? []).filter((event) => event.businessDate === businessDate),
    [businessDate, payload],
  );
  const targetEvent = dayEvents.find((event) => event.effectiveId === edit?.targetEffectiveId) ?? null;

  function attendanceHref(receiptId?: string) {
    if (consultationId) return consultationHref(storeId, consultationId);
    return attendanceReturnHref({ storeId, staffId, businessDate }, routeParams?.reviewOnly ?? false, receiptId);
  }

  function goBackToAttendance() {
    window.location.replace(attendanceHref());
  }

  function scrollToEditor() {
    window.requestAnimationFrame(() => window.requestAnimationFrame(() => editorRef.current?.scrollIntoView({ behavior: "smooth", block: "start" })));
  }

  function startEdit(next: EditState) {
    saveRequest.current = null;
    setEdit(next);
    setReviewing(false);
    setSubmitMessage(null);
    scrollToEditor();
  }

  function startAdd() {
    startEdit({ operation: "ADD", eventType: "", date: businessDate, time: "", reason: "", reasonChoice: "管理者確認による追加" });
  }

  function startReplace(event: StaffEvent) {
    startEdit({ operation: "REPLACE", targetEffectiveId: event.effectiveId, eventType: event.eventType, ...managerCorrectionInputParts(event.occurredAt), reason: "", reasonChoice: "" });
  }

  function startVoid(event: StaffEvent) {
    startEdit({ operation: "VOID", targetEffectiveId: event.effectiveId, eventType: event.eventType, ...managerCorrectionInputParts(event.occurredAt), reason: "", reasonChoice: "" });
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
    if (edit.operation !== "VOID" && (!edit.eventType || !edit.date || !edit.time)) {
      setSubmitMessage("打刻種類・日付・時刻を入力してください。");
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
      if (consultationId && !payload.consultation) throw new Error("相談の最新状態を確認してください。");
      if (consultationId && !saveRequest.current) saveRequest.current = crypto.randomUUID();
      const send = async (signal?: AbortSignal) => {
      const response = await fetch("/api/manager/punch-corrections", {
        signal,
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId,
          staffId,
          operation: edit.operation,
          targetEffectiveId: edit.targetEffectiveId,
          eventType: edit.operation === "VOID" ? undefined : edit.eventType,
          occurredAt: edit.operation === "VOID" ? undefined : managerCorrectionTimestamp(edit.date, edit.time),
          reason: finalReason(),
          ...(consultationId ? { consultationId, clientRequestId: saveRequest.current, expectedVersion: payload.consultation!.version } : {}),
        }),
      });
      return { response, data: await response.json() };
      };
      const { response, data } = consultationId
        ? await withAttendanceDeadline(send).catch(() => { throw new Error("保存結果を確認できませんでした。相談へ戻って保存済みの修正を確認してください。"); })
        : await send();
      if (!response.ok || !data.ok) {
        const messages: Record<string, string> = {
          ATTENDANCE_CHANGED: "打刻が更新されています。相談へ戻り、最新の内容を確認してください。",
          REQUEST_NOT_PENDING: "この相談は既に処理されています。相談へ戻って結果を確認してください。",
          CLIENT_REQUEST_CONFLICT: "送信済みの内容と異なります。相談へ戻って保存結果を確認してください。",
          OCCURRED_AT_IN_FUTURE: "未来の日時には修正できません。実際に打刻した日付・時刻を確認してください。",
          DUPLICATE_PUNCH_TIME: "同じ時刻の打刻が既にあります。時刻を確認してください。",
          INVALID_PUNCH_SEQUENCE: "この修正では打刻の順序が正しくなりません。履歴を確認してください。",
          TARGET_NOT_FOUND: "選択した打刻が最新の履歴に見つかりません。画面を更新してください。",
        };
        throw new Error(messages[data.code] ?? "打刻を修正できませんでした。");
      }
      // Return to the attendance month where the manager started this correction.
      const receiptId = consultationId ? undefined : rememberCorrection({ storeId, staffId, businessDate, operation: edit.operation });
      window.location.replace(attendanceHref(receiptId));
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
          <button type="button" className={styles.back} onClick={goBackToAttendance}>{consultationId ? "← 相談へ戻る・保存結果を確認" : "← 個人勤怠へ戻る"}</button>
          <p className={styles.eyebrow}>ONOGAMI 勤怠</p>
          <h1>{payload ? `${payload.staff.legalName}さんの打刻修正` : "打刻修正"}</h1>
          {businessDate && <p className={styles.date}>{dateLabel(businessDate)}の勤務</p>}
          {process.env.NEXT_PUBLIC_MANAGER_LIFF_ID && <p className="manager-preview-notice">検証用の勤怠画面です。</p>}
        </header>

        {message && !routeError && <p className={styles.status}>{message}</p>}
        {payload?.consultation && <p className={styles.status}>この相談への対応中：{payload.consultation.reason}<br />修正を保存した後、相談へ戻って「対応済み」にします。</p>}
        {visibleError && <p className={styles.error} role="alert">{visibleError}</p>}

        {payload && !visibleError && (
          <>
            <section className={styles.history}>
              <div className={styles.sectionHeading}><h2>この日の打刻</h2><span>{dayEvents.length}件</span></div>
              {dayEvents.length === 0 ? <p className={styles.empty}>打刻記録はありません</p> : (
                <ol>{dayEvents.map((event) => (
                  <li key={event.effectiveId}>
                    <div><time dateTime={event.occurredAt}>{managerCorrectionInputParts(event.occurredAt).date === businessDate ? formatTime(event.occurredAt) : eventDateTimeLabel(event.occurredAt)}</time><strong>{eventLabels[event.eventType]}</strong>{event.corrected && <small>訂正</small>}</div>
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
                    {edit.operation === "VOID" ? (
                      <p>取り消す打刻：{dateLabel(edit.date)} {edit.time} {edit.eventType && eventLabels[edit.eventType]}</p>
                    ) : <label>実際の打刻日<input type="date" value={edit.date} onChange={(event) => setEdit({ ...edit, date: event.target.value })} /></label>}
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
                      {edit.operation === "REPLACE" && <><div><dt>変更前</dt><dd>{targetEvent ? eventDateTimeLabel(targetEvent.occurredAt) : "—"}</dd></div><div><dt>変更後</dt><dd>{dateLabel(edit.date)} {edit.time}</dd></div></>}
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
