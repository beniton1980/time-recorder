"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import styles from "./payroll.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";

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
};

type PayrollData = {
  settings: Settings | null;
  staff: Staff[];
  compensationTerms: CompensationTerm[];
};

function todayJst() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export default function PayrollSettingsPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [data, setData] = useState<PayrollData | null>(null);
  const [message, setMessage] = useState("給与設定を読み込んでいます");
  const [error, setError] = useState<string | null>(null);
  const [savingStore, setSavingStore] = useState(false);
  const [workTimeSystem, setWorkTimeSystem] = useState<Settings["work_time_system"]>("OTHER_REVIEW_REQUIRED");
  const [wageDrafts, setWageDrafts] = useState<Record<string, { hourlyRate: string; effectiveFrom: string }>>({});
  const [savingStaffId, setSavingStaffId] = useState<string | null>(null);

  const currentTerms = useMemo(() => {
    const map = new Map<string, CompensationTerm>();
    for (const term of data?.compensationTerms ?? []) {
      if (!map.has(term.staff_id)) map.set(term.staff_id, term);
    }
    return map;
  }, [data]);

  async function api(body: Record<string, unknown>) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/settings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...body, idToken }),
    });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      if (result.code === "COMPENSATION_HISTORY_EXISTS") {
        throw new Error("このスタッフにはすでに給与条件があります。変更機能は次の段階で安全に追加します。");
      }
      if (result.code === "PAYROLL_SETTINGS_UNAVAILABLE") {
        throw new Error("給与設定の準備がまだ完了していません。");
      }
      throw new Error("給与設定を保存できませんでした。");
    }
    return result;
  }

  async function loadPayroll(targetStoreId: string) {
    setError(null);
    setMessage("給与設定を読み込んでいます");
    const result = await api({ action: "load", storeId: targetStoreId });
    const next: PayrollData = {
      settings: result.settings,
      staff: result.staff,
      compensationTerms: result.compensationTerms,
    };
    setData(next);
    setWorkTimeSystem(result.settings?.work_time_system ?? "OTHER_REVIEW_REQUIRED");
    const drafts: Record<string, { hourlyRate: string; effectiveFrom: string }> = {};
    for (const staff of next.staff) drafts[staff.staff_id] = { hourlyRate: "", effectiveFrom: todayJst() };
    setWageDrafts(drafts);
    setMessage("");
  }

  useEffect(() => {
    let active = true;
    (async () => {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const idToken = liff.getIDToken();
        if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
        const response = await fetch("/api/manager/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
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
      await api({ action: "saveStoreSettings", storeId, workTimeSystem });
      await loadPayroll(storeId);
      setMessage("店舗の給与設定を保存しました。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "保存できませんでした。"); }
    finally { setSavingStore(false); }
  }

  async function saveInitialWage(staffId: string) {
    const draft = wageDrafts[staffId];
    const rate = Number(draft?.hourlyRate ?? "");
    if (!Number.isInteger(rate) || rate <= 0 || !draft?.effectiveFrom) {
      setError("時給と適用開始日を確認してください。");
      return;
    }
    setSavingStaffId(staffId); setError(null);
    try {
      await api({ action: "createInitialCompensationTerm", storeId, staffId, hourlyRateYen: rate, effectiveFrom: draft.effectiveFrom });
      await loadPayroll(storeId);
      setMessage("時給を登録しました。");
    } catch (caught) { setError(caught instanceof Error ? caught.message : "時給を登録できませんでした。"); }
    finally { setSavingStaffId(null); }
  }

  return (
    <main className={styles.page}>
      <header className={styles.header}>
        <div>
          <p className={styles.eyebrow}>ONOGAMI 給与集計</p>
          <h1>給与設定</h1>
          <p className={styles.lead}>最初に必要な条件だけ登録します。税・社会保険の設定はまだありません。</p>
        </div>
        <a className={styles.backLink} href="/manager">管理画面へ戻る</a>
      </header>

      {memberships.length > 1 && (
        <section className={styles.card}>
          <label className={styles.label} htmlFor="store">店舗</label>
          <select id="store" className={styles.select} value={storeId} onChange={(event) => void changeStore(event.target.value)}>
            {memberships.map((membership) => <option key={membership.store_id} value={membership.store_id}>{membership.store_name}</option>)}
          </select>
        </section>
      )}

      {message && <p className={styles.message}>{message}</p>}
      {error && <p className={styles.error}>{error}</p>}

      <section className={styles.card}>
        <h2>1. 店舗の勤務制度</h2>
        <p className={styles.help}>分からない場合は「要確認」のままにできます。その場合、給与額は自動確定しません。</p>
        <select className={styles.select} value={workTimeSystem} onChange={(event) => setWorkTimeSystem(event.target.value as Settings["work_time_system"])}>
          <option value="OTHER_REVIEW_REQUIRED">要確認（まだ分からない）</option>
          <option value="STANDARD_40H">原則：週40時間</option>
          <option value="SPECIAL_44H">特例：週44時間</option>
        </select>
        <button className={styles.primaryButton} disabled={savingStore} onClick={() => void saveStoreSettings()}>{savingStore ? "保存中…" : "保存する"}</button>
      </section>

      <section className={styles.card}>
        <h2>2. スタッフの時給</h2>
        <p className={styles.help}>初回登録だけを先に用意しています。登録済み時給の変更は履歴を壊さない専用画面を次に追加します。</p>
        <div className={styles.staffList}>
          {(data?.staff ?? []).map((staff) => {
            const term = currentTerms.get(staff.staff_id);
            const draft = wageDrafts[staff.staff_id] ?? { hourlyRate: "", effectiveFrom: todayJst() };
            return (
              <article className={styles.staffRow} key={staff.staff_id}>
                <div className={styles.staffIdentity}>
                  <strong>{staff.legal_name}</strong>
                  {staff.status !== "active" && <span className={styles.inactive}>在籍停止</span>}
                </div>
                {term ? (
                  <div className={styles.registered}>
                    <span>現在の登録</span>
                    <strong>{Number(term.hourly_rate_yen).toLocaleString("ja-JP")}円 / 時</strong>
                    <small>{term.effective_from} から</small>
                  </div>
                ) : (
                  <div className={styles.inputs}>
                    <label>時給<input inputMode="numeric" value={draft.hourlyRate} onChange={(event) => setWageDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, hourlyRate: event.target.value } }))} placeholder="例 1200" /></label>
                    <label>適用開始日<input type="date" value={draft.effectiveFrom} onChange={(event) => setWageDrafts((current) => ({ ...current, [staff.staff_id]: { ...draft, effectiveFrom: event.target.value } }))} /></label>
                    <button className={styles.secondaryButton} disabled={savingStaffId === staff.staff_id} onClick={() => void saveInitialWage(staff.staff_id)}>{savingStaffId === staff.staff_id ? "登録中…" : "登録"}</button>
                  </div>
                )}
              </article>
            );
          })}
        </div>
      </section>
    </main>
  );
}
