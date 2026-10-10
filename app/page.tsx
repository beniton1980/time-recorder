"use client";

import liff from "@line/liff";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";
import { createPunchLocationReader } from "@/lib/punch-location.mjs";
import type { PunchLocationReader } from "@/lib/punch-location.mjs";
import { measurePunchStage } from "@/lib/punch-performance.mjs";
import { readPendingOperation, savePendingOperation, clearPendingOperation, tabOperationStorage } from "@/lib/attendance-operation";
import type { EventType, CorrectionIntent, PendingOperation, OperationResult } from "@/lib/attendance-operation";
import { withAttendanceDeadline } from "@/lib/attendance-request";

const LIFF_ID = "2010761826-6FNSE1PD";

type WorkState = "OFF_DUTY" | "WORKING" | "ON_BREAK";

type PunchHistoryItem = {
  effective_id: string;
  original_event_id: string | null;
  event_type: EventType;
  occurred_at: string;
  corrected: boolean;
};

type ActiveStoreConflict = {
  store_id: string;
  store_name: string;
  state: "WORKING" | "ON_BREAK";
};

type Membership = {
  staff_id: string;
  legal_name: string;
  store_id: string;
  store_name: string;
  state: WorkState;
  state_version: string | null;
  last_event_id: string | null;
  last_event_revision_id: string | null;
  last_event_at: string | null;
  last_event_type: EventType | null;
  recent_punches: PunchHistoryItem[];
};

type ViewState =
  | { kind: "loading" }
  | { kind: "unregistered"; storeName: string }
  | { kind: "store_required"; message: string }
  | {
      kind: "active_store_conflict";
      requestedStoreName: string;
      activeStore: ActiveStoreConflict;
    }
  | { kind: "ready"; membership: Membership }
  | { kind: "error"; message: string };

const stateLabels: Record<WorkState, string> = {
  OFF_DUTY: "勤務前",
  WORKING: "勤務中",
  ON_BREAK: "休憩中",
};

const eventLabels: Record<EventType, string> = {
  CHECK_IN: "出勤",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  CHECK_OUT: "退勤",
};

const actionsByState: Record<WorkState, EventType[]> = {
  OFF_DUTY: ["CHECK_IN"],
  WORKING: ["CHECK_OUT", "BREAK_START"],
  ON_BREAK: ["BREAK_END"],
};


function formatDate(value: Date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
}

function formatTime(value: Date | string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

type SessionData = {
  ok: boolean;
  code?: string;
  registered?: boolean;
  store?: { store_name: string };
  memberships?: Membership[];
  activeStoreConflict?: ActiveStoreConflict | null;
  operationResult?: OperationResult | null;
};

function sessionView(response: Response, data: SessionData): ViewState {
  if (!response.ok || !data.ok) {
    if (data.code === "STORE_TOKEN_REQUIRED" || data.code === "STORE_TOKEN_INVALID") {
      return { kind: "store_required", message: "この店舗QRコードは利用できません。" };
    }
    if (data.code === "STAFF_INACTIVE") {
      return { kind: "store_required", message: "この店舗での利用は停止されています。管理者に確認してください。" };
    }
    throw new Error("認証を確認できませんでした。通信を確認して、もう一度お試しください。");
  }
  if (!data.registered && data.store) {
    return { kind: "unregistered", storeName: data.store.store_name };
  }
  const membership = data.memberships?.[0];
  if (!membership) throw new Error("勤務情報を取得できませんでした。");
  if (data.activeStoreConflict) {
    return { kind: "active_store_conflict", requestedStoreName: membership.store_name, activeStore: data.activeStoreConflict };
  }
  return { kind: "ready", membership };
}

async function loadStaffSession(storeToken: string, pending?: PendingOperation) {
  const idToken = liff.getIDToken();
  if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
  return measurePunchStage("session", () => withAttendanceDeadline(async signal => {
    const response = await fetch("/api/session/bootstrap", {
      method: "POST", signal,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, storeToken, pendingOperation: pending
        ? { kind: pending.kind, clientRequestId: pending.clientRequestId } : undefined }),
    });
    const data = await response.json() as SessionData;
    return { view: sessionView(response, data), result: data.operationResult ?? null };
  }));
}

function operationLabel(operation: PendingOperation) {
  if (operation.kind === "punch") return eventLabels[operation.eventType];
  if (operation.intent.category === "MISTAKE") return eventLabels[operation.intent.eventType] + "への訂正";
  if (operation.intent.category === "MISSED") return "押し忘れた" + eventLabels[operation.intent.eventType] + "の申請";
  return "打刻修正の申請";
}

function operationNotice(operation: PendingOperation, result: OperationResult) {
  if (operation.kind === "punch") {
    return (result.occurred_at ? formatTime(result.occurred_at) + "の" : "")
      + eventLabels[result.event_type ?? operation.eventType] + "を記録しました"
      + (result.location_status === "OK" ? "" : "（位置情報は未確認）");
  }
  if (result.status === "PENDING") return "打刻修正を申請しました（承認待ち）";
  if (result.status === "REJECTED") return "この修正申請は却下されています。現在の記録を確認してください。";
  return "打刻修正が反映されています。現在の記録を表示しています。";
}

export default function Home() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState<EventType | null>(null);
  const [punchPhase, setPunchPhase] = useState<"location" | "sending" | "confirming">("location");
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [showCorrection, setShowCorrection] = useState(false);
  const [correctionCategory, setCorrectionCategory] =
    useState<"MISTAKE" | "MISSED" | "OTHER">("MISTAKE");
  const [correctionEvent, setCorrectionEvent] =
    useState<EventType>("CHECK_IN");
  const [correctionDate, setCorrectionDate] = useState("");
  const [correctionTime, setCorrectionTime] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionReview, setCorrectionReview] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const [registrationName, setRegistrationName] = useState("");
  const [registrationError, setRegistrationError] = useState<string | null>(null);
  const [registrationSubmitting, setRegistrationSubmitting] = useState(false);
  const storeTokenRef = useRef<string | null>(null);
  const locationReaderRef = useRef<PunchLocationReader | null>(null);
  const punchInFlightRef = useRef(false);
  const pendingOperationRef = useRef<PendingOperation | null>(null);
  const registrationInFlightRef = useRef(false);
  const [pendingOperation, setPendingOperation] = useState<PendingOperation | null>(null);
  const [recovering, setRecovering] = useState(false);
  const readyForPunch = view.kind === "ready";

  useEffect(() => {
    if (!readyForPunch) return;
    const reader = createPunchLocationReader({
      geolocation: navigator.geolocation,
      permissions: navigator.permissions,
    });
    locationReaderRef.current = reader;
    if (document.visibilityState === "visible") void reader.prepare();
    const clearWhenHidden = () => {
      if (document.visibilityState !== "visible") reader.clear();
    };
    document.addEventListener("visibilitychange", clearWhenHidden);
    return () => {
      reader.clear();
      locationReaderRef.current = null;
      document.removeEventListener("visibilitychange", clearWhenHidden);
    };
  }, [readyForPunch]);

  useEffect(() => {
    const updateClock = () => setNow(new Date());
    const initialTimer = window.setTimeout(updateClock, 0);
    const timer = window.setInterval(updateClock, 1000);

    return () => {
      window.clearTimeout(initialTimer);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    let active = true;
    async function bootstrap() {
      try {
        await measurePunchStage("line", () => liff.init({ liffId: LIFF_ID }));
        const storeToken = new URLSearchParams(window.location.search).get("store_token");
        if (!storeToken) {
          if (active) setView({ kind: "store_required", message: "店舗に設置されたQRコードから開いてください。" });
          return;
        }
        storeTokenRef.current = storeToken;
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        let session = await loadStaffSession(storeToken);
        if (!active) return;
        if (session.view.kind === "ready") {
          const { staff_id, store_id } = session.view.membership;
          const pending = readPendingOperation(tabOperationStorage(), staff_id, store_id);
          if (pending) {
            pendingOperationRef.current = pending;
            setPendingOperation(pending);
            try {
              // Reload only checks the result. It never creates a new punch.
              session = await loadStaffSession(storeToken, pending);
              if (!active) return;
              if (session.result) {
                clearPendingOperation(tabOperationStorage(), pending);
                pendingOperationRef.current = null;
                setPendingOperation(null);
                setNotice(operationNotice(pending, session.result));
              }
            } catch {
              if (active) setNotice("送信結果を確認できませんでした。通信を確認して、結果を再確認してください。");
            }
          }
        }
        if (active) setView(session.view);
      } catch {
        if (active) setView({ kind: "error", message: "画面を読み込めませんでした。通信を確認して、もう一度開いてください。" });
      }
    }
    void bootstrap();
    return () => { active = false; };
  }, []);

  async function selfRegister(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (registrationInFlightRef.current) return;
    const legalName = registrationName.trim();
    if (!legalName) {
      setRegistrationError("お名前を入力してください。");
      return;
    }
    const idToken = liff.getIDToken();
    const storeToken = storeTokenRef.current;
    if (!idToken || !storeToken) {
      setRegistrationError("LINEの認証情報を取得できませんでした。");
      return;
    }
    registrationInFlightRef.current = true;
    setRegistrationSubmitting(true);
    setRegistrationError(null);
    try {
      // The membership is authoritative even if the registration response is lost
      // or another tap already registered this identity.
      try {
        await withAttendanceDeadline(signal => fetch("/api/staff/self-register", {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeToken, legalName }),
        }));
      } catch { /* A failed response does not establish that the write failed. */ }
      const session = await loadStaffSession(storeToken);
      if (session.view.kind === "unregistered") {
        setRegistrationError("登録を確認できませんでした。通信を確認して、もう一度お試しください。");
      } else {
        setView(session.view);
        if (session.view.kind === "ready") setNotice("この店舗への登録を確認しました。打刻できます。");
      }
    } catch {
      setRegistrationError("登録結果を確認できませんでした。通信を確認して、もう一度お試しください。");
    } finally {
      registrationInFlightRef.current = false;
      setRegistrationSubmitting(false);
    }
  }

  function rememberOperation(operation: PendingOperation) {
    savePendingOperation(tabOperationStorage(), operation);
    pendingOperationRef.current = operation;
    setPendingOperation(operation);
  }

  function forgetOperation(operation: PendingOperation) {
    clearPendingOperation(tabOperationStorage(), operation);
    pendingOperationRef.current = null;
    setPendingOperation(null);
  }

  async function refreshOperation(operation: PendingOperation) {
    const session = await loadStaffSession(storeTokenRef.current!, operation);
    setView(session.view);
    if (session.result) {
      forgetOperation(operation);
      setShowCorrection(false);
      setNotice(operationNotice(operation, session.result));
      return true;
    }
    return false;
  }

  async function checkPendingOperation() {
    const operation = pendingOperationRef.current;
    if (!operation || punchInFlightRef.current) return;
    punchInFlightRef.current = true;
    setRecovering(true);
    setNotice(null);
    try {
      if (!await refreshOperation(operation)) {
        setNotice("まだ完了を確認できません。同じ内容で再試行できます。");
      }
    } catch {
      setNotice("送信結果を確認できませんでした。通信が戻ってから再確認してください。");
    } finally {
      punchInFlightRef.current = false;
      setRecovering(false);
    }
  }

  async function sendOperation(operation: PendingOperation) {
    if (punchInFlightRef.current) return;
    punchInFlightRef.current = true;
    rememberOperation(operation);
    setNotice(null);
    setShowCorrection(false);
    if (operation.kind === "punch") {
      setSubmitting(operation.eventType);
      setPunchPhase("location");
    } else {
      setCorrectionSubmitting(true);
    }
    let responseStatus: number | undefined;
    try {
      const idToken = liff.getIDToken();
      if (!idToken || !storeTokenRef.current) throw new Error("AUTH_UNAVAILABLE");
      let location = null;
      if (operation.kind === "punch") {
        const reader = locationReaderRef.current ?? createPunchLocationReader({ geolocation: navigator.geolocation });
        location = await measurePunchStage("location", () => reader.read());
        reader.clear();
        setPunchPhase("sending");
      }
      const response = await measurePunchStage("send", () => withAttendanceDeadline(signal => fetch(
        operation.kind === "punch" ? "/api/punch" : "/api/correction-requests", {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idToken, storeToken: storeTokenRef.current, clientRequestId: operation.clientRequestId,
            ...(operation.kind === "punch" ? { eventType: operation.eventType, expectedStateVersion: operation.expectedStateVersion, location } : operation.intent),
          }),
        },
      )));
      responseStatus = response.status;
    } catch { /* A timeout does not establish whether the write committed. */ }
    try {
      setPunchPhase("confirming");
      // Refresh all visible state together, including when the write succeeded but
      // the response body was truncated. No stale local history is appended.
      if (await refreshOperation(operation)) return;
      if (responseStatus !== undefined && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408 && responseStatus !== 429) {
        forgetOperation(operation);
        setNotice(operation.kind === "punch"
          ? "打刻は追加されていません。最新の勤務状態と履歴を確認してください。"
          : "修正を受け付けられませんでした。最新の記録を確認し、内容を見直してください。");
      } else {
        setNotice("送信結果を確認できませんでした。通信を確認して、結果を再確認してください。");
      }
    } catch {
      setNotice("送信結果を確認できませんでした。通信を確認して、結果を再確認してください。");
    } finally {
      punchInFlightRef.current = false;
      setSubmitting(null);
      setCorrectionSubmitting(false);
    }
  }

  function canCorrectLastPunch(membership: Membership) {
    return (
      membership.last_event_id !== null &&
      membership.last_event_at !== null &&
      membership.last_event_revision_id != null &&
      (membership.last_event_type === "CHECK_OUT" ||
        membership.last_event_type === "BREAK_START")
    );
  }

  function correctedLastEvent(membership: Membership): EventType | null {
    if (membership.last_event_type === "CHECK_OUT") return "BREAK_START";
    if (membership.last_event_type === "BREAK_START") return "CHECK_OUT";
    return null;
  }

  function openCorrectionForm() {
    if (view.kind !== "ready" || pendingOperationRef.current || punchInFlightRef.current) return;

    setCorrectionCategory(
      canCorrectLastPunch(view.membership) ? "MISTAKE" : "MISSED",
    );
    setCorrectionDate("");
    setCorrectionTime("");
    setCorrectionReason("");
    setCorrectionReview(false);
    setCorrectionError(null);
    setNotice(null);
    setShowCorrection(true);
  }

  function reviewCorrectionRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (view.kind !== "ready") return;

    if (
      correctionCategory === "MISTAKE" &&
      !canCorrectLastPunch(view.membership)
    ) {
      setCorrectionError(
        "前回の打刻は、この画面から種類を変更できません。",
      );
      return;
    }

    if (correctionCategory === "MISSED") {
      if (!correctionDate) {
        setCorrectionError("追加する打刻の日付を選択してください。");
        return;
      }

      if (!correctionTime) {
        setCorrectionError("追加する打刻の時刻を選択してください。");
        return;
      }
    }

    if (correctionCategory === "OTHER" && !correctionReason.trim()) {
      setCorrectionError(
        "管理者に確認してほしい内容を入力してください。",
      );
      return;
    }

    setCorrectionError(null);
    setCorrectionReview(true);
  }

  async function submitCorrectionRequest() {
    if (view.kind !== "ready" || punchInFlightRef.current || pendingOperationRef.current) return;
    const member = view.membership;
    let intent: CorrectionIntent;
    if (correctionCategory === "MISTAKE") {
      const eventType = correctedLastEvent(member);
      if (!canCorrectLastPunch(member) || (eventType !== "CHECK_OUT" && eventType !== "BREAK_START")) return;
      intent = { category: "MISTAKE", targetEventId: member.last_event_id!,
        expectedRevisionId: member.last_event_revision_id!, eventType };
    } else if (correctionCategory === "MISSED") {
      // Form fields are store-local wall time, independent of the device timezone.
      const date = new Date(correctionDate + "T" + correctionTime + ":00+09:00");
      if (!Number.isFinite(date.getTime())) {
        setCorrectionError("追加する打刻の日付と時刻を確認してください。");
        return;
      }
      intent = { category: "MISSED", eventType: correctionEvent, occurredAt: date.toISOString() };
    } else {
      intent = { category: "OTHER", reason: correctionReason.trim() };
    }
    await sendOperation({ kind: "correction", clientRequestId: crypto.randomUUID(),
      staffId: member.staff_id, storeId: member.store_id, intent });
  }

  async function submitPunch(eventType: EventType) {
    if (view.kind !== "ready" || punchInFlightRef.current || pendingOperationRef.current || showCorrection) return;
    const expectedStateVersion = view.membership.state_version;
    if (!expectedStateVersion) {
      setNotice("勤務情報を確認できませんでした。画面を読み込み直してください。");
      return;
    }
    await measurePunchStage("total", () => sendOperation({
      kind: "punch", clientRequestId: crypto.randomUUID(), eventType,
      staffId: view.membership.staff_id, storeId: view.membership.store_id,
      expectedStateVersion,
    }));
  }

  function closeApp() {
    if (liff.isInClient()) {
      liff.closeWindow();
      return;
    }

    window.close();
  }

  return (
    <main>
      <section className="card" aria-live="polite">
        <p className="eyebrow">ONOGAMI</p>
        <h1>勤怠</h1>

        {view.kind === "loading" && (
          <div className="message">
            <span className="spinner" aria-hidden="true" />
            <p>LINE認証を確認しています</p>
          </div>
        )}

        {view.kind === "store_required" && (
          <div className="message">
            <p className="status">店舗QRコードが必要です</p>
            <p className="note">{view.message}</p>
          </div>
        )}

        {view.kind === "unregistered" && (
          <div className="message">
            <p className="status">{view.storeName}へ初回登録</p>
            <p className="note">お名前を入力すると、この店舗で打刻できるようになります。</p>
            <form className="correction-form" onSubmit={selfRegister}>
              <label>
                お名前
                <input
                  type="text"
                  maxLength={100}
                  autoComplete="name"
                  value={registrationName}
                  onChange={(event) => {
                    setRegistrationName(event.target.value);
                    setRegistrationError(null);
                  }}
                />
              </label>
              {registrationError && <p className="correction-error" role="alert">{registrationError}</p>}
              <button className="correction-submit" type="submit" disabled={registrationSubmitting}>
                {registrationSubmitting ? "登録中…" : "この店舗に登録する"}
              </button>
            </form>
          </div>
        )}

        {view.kind === "active_store_conflict" && (
          <div className="message">
            <p className="status">別の店舗で勤務中です</p>
            <p className="note">
              現在{view.activeStore.store_name}で
              {view.activeStore.state === "ON_BREAK" ? "休憩中" : "勤務中"}です。
              {view.activeStore.store_name}で退勤してから
              {view.requestedStoreName}で出勤してください。
            </p>
          </div>
        )}

        {view.kind === "ready" && (
          <div className="message">
            {now && (
              <div className="clock" aria-label="現在時刻">
                <p className="clock-date">{formatDate(now)}</p>
                <p className="clock-time">{formatTime(now)}</p>
              </div>
            )}

            <p className="store">{view.membership.store_name}</p>
            <p className="status">{view.membership.legal_name}さん</p>
            <p className="state">{stateLabels[view.membership.state]}</p>

            {view.membership.last_event_at &&
              view.membership.last_event_type && (
                <p className="last-punch">
                  {formatTime(view.membership.last_event_at)} に
                  {eventLabels[view.membership.last_event_type]}
                </p>
              )}

            {pendingOperation && (
              <div className="operation-recovery" role="status">
                <p>{operationLabel(pendingOperation)}の送信結果が未確認です。</p>
                <p className="field-help">確認が終わるまで、別の打刻や訂正は行えません。再試行しても同じ操作は重複しません。</p>
                <div className="correction-actions">
                  <button className="correction-cancel" type="button"
                    disabled={submitting !== null || correctionSubmitting || recovering}
                    onClick={() => void checkPendingOperation()}>
                    {recovering ? "確認中…" : "結果を確認"}
                  </button>
                  <button className="correction-submit" type="button"
                    disabled={submitting !== null || correctionSubmitting || recovering}
                    onClick={() => void sendOperation(pendingOperation)}>
                    {submitting !== null || correctionSubmitting ? "送信中…" : "同じ内容で再試行"}
                  </button>
                </div>
              </div>
            )}
            {notice && <p className="punch-notice" role="status">{notice}</p>}

            <div className="punch-actions">
              {actionsByState[view.membership.state].map((eventType) => (
                <button
                  className={
                    eventType === "BREAK_START"
                      ? "punch-button punch-button-secondary"
                      : "punch-button"
                  }
                  type="button"
                  key={eventType}
                  disabled={submitting !== null || correctionSubmitting || recovering || pendingOperation !== null || showCorrection}
                  onClick={() => void submitPunch(eventType)}
                >
                  {submitting === eventType
                    ? punchPhase === "location" ? "位置情報を確認しています…"
                      : punchPhase === "sending" ? "打刻を送信しています…" : "記録を確認しています…"
                    : eventLabels[eventType]}
                </button>
              ))}
            </div>

            <details className="location-guide">
              <summary>
                位置情報は距離確認に使用します（取得できなくても打刻できます）
              </summary>
              <div className="location-guide-detail">
                <p>
                  店舗から離れている場合も打刻は記録されます。
                </p>
                <p>
                  管理者には不正の断定ではなく、確認の目安として表示されます。
                </p>
                <p>
                  位置情報を許可済みの場合は、この画面を開いた後に確認を始めます。
                  正確な位置情報は保存せず、確認結果だけを記録します。
                </p>
              </div>
            </details>


            {!showCorrection && (
              <button
                className="correction-link"
                type="button"
                disabled={submitting !== null || correctionSubmitting || recovering || pendingOperation !== null || showCorrection}
                onClick={openCorrectionForm}
              >
                打刻修正
              </button>
            )}

            {showCorrection && (
              <form
                className="correction-form"
                noValidate
                onSubmit={reviewCorrectionRequest}
              >
                <p className="correction-title">打刻修正</p>

                {!correctionReview ? (
                  <>
                    <label>
                      修正内容
                      <select
                        value={correctionCategory}
                        onChange={(event) => {
                          setCorrectionCategory(
                            event.target.value as
                              | "MISTAKE"
                              | "MISSED"
                              | "OTHER",
                          );
                          setCorrectionError(null);
                        }}
                      >
                        <option value="MISTAKE">
                          前回の打刻を押し間違えた
                        </option>
                        <option value="MISSED">打刻を押し忘れた</option>
                        <option value="OTHER">その他</option>
                      </select>
                    </label>

                    {correctionCategory === "MISTAKE" &&
                      view.membership.last_event_at &&
                      view.membership.last_event_type &&
                      correctedLastEvent(view.membership) && (
                        <div className="last-punch-correction">
                          <p>前回の打刻を次のように修正します。</p>
                          <div>
                            <span>
                              {formatTime(view.membership.last_event_at)}{" "}
                              {eventLabels[view.membership.last_event_type]}
                            </span>
                            <strong aria-hidden="true">→</strong>
                            <span>
                              {formatTime(view.membership.last_event_at)}{" "}
                              {
                                eventLabels[
                                  correctedLastEvent(
                                    view.membership,
                                  ) as EventType
                                ]
                              }
                            </span>
                          </div>
                        </div>
                      )}

                    {correctionCategory === "MISTAKE" &&
                      !canCorrectLastPunch(view.membership) && (
                        <p className="correction-error" role="alert">
                          前回の打刻は種類の押し間違いとして修正できません。
                          「打刻を押し忘れた」または「その他」を選択してください。
                        </p>
                      )}

                    {correctionCategory === "MISSED" && (
                      <>
                        <label>
                          追加する打刻
                          <select
                            value={correctionEvent}
                            onChange={(event) => {
                              setCorrectionEvent(
                                event.target.value as EventType,
                              );
                              setCorrectionError(null);
                            }}
                          >
                            <option value="CHECK_IN">出勤</option>
                            <option value="BREAK_START">休憩開始</option>
                            <option value="BREAK_END">休憩終了</option>
                            <option value="CHECK_OUT">退勤</option>
                          </select>
                        </label>

                        <div className="correction-date-time">
                          <label>
                            日付
                            <input
                              type="date"
                              value={correctionDate}
                              onChange={(event) => {
                                setCorrectionDate(event.target.value);
                                setCorrectionError(null);
                              }}
                            />
                          </label>
                          <label>
                            時刻
                            <input
                              type="time"
                              step="60"
                              value={correctionTime}
                              onChange={(event) => {
                                setCorrectionTime(event.target.value);
                                setCorrectionError(null);
                              }}
                            />
                          </label>
                        </div>
                      </>
                    )}

                    {correctionCategory === "OTHER" && (
                      <label>
                        管理者に確認してほしい内容
                        <span className="field-help">
                          どの記録をどのように直したいか入力してください。
                        </span>
                        <textarea
                          maxLength={500}
                          rows={4}
                          placeholder="例：休憩終了の時刻が分からないため確認してほしい"
                          value={correctionReason}
                          onChange={(event) => {
                            setCorrectionReason(event.target.value);
                            setCorrectionError(null);
                          }}
                        />
                      </label>
                    )}

                    {correctionError && (
                      <p className="correction-error" role="alert">
                        {correctionError}
                      </p>
                    )}

                    <div className="correction-actions">
                      <button
                        className="correction-cancel"
                        type="button"
                        onClick={() => setShowCorrection(false)}
                      >
                        キャンセル
                      </button>
                      <button className="correction-submit" type="submit">
                        内容を確認
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="correction-review">
                      <p>以下の内容で申請します。</p>
                      <dl>
                        <div>
                          <dt>内容</dt>
                          <dd>
                            {correctionCategory === "MISTAKE"
                              ? "前回の打刻を押し間違えた"
                              : correctionCategory === "MISSED"
                                ? "打刻を押し忘れた"
                                : "その他"}
                          </dd>
                        </div>
                        {correctionCategory === "MISTAKE" &&
                          view.membership.last_event_at &&
                          view.membership.last_event_type &&
                          correctedLastEvent(view.membership) && (
                            <div>
                              <dt>修正</dt>
                              <dd>
                                {formatTime(view.membership.last_event_at)}{" "}
                                {eventLabels[view.membership.last_event_type]}
                                {" → "}
                                {
                                  eventLabels[
                                    correctedLastEvent(
                                      view.membership,
                                    ) as EventType
                                  ]
                                }
                              </dd>
                            </div>
                          )}
                        {correctionCategory === "MISSED" && (
                          <>
                            <div>
                              <dt>種類</dt>
                              <dd>{eventLabels[correctionEvent]}</dd>
                            </div>
                            <div>
                              <dt>日時</dt>
                              <dd>
                                {correctionDate.replaceAll("-", "/")}{" "}
                                {correctionTime}
                              </dd>
                            </div>
                          </>
                        )}
                        {correctionCategory === "OTHER" && (
                          <div>
                            <dt>内容</dt>
                            <dd>{correctionReason.trim()}</dd>
                          </div>
                        )}
                      </dl>
                    </div>

                    {correctionError && (
                      <p className="correction-error" role="alert">
                        {correctionError}
                      </p>
                    )}

                    <div className="correction-actions">
                      <button
                        className="correction-cancel"
                        type="button"
                        disabled={correctionSubmitting}
                        onClick={() => {
                          setCorrectionReview(false);
                          setCorrectionError(null);
                        }}
                      >
                        入力に戻る
                      </button>
                      <button
                        className="correction-submit"
                        type="button"
                        disabled={correctionSubmitting}
                        onClick={() => void submitCorrectionRequest()}
                      >
                        {correctionSubmitting ? "送信中…" : "この内容で申請"}
                      </button>
                    </div>
                  </>
                )}
              </form>
            )}

            <button
              className="close-app-button"
              type="button"
              disabled={submitting !== null || correctionSubmitting}
              onClick={closeApp}
            >
              打刻画面を閉じる
            </button>

            <div className="punch-history">
              <p className="punch-history-title">本日の打刻履歴</p>
              {view.membership.recent_punches.length > 0 ? (
                <ol>
                  {view.membership.recent_punches.map((punch) => (
                    <li key={punch.effective_id}>
                      <time dateTime={punch.occurred_at}>
                        {formatTime(punch.occurred_at)}
                      </time>
                      <span>{eventLabels[punch.event_type]}</span>
                      {punch.corrected && <small>修正済み</small>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="punch-history-empty">本日の打刻はありません</p>
              )}
            </div>

          </div>
        )}

        {view.kind === "error" && (
          <div className="message">
            <p className="status">接続を確認してください</p>
            <p className="note">{view.message}</p>
          </div>
        )}
      </section>
    </main>
  );
}

