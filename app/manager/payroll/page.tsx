"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import { managerApiAuthError } from "@/lib/manager-api-auth-error";
import styles from "./payroll.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const weekdays = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
const shortWeekdays = ["日", "月", "火", "水", "木", "金", "土"];

type Membership = { store_id: string; store_name: string };
type Staff = { staff_id: string; legal_name: string; status: "active" | "inactive" };
type WeekStartRule = "CALENDAR_DEFAULT" | "EXPLICIT_WEEKDAY" | "OTHER_REVIEW_REQUIRED";
type CompensationTerm = {
  id: string;
  staff_id: string;
  hourly_rate_yen: number;
  effective_from: string;
  effective_to: string | null;
};
type OtherEmploymentStatus = "NONE" | "HAS_OTHER_EMPLOYER" | "UNKNOWN";
type OtherEmploymentConfirmation = {
  staff_id: string;
  status: OtherEmploymentStatus;
  confirmed_at: string;
  confirmation_current: boolean;
};
type CommutingMethod = "MONTHLY_PASS" | "PER_WORKDAY_GAS";
type CommutingAllowanceTerm = { id: string; staff_id: string; method: CommutingMethod; amount_yen: number; effective_from: string; effective_to: string | null; basis_confirmed: boolean };
type CommutingDraft = { method: CommutingMethod; amount: string; effectiveFrom: string; basisConfirmed: boolean };
type Settings = {
  store_id: string;
  work_time_system: "STANDARD_40H" | "SPECIAL_44H" | "OTHER_REVIEW_REQUIRED";
  overtime_month_rule: "PAY_PERIOD" | "CALENDAR_MONTH" | "OTHER_REVIEW_REQUIRED";
  statutory_holiday_rule: "FIXED_WEEKDAY" | "MANUAL_DATES" | "OTHER_REVIEW_REQUIRED";
  statutory_holiday_weekday: number | null;
};
type PayrollData = {
  settings: Settings | null;
  staff: Staff[];
  compensationTerms: CompensationTerm[];
  statutoryHolidayDates: string[];
  statutoryHolidayConfirmedMonths: string[];
  otherEmploymentConfirmations: OtherEmploymentConfirmation[];
  commutingAllowanceTerms: CommutingAllowanceTerm[];
};
type WageDraft = { hourlyRate: string; effectiveFrom: string };

function todayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date());
}

function datesForMonth(month: string) {
  const [yearText, monthText] = month.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const count = new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
  return Array.from({ length: count }, (_, index) => `${yearText}-${monthText}-${String(index + 1).padStart(2, "0")}`);
}

function firstWeekday(month: string) {
  const [yearText, monthText] = month.split("-");
  return new Date(Date.UTC(Number(yearText), Number(monthText) - 1, 1)).getUTCDay();
}

export default function PayrollSettingsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [data, setData] = useState<PayrollData | null>(null);
  const [message, setMessage] = useState("給与設定を読み込んでいます");
  const [error, setError] = useState<string | null>(null);
  const [savingStore, setSavingStore] = useState(false);
  const [workTimeSystem, setWorkTimeSystem] = useState<Settings["work_time_system"]>("OTHER_REVIEW_REQUIRED");
  const [weekStartRule, setWeekStartRule] = useState<WeekStartRule>("OTHER_REVIEW_REQUIRED");
  const [weekStartsOn, setWeekStartsOn] = useState(0);
  const [overtimeMonthRule, setOvertimeMonthRule] = useState<Settings["overtime_month_rule"]>("OTHER_REVIEW_REQUIRED");
  const [statutoryHolidayRule, setStatutoryHolidayRule] = useState<Settings["statutory_holiday_rule"]>("OTHER_REVIEW_REQUIRED");
  const [statutoryHolidayWeekday, setStatutoryHolidayWeekday] = useState(0);
  const [holidayMonth, setHolidayMonth] = useState(todayJst().slice(0, 7));
  const [selectedHolidayDates, setSelectedHolidayDates] = useState<string[]>([]);
  const [holidayMonthReviewed, setHolidayMonthReviewed] = useState(false);
  const [wageDrafts, setWageDrafts] = useState<Record<string, WageDraft>>({});
  const [revisionDrafts, setRevisionDrafts] = useState<Record<string, WageDraft>>({});
  const [savingInitialWages, setSavingInitialWages] = useState(false);
  const [revisingStaffId, setRevisingStaffId] = useState<string | null>(null);
  const [showHistoryFor, setShowHistoryFor] = useState<string | null>(null);
  const [savedInitialStaffIds, setSavedInitialStaffIds] = useState<string[]>([]);
  const [otherEmploymentDrafts, setOtherEmploymentDrafts] = useState<Record<string, OtherEmploymentStatus>>({});
  const [savingOtherEmploymentStaffId, setSavingOtherEmploymentStaffId] = useState<string | null>(null);
  const [commutingDrafts, setCommutingDrafts] = useState<Record<string, CommutingDraft>>({});
  const [savingCommutingStaffId, setSavingCommutingStaffId] = useState<string | null>(null);

  const termsByStaff = useMemo(() => {
    const map = new Map<string, CompensationTerm[]>();
    for (const term of data?.compensationTerms ?? []) {
      const list = map.get(term.staff_id) ?? [];
      list.push(term);
      map.set(term.staff_id, list);
    }
    return map;
  }, [data]);

  const currentTerms = useMemo(() => {
    const map = new Map<string, CompensationTerm>();
    for (const [staffId, terms] of termsByStaff) {
      const current = terms.find((term) => term.effective_to === null);
      if (current) map.set(staffId, current);
    }
    return map;
  }, [termsByStaff]);
  const currentCommutingTerms = useMemo(() => new Map((data?.commutingAllowanceTerms ?? []).filter((term) => term.effective_to === null).map((term) => [term.staff_id, term])), [data]);

  const calendarDates = useMemo(() => datesForMonth(holidayMonth), [holidayMonth]);
  const calendarBlanks = useMemo(() => Array.from({ length: firstWeekday(holidayMonth) }), [holidayMonth]);

  useEffect(() => {
    setSelectedHolidayDates((data?.statutoryHolidayDates ?? []).filter((date) => date.startsWith(`${holidayMonth}-`)));
    setHolidayMonthReviewed((data?.statutoryHolidayConfirmedMonths ?? []).includes(holidayMonth));
  }, [data?.statutoryHolidayDates, data?.statutoryHolidayConfirmedMonths, holidayMonth]);

  async function api(body: Record<string, unknown>) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idToken }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const authError = managerApiAuthError(response.status, result);
      if (authError) throw authError;
      if (result.code === "COMPENSATION_HISTORY_EXISTS") throw new Error("このスタッフにはすでに給与条件があります。");
      if (result.code === "COMPENSATION_REVISION_DATE_INVALID") throw new Error("改定日は現在の時給の開始日より後の日付を指定してください。");
      if (result.code === "COMPENSATION_PERIOD_OVERLAP") throw new Error("その改定日は既存の時給期間と重なります。履歴を確認してください。");
      if (result.code === "COMPENSATION_CURRENT_TERM_REQUIRED") throw new Error("現在有効な時給を1件に特定できません。履歴を確認してください。");
      if (result.code === "INVALID_PAYROLL_STORE_SETTINGS") throw new Error("勤務制度・残業の区切り・法定休日の設定を確認してください。");
      if (result.code === "INVALID_STATUTORY_HOLIDAY_DATE") throw new Error("法定休日の日付を確認してください。");
      if (result.code === "STATUTORY_HOLIDAY_SAVE_NOT_VERIFIED") throw new Error("法定休日をDBへ保存できませんでした。もう一度お試しください。");
      if (result.code === "INVALID_COMPENSATION_TERM") throw new Error("時給と適用開始日を確認してください。");
      if (result.code === "INVALID_COMMUTING_ALLOWANCE") throw new Error("通勤手当の金額・算定根拠・適用開始日を確認してください。");
      if (result.code === "COMMUTING_ALLOWANCE_REVISION_DATE_INVALID") throw new Error("通勤手当の改定日は現在の条件の開始日より後を指定してください。");
      if (result.code === "COMMUTING_ALLOWANCE_PERIOD_OVERLAP" || result.code === "COMMUTING_ALLOWANCE_CURRENT_TERM_AMBIGUOUS") throw new Error("通勤手当の適用期間が重なっています。履歴を確認してください。");
      if (result.code === "PAYROLL_SETTINGS_UNAVAILABLE") throw new Error("給与設定を利用できませんでした。");
      throw new Error("給与設定を保存できませんでした。");
    }
    return result;
  }

  async function weekBoundaryApi(targetStoreId: string, action: "load" | "save") {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/week-boundary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        idToken,
        storeId: targetStoreId,
        action,
        ...(action === "save" ? { weekStartRule, weekStartsOn } : {}),
      }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const authError = managerApiAuthError(response.status, result);
      if (authError) throw authError;
      throw new Error("1週間の区切りを保存できませんでした。");
    }
    return result;
  }

  async function loadPayroll(targetStoreId: string, preserveDrafts = false) {
    setError(null);
    setMessage("給与設定を読み込んでいます");
    const [result, weekBoundary] = await Promise.all([
      api({ action: "load", storeId: targetStoreId }),
      weekBoundaryApi(targetStoreId, "load"),
    ]);
    const next: PayrollData = {
      settings: result.settings,
      staff: result.staff,
      compensationTerms: result.compensationTerms,
      statutoryHolidayDates: result.statutoryHolidayDates ?? [],
      statutoryHolidayConfirmedMonths: result.statutoryHolidayConfirmedMonths ?? [],
      otherEmploymentConfirmations: result.otherEmploymentConfirmations ?? [],
      commutingAllowanceTerms: result.commutingAllowanceTerms ?? [],
    };
    setData(next);
    setWorkTimeSystem(result.settings?.work_time_system ?? "OTHER_REVIEW_REQUIRED");
    setWeekStartRule(weekBoundary.weekStartRule as WeekStartRule);
    setWeekStartsOn(Number(weekBoundary.weekStartsOn ?? 0));
    setOvertimeMonthRule(result.settings?.overtime_month_rule ?? "OTHER_REVIEW_REQUIRED");
    setStatutoryHolidayRule(result.settings?.statutory_holiday_rule ?? "OTHER_REVIEW_REQUIRED");
    setStatutoryHolidayWeekday(result.settings?.statutory_holiday_weekday ?? 0);
    setWageDrafts((current) => {
      const drafts: Record<string, WageDraft> = {};
      for (const staff of next.staff) drafts[staff.staff_id] = preserveDrafts && current[staff.staff_id] ? current[staff.staff_id] : { hourlyRate: "", effectiveFrom: todayJst() };
      return drafts;
    });
    setRevisionDrafts((current) => {
      const revisions: Record<string, WageDraft> = {};
      for (const staff of next.staff) revisions[staff.staff_id] = preserveDrafts && current[staff.staff_id] ? current[staff.staff_id] : { hourlyRate: "", effectiveFrom: todayJst() };
      return revisions;
    });
    setOtherEmploymentDrafts(Object.fromEntries(next.staff.map((staff) => {
      const confirmation = next.otherEmploymentConfirmations.find((item) => item.staff_id === staff.staff_id);
      return [staff.staff_id, confirmation?.status ?? "UNKNOWN"];
    })));
    setCommutingDrafts(Object.fromEntries(next.staff.map((staff) => {
      const current = next.commutingAllowanceTerms.find((term) => term.staff_id === staff.staff_id && term.effective_to === null);
      return [staff.staff_id, { method: current?.method ?? "MONTHLY_PASS", amount: "", effectiveFrom: todayJst(), basisConfirmed: false }];
    })));
    if (!preserveDrafts) setSavedInitialStaffIds([]);
    setMessage("");
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) { liff.login({ redirectUri: window.location.href }); return; }
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
        const response = await fetch("/api/manager/session", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken }) });
        const session = await response.json();
        if (!response.ok || !session.ok) {
          throw managerApiAuthError(response.status, session) ?? new Error("管理者情報を確認できませんでした。");
        }
        if (!active) return;
        const nextMemberships = session.manager.memberships as Membership[];
        setMemberships(nextMemberships);
        const firstStoreId = nextMemberships[0]?.store_id ?? "";
        if (!firstStoreId) throw new Error("対象店舗がありません。");
        setStoreId(firstStoreId);
        await loadPayroll(firstStoreId);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "給与設定を読み込めませんでした。");
        setMessage("");
      }
    })();
    return () => { active = false; };
  }, []);

  async function changeStore(nextStoreId: string) {
    setStoreId(nextStoreId);
    try { await loadPayroll(nextStoreId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "給与設定を読み込めませんでした。"); }
  }

  async function saveStoreSettings() {
    if (!storeId) return;
    setSavingStore(true); setError(null);
    try {
      const result = await api({ action: "saveStoreSettings", storeId, workTimeSystem, overtimeMonthRule, statutoryHolidayRule, statutoryHolidayWeekday: statutoryHolidayRule === "FIXED_WEEKDAY" ? statutoryHolidayWeekday : null });
      const savedWeekBoundary = await weekBoundaryApi(storeId, "save");
      setWeekStartRule(savedWeekBoundary.weekStartRule as WeekStartRule);
      setWeekStartsOn(Number(savedWeekBoundary.weekStartsOn ?? 0));
      let savedDates: string[] | null = null;
      if (statutoryHolidayRule === "MANUAL_DATES" && holidayMonthReviewed) {
        const holidayResult = await api({ action: "saveStatutoryHolidayMonth", storeId, holidayMonth, holidayDates: selectedHolidayDates });
        savedDates = holidayResult.statutoryHolidayDates as string[];
      }
      setData((current) => {
        if (!current) return current;
        const next = { ...current, settings: result.settings };
        if (!savedDates) return next;
        const outsideMonth = current.statutoryHolidayDates.filter((date) => !date.startsWith(`${holidayMonth}-`));
        return {
          ...next,
          statutoryHolidayDates: [...outsideMonth, ...savedDates].sort(),
          statutoryHolidayConfirmedMonths: [...new Set([...current.statutoryHolidayConfirmedMonths, holidayMonth])].sort(),
        };
      });
      if (savedDates) setSelectedHolidayDates(savedDates);
      if (statutoryHolidayRule !== "MANUAL_DATES") setMessage("店舗ルールと1週間の区切りを保存しました。");
      else if (savedDates) setMessage(`店舗ルール・1週間の区切り・${holidayMonth}の法定休日（確認済み）を保存しました。`);
      else setMessage("店舗ルールと1週間の区切りを保存しました。法定休日は「この月の法定休日をすべて確認しました」にチェックしていないため更新していません。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存できませんでした。"); }
    finally { setSavingStore(false); }
  }

  function toggleHolidayDate(date: string) {
    setSelectedHolidayDates((current) => current.includes(date) ? current.filter((item) => item !== date) : [...current, date].sort());
    setHolidayMonthReviewed(false);
  }

  async function saveInitialWages() {
    if (!storeId || !data) return;
    const targets = data.staff.flatMap((staff) => {
      if (currentTerms.has(staff.staff_id)) return [];
      const draft = wageDrafts[staff.staff_id];
      if (!draft?.hourlyRate.trim()) return [];
      return [{ staff, draft }];
    });
    if (targets.length === 0) { setError("登録するスタッフの時給を入力してください。"); return; }
    for (const { staff, draft } of targets) {
      const rate = Number(draft.hourlyRate);
      if (!Number.isInteger(rate) || rate <= 0 || !draft.effectiveFrom) { setError(`${staff.legal_name}さんの時給と適用開始日を確認してください。`); return; }
    }
    setSavingInitialWages(true); setError(null);
    try {
      const result = await api({
        action: "saveInitialCompensationTerms",
        storeId,
        initialCompensationTerms: targets.map(({ staff, draft }) => ({
          staffId: staff.staff_id,
          hourlyRateYen: Number(draft.hourlyRate),
          effectiveFrom: draft.effectiveFrom,
        })),
      });
      const savedTerms = result.compensationTerms as CompensationTerm[];
      const savedIds = savedTerms.map((term) => term.staff_id);
      setData((current) => current ? { ...current, compensationTerms: [...current.compensationTerms, ...savedTerms] } : current);
      setSavedInitialStaffIds((current) => [...new Set([...current, ...savedIds])]);
      setWageDrafts((current) => {
        const next = { ...current };
        for (const staffId of savedIds) next[staffId] = { hourlyRate: "", effectiveFrom: todayJst() };
        return next;
      });
      setMessage(`${savedTerms.length}名の時給を保存しました。`);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "時給を登録できませんでした。"); }
    finally { setSavingInitialWages(false); }
  }

  async function reviseWage(staffId: string) {
    const draft = revisionDrafts[staffId];
    const current = currentTerms.get(staffId);
    const rate = Number(draft?.hourlyRate ?? "");
    if (!current || !Number.isInteger(rate) || rate <= 0 || !draft?.effectiveFrom) { setError("新しい時給と改定日を確認してください。"); return; }
    if (draft.effectiveFrom <= current.effective_from) { setError("改定日は現在の時給の開始日より後の日付を指定してください。"); return; }
    setRevisingStaffId(staffId); setError(null);
    try {
      await api({ action: "reviseCompensationTerm", storeId, staffId, hourlyRateYen: rate, effectiveFrom: draft.effectiveFrom });
      await loadPayroll(storeId, true);
      setMessage("時給を改定しました。過去の時給履歴は保持されています。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "時給を改定できませんでした。"); }
    finally { setRevisingStaffId(null); }
  }

  async function confirmOtherEmployment(staffId: string) {
    const otherEmploymentStatus = otherEmploymentDrafts[staffId];
    if (!storeId || !otherEmploymentStatus) return;
    setSavingOtherEmploymentStaffId(staffId); setError(null);
    try {
      const result = await api({ action: "confirmOtherEmployment", storeId, staffId, otherEmploymentStatus });
      const saved = result.otherEmploymentConfirmation as OtherEmploymentConfirmation;
      setData((current) => current ? {
        ...current,
        otherEmploymentConfirmations: [
          ...current.otherEmploymentConfirmations.filter((item) => item.staff_id !== staffId),
          saved,
        ],
      } : current);
      setMessage("他の勤務先の状況を確認済みとして保存しました。状況が変わったときはいつでも更新してください。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "他の勤務先の状況を保存できませんでした。"); }
    finally { setSavingOtherEmploymentStaffId(null); }
  }

  async function saveCommutingAllowance(staffId: string) {
    const draft = commutingDrafts[staffId];
    const amount = Number(draft?.amount);
    if (!draft || !Number.isInteger(amount) || amount < 0 || !draft.effectiveFrom || !draft.basisConfirmed) {
      setError("通勤手当の金額・適用開始日を入力し、算定根拠の確認にチェックしてください。"); return;
    }
    setSavingCommutingStaffId(staffId); setError(null);
    try {
      const result = await api({ action: "saveCommutingAllowance", storeId, staffId, commutingMethod: draft.method, commutingAmountYen: amount, commutingBasisConfirmed: true, effectiveFrom: draft.effectiveFrom });
      const saved = result.commutingAllowanceTerm as CommutingAllowanceTerm;
      setData((current) => current ? { ...current, commutingAllowanceTerms: [...current.commutingAllowanceTerms.map((term) => term.staff_id === staffId && term.effective_to === null ? { ...term, effective_to: new Date(new Date(`${saved.effective_from}T00:00:00Z`).getTime() - 86400000).toISOString().slice(0, 10) } : term), saved] } : current);
      setCommutingDrafts((current) => ({ ...current, [staffId]: { ...draft, amount: "", basisConfirmed: false } }));
      setMessage("通勤手当を適用履歴として保存しました。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "通勤手当を保存できませんでした。"); }
    finally { setSavingCommutingStaffId(null); }
  }

  const unregisteredCount = (data?.staff ?? []).filter((staff) => !currentTerms.has(staff.staff_id)).length;

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div><p className={styles.eyebrow}>ONOGAMI 給与集計</p><h1>給与設定</h1><p className={styles.lead}>必要な条件だけ登録します。税・社会保険の設定はまだありません。</p></div>
        <a className={styles.backLink} href="/manager">管理画面へ戻る</a>
      </header>

      {memberships.length > 1 && <section className={styles.card}><label className={styles.label} htmlFor="store">店舗</label><select id="store" className={styles.select} value={storeId} onChange={(event) => void changeStore(event.target.value)}>{memberships.map((membership) => <option key={membership.store_id} value={membership.store_id}>{membership.store_name}</option>)}</select></section>}
      {message && <p className={styles.message}>{message}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <section className={styles.card}>
        <h2>1. 店舗の勤務・残業ルール</h2>
        <p className={styles.help}>分からない項目は「要確認」のままにできます。その場合、給与額は自動確定しません。</p>
        <label className={styles.label}>法定労働時間</label>
        <select className={styles.select} value={workTimeSystem} onChange={(event) => setWorkTimeSystem(event.target.value as Settings["work_time_system"])}><option value="OTHER_REVIEW_REQUIRED">要確認（まだ分からない）</option><option value="STANDARD_40H">原則：週40時間</option><option value="SPECIAL_44H">特例：週44時間</option></select>
        {workTimeSystem === "SPECIAL_44H" && <p className={styles.revisionNote}>週44時間特例は対象事業場の条件を満たしている場合だけ選択してください。飲食店という理由だけでは自動適用しません。</p>}

        <label className={styles.label}>1週間の区切り</label>
        <select className={styles.select} value={weekStartRule} onChange={(event) => setWeekStartRule(event.target.value as WeekStartRule)}>
          <option value="OTHER_REVIEW_REQUIRED">要確認（まだ分からない）</option>
          <option value="CALENDAR_DEFAULT">特に定めなし（日曜日〜土曜日）</option>
          <option value="EXPLICIT_WEEKDAY">就業規則等で曜日を定めている</option>
        </select>
        {weekStartRule === "EXPLICIT_WEEKDAY" && <select className={styles.select} value={weekStartsOn} onChange={(event) => setWeekStartsOn(Number(event.target.value))}>{weekdays.map((name, index) => <option value={index} key={name}>{name}</option>)}</select>}
        <p className={styles.revisionNote}>週40時間超などを判定するための区切りです。特に定めがなければ日曜日〜土曜日として扱います。</p>

        <label className={styles.label}>月60時間超の残業を数える1か月</label>
        <select className={styles.select} value={overtimeMonthRule} onChange={(event) => setOvertimeMonthRule(event.target.value as Settings["overtime_month_rule"])}><option value="OTHER_REVIEW_REQUIRED">要確認（まだ分からない）</option><option value="PAY_PERIOD">給与の締め期間と同じ</option><option value="CALENDAR_MONTH">毎月1日〜月末</option></select>
        <p className={styles.revisionNote}>就業規則などで定めている1か月の区切りに合わせます。給与締め日と同じとは限りません。</p>
        <label className={styles.label}>法定休日</label>
        <select className={styles.select} value={statutoryHolidayRule} onChange={(event) => setStatutoryHolidayRule(event.target.value as Settings["statutory_holiday_rule"])}><option value="OTHER_REVIEW_REQUIRED">要確認（まだ分からない）</option><option value="FIXED_WEEKDAY">毎週同じ曜日</option><option value="MANUAL_DATES">日付を指定する</option></select>
        {statutoryHolidayRule === "FIXED_WEEKDAY" && <select className={styles.select} value={statutoryHolidayWeekday} onChange={(event) => setStatutoryHolidayWeekday(Number(event.target.value))}>{weekdays.map((name, index) => <option value={index} key={name}>{name}</option>)}</select>}
        {statutoryHolidayRule === "MANUAL_DATES" && (
          <div className={styles.revisionBox}>
            <strong>法定休日をまとめて登録</strong>
            <div className={styles.calendarToolbar}><label>対象月<input type="month" value={holidayMonth} onChange={(event) => setHolidayMonth(event.target.value)} /></label><div className={styles.calendarSummary}>選択中 {selectedHolidayDates.length}日</div></div>
            <div className={styles.calendarWeekdays}>{shortWeekdays.map((name) => <span key={name}>{name}</span>)}</div>
            <div className={styles.calendarGrid}>{calendarBlanks.map((_, index) => <span className={styles.calendarBlank} key={`blank-${index}`} />)}{calendarDates.map((date) => { const selected = selectedHolidayDates.includes(date); return <button type="button" key={date} className={`${styles.calendarDay} ${selected ? styles.calendarDaySelected : ""}`} aria-pressed={selected} onClick={() => toggleHolidayDate(date)}>{Number(date.slice(-2))}</button>; })}</div>
            <label className={styles.label}><input type="checkbox" checked={holidayMonthReviewed} onChange={(event) => setHolidayMonthReviewed(event.target.checked)} /> この月の法定休日をすべて確認しました</label>
            <p className={styles.revisionNote}>法定休日が0日でも、内容を確認してチェックしたうえで保存してください。日付を変更すると確認チェックは自動で外れます。</p>
          </div>
        )}
        <p className={styles.revisionNote}>法定休日は「店休日」と同じとは限りません。4週4休など固定曜日以外の複雑な制度は、v1では無理に自動判定せず要確認にします。</p>
        <button className={styles.primaryButton} disabled={savingStore} onClick={() => void saveStoreSettings()}>{savingStore ? "保存中…" : statutoryHolidayRule === "MANUAL_DATES" ? "店舗ルール・週の区切り・法定休日を保存" : "店舗ルールと週の区切りを保存"}</button>
      </section>

      <section className={styles.card}>
        <h2>2. この店舗以外の勤務先の確認</h2>
        <p className={styles.help}>同じ会社の別店舗も含め、この店舗以外で働いているか確認します。入社時や勤務先の変更時に更新してください。最終確認から6か月を過ぎると、給与は要確認になり保存できません。</p>
        <div className={styles.staffList}>
          {(data?.staff ?? []).map((staff) => {
            const confirmation = data?.otherEmploymentConfirmations.find((item) => item.staff_id === staff.staff_id);
            const draft = otherEmploymentDrafts[staff.staff_id] ?? "UNKNOWN";
            const confirmedLabel = confirmation
              ? `${new Date(confirmation.confirmed_at).toLocaleDateString("ja-JP", { timeZone: "Asia/Tokyo" })} 確認${confirmation.confirmation_current ? "" : "（再確認が必要）"}`
              : "未確認";
            return <article className={styles.staffRow} key={staff.staff_id}>
              <div className={styles.staffIdentity}><strong>{staff.legal_name}</strong><span className={styles.inactive}>{confirmedLabel}</span></div>
              <div className={styles.inputs}>
                <label>この店舗以外の勤務先
                  <select value={draft} onChange={(event) => setOtherEmploymentDrafts((current) => ({ ...current, [staff.staff_id]: event.target.value as OtherEmploymentStatus }))}>
                    <option value="NONE">なし（この店舗だけ）</option>
                    <option value="HAS_OTHER_EMPLOYER">あり（同じ会社の別店舗・別会社）</option>
                    <option value="UNKNOWN">わからない</option>
                  </select>
                </label>
                <button className={styles.secondaryButton} disabled={savingOtherEmploymentStaffId === staff.staff_id} onClick={() => void confirmOtherEmployment(staff.staff_id)}>{savingOtherEmploymentStaffId === staff.staff_id ? "保存中…" : "確認済みとして保存"}</button>
              </div>
              {draft !== "NONE" && <p className={styles.revisionNote}>給与額は参考値として表示しますが、他の店舗・勤務先との労働時間の通算確認が必要なため保存は止まります。</p>}
            </article>;
          })}
        </div>
      </section>

      <section className={styles.card}>
        <h2>3. スタッフの時給</h2>
        <p className={styles.help}>未登録のスタッフは必要な人をまとめて入力し、最後に1回で登録できます。時給を変更するときは上書きせず、改定日で履歴を分けます。履歴を残すことで、過去月の再集計でも当時の時給を使えます。</p>
        <div className={styles.staffList}>
          {(data?.staff ?? []).map((staff) => {
            const term = currentTerms.get(staff.staff_id);
            const history = termsByStaff.get(staff.staff_id) ?? [];
            const draft = wageDrafts[staff.staff_id] ?? { hourlyRate: "", effectiveFrom: todayJst() };
            const revision = revisionDrafts[staff.staff_id] ?? { hourlyRate: "", effectiveFrom: todayJst() };
            return <article className={styles.staffRow} key={staff.staff_id}>
              <div className={styles.staffIdentity}><strong>{staff.legal_name}</strong>{staff.status !== "active" && <span className={styles.inactive}>在籍停止</span>}{savedInitialStaffIds.includes(staff.staff_id) && <span className={styles.inactive}>保存済み</span>}</div>
              {term ? <>
                <div className={styles.registered}><span>現在の登録</span><strong>{Number(term.hourly_rate_yen).toLocaleString("ja-JP")}円 / 時</strong><small>{term.effective_from} から</small></div>
                <div className={styles.revisionBox}><strong>時給を改定</strong><div className={styles.inputs}><label>新しい時給<input inputMode="numeric" value={revision.hourlyRate} onChange={(event) => setRevisionDrafts((current) => ({ ...current, [staff.staff_id]: { ...revision, hourlyRate: event.target.value } }))} placeholder="例 1300" /></label><label>改定日<input type="date" min={term.effective_from} value={revision.effectiveFrom} onChange={(event) => setRevisionDrafts((current) => ({ ...current, [staff.staff_id]: { ...revision, effectiveFrom: event.target.value } }))} /></label><button className={styles.secondaryButton} disabled={revisingStaffId === staff.staff_id} onClick={() => void reviseWage(staff.staff_id)}>{revisingStaffId === staff.staff_id ? "改定中…" : "改定する"}</button></div><p className={styles.revisionNote}>改定日前日までを現在の時給として残し、改定日から新しい時給を適用します。</p></div>
                {history.length > 1 && <div className={styles.historyBlock}><button className={styles.textButton} onClick={() => setShowHistoryFor((current) => current === staff.staff_id ? null : staff.staff_id)}>{showHistoryFor === staff.staff_id ? "履歴を閉じる" : `時給履歴を見る（${history.length}件）`}</button>{showHistoryFor === staff.staff_id && <ul className={styles.historyList}>{history.map((item) => <li key={item.id}><strong>{Number(item.hourly_rate_yen).toLocaleString("ja-JP")}円 / 時</strong><span>{item.effective_from} 〜 {item.effective_to ?? "現在"}</span></li>)}</ul>}</div>}
              </> : <div className={styles.inputs}><label>時給<input inputMode="numeric" value={draft.hourlyRate} onChange={(event) => setWageDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, hourlyRate: event.target.value } }))} placeholder="例 1200" /></label><label>適用開始日<input type="date" value={draft.effectiveFrom} onChange={(event) => setWageDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, effectiveFrom: event.target.value } }))} /></label></div>}
            </article>;
          })}
        </div>
        {unregisteredCount > 0 && <button className={`${styles.primaryButton} ${styles.fullButton}`} disabled={savingInitialWages} onClick={() => void saveInitialWages()}>{savingInitialWages ? "登録中…" : "入力した時給をまとめて保存"}</button>}
      </section>
      <section className={styles.card}>
        <h2>4. 通勤手当</h2>
        <p className={styles.help}>月額の定期代、または通勤距離等に基づく出勤1日あたりのガソリン代を登録します。税務上の非課税判定は行いません。金額変更は上書きせず履歴として残します。</p>
        <div className={styles.staffList}>{(data?.staff ?? []).map((staff) => {
          const term = currentCommutingTerms.get(staff.staff_id);
          const draft = commutingDrafts[staff.staff_id] ?? { method: "MONTHLY_PASS" as const, amount: "", effectiveFrom: todayJst(), basisConfirmed: false };
          return <article className={styles.staffRow} key={staff.staff_id}><div className={styles.staffIdentity}><strong>{staff.legal_name}</strong>{term && <span className={styles.inactive}>現在 {term.method === "MONTHLY_PASS" ? `定期代 月額 ${Number(term.amount_yen).toLocaleString("ja-JP")}円` : `ガソリン代 1出勤 ${Number(term.amount_yen).toLocaleString("ja-JP")}円`}</span>}</div><div className={styles.inputs}><label>支給方法<select value={draft.method} onChange={(event) => setCommutingDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, method: event.target.value as CommutingMethod, basisConfirmed: false } }))}><option value="MONTHLY_PASS">1か月の定期代</option><option value="PER_WORKDAY_GAS">出勤日ごとのガソリン代</option></select></label><label>{draft.method === "MONTHLY_PASS" ? "月額" : "1出勤あたり"}<input inputMode="numeric" value={draft.amount} onChange={(event) => setCommutingDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, amount: event.target.value, basisConfirmed: false } }))} placeholder="例 8000" /></label><label>適用開始日<input type="date" value={draft.effectiveFrom} onChange={(event) => setCommutingDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, effectiveFrom: event.target.value, basisConfirmed: false } }))} /></label></div><label className={styles.revisionNote}><input type="checkbox" checked={draft.basisConfirmed} onChange={(event) => setCommutingDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, basisConfirmed: event.target.checked } }))} /> {draft.method === "MONTHLY_PASS" ? "実際の定期代に基づく金額です" : "通勤距離・ガソリン代等に基づく金額です"}</label><button className={styles.secondaryButton} disabled={savingCommutingStaffId === staff.staff_id} onClick={() => void saveCommutingAllowance(staff.staff_id)}>{savingCommutingStaffId === staff.staff_id ? "保存中…" : term ? "通勤手当を改定" : "通勤手当を登録"}</button><p className={styles.revisionNote}>{draft.method === "MONTHLY_PASS" ? "対象期間を通して同じ条件が有効で、出勤実績がある場合に月額を1回加算します。自動日割りはしません。" : "給与期間内の実出勤日数を掛けて計算します。"}</p></article>;
        })}</div>
      </section>
    </main>
  );
}
