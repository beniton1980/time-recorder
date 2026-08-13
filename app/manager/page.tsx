"use client";

import liff from "@line/liff";
import { useCallback, useEffect, useState } from "react";
import styles from "./manager.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_QR_LIFF_URL = `https://liff.line.me/${LIFF_ID}/manager/qr`;

type WorkState = "OFF_DUTY" | "WORKING" | "ON_BREAK";
type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";

type Attendance = {
  staff_id: string;
  legal_name: string;
  state: WorkState;
  current_state: WorkState;
  active_since: string | null;
  carried_over_active: boolean;
  last_event_type: EventType | null;
  last_event_at: string | null;
  punch_count: number;
  day_events: DayEvent[];
};

type DayEvent = {
  effective_id: string;
  original_event_id: string | null;
  correction_request_id: string | null;
  origin_correction_id: string | null;
  event_type: EventType;
  occurred_at: string;
  corrected: boolean;
};

type Correction = {
  id: string;
  operation: "ADD" | "REPLACE" | "VOID" | "REVIEW";
  requested_event_type: EventType | null;
  requested_occurred_at: string | null;
  reason: string | null;
  requested_at: string;
  legal_name: string;
  target_event_type: EventType | null;
  target_occurred_at: string | null;
  day_events: DayEvent[];
};

type Dashboard = {
  manager: {
    legal_name: string;
    store_id: string;
    store_name: string;
  };
  attendance: Attendance[];
  corrections: Correction[];
  staffMemberships: StaffMembership[];
  businessDate: string;
};

type ManagerMembership = {
  store_id: string;
  store_name: string;
};

type MonthlyReport = {
  period_start: string;
  period_end: string;
  sent_at: string;
  reissue_count: number;
};

type StaffMembership = {
  staff_id: string;
  legal_name: string;
  status: "active" | "inactive";
  state: WorkState;
};

type DirectEdit = {
  staffId: string;
  staffName: string;
  operation: "ADD" | "REPLACE" | "VOID";
  targetEffectiveId?: string;
  eventType: EventType;
  date: string;
  time: string;
  reason: string;
};

type ReviewDraft = {
  eventType: EventType;
  date: string;
  time: string;
};

const stateLabels: Record<WorkState, string> = {
  OFF_DUTY: "勤務前・退勤済み",
  WORKING: "勤務中",
  ON_BREAK: "休憩中",
};

const eventLabels: Record<EventType, string> = {
  CHECK_IN: "出勤",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  CHECK_OUT: "退勤",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function inputParts(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hour12: false,
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

async function dismissKeyboard() {
  if (document.activeElement instanceof HTMLElement) {
    document.activeElement.blur();
    await new Promise<void>((resolve) => window.setTimeout(resolve, 180));
  }
}

function currentBusinessDate() {
  return inputParts(new Date().toISOString()).date;
}

export default function ManagerPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [managerMemberships, setManagerMemberships] = useState<ManagerMembership[]>([]);
  const [switchingStore, setSwitchingStore] = useState(false);
  const [message, setMessage] = useState("管理者権限を確認しています");
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const [directEdit, setDirectEdit] = useState<DirectEdit | null>(null);
  const [directSubmitting, setDirectSubmitting] = useState(false);
  const [directError, setDirectError] = useState<string | null>(null);
  const [selectedDate, setSelectedDate] = useState(currentBusinessDate);
  const [selectedStaffId, setSelectedStaffId] = useState("ALL");
  const [updatingStaffId, setUpdatingStaffId] = useState<string | null>(null);
  const [monthlyReports, setMonthlyReports] = useState<MonthlyReport[]>([]);
  const [reissuingPeriod, setReissuingPeriod] = useState<string | null>(null);
  const [reissueMessage, setReissueMessage] = useState<string | null>(null);
  const [exportingPeriod, setExportingPeriod] = useState<string | null>(null);

  const loadDashboard = useCallback(async (businessDate?: string, requestedStoreId?: string) => {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");

    const storeId = requestedStoreId
      ?? new URLSearchParams(window.location.search).get("store_id");
    const response = await fetch("/api/manager/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, businessDate, storeId: storeId ?? undefined }),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      if (data.code === "MANAGER_ACCESS_REQUIRED") {
        throw new Error("この画面を利用できる管理者権限がありません。");
      }
      throw new Error("管理者画面を読み込めませんでした。");
    }

    setDashboard(data as Dashboard);
    setSelectedDate(data.businessDate as string);
    setMessage("");
    return data as Dashboard;
  }, []);

  const loadManagerMemberships = useCallback(async () => {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/session", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      throw new Error("管理者権限を確認できませんでした。");
    }
    const memberships = data.manager.memberships as ManagerMembership[];
    setManagerMemberships(memberships);
    return memberships;
  }, []);

  const loadMonthlyReports = useCallback(async (storeId: string) => {
    const idToken = liff.getIDToken();
    if (!idToken) return;
    const response = await fetch("/api/manager/monthly-attendance/reports", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, storeId }),
    });
    const data = await response.json();
    if (response.ok && data.ok) setMonthlyReports(data.reports as MonthlyReport[]);
  }, []);

  useEffect(() => {
    let active = true;

    async function start() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        if (active) {
          const memberships = await loadManagerMemberships();
          const requestedStoreId = new URLSearchParams(window.location.search)
            .get("store_id");
          const initialStoreId = memberships.find(
            (item) => item.store_id === requestedStoreId,
          )?.store_id ?? memberships[0]?.store_id;
          const loadedDashboard = await loadDashboard(selectedDate, initialStoreId);
          await loadMonthlyReports(loadedDashboard.manager.store_id);
        }
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "管理者画面を読み込めませんでした。");
        }
      }
    }

    void start();
    return () => {
      active = false;
    };
  }, [loadDashboard, loadManagerMemberships, loadMonthlyReports, selectedDate]);

  async function changeStore(storeId: string) {
    if (!dashboard || storeId === dashboard.manager.store_id) return;
    setSwitchingStore(true);
    setError(null);
    setSelectedStaffId("ALL");
    setMonthlyReports([]);
    setReissueMessage(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("store_id", storeId);
      window.history.replaceState(null, "", url);
      const loadedDashboard = await loadDashboard(undefined, storeId);
      await loadMonthlyReports(loadedDashboard.manager.store_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "店舗を切り替えられませんでした。");
    } finally {
      setSwitchingStore(false);
    }
  }

  function updateReviewDraft(id: string, values: Partial<ReviewDraft>) {
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setReviewDrafts((current) => ({
      ...current,
      [id]: {
        eventType: current[id]?.eventType ?? "CHECK_IN",
        date: current[id]?.date ?? "",
        time: current[id]?.time ?? "",
        ...values,
      },
    }));
  }

  function openDirectEdit(
    staff: Attendance,
    operation: "ADD" | "REPLACE" | "VOID",
    target?: DayEvent,
  ) {
    const currentParts = inputParts(new Date().toISOString());
    const parts = target
      ? inputParts(target.occurred_at)
      : { date: selectedDate, time: currentParts.time };
    setDirectEdit({
      staffId: staff.staff_id,
      staffName: staff.legal_name,
      operation,
      targetEffectiveId: target?.effective_id,
      eventType: target?.event_type ?? "CHECK_IN",
      date: parts.date,
      time: parts.time,
      reason: "",
    });
    setError(null);
    setDirectError(null);
  }

  async function submitDirectEdit() {
    if (!directEdit || !directEdit.reason.trim()) {
      setDirectError("管理者による修正理由を入力してください。");
      return;
    }
    await dismissKeyboard();
    if (!window.confirm(`${directEdit.staffName}さんの打刻履歴を修正しますか？`)) return;

    setDirectSubmitting(true);
    setError(null);
    setDirectError(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/punch-corrections", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard?.manager.store_id,
          staffId: directEdit.staffId,
          operation: directEdit.operation,
          targetEffectiveId: directEdit.targetEffectiveId,
          eventType: directEdit.operation === "VOID" ? undefined : directEdit.eventType,
          occurredAt:
            directEdit.operation === "VOID"
              ? undefined
              : new Date(`${directEdit.date}T${directEdit.time}`).toISOString(),
          reason: directEdit.reason.trim(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.code === "DUPLICATE_PUNCH_TIME") {
          throw new Error("同じ時刻の打刻が既にあります。時刻を確認してください。");
        }
        if (data.code === "INVALID_PUNCH_SEQUENCE") {
          throw new Error("この修正では打刻の順序が正しくなりません。履歴を確認してください。");
        }
        const messages: Record<string, string> = {
          TARGET_NOT_FOUND: "選択した打刻が最新の履歴に見つかりません。画面を更新してください。",
          INVALID_PUNCH_SEQUENCE: "この修正では打刻の順序が正しくなりません。履歴を確認してください。",
          DUPLICATE_PUNCH_TIME: "同じ時刻の打刻が既にあります。時刻を確認してください。",
          REQUEST_NOT_PENDING: "この申請は既に処理されています。",
        };
        throw new Error(messages[data.code] ?? `打刻履歴を修正できませんでした（${data.code ?? "不明なエラー"}）`);
      }
      setDirectEdit(null);
      await loadDashboard(selectedDate);
    } catch (caught) {
      setDirectError(caught instanceof Error ? caught.message : "打刻履歴を修正できませんでした。");
    } finally {
      setDirectSubmitting(false);
    }
  }

  async function decide(correction: Correction, decision: "APPROVED" | "REJECTED") {
    const draft = reviewDrafts[correction.id];

    if (
      decision === "APPROVED" &&
      correction.operation === "REVIEW" &&
      (!draft?.date || !draft?.time)
    ) {
      setFieldErrors((current) => ({
        ...current,
        [correction.id]: "追加する打刻の日付と時刻を入力してください。",
      }));
      return;
    }

    const verb = decision === "APPROVED" ? "承認" : "却下";
    await dismissKeyboard();
    if (!window.confirm(`${correction.legal_name}さんの申請を${verb}しますか？`)) return;

    setDeciding(correction.id);
    setError(null);

    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");

      const response = await fetch("/api/manager/corrections/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard?.manager.store_id,
          requestId: correction.id,
          decision,
          resolvedEventType:
            correction.operation === "REVIEW" ? draft?.eventType : undefined,
          resolvedOccurredAt:
            correction.operation === "REVIEW" && draft
              ? new Date(`${draft.date}T${draft.time}`).toISOString()
              : undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        if (data.code === "RESOLUTION_REQUIRED" || data.code === "INVALID_RESOLUTION_TIME") {
          throw new Error("追加する打刻の種類・日付・時刻を確認してください。");
        }
        throw new Error("申請を更新できませんでした。");
      }

      setFieldErrors((current) => {
        const next = { ...current };
        delete next[correction.id];
        return next;
      });
      await loadDashboard(selectedDate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申請を更新できませんでした。");
    } finally {
      setDeciding(null);
    }
  }

  async function updateStaffStatus(staff: StaffMembership) {
    const nextStatus = staff.status === "active" ? "inactive" : "active";
    const action = nextStatus === "inactive" ? "利用停止" : "利用再開";
    if (!window.confirm(`${staff.legal_name}さんを${action}しますか？`)) return;

    setUpdatingStaffId(staff.staff_id);
    setError(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/staff/status", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard?.manager.store_id,
          staffId: staff.staff_id,
          status: nextStatus,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.code === "STAFF_ACTIVE_WORK") {
          throw new Error("勤務中または休憩中のスタッフは停止できません。先に退勤してください。");
        }
        throw new Error(`${action}できませんでした。`);
      }
      await loadDashboard(selectedDate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${action}できませんでした。`);
    } finally {
      setUpdatingStaffId(null);
    }
  }

  async function exportMonthlyCsv(report: MonthlyReport) {
    setExportingPeriod(report.period_end);
    setReissueMessage(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/monthly-attendance/csv", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard?.manager.store_id,
          periodEnd: report.period_end,
        }),
      });
      if (!response.ok) throw new Error("CSVを作成できませんでした。");
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `${dashboard?.manager.store_name ?? "店舗"}-${report.period_end}-勤怠.csv`;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
      setReissueMessage("補助CSVを保存しました。");
    } catch (caught) {
      setReissueMessage(caught instanceof Error ? caught.message : "CSVを作成できませんでした。");
    } finally {
      setExportingPeriod(null);
    }
  }

  async function reissueMonthlyReport(report: MonthlyReport) {
    if (!window.confirm(`${report.period_end.replaceAll("-", "/")}締めの勤怠表を最新データで再発行し、登録メールへ送信しますか？`)) return;
    setReissuingPeriod(report.period_end);
    setReissueMessage(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/monthly-attendance/reissue", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard?.manager.store_id,
          periodEnd: report.period_end,
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("勤怠表を再発行できませんでした。時間をおいて再度お試しください。");
      setReissueMessage("最新の勤怠表を登録メールへ送信しました。");
      if (dashboard) await loadMonthlyReports(dashboard.manager.store_id);
    } catch (caught) {
      setReissueMessage(caught instanceof Error ? caught.message : "勤怠表を再発行できませんでした。");
    } finally {
      setReissuingPeriod(null);
    }
  }

  const visibleAttendance = dashboard?.attendance.filter(
    (staff) => selectedStaffId === "ALL" || staff.staff_id === selectedStaffId,
  ) ?? [];

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>ONOGAMI</p>
          <h1>管理者画面</h1>
          {dashboard && (
            <>
              {managerMemberships.length > 1 ? (
                <label className={styles.storeSelector}>
                  表示する店舗
                  <select
                    value={dashboard.manager.store_id}
                    disabled={switchingStore}
                    onChange={(event) => void changeStore(event.target.value)}
                  >
                    {managerMemberships.map((membership) => (
                      <option key={membership.store_id} value={membership.store_id}>
                        {membership.store_name}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <p className={styles.store}>{dashboard.manager.store_name}</p>
              )}
              {switchingStore && <p className={styles.switchingStore} role="status">店舗を切り替えています…</p>}
              <p className={styles.manager}>{dashboard.manager.legal_name}さん</p>
              <a href={`${MANAGER_QR_LIFF_URL}?store_id=${encodeURIComponent(dashboard.manager.store_id)}`}>店舗QRを発行・再発行</a>
            </>
          )}
        </header>

        {!dashboard && !error && <p className={styles.loading}>{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {dashboard && (
          <>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>月次勤怠表</h2>
                <span>{monthlyReports.length}件</span>
              </div>
              <p className={styles.sectionNote}>打刻を修正した後、対象期間の勤怠表を最新データで再発行できます。</p>
              {reissueMessage && <p className={styles.reissueMessage} role="status">{reissueMessage}</p>}
              {monthlyReports.length === 0 ? (
                <p className={styles.empty}>再発行できる勤怠表はまだありません</p>
              ) : (
                <ul className={styles.monthlyReportList}>
                  {monthlyReports.map((report) => (
                    <li key={report.period_end}>
                      <div>
                        <strong>{report.period_end.slice(5, 7)}月度</strong>
                        <span>{report.period_start.replaceAll("-", "/")} - {report.period_end.replaceAll("-", "/")}</span>
                      </div>
                      <div className={styles.monthlyReportActions}>
                        <button type="button" className={styles.csvButton} disabled={exportingPeriod !== null || reissuingPeriod !== null} onClick={() => void exportMonthlyCsv(report)}>
                          {exportingPeriod === report.period_end ? "CSV作成中…" : "補助CSV"}
                        </button>
                        <button type="button" disabled={reissuingPeriod !== null || exportingPeriod !== null} onClick={() => void reissueMonthlyReport(report)}>
                          {reissuingPeriod === report.period_end ? "再発行中…" : "再発行して送信"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>スタッフ管理</h2>
                <span>{dashboard.staffMemberships.length}名</span>
              </div>
              <p className={styles.sectionNote}>登録は店舗QRから自動で行われます。必要なときだけ停止・再開してください。</p>
              {dashboard.staffMemberships.length === 0 ? (
                <p className={styles.empty}>登録済みスタッフはいません</p>
              ) : (
                <ul className={styles.staffManagementList}>
                  {dashboard.staffMemberships.map((staff) => (
                    <li key={staff.staff_id}>
                      <div>
                        <strong>{staff.legal_name}</strong>
                        <span>{staff.status === "active" ? "利用中" : "停止中"}</span>
                      </div>
                      <button
                        type="button"
                        className={staff.status === "active" ? styles.reject : styles.approve}
                        disabled={updatingStaffId !== null || (staff.status === "active" && staff.state !== "OFF_DUTY")}
                        title={staff.status === "active" && staff.state !== "OFF_DUTY" ? "退勤後に停止できます" : undefined}
                        onClick={() => void updateStaffStatus(staff)}
                      >
                        {updatingStaffId === staff.staff_id
                          ? "処理中…"
                          : staff.status === "active"
                            ? "利用停止"
                            : "利用再開"}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>勤務状況</h2>
                <button type="button" onClick={() => void loadDashboard(selectedDate)}>更新</button>
              </div>
              <label className={styles.dateSelector}>
                表示する営業日
                <input
                  type="date"
                  value={selectedDate}
                  onChange={(event) => setSelectedDate(event.target.value)}
                />
              </label>
              <label className={styles.staffSelector}>
                スタッフを選択
                <select
                  value={selectedStaffId}
                  onChange={(event) => setSelectedStaffId(event.target.value)}
                >
                  <option value="ALL">全スタッフ</option>
                  {dashboard.attendance.map((staff) => (
                    <option key={staff.staff_id} value={staff.staff_id}>
                      {staff.legal_name}
                    </option>
                  ))}
                </select>
              </label>
              <div className={styles.sectionHeading}>
                <strong>{selectedDate.replaceAll("-", "/")}</strong>
                <span>{visibleAttendance.length}名</span>
              </div>
              <ul className={styles.attendanceList}>
                {visibleAttendance.map((staff) => (
                  <li key={staff.staff_id}>
                    <div>
                      <strong>{staff.legal_name}</strong>
                      <span className={`${styles.state} ${styles[staff.state]}`}>
                        {stateLabels[staff.state]}
                      </span>
                    </div>
                    {staff.carried_over_active && staff.active_since && (
                      <p className={styles.fieldError} role="alert">
                        前営業日から
                        {staff.current_state === "ON_BREAK" ? "休憩" : "勤務"}が継続中です
                        （出勤 {formatDateTime(staff.active_since)}）
                      </p>
                    )}
                    <p>
                      {staff.last_event_at && staff.last_event_type
                        ? `最終 ${formatTime(staff.last_event_at)} ${eventLabels[staff.last_event_type]}`
                        : "この日の打刻なし"}
                      <small>{staff.punch_count}件</small>
                    </p>
                    <div className={styles.directHistory}>
                      <ol>
                        {staff.day_events.map((dayEvent) => (
                          <li key={dayEvent.effective_id}>
                            <time>{formatTime(dayEvent.occurred_at)}</time>
                            <strong>{eventLabels[dayEvent.event_type]}</strong>
                            {dayEvent.corrected && <small>訂正</small>}
                            <button type="button" onClick={() => openDirectEdit(staff, "REPLACE", dayEvent)}>
                              変更
                            </button>
                            <button type="button" onClick={() => openDirectEdit(staff, "VOID", dayEvent)}>
                              取消
                            </button>
                          </li>
                        ))}
                      </ol>
                      <button type="button" className={styles.addPunch} onClick={() => openDirectEdit(staff, "ADD")}>
                        打刻を追加
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>

            {directEdit && (
              <section className={styles.section}>
                <div className={styles.sectionHeading}>
                  <h2>{directEdit.staffName}さんの打刻修正</h2>
                </div>
                <div className={styles.resolution}>
                  <p>
                    {directEdit.operation === "ADD"
                      ? "打刻を追加"
                      : directEdit.operation === "REPLACE"
                        ? "選択した打刻を変更"
                        : "選択した打刻を取消"}
                  </p>
                  {directEdit.operation !== "VOID" && (
                    <>
                      <label>
                        打刻種類
                        <select value={directEdit.eventType} onChange={(event) => setDirectEdit({ ...directEdit, eventType: event.target.value as EventType })}>
                          {Object.entries(eventLabels).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
                        </select>
                      </label>
                      <div className={styles.resolutionDateTime}>
                        <label>日付<input type="date" value={directEdit.date} onChange={(event) => setDirectEdit({ ...directEdit, date: event.target.value })} /></label>
                        <label>時刻<input type="time" value={directEdit.time} onChange={(event) => setDirectEdit({ ...directEdit, time: event.target.value })} /></label>
                      </div>
                    </>
                  )}
                  <label>
                    修正理由
                    <input value={directEdit.reason} onChange={(event) => setDirectEdit({ ...directEdit, reason: event.target.value })} placeholder="例：管理者確認により時刻を修正" />
                  </label>
                  {directError && (
                    <p className={styles.fieldError} role="alert">{directError}</p>
                  )}
                  <div className={styles.actions}>
                    <button type="button" className={styles.reject} onClick={() => { setDirectEdit(null); setDirectError(null); }}>キャンセル</button>
                    <button type="button" className={styles.approve} disabled={directSubmitting} onClick={() => void submitDirectEdit()}>
                      {directSubmitting ? "処理中…" : "修正を確定"}
                    </button>
                  </div>
                </div>
              </section>
            )}

            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>未処理の訂正申請</h2>
                <span>{dashboard.corrections.length}件</span>
              </div>

              {dashboard.corrections.length === 0 ? (
                <p className={styles.empty}>未処理の申請はありません</p>
              ) : (
                <ul className={styles.correctionList}>
                  {dashboard.corrections.map((correction) => (
                    <li key={correction.id}>
                      <div className={styles.correctionTop}>
                        <strong>{correction.legal_name}</strong>
                        <time dateTime={correction.requested_at}>
                          申請 {formatDateTime(correction.requested_at)}
                        </time>
                      </div>

                      {correction.operation === "ADD" && correction.requested_event_type && correction.requested_occurred_at ? (
                        <p className={styles.requestDetail}>
                          打刻漏れを追加：{formatDateTime(correction.requested_occurred_at)}{" "}
                          {eventLabels[correction.requested_event_type]}
                        </p>
                      ) : (
                        <p className={styles.requestDetail}>内容確認が必要な申請</p>
                      )}

                      {correction.reason && <p className={styles.reason}>{correction.reason}</p>}

                      <div className={styles.dayHistory}>
                        <p>対象日の有効な打刻履歴</p>
                        {correction.day_events.length === 0 ? (
                          <span>打刻履歴はありません</span>
                        ) : (
                          <ol>
                            {correction.day_events.map((dayEvent) => (
                              <li key={dayEvent.effective_id}>
                                <time dateTime={dayEvent.occurred_at}>
                                  {formatTime(dayEvent.occurred_at)}
                                </time>
                                <strong>{eventLabels[dayEvent.event_type]}</strong>
                                {dayEvent.corrected && <small>訂正</small>}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>

                      {correction.operation === "REVIEW" && (
                        <div className={styles.resolution}>
                          <p>管理者が確認した内容を入力してください</p>
                          <label>
                            追加する打刻
                            <select
                              value={reviewDrafts[correction.id]?.eventType ?? "CHECK_IN"}
                              onChange={(event) =>
                                updateReviewDraft(correction.id, {
                                  eventType: event.target.value as EventType,
                                })
                              }
                            >
                              <option value="CHECK_IN">出勤</option>
                              <option value="BREAK_START">休憩開始</option>
                              <option value="BREAK_END">休憩終了</option>
                              <option value="CHECK_OUT">退勤</option>
                            </select>
                          </label>
                          <div className={styles.resolutionDateTime}>
                            <label>
                              日付
                              <input
                                type="date"
                                value={reviewDrafts[correction.id]?.date ?? ""}
                                onChange={(event) =>
                                  updateReviewDraft(correction.id, {
                                    date: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label>
                              時刻
                              <input
                                type="time"
                                step="60"
                                value={reviewDrafts[correction.id]?.time ?? ""}
                                onChange={(event) =>
                                  updateReviewDraft(correction.id, {
                                    time: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                          {fieldErrors[correction.id] && (
                            <p className={styles.fieldError} role="alert">
                              {fieldErrors[correction.id]}
                            </p>
                          )}
                          <small>
                            承認すると、この打刻が訂正データとして追加されます。
                          </small>
                        </div>
                      )}

                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.reject}
                          disabled={deciding !== null}
                          onClick={() => void decide(correction, "REJECTED")}
                        >
                          却下
                        </button>
                        <button
                          type="button"
                          className={styles.approve}
                          disabled={deciding !== null}
                          onClick={() => void decide(correction, "APPROVED")}
                        >
                          {deciding === correction.id ? "処理中…" : "承認"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </section>
    </main>
  );
}

