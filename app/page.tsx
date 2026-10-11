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
import { correctionValidationMessage } from "@/lib/correction-validation";

const LIFF_ID = process.env.NEXT_PUBLIC_ATTENDANCE_LIFF_ID || "2010761826-6FNSE1PD";

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
  | { kind: "login_required"; message?: string }
  | { kind: "line_auth_error" }
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

function correctionDateShortcut(daysAgo: number) {
  // These are calendar dates in Japan, not the device's date or a business day.
  return new Date(Date.now() + (9 - daysAgo * 24) * 60 * 60 * 1000).toISOString().slice(0, 10);
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
  if (operation.intent.category === "MISSED_BREAK") return "休憩開始・終了の申請";
  return "打刻修正の申請";
}

function operationNotice(operation: PendingOperation, result: OperationResult) {
  if (operation.kind === "punch") {
    return (result.occurred_at ? formatTime(result.occurred_at) + "の" : "")
      + eventLabels[result.event_type ?? operation.eventType] + "を記録しました";
  }
  if (result.status === "PENDING") return "打刻修正を申請しました（承認待ち）";
  if (result.status === "REJECTED") return "この修正申請は却下されています。現在の記録を確認してください。";
  return "打刻修正が反映されています。現在の記録を表示しています。";
}

function locationExplanation(result: OperationResult) {
  if (result.location_status === "OK") return "店舗の範囲内を確認しました。";
  switch (result.validation_code) {
    case "STORE_LOCATION_UNAVAILABLE": return "店舗の位置が未設定のため、距離は確認していません。";
    case "CLIENT_LOCATION_UNAVAILABLE": return "端末の位置情報を取得できませんでした。";
    case "LOW_GPS_ACCURACY": return "位置情報の精度が低いため、距離は確認できませんでした。";
    case "OUTSIDE_STORE_RADIUS": return "店舗の範囲外として記録しました。";
    default: return "位置情報による確認はできませんでした。";
  }
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
    useState<EventType | "BREAK_PAIR">("CHECK_IN");
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
  const [locationNotice, setLocationNotice] = useState<string | null>(null);
  const [correctionEndDate, setCorrectionEndDate] = useState("");
  const [correctionEndTime, setCorrectionEndTime] = useState("");
  const [correctionValidating, setCorrectionValidating] = useState(false);
  const [correctionCode, setCorrectionCode] = useState<string | null>(null);
  const reviewedIntentRef = useRef<CorrectionIntent | null>(null);
  const correctionValidationRef = useRef({ sequence: 0, pending: false });
  const correctionEventSelectRef = useRef<HTMLSelectElement | null>(null);
  const rejectedCorrectionRef = useRef<{ clientRequestId: string; code: unknown } | null>(null);
  const readyForPunch = view.kind === "ready";
  const correctionLocked = submitting !== null || correctionSubmitting || recovering || pendingOperation !== null;

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
        if (!active) return;
        const storeToken = new URLSearchParams(window.location.search).get("store_token");
        if (!storeToken) {
          if (active) setView({ kind: "store_required", message: "店舗に設置されたQRコードから開いてください。" });
          return;
        }
        storeTokenRef.current = storeToken;
        if (!liff.isLoggedIn()) {
          setView({ kind: liff.isInClient() ? "line_auth_error" : "login_required" });
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
                if (pending.kind === "punch") setLocationNotice(locationExplanation(session.result));
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

  function beginLineLogin() {
    if (view.kind !== "login_required") return;
    if (liff.isInClient()) {
      setView({ kind: "line_auth_error" });
      return;
    }
    try {
      const redirectUri = new URL("/liff-entry", window.location.href);
      if (storeTokenRef.current) redirectUri.searchParams.set("store_token", storeTokenRef.current);
      // Keep login directly inside the user's tap; init already completed.
      liff.login({ redirectUri: redirectUri.toString() });
    } catch {
      setView({ kind: "login_required", message: "LINEのログイン画面を開けませんでした。もう一度お試しください。" });
    }
  }

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
    rejectedCorrectionRef.current = null;
  }

  function finishRejectedCorrection(operation: PendingOperation) {
    const rejected = rejectedCorrectionRef.current;
    if (operation.kind !== "correction" || rejected?.clientRequestId !== operation.clientRequestId) return false;
    forgetOperation(operation);
    restoreCorrectionIntent(operation.intent);
    setCorrectionCode(typeof rejected.code === "string" ? rejected.code : null);
    setCorrectionError("申請は追加されていません。" + (correctionValidationMessage(rejected.code)
      ?? "最新の記録を確認し、内容を見直してください。"));
    return true;
  }

  async function refreshOperation(operation: PendingOperation) {
    const session = await loadStaffSession(storeTokenRef.current!, operation);
    setView(session.view);
    if (session.result) {
      forgetOperation(operation);
      setShowCorrection(false);
      setNotice(operationNotice(operation, session.result));
      if (operation.kind === "punch") setLocationNotice(locationExplanation(session.result));
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
        if (!finishRejectedCorrection(operation)) setNotice("まだ完了を確認できません。同じ内容で再試行できます。");
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
    rejectedCorrectionRef.current = null;
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
    let responseCode: unknown;
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
      const response = await measurePunchStage("send", () => withAttendanceDeadline(async signal => {
        const response = await fetch(operation.kind === "punch" ? "/api/punch" : "/api/correction-requests", {
          method: "POST", signal, headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            idToken, storeToken: storeTokenRef.current, clientRequestId: operation.clientRequestId,
            ...(operation.kind === "punch" ? { eventType: operation.eventType, expectedStateVersion: operation.expectedStateVersion, location } : operation.intent),
          }),
        });
        responseStatus = response.status;
        if (operation.kind === "correction" && !response.ok) {
          const data = await response.json();
          responseCode = data?.code;
        }
        return response;
      }));
      responseStatus = response.status;
    } catch { /* A timeout does not establish whether the write committed. */ }
    const terminalFailure = responseStatus !== undefined && responseStatus >= 400 && responseStatus < 500 && responseStatus !== 408 && responseStatus !== 429;
    if (operation.kind === "correction" && terminalFailure) {
      // Preserve a known rejection while result lookup is unavailable. A later
      // lookup must still establish that no saved result exists before editing.
      rejectedCorrectionRef.current = { clientRequestId: operation.clientRequestId, code: responseCode };
    }
    try {
      setPunchPhase("confirming");
      // Refresh all visible state together, including when the write succeeded but
      // the response body was truncated. No stale local history is appended.
      if (await refreshOperation(operation)) return;
      if (terminalFailure) {
        if (!finishRejectedCorrection(operation)) {
          forgetOperation(operation);
          setNotice("打刻は追加されていません。最新の勤務状態と履歴を確認してください。");
        }
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

    invalidateCorrectionValidation();
    setCorrectionCategory("MISTAKE");
    setCorrectionEvent("CHECK_IN");
    setCorrectionDate("");
    setCorrectionTime("");
    setCorrectionEndDate("");
    setCorrectionEndTime("");
    setCorrectionReason("");
    setCorrectionReview(false);
    setCorrectionError(null);
    setCorrectionCode(null);
    setNotice(null);
    setShowCorrection(true);
  }

  function invalidateCorrectionValidation() {
    correctionValidationRef.current.sequence += 1;
    correctionValidationRef.current.pending = false;
    setCorrectionValidating(false);
    reviewedIntentRef.current = null;
  }

  function changeCorrectionInput(update: () => void) {
    if (correctionValidationRef.current.pending || punchInFlightRef.current || pendingOperationRef.current) return;
    update();
    reviewedIntentRef.current = null;
    setCorrectionError(null);
    setCorrectionCode(null);
  }

  function restoreCorrectionIntent(intent: CorrectionIntent) {
    invalidateCorrectionValidation();
    setCorrectionCategory(intent.category === "MISSED_BREAK" ? "MISSED" : intent.category);
    setCorrectionReview(false);
    setShowCorrection(true);
    if (intent.category === "MISSED" || intent.category === "MISSED_BREAK") {
      const start = new Date(Date.parse(intent.occurredAt) + 9 * 60 * 60 * 1000).toISOString();
      setCorrectionEvent(intent.category === "MISSED_BREAK" ? "BREAK_PAIR" : intent.eventType);
      setCorrectionDate(start.slice(0, 10));
      setCorrectionTime(start.slice(11, 16));
      const end = intent.category === "MISSED_BREAK"
        ? new Date(Date.parse(intent.breakEndedAt) + 9 * 60 * 60 * 1000).toISOString() : "";
      setCorrectionEndDate(end.slice(0, 10));
      setCorrectionEndTime(end.slice(11, 16));
    } else if (intent.category === "OTHER") {
      setCorrectionReason(intent.reason);
    }
  }

  function cancelCorrectionForm() {
    if (punchInFlightRef.current || pendingOperationRef.current) return;
    invalidateCorrectionValidation();
    setShowCorrection(false);
    setCorrectionReview(false);
    setCorrectionError(null);
    setCorrectionCode(null);
  }

  function correctionIntentFromInput(): CorrectionIntent | null {
    if (view.kind !== "ready") return null;
    if (correctionCategory === "MISTAKE") {
      const eventType = correctedLastEvent(view.membership);
      if (!canCorrectLastPunch(view.membership) || (eventType !== "CHECK_OUT" && eventType !== "BREAK_START")) {
        setCorrectionError("前回の打刻は、この画面から種類を変更できません。");
        return null;
      }
      return { category: "MISTAKE", targetEventId: view.membership.last_event_id!,
        expectedRevisionId: view.membership.last_event_revision_id!, eventType };
    }
    if (correctionCategory === "MISSED") {
      if (!correctionDate) {
        setCorrectionError("追加する打刻の日付を選択してください。");
        return null;
      }
      if (!correctionTime) {
        setCorrectionError("追加する打刻の時刻を選択してください。");
        return null;
      }
      // Inputs are Japan wall time, regardless of the device's timezone.
      const start = new Date(correctionDate + "T" + correctionTime + ":00+09:00");
      if (!Number.isFinite(start.getTime())) {
        setCorrectionError("追加する打刻の日付と時刻を確認してください。");
        return null;
      }
      if (correctionEvent === "BREAK_PAIR") {
        if (!correctionEndDate || !correctionEndTime) {
          setCorrectionError("休憩終了の日付と実際の時刻を入力してください。");
          return null;
        }
        const end = new Date(correctionEndDate + "T" + correctionEndTime + ":00+09:00");
        if (!Number.isFinite(end.getTime()) || end.getTime() <= start.getTime()) {
          setCorrectionError("休憩終了は、休憩開始より後の日時を指定してください。");
          return null;
        }
        return { category: "MISSED_BREAK", eventType: "BREAK_START", occurredAt: start.toISOString(), breakEndedAt: end.toISOString() };
      }
      return { category: "MISSED", eventType: correctionEvent, occurredAt: start.toISOString() };
    }
    if (!correctionReason.trim()) {
      setCorrectionError("管理者に確認してほしい内容を入力してください。");
      return null;
    }
    return { category: "OTHER", reason: correctionReason.trim() };
  }

  async function reviewCorrectionRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (view.kind !== "ready" || correctionValidationRef.current.pending || punchInFlightRef.current || pendingOperationRef.current) return;
    const intent = correctionIntentFromInput();
    if (!intent) return;
    setCorrectionError(null);
    setCorrectionCode(null);
    if (intent.category === "MISSED" || intent.category === "MISSED_BREAK") {
      const idToken = liff.getIDToken(), storeToken = storeTokenRef.current;
      if (!idToken || !storeToken) {
        setCorrectionError("LINEの認証情報を取得できませんでした。");
        return;
      }
      const sequence = ++correctionValidationRef.current.sequence;
      correctionValidationRef.current.pending = true;
      setCorrectionValidating(true);
      try {
        const { response, data } = await withAttendanceDeadline(async signal => {
          const response = await fetch("/api/correction-requests/validate", {
            method: "POST", signal, headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ idToken, storeToken, ...intent }),
          });
          const data = await response.json() as { ok: boolean; code?: string };
          return { response, data };
        });
        if (sequence !== correctionValidationRef.current.sequence) return;
        if (!response.ok || !data.ok) {
          setCorrectionCode(data.code ?? null);
          setCorrectionError(correctionValidationMessage(data.code) ?? "内容を確認できませんでした。まだ申請は送信していません。もう一度お試しください。");
          return;
        }
      } catch {
        if (sequence === correctionValidationRef.current.sequence) {
          setCorrectionError("内容を確認できませんでした。まだ申請は送信していません。通信を確認して、もう一度お試しください。");
        }
        return;
      } finally {
        if (sequence === correctionValidationRef.current.sequence) {
          correctionValidationRef.current.pending = false;
          setCorrectionValidating(false);
        }
      }
    }
    reviewedIntentRef.current = intent;
    setCorrectionReview(true);
  }

  async function submitCorrectionRequest() {
    const intent = reviewedIntentRef.current;
    if (view.kind !== "ready" || punchInFlightRef.current || pendingOperationRef.current || !intent) return;
    const member = view.membership;
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
    <main className="attendance-screen">
      <section className="card" aria-live="polite">
        <header className="attendance-header">
          <p className="eyebrow">ONOGAMI</p>
          <h1>勤怠</h1>
        </header>

        {view.kind === "loading" && (
          <div className="message">
            <span className="spinner" aria-hidden="true" />
            <p>LINE認証を確認しています</p>
          </div>
        )}

        {view.kind === "login_required" && (
          <div className="message">
            <p className="status">LINEで本人確認</p>
            <p className="note">ログインすると、打刻画面に進みます。</p>
            <div className="punch-actions">
              <button className="punch-button" type="button" onClick={beginLineLogin}>
                LINEでログイン
              </button>
            </div>
            <p className="note">LINEが開かない場合は、Safari／Chromeでこのページを開き直してください。</p>
            {view.message && <p className="correction-error" role="alert">{view.message}</p>}
          </div>
        )}

        {view.kind === "line_auth_error" && (
          <div className="message">
            <p className="status">LINEの認証を確認できませんでした</p>
            <p className="note">この画面を閉じて、店舗のQRコードを読み直してください。</p>
            <button className="close-app-button" type="button" onClick={closeApp}>
              画面を閉じる
            </button>
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

            <p className="last-punch">
              {view.membership.last_event_at && view.membership.last_event_type && (
                <>
                  {formatTime(view.membership.last_event_at)} に
                  {eventLabels[view.membership.last_event_type]}
                </>
              )}
            </p>

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
                    ? punchPhase === "location" ? "位置確認中…"
                      : punchPhase === "sending" ? "送信中…" : "確認中…"
                    : eventLabels[eventType]}
                </button>
              ))}
            </div>

            <div className="punch-feedback" role="status">
              {correctionSubmitting
                ? <p className="punch-notice">修正申請を送信・確認しています…</p>
                : notice && <p className="punch-notice">{notice}</p>}
            </div>
            {pendingOperation && submitting === null && !correctionSubmitting && (
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


            <details className="location-guide">
              <summary>
                位置情報なしでも打刻できます
              </summary>
              <div className="location-guide-detail">
                {locationNotice && <p>直前の位置確認：{locationNotice}</p>}
                <p>
                  位置情報は距離確認に使用します。許可しない場合や取得できない場合、店舗から離れている場合も、打刻は記録されます。
                </p>
                <p>
                  正確な位置情報は保存しません。管理者には不正の断定ではなく、確認の目安として結果だけを表示します。許可済みの場合は画面を開くと確認を始めます。
                </p>
              </div>
            </details>


            {!showCorrection && <div className="attendance-tools">
              <button
                className="correction-link"
                type="button"
                disabled={submitting !== null || correctionSubmitting || recovering || pendingOperation !== null || showCorrection}
                onClick={openCorrectionForm}
              >
                打刻修正
              </button>
            </div>}

            {showCorrection && (
              <form
                className="correction-form"
                noValidate
                onSubmit={reviewCorrectionRequest}
              >
                <div className="correction-header">
                  <p className="correction-title">打刻修正</p>
                  <button
                    className="correction-cancel"
                    type="button"
                    disabled={correctionLocked}
                    onClick={cancelCorrectionForm}
                  >
                    キャンセル
                  </button>
                </div>

                {!correctionReview ? (
                  <fieldset className="correction-inputs" disabled={correctionValidating} aria-busy={correctionValidating}>
                    <label>
                      修正内容
                      <select
                        value={correctionCategory}
                        onChange={(event) => changeCorrectionInput(() => {
                          setCorrectionCategory(
                            event.target.value as
                              | "MISTAKE"
                              | "MISSED"
                              | "OTHER",
                          );
                        })}
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
                        <p className="field-help">
                          記録が抜けた打刻を追加申請します。実際の日付と時刻を指定してください。管理者の承認後に反映されます。
                        </p>
                        <label>
                          追加する打刻
                          <select
                            ref={correctionEventSelectRef}
                            value={correctionEvent}
                            onChange={(event) => changeCorrectionInput(() => {
                              const next = event.target.value as EventType | "BREAK_PAIR";
                              if ((next === "BREAK_PAIR") !== (correctionEvent === "BREAK_PAIR")) {
                                setCorrectionDate("");
                                setCorrectionTime("");
                                setCorrectionEndDate("");
                                setCorrectionEndTime("");
                              }
                              setCorrectionEvent(next);
                            })}
                          >
                            <option value="CHECK_IN">出勤</option>
                            <option value="BREAK_START">休憩開始</option>
                            <option value="BREAK_END">休憩終了</option>
                            <option value="CHECK_OUT">退勤</option>
                            <option value="BREAK_PAIR">休憩開始・終了の両方</option>
                          </select>
                        </label>

                        <div className="correction-date-time">
                          <div className="correction-date-field">
                            <label>
                              {correctionEvent === "BREAK_PAIR" ? "休憩開始の日付" : "日付"}
                              <input
                                type="date"
                                value={correctionDate}
                                onChange={(event) => changeCorrectionInput(() => {
                                  setCorrectionDate(event.target.value);
                                })}
                              />
                            </label>
                            <div className="correction-date-shortcuts" role="group" aria-label={correctionEvent === "BREAK_PAIR" ? "休憩開始の日付の入力補助" : "日付の入力補助"}>
                              <button type="button" onClick={() => changeCorrectionInput(() => {
                                setCorrectionDate(correctionDateShortcut(0));
                              })}>今日</button>
                              <button type="button" onClick={() => changeCorrectionInput(() => {
                                setCorrectionDate(correctionDateShortcut(1));
                              })}>昨日</button>
                            </div>
                          </div>
                          <label>
                            {correctionEvent === "BREAK_PAIR" ? "開始の実際の時刻" : "実際の時刻"}
                            <input
                              type="time"
                              step="60"
                              value={correctionTime}
                              onChange={(event) => changeCorrectionInput(() => {
                                setCorrectionTime(event.target.value);
                              })}
                            />
                          </label>
                        </div>
                        {correctionEvent === "BREAK_PAIR" && (
                          <div className="correction-date-time">
                            <div className="correction-date-field">
                              <label>
                                休憩終了の日付
                                <input type="date" value={correctionEndDate} onChange={(event) => changeCorrectionInput(() => {
                                  setCorrectionEndDate(event.target.value);
                                })} />
                              </label>
                              <div className="correction-date-shortcuts" role="group" aria-label="休憩終了の日付の入力補助">
                                <button type="button" onClick={() => changeCorrectionInput(() => {
                                  setCorrectionEndDate(correctionDateShortcut(0));
                                })}>今日</button>
                                <button type="button" onClick={() => changeCorrectionInput(() => {
                                  setCorrectionEndDate(correctionDateShortcut(1));
                                })}>昨日</button>
                              </div>
                            </div>
                            <label>
                              終了の実際の時刻
                              <input type="time" step="60" value={correctionEndTime} onChange={(event) => changeCorrectionInput(() => {
                                setCorrectionEndTime(event.target.value);
                              })} />
                            </label>
                          </div>
                        )}
                        <p className="field-help">時刻が分からない場合は「その他」から確認を依頼できます。</p>
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
                          onChange={(event) => changeCorrectionInput(() => {
                            setCorrectionReason(event.target.value);
                          })}
                        />
                      </label>
                    )}

                    {correctionError && (
                      <p className="correction-error" role="alert">
                        {correctionError}
                      </p>
                    )}

                    {correctionCode === "CORRECTION_BREAK_START_REQUIRED" && correctionCategory === "MISSED" && correctionEvent === "BREAK_END" && (
                      <div className="correction-alternatives">
                        <button type="button" onClick={() => changeCorrectionInput(() => {
                          // Keep the explicitly entered end, but never infer the missing start.
                          setCorrectionEndDate(correctionDate);
                          setCorrectionEndTime(correctionTime);
                          setCorrectionDate("");
                          setCorrectionTime("");
                          setCorrectionEvent("BREAK_PAIR");
                        })}>開始・終了をまとめて申請</button>
                        <button type="button" onClick={() => changeCorrectionInput(() => {
                          correctionEventSelectRef.current?.focus();
                        })}>種類を選び直す</button>
                        <button type="button" onClick={() => changeCorrectionInput(() => {
                          setCorrectionCategory("OTHER");
                        })}>時刻が分からないので相談</button>
                      </div>
                    )}

                    <div className="correction-actions">
                      <button className="correction-submit" type="submit" disabled={correctionLocked || correctionValidating}>
                        {correctionValidating ? "前後の打刻を確認中…" : "内容を確認"}
                      </button>
                    </div>
                  </fieldset>
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
                              <dd>{correctionEvent === "BREAK_PAIR" ? "休憩開始・終了の両方" : eventLabels[correctionEvent]}</dd>
                            </div>
                            <div>
                              <dt>{correctionEvent === "BREAK_PAIR" ? "休憩開始" : "日時"}</dt>
                              <dd>
                                {correctionDate.replaceAll("-", "/")}{" "}
                                {correctionTime}
                              </dd>
                            </div>
                            {correctionEvent === "BREAK_PAIR" && (
                              <div>
                                <dt>休憩終了</dt>
                                <dd>{correctionEndDate.replaceAll("-", "/")} {correctionEndTime}</dd>
                              </div>
                            )}
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
                        disabled={correctionLocked}
                        onClick={() => {
                          if (punchInFlightRef.current || pendingOperationRef.current) return;
                          invalidateCorrectionValidation();
                          setCorrectionReview(false);
                          setCorrectionError(null);
                        }}
                      >
                        入力に戻る
                      </button>
                      <button
                        className="correction-submit"
                        type="button"
                        disabled={correctionLocked}
                        onClick={() => void submitCorrectionRequest()}
                      >
                        {correctionSubmitting ? "送信中…" : "この内容で申請"}
                      </button>
                    </div>
                  </>
                )}
              </form>
            )}

            <details className="punch-history">
              <summary className="punch-history-title">本日の打刻履歴</summary>
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
            </details>

            {!showCorrection && (
              <div className="attendance-exit">
                <button
                  className="close-app-button"
                  type="button"
                  disabled={correctionLocked}
                  onClick={closeApp}
                >
                  打刻画面を閉じる
                </button>
              </div>
            )}

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

