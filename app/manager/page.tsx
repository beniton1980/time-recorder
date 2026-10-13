"use client";

import liff from "@line/liff";
import { useCallback, useEffect, useState } from "react";
import { correctionValidationMessage } from "@/lib/correction-validation";
import { managerCorrectionInputParts as inputParts, managerCorrectionTimestamp } from "@/lib/manager-correction-datetime";
import styles from "./manager.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const MANAGER_SESSION_LIFF_ID = process.env.NEXT_PUBLIC_MANAGER_LIFF_ID || LIFF_ID;
const MANAGER_ATTENDANCE_PREVIEW = Boolean(process.env.NEXT_PUBLIC_MANAGER_LIFF_ID);
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
  group_id?: string | null;
  requested_break_ended_at?: string | null;
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
    store_latitude: number | null;
    store_longitude: number | null;
    monthly_report_email: string | null;
    monthly_report_email_verification_sent_at: string | null;
    monthly_report_email_verified_at: string | null;
    monthly_report_email_consented_at: string | null;
    monthly_report_email_consent_version: string | null;
  };
  attendance: Attendance[];
  corrections: Correction[];
  staffMemberships: StaffMembership[];
  coManagers: CoManager[];
  businessDate: string;
};

type CoManager = { staff_id: string; legal_name: string; status: "active" | "inactive"; is_self: boolean; is_owner: boolean };
type CoManagerShare = { legalName: string; storeName: string };

type ManagerMembership = {
  store_id: string;
  store_name: string;
};

type MonthlyReport = {
  id: string;
  period_start: string;
  period_end: string;
  sent_at: string;
  reissue_count: number;
};

type StaffMembership = {
  staff_id: string;
  legal_name: string;
  status: "active" | "inactive" | "departed";
  state: WorkState;
};

type ReviewDraft = {
  eventType: EventType;
  date: string;
  time: string;
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
  const [selectedDate, setSelectedDate] = useState(currentBusinessDate);
  const [selectedStaffId, setSelectedStaffId] = useState("");
  const [updatingStaffId, setUpdatingStaffId] = useState<string | null>(null);
  const [showDepartedStaff, setShowDepartedStaff] = useState(false);
  const [monthlyReports, setMonthlyReports] = useState<MonthlyReport[]>([]);
  const [monthlyRecipientEmail, setMonthlyRecipientEmail] = useState("");
  const [monthlyRecipientWorking, setMonthlyRecipientWorking] = useState(false);
  const [monthlyRecipientMessage, setMonthlyRecipientMessage] = useState<string | null>(null);
  const [reissuingPeriod, setReissuingPeriod] = useState<string | null>(null);
  const [reissueMessage, setReissueMessage] = useState<string | null>(null);
  const [exportingPeriod, setExportingPeriod] = useState<string | null>(null);
  const [savingStoreLocation, setSavingStoreLocation] = useState(false);
  const [storeLocationMessage, setStoreLocationMessage] = useState<string | null>(null);
  const [selectedCoManagerStaffId, setSelectedCoManagerStaffId] = useState("");
  const [coManagerWorking, setCoManagerWorking] = useState(false);
  const [coManagerMessage, setCoManagerMessage] = useState<string | null>(null);
  const [coManagerShare, setCoManagerShare] = useState<CoManagerShare | null>(null);

  const loadDashboard = useCallback(async (businessDate: string | undefined, storeId: string) => {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");

    const response = await fetch("/api/manager/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, businessDate, storeId }),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      if (data.code === "MANAGER_ACCESS_REQUIRED") {
        throw new Error("この画面を利用できる管理者権限がありません。");
      }
      throw new Error("管理者画面を読み込めませんでした。");
    }

    setDashboard(data as Dashboard);
    setMonthlyRecipientEmail(String(data.manager.monthly_report_email ?? ""));
    setSelectedDate(data.businessDate as string);
    setMessage("");
    return data as Dashboard;
  }, []);

  const reloadDashboard = useCallback(async (businessDate?: string) => {
    if (!dashboard) throw new Error("表示中の店舗を確認できませんでした。");
    return loadDashboard(businessDate, dashboard.manager.store_id);
  }, [dashboard, loadDashboard]);

  async function grantCoManagerAccess() {
    if (!dashboard || !selectedCoManagerStaffId) { setCoManagerMessage("共同管理者にするスタッフを選択してください。"); return; }
    const selectedStaff = dashboard.staffMemberships.find((staff) => staff.staff_id === selectedCoManagerStaffId);
    if (!selectedStaff) { setCoManagerMessage("選択したスタッフを確認できませんでした。"); return; }
    const idToken = liff.getIDToken();
    if (!idToken) return;
    setCoManagerWorking(true); setCoManagerMessage(null); setCoManagerShare(null);
    try {
      const response = await fetch("/api/manager/co-managers/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId: dashboard.manager.store_id, staffId: selectedCoManagerStaffId, status: "active" }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("管理権限を付与できませんでした。");
      setSelectedCoManagerStaffId("");
      setCoManagerShare({ legalName: selectedStaff.legal_name, storeName: dashboard.manager.store_name });
      setCoManagerMessage("共同管理者として登録しました。続けて本人へ案内を共有してください。");
      await reloadDashboard(selectedDate);
    } catch (caught) { setCoManagerMessage(caught instanceof Error ? caught.message : "管理権限を付与できませんでした。"); }
    finally { setCoManagerWorking(false); }
  }

  async function shareCoManagerGuide() {
    if (MANAGER_ATTENDANCE_PREVIEW || !coManagerShare) return;
    const guide = `${coManagerShare.legalName}さん\n${coManagerShare.storeName}の勤怠管理者に登録しました。\n次のリンクから管理者画面を開いてください。\nhttps://liff.line.me/${LIFF_ID}/manager`;
    setCoManagerWorking(true);
    try {
      if (liff.isApiAvailable("shareTargetPicker")) {
        const result = await liff.shareTargetPicker([{ type: "text", text: guide }], { isMultiple: false });
        setCoManagerMessage(result?.status === "success" ? "LINEの送信先へ案内を共有しました。" : "LINEの共有画面を開きました。");
        return;
      }
      if (typeof navigator.share === "function") {
        await navigator.share({ title: "ONOGAMI 勤怠 管理者のご案内", text: guide });
        setCoManagerMessage("案内を共有しました。");
        return;
      }
      await navigator.clipboard.writeText(guide);
      setCoManagerMessage("案内文をコピーしました。LINEのトークへ貼り付けて送信してください。");
    } catch (caught) {
      if (caught instanceof DOMException && caught.name === "AbortError") {
        setCoManagerMessage("共有をキャンセルしました。管理権限の登録は完了しています。");
      } else {
        setCoManagerMessage("共有画面を開けませんでした。もう一度お試しください。");
      }
    } finally {
      setCoManagerWorking(false);
    }
  }

  async function updateCoManagerStatus(manager: CoManager) {
    if (!dashboard || manager.is_self) return;
    const nextStatus = manager.status === "active" ? "inactive" : "active";
    if (!window.confirm(`${manager.legal_name}さんの管理権限を${nextStatus === "active" ? "再開" : "停止"}しますか？`)) return;
    const idToken = liff.getIDToken(); if (!idToken) return;
    setCoManagerWorking(true); setCoManagerMessage(null);
    try {
      const response = await fetch("/api/manager/co-managers/access", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId: dashboard.manager.store_id, staffId: manager.staff_id, status: nextStatus }) });
      const data = await response.json();
      if (!response.ok || !data.ok) throw new Error("本人または最後の管理者は停止できません。");
      await reloadDashboard(selectedDate);
      if (nextStatus === "active") {
        setCoManagerShare({ legalName: manager.legal_name, storeName: dashboard.manager.store_name });
        setCoManagerMessage("管理権限を再開しました。必要に応じて本人へ案内を共有してください。");
      } else {
        setCoManagerShare(null);
        setCoManagerMessage("管理権限を停止しました。");
      }
    } catch (caught) { setCoManagerMessage(caught instanceof Error ? caught.message : "管理権限を更新できませんでした。"); }
    finally { setCoManagerWorking(false); }
  }

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
      if (data.code === "INVALID_ID_TOKEN") {
        throw new Error("LINE認証の有効期限が切れました。右上の×で画面を閉じ、LINEから管理者画面を開き直してください。");
      }
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
        await liff.init({ liffId: MANAGER_SESSION_LIFF_ID });
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
          if (!initialStoreId) {
            throw new Error("管理対象の店舗を確認できませんでした。");
          }
          const loadedDashboard = await loadDashboard(currentBusinessDate(), initialStoreId);
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
  }, [loadDashboard, loadManagerMemberships, loadMonthlyReports]);

  async function changeStore(storeId: string) {
    if (!dashboard || storeId === dashboard.manager.store_id) return;
    setSwitchingStore(true);
    setError(null);
    setMonthlyReports([]);
    setReissueMessage(null);
    setStoreLocationMessage(null);
    setCoManagerShare(null);
    setCoManagerMessage(null);
    try {
      const url = new URL(window.location.href);
      url.searchParams.set("store_id", storeId);
      const loadedDashboard = await loadDashboard(undefined, storeId);
      setSelectedStaffId("");
      window.history.replaceState(null, "", url);
      await loadMonthlyReports(loadedDashboard.manager.store_id);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "店舗を切り替えられませんでした。");
    } finally {
      setSwitchingStore(false);
    }
  }

  async function registerCurrentStoreLocation() {
    if (!dashboard) return;
    setSavingStoreLocation(true);
    setStoreLocationMessage("現在地を確認しています…");
    try {
      const position = await new Promise<GeolocationPosition>((resolve, reject) => {
        navigator.geolocation.getCurrentPosition(resolve, reject, {
          enableHighAccuracy: true,
          timeout: 15000,
          maximumAge: 0,
        });
      });
      const accuracy = Math.round(position.coords.accuracy);
      if (accuracy > 100) {
        throw new Error(`位置情報の精度が不足しています（誤差約${accuracy}m）。屋外や窓際で再度お試しください。`);
      }
      if (!window.confirm(`${dashboard.manager.store_name}の打刻位置を、現在地（誤差約${accuracy}m）に設定しますか？`)) {
        setStoreLocationMessage(null);
        return;
      }
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/store-location", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard.manager.store_id,
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.code === "LOCATION_ACCURACY_TOO_LOW") {
          throw new Error("位置情報の精度が不足しています。屋外や窓際で再度お試しください。");
        }
        throw new Error("店舗の打刻位置を保存できませんでした。");
      }
      setDashboard((current) => current ? {
        ...current,
        manager: {
          ...current.manager,
          store_latitude: Number(data.store.latitude),
          store_longitude: Number(data.store.longitude),
        },
      } : current);
      setStoreLocationMessage(`店舗の打刻位置を登録しました（誤差約${accuracy}m）。`);
    } catch (caught) {
      const geolocationDenied = typeof caught === "object"
        && caught !== null
        && "code" in caught
        && caught.code === 1;
      setStoreLocationMessage(
        geolocationDenied
          ? "位置情報の利用が許可されていません。LINEの設定で位置情報を許可してください。"
          : caught instanceof Error ? caught.message : "現在地を取得できませんでした。",
      );
    } finally {
      setSavingStoreLocation(false);
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
    const details = correction.requested_break_ended_at
      ? "\n\n休憩開始と終了をまとめて処理します。" : "";
    if (!window.confirm(`${correction.legal_name}さんの申請を${verb}しますか？${details}`)) return;

    setDeciding(correction.id);
    setError(null);
    setFieldErrors((current) => { const next = { ...current }; delete next[correction.id]; return next; });

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
              ? managerCorrectionTimestamp(draft.date, draft.time)
              : undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        const validationMessage = data.code === "OCCURRED_AT_IN_FUTURE"
          ? "未来の日時が指定されています。"
          : correctionValidationMessage(data.code);
        if (validationMessage) {
          setFieldErrors((current) => ({ ...current,
            [correction.id]: `${validationMessage}承認は行っていません。記録と申請内容を確認してください。`,
          }));
          await reloadDashboard(selectedDate);
          return;
        }
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
      await reloadDashboard(selectedDate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申請を更新できませんでした。");
    } finally {
      setDeciding(null);
    }
  }

  async function updateStaffStatus(staff: StaffMembership, nextStatus: StaffMembership["status"]) {
    const action = nextStatus === "active" ? (staff.status === "departed" ? "再雇用" : "利用再開") : nextStatus === "inactive" ? "一時停止" : "退社";
    const detail = nextStatus === "departed"
      ? "\n\n通常のスタッフ一覧から非表示になります。過去の勤怠履歴は残ります。"
      : nextStatus === "active" && staff.status === "departed"
        ? "\n\n打刻の利用を再開します。管理権限は自動では戻りません。"
        : "";
    if (!window.confirm(`${staff.legal_name}さんを${action}にしますか？${detail}`)) return;

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
      await reloadDashboard(selectedDate);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : `${action}できませんでした。`);
    } finally {
      setUpdatingStaffId(null);
    }
  }

  async function exportMonthlyCsv(report: MonthlyReport) {
    setExportingPeriod(report.id);
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
          reportId: report.id,
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
    setReissuingPeriod(report.id);
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
          reportId: report.id,
          requestId: crypto.randomUUID(),
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.code === "MONTHLY_REPORT_RECIPIENT_NOT_CONFIRMED"
          ? "月次勤怠表の送信先確認と受信同意が完了していません。"
          : "勤怠表を再発行できませんでした。時間をおいて再度お試しください。");
      }
      setReissueMessage("最新の勤怠表を登録メールへ送信しました。");
      if (dashboard) await loadMonthlyReports(dashboard.manager.store_id);
    } catch (caught) {
      setReissueMessage(caught instanceof Error ? caught.message : "勤怠表を再発行できませんでした。");
    } finally {
      setReissuingPeriod(null);
    }
  }

  async function sendMonthlyRecipientVerification() {
    const email = monthlyRecipientEmail.trim();
    if (!email) {
      setMonthlyRecipientMessage("送信先メールアドレスを入力してください。");
      return;
    }
    if (!window.confirm(
      `${email}を月次勤怠表の送信先として確認しますか？\n\nスタッフ氏名・打刻時刻・勤務時間等を含むPDFの受信同意が必要です。`,
    )) return;

    setMonthlyRecipientWorking(true);
    setMonthlyRecipientMessage(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken || !dashboard) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/monthly-attendance/recipient", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeId: dashboard.manager.store_id,
          email,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(
          data.code === "INVALID_EMAIL"
            ? "正しいメールアドレスを入力してください。"
            : data.code === "MONTHLY_REPORT_DELIVERY_IN_PROGRESS"
              ? "勤怠表を送信中です。送信完了後に送信先を変更してください。"
              : "確認メールを送信できませんでした。",
        );
      }
      if (data.email.sent !== true) {
        throw new Error("確認メールを送信できませんでした。設定を確認して再送してください。");
      }
      setMonthlyRecipientMessage("確認メールを送信しました。メール内で受信への同意を完了してください。");
      await loadDashboard(selectedDate, dashboard.manager.store_id);
    } catch (caught) {
      setMonthlyRecipientMessage(caught instanceof Error ? caught.message : "確認メールを送信できませんでした。");
    } finally {
      setMonthlyRecipientWorking(false);
    }
  }

  // Derive both the controlled selection and link from the current response.
  // Preserve a valid selection on refresh, otherwise use the first current staff.
  const attendanceStaffId = dashboard?.attendance.find(
    (staff) => staff.staff_id === selectedStaffId,
  )?.staff_id ?? dashboard?.attendance[0]?.staff_id ?? "";
  const monthlyRecipientConfirmed = Boolean(
    dashboard?.manager.monthly_report_email
    && dashboard.manager.monthly_report_email_verified_at
    && dashboard.manager.monthly_report_email_consented_at
    && dashboard.manager.monthly_report_email_consent_version === "2026-08-21-v1",
  );
  const coManagerCandidates = dashboard?.staffMemberships.filter(
    (staff) => staff.status === "active" && !dashboard.coManagers.some((manager) => manager.staff_id === staff.staff_id),
  ) ?? [];
  const currentStaffMemberships = dashboard?.staffMemberships.filter((staff) => staff.status !== "departed") ?? [];
  const departedStaffMemberships = dashboard?.staffMemberships.filter((staff) => staff.status === "departed") ?? [];

  return (
    <main className={styles.page} data-manager-attendance-preview={MANAGER_ATTENDANCE_PREVIEW ? "true" : undefined}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>ONOGAMI</p>
          <h1>管理者画面</h1>
          {MANAGER_ATTENDANCE_PREVIEW && <p className="manager-preview-notice">検証用の勤怠画面です。スタッフを選び、打刻の追加・変更・取消を確認できます。</p>}
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
              <a hidden={MANAGER_ATTENDANCE_PREVIEW} href={`${MANAGER_QR_LIFF_URL}?store_id=${encodeURIComponent(dashboard.manager.store_id)}`}>店舗QRを発行・再発行</a>
            </>
          )}
        </header>

        {!dashboard && !error && <p className={styles.loading}>{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {dashboard && (
          <>
            <section className={styles.section}>
              <div className={styles.sectionHeading}><h2>店舗設定</h2><span>登録情報</span></div>
              <p className={styles.sectionNote}>締め日と月次メールの確認状況を確認できます。</p>
              <a href={`/manager/store-settings?store_id=${encodeURIComponent(dashboard.manager.store_id)}`}>店舗設定を確認・変更</a>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeading}><h2>共同管理者</h2><span>{dashboard.coManagers.filter((item) => item.status === "active").length}名</span></div>
              <p className={styles.sectionNote}>この店舗に登録済みのスタッフへ、管理権限を追加します。管理権限を停止しても本人の打刻は継続できます。</p>
              <div className={styles.coManagerInvite}>
                <label>登録済みスタッフを選択<select value={selectedCoManagerStaffId} onChange={(event) => setSelectedCoManagerStaffId(event.target.value)}><option value="">選択してください</option>{coManagerCandidates.map((staff) => <option key={staff.staff_id} value={staff.staff_id}>{staff.legal_name}</option>)}</select></label>
                <button type="button" disabled={coManagerWorking || !selectedCoManagerStaffId} onClick={() => void grantCoManagerAccess()}>共同管理者に登録</button>
                {coManagerShare && !MANAGER_ATTENDANCE_PREVIEW && <button type="button" className={styles.shareGuideButton} disabled={coManagerWorking} onClick={() => void shareCoManagerGuide()}>LINEで案内を共有</button>}
                {coManagerMessage && <p className={styles.reissueMessage} role="status">{coManagerMessage}</p>}
              </div>
              {coManagerCandidates.length === 0 && dashboard.staffMemberships.length > 0 && <p className={styles.sectionNote}>追加できる登録済みスタッフはいません。</p>}
              <ul className={styles.staffManagementList}>{dashboard.coManagers.map((manager) => <li key={manager.staff_id}><div><strong>{manager.legal_name}{manager.is_self ? "（あなた）" : ""}</strong><span>{manager.is_owner ? "店舗管理者" : manager.status === "active" ? "共同管理中" : "管理停止中"}</span></div>{!manager.is_self && !manager.is_owner && <button type="button" className={manager.status === "active" ? styles.reject : styles.approve} disabled={coManagerWorking} onClick={() => void updateCoManagerStatus(manager)}>{manager.status === "active" ? "権限停止" : "利用再開"}</button>}</li>)}</ul>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>店舗の打刻位置</h2>
                <span>{dashboard.manager.store_latitude === null ? "未設定" : "設定済み"}</span>
              </div>
              <p className={styles.sectionNote}>
                店舗内で操作してください。打刻時の位置確認に使用します。
              </p>
              {storeLocationMessage && <p className={styles.reissueMessage} role="status">{storeLocationMessage}</p>}
              <button
                type="button"
                className={styles.storeLocationButton}
                disabled={savingStoreLocation}
                onClick={() => void registerCurrentStoreLocation()}
              >
                {savingStoreLocation ? "現在地を確認中…" : dashboard.manager.store_latitude === null ? "現在地を店舗位置に登録" : "店舗位置を現在地で更新"}
              </button>
            </section>

            <section id="monthly-report" className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>月次勤怠表</h2>
                <span>{monthlyReports.length}件</span>
              </div>
              <p className={styles.sectionNote}>確認・同意済みの店舗別メールだけへ、締め日の翌朝に勤怠表を送信します。</p>
              <div className={styles.monthlyRecipient}>
                <label>
                  月次勤怠表の送信先
                  <input
                    type="email"
                    maxLength={254}
                    value={monthlyRecipientEmail}
                    onChange={(event) => setMonthlyRecipientEmail(event.target.value)}
                    placeholder="manager@example.com"
                  />
                </label>
                <p className={monthlyRecipientConfirmed ? styles.recipientConfirmed : styles.recipientPending}>
                  {monthlyRecipientConfirmed
                    ? "メール確認・受信同意済みです。"
                    : dashboard.manager.monthly_report_email_verification_sent_at
                      ? "確認メール送信済みです。メール内で受信に同意してください。"
                      : "未確認です。確認完了まで月次勤怠表は送信されません。"}
                </p>
                <p className={styles.recipientDisclosure}>PDFにはスタッフ氏名、打刻時刻、勤務・休憩時間、勤怠の要確認状態が含まれます。送信先を変更すると再確認が必要です。</p>
                <button type="button" disabled={monthlyRecipientWorking || (monthlyRecipientConfirmed && monthlyRecipientEmail === dashboard.manager.monthly_report_email)} onClick={()=>void sendMonthlyRecipientVerification()}>
                  {monthlyRecipientWorking
                    ? "送信中…"
                    : monthlyRecipientConfirmed && monthlyRecipientEmail === dashboard.manager.monthly_report_email
                      ? "確認済み"
                      : "この送信先を確認"}
                </button>
                {monthlyRecipientMessage && <p className={styles.reissueMessage} role="status">{monthlyRecipientMessage}</p>}
              </div>
              <p className={styles.sectionNote}>打刻を修正した後、対象期間の勤怠表を最新データで再発行できます。</p>
              {reissueMessage && <p className={styles.reissueMessage} role="status">{reissueMessage}</p>}
              {monthlyReports.length === 0 ? (
                <p className={styles.empty}>再発行できる勤怠表はまだありません</p>
              ) : (
                <ul className={styles.monthlyReportList}>
                  {monthlyReports.map((report) => (
                    <li key={report.id}>
                      <div>
                        <strong>{report.period_end.slice(5, 7)}月度</strong>
                        <span>{report.period_start.replaceAll("-", "/")} - {report.period_end.replaceAll("-", "/")}</span>
                      </div>
                      <div className={styles.monthlyReportActions}>
                        <button type="button" className={styles.csvButton} disabled={exportingPeriod !== null || reissuingPeriod !== null} onClick={() => void exportMonthlyCsv(report)}>
                          {exportingPeriod === report.id ? "CSV作成中…" : "補助CSV"}
                        </button>
                        <button type="button" disabled={!monthlyRecipientConfirmed || reissuingPeriod !== null || exportingPeriod !== null} onClick={() => void reissueMonthlyReport(report)}>
                          {reissuingPeriod === report.id ? "再発行中…" : "再発行して送信"}
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
                <span>{currentStaffMemberships.length}名</span>
              </div>
              <p className={styles.sectionNote}>一時的に使わない場合は「一時停止」、退社した場合は「退社」を選んでください。勤怠履歴はどちらも削除されません。</p>
              {currentStaffMemberships.length === 0 ? (
                <p className={styles.empty}>登録済みスタッフはいません</p>
              ) : (
                <ul className={styles.staffManagementList}>
                  {currentStaffMemberships.map((staff) => (
                    <li key={staff.staff_id}>
                      <div>
                        <strong>{staff.legal_name}</strong>
                        <span>{staff.status === "active" ? "利用中" : "一時停止中"}</span>
                      </div>
                      <div className={styles.staffActions}>
                        <button type="button" className={staff.status === "active" ? styles.reject : styles.approve} disabled={updatingStaffId !== null || (staff.status === "active" && staff.state !== "OFF_DUTY")} title={staff.status === "active" && staff.state !== "OFF_DUTY" ? "退勤後に停止できます" : undefined} onClick={() => void updateStaffStatus(staff, staff.status === "active" ? "inactive" : "active")}>{updatingStaffId === staff.staff_id ? "処理中…" : staff.status === "active" ? "一時停止" : "利用再開"}</button>
                        <button type="button" className={styles.departButton} disabled={updatingStaffId !== null || staff.state !== "OFF_DUTY"} title={staff.state !== "OFF_DUTY" ? "退勤後に退社へ変更できます" : undefined} onClick={() => void updateStaffStatus(staff, "departed")}>退社</button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              {departedStaffMemberships.length > 0 && (
                <div className={styles.departedStaff}>
                  <button type="button" className={styles.departedToggle} onClick={() => setShowDepartedStaff((current) => !current)}>{showDepartedStaff ? "退社したスタッフを閉じる" : `退社したスタッフ（${departedStaffMemberships.length}名）`}</button>
                  {showDepartedStaff && <ul className={styles.staffManagementList}>{departedStaffMemberships.map((staff) => <li key={staff.staff_id}><div><strong>{staff.legal_name}</strong><span>退社</span></div><button type="button" className={styles.approve} disabled={updatingStaffId !== null} onClick={() => void updateStaffStatus(staff, "active")}>{updatingStaffId === staff.staff_id ? "処理中…" : "再雇用"}</button></li>)}</ul>}
                </div>
              )}
            </section>

            <section className={styles.section} data-dashboard-key="attendance" aria-busy={switchingStore}>
              <div className={styles.sectionHeading}>
                <h2>勤怠確認</h2>
                <span>{dashboard.attendance.length}名</span>
              </div>
              <p className={styles.sectionNote}>
                スタッフを選択すると、その人の今月の勤怠・要確認・打刻修正をまとめて確認できます。
              </p>
              <label className={styles.staffSelector}>
                スタッフを選択
                <select
                  value={attendanceStaffId}
                  disabled={switchingStore || !attendanceStaffId}
                  onChange={(event) => setSelectedStaffId(event.target.value)}
                >
                  {dashboard.attendance.length === 0 && <option value="">対象のスタッフはいません</option>}
                  {dashboard.attendance.map((staff) => (
                    <option key={staff.staff_id} value={staff.staff_id}>
                      {staff.legal_name}
                    </option>
                  ))}
                </select>
              </label>
              {attendanceStaffId && !switchingStore && (
                <a
                  data-staff-attendance-link="true"
                  aria-label="選択したスタッフの個人勤怠を開く"
                  href={"/manager/staff-attendance?store_id=" + encodeURIComponent(dashboard.manager.store_id) + "&staff_id=" + encodeURIComponent(attendanceStaffId)}
                >
                  個人の勤怠を開く
                </a>
              )}
            </section>

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

                      {correction.requested_break_ended_at && correction.requested_occurred_at ? (
                        <p>
                          休憩開始・終了をまとめて追加<br />
                          開始：{formatDateTime(correction.requested_occurred_at)}<br />
                          終了：{formatDateTime(correction.requested_break_ended_at)}
                        </p>
                      ) : correction.operation === "ADD" && correction.requested_event_type && correction.requested_occurred_at ? (
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
                          <small>
                            承認すると、この打刻が訂正データとして追加されます。
                          </small>
                        </div>
                      )}

                      {fieldErrors[correction.id] && (
                        <p className={styles.fieldError} role="alert">
                          {fieldErrors[correction.id]}
                        </p>
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

