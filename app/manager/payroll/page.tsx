"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import styles from "./payroll.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
const weekdays = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];
const shortWeekdays = ["日", "月", "火", "水", "木", "金", "土"];

type Membership = { store_id: string; store_name: string };
type Staff = { staff_id: string; legal_name: string; status: "active" | "inactive" };
type CompensationTerm = {
  id: string;
  staff_id: string;
  hourly_rate_yen: number;
  effective_from: string;
  effective_to: string | null;
};
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
  const [overtimeMonthRule, setOvertimeMonthRule] = useState<Settings["overtime_month_rule"]>("OTHER_REVIEW_REQUIRED");
  const [statutoryHolidayRule, setStatutoryHolidayRule] = useState<Settings["statutory_holiday_rule"]>("OTHER_REVIEW_REQUIRED");
  const [statutoryHolidayWeekday, setStatutoryHolidayWeekday] = useState(0);
  const [holidayMonth, setHolidayMonth] = useState(todayJst().slice(0, 7));
  const [selectedHolidayDates, setSelectedHolidayDates] = useState<string[]>([]);
  const [wageDrafts, setWageDrafts] = useState<Record<string, WageDraft>>({});
  const [revisionDrafts, setRevisionDrafts] = useState<Record<string, WageDraft>>({});
  const [savingInitialWages, setSavingInitialWages] = useState(false);
  const [revisingStaffId, setRevisingStaffId] = useState<string | null>(null);
  const [showHistoryFor, setShowHistoryFor] = useState<string | null>(null);
  const [savedInitialStaffIds, setSavedInitialStaffIds] = useState<string[]>([]);

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

  const calendarDates = useMemo(() => datesForMonth(holidayMonth), [holidayMonth]);
  const calendarBlanks = useMemo(() => Array.from({ length: firstWeekday(holidayMonth) }), [holidayMonth]);

  useEffect(() => {
    setSelectedHolidayDates((data?.statutoryHolidayDates ?? []).filter((date) => date.startsWith(`${holidayMonth}-`)));
  }, [data?.statutoryHolidayDates, holidayMonth]);

  async function api(body: Record<string, unknown>) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/settings", {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, idToken }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      if (result.code === "COMPENSATION_HISTORY_EXISTS") throw new Error("このスタッフにはすでに給与条件があります。");
      if (result.code === "COMPENSATION_REVISION_DATE_INVALID") throw new Error("改定日は現在の時給の開始日より後の日付を指定してください。");
      if (result.code === "COMPENSATION_PERIOD_OVERLAP") throw new Error("その改定日は既存の時給期間と重なります。履歴を確認してください。");
      if (result.code === "COMPENSATION_CURRENT_TERM_REQUIRED") throw new Error("現在有効な時給を1件に特定できません。履歴を確認してください。");
      if (result.code === "INVALID_PAYROLL_STORE_SETTINGS") throw new Error("勤務制度・残業の区切り・法定休日の設定を確認してください。");
      if (result.code === "INVALID_STATUTORY_HOLIDAY_DATE") throw new Error("法定休日の日付を確認してください。");
      if (result.code === "STATUTORY_HOLIDAY_SAVE_NOT_VERIFIED") throw new Error("法定休日をDBへ保存できませんでした。もう一度お試しください。");
      if (result.code === "INVALID_COMPENSATION_TERM") throw new Error("時給と適用開始日を確認してください。");
      if (result.code === "PAYROLL_SETTINGS_UNAVAILABLE") throw new Error("給与設定を利用できませんでした。");
      throw new Error("給与設定を保存できませんでした。");
    }
    return result;
  }

  async function loadPayroll(targetStoreId: string, preserveDrafts = false) {
    setError(null);
    setMessage("給与設定を読み込んでいます");
    const result = await api({ action: "load", storeId: targetStoreId });
    const next: PayrollData = {
      settings: result.settings,
      staff: result.staff,
      compensationTerms: result.compensationTerms,
      statutoryHolidayDates: result.statutoryHolidayDates ?? [],
    };
    setData(next);
    setWorkTimeSystem(result.settings?.work_time_system ?? "OTHER_REVIEW_REQUIRED");
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
        if (!response.ok || !session.ok) throw new Error("管理者権限を確認できませんでした。");
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
      let savedDates: string[] | null = null;
      if (statutoryHolidayRule === "MANUAL_DATES") {
        const holidayResult = await api({ action: "saveStatutoryHolidayMonth", storeId, holidayMonth, holidayDates: selectedHolidayDates });
        savedDates = holidayResult.statutoryHolidayDates as string[];
      }
      setData((current) => {
        if (!current) return current;
        const next = { ...current, settings: result.settings };
        if (!savedDates) return next;
        const outsideMonth = current.statutoryHolidayDates.filter((date) => !date.startsWith(`${holidayMonth}-`));
        return { ...next, statutoryHolidayDates: [...outsideMonth, ...savedDates].sort() };
      });
      if (savedDates) setSelectedHolidayDates(savedDates);
      setMessage(statutoryHolidayRule === "MANUAL_DATES" ? "店舗ルールと法定休日を保存しました。" : "店舗の給与設定を保存しました。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存できませんでした。"); }
    finally { setSavingStore(false); }
  }

  function toggleHolidayDate(date: string) {
    setSelectedHolidayDates((current) => current.includes(date) ? current.filter((item) => item !== date) : [...current, date].sort());
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
            <p className={styles.revisionNote}>日付を選んだら、この項目の下にある「店舗ルールと法定休日を保存」を1回押してください。選択した日付も同時に保存します。</p>
          </div>
        )}
        <p className={styles.revisionNote}>法定休日は「店休日」と同じとは限りません。4週4休など固定曜日以外の複雑な制度は、v1では無理に自動判定せず要確認にします。</p>
        <button className={styles.primaryButton} disabled={savingStore} onClick={() => void saveStoreSettings()}>{savingStore ? "保存中…" : statutoryHolidayRule === "MANUAL_DATES" ? "店舗ルールと法定休日を保存" : "店舗ルールを保存"}</button>
      </section>

      <section className={styles.card}>
        <h2>2. スタッフの時給</h2>
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
    </main>
  );
}
