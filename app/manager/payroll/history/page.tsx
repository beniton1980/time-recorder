"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import { managerApiAuthError } from "@/lib/manager-api-auth-error";
import styles from "../payroll.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
type Membership = { store_id: string; store_name: string };
type PayrollRun = { id: string; period_start: string; period_end: string; gross_pay_yen: number; calculation_spec_version: string; saved_at: string; staff_count: number };
type PayrollItem = { staff_id: string; legal_name_snapshot: string; hourly_rates_used: number[]; minutes_snapshot: { worked?: number }; components_snapshot: Record<string, number>; gross_pay_yen: number };
type RunDetail = { run: PayrollRun; items: PayrollItem[] };

function savedAt(value: string) { return new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); }
function hours(minutes = 0) { return `${Math.floor(minutes / 60)}時間${minutes % 60}分`; }
function componentLabel(name: string) {
  return ({ basePay: "基本給", overtimePremium: "時間外割増", highOvertimePremium: "月60時間超割増", statutoryHolidayPremium: "法定休日割増", lateNightPremium: "深夜割増", adjustments: "調整額" } as Record<string, string>)[name] ?? name;
}

export default function PayrollHistoryPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  async function historyApi(targetStore: string, runId?: string) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/history", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeId: targetStore, runId }) });
    const result = await response.json();
    if (!response.ok || !result.ok) {
      const authError = managerApiAuthError(response.status, result);
      if (authError) throw authError;
      throw new Error("保存済み給与を読み込めませんでした。");
    }
    return result;
  }

  async function loadRuns(targetStore: string) {
    setLoading(true); setError(null); setDetail(null);
    try { const result = await historyApi(targetStore); setRuns(result.runs as PayrollRun[]); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "保存済み給与を読み込めませんでした。"); }
    finally { setLoading(false); }
  }

  async function loadDetail(runId: string) {
    setLoading(true); setError(null);
    try { setDetail(await historyApi(storeId, runId) as RunDetail); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "給与の内訳を読み込めませんでした。"); }
    finally { setLoading(false); }
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
        const next = session.manager.memberships as Membership[];
        const first = next[0]?.store_id ?? "";
        setMemberships(next); setStoreId(first);
        if (!first) throw new Error("対象店舗がありません。");
        await loadRuns(first);
      } catch (caught) { if (active) { setError(caught instanceof Error ? caught.message : "読み込めませんでした。"); setLoading(false); } }
    })();
    return () => { active = false; };
  }, []);

  return <main className={`${styles.page} ${styles.previewPage}`}>
    <header className={styles.header}><div><p className={styles.eyebrow}>ONOGAMI 給与集計</p><h1>保存済み給与</h1><p className={styles.lead}>保存時点の集計結果を、そのまま閲覧できます。過去の記録は変更されません。</p></div><a className={styles.backLink} href="/manager/payroll/preview">給与プレビューへ戻る</a></header>
    {error && <p className={styles.error}>{error}</p>}
    {memberships.length > 1 && <section className={styles.card}><label className={styles.label}>店舗</label><select className={styles.select} value={storeId} onChange={(e) => { setStoreId(e.target.value); void loadRuns(e.target.value); }}>{memberships.map((m) => <option value={m.store_id} key={m.store_id}>{m.store_name}</option>)}</select></section>}
    {loading && <p className={styles.message}>保存済み給与を読み込んでいます…</p>}
    {!detail && !loading && <section className={styles.card}><h2>保存履歴</h2>{runs.length === 0 ? <p className={styles.revisionNote}>保存済みの給与集計はありません。</p> : <ul className={styles.historyList}>{runs.map((run) => <li key={run.id}><button className={`${styles.secondaryButton} ${styles.fullButton}`} onClick={() => void loadDetail(run.id)}><span>{run.period_start} 〜 {run.period_end}<small>保存 {savedAt(run.saved_at)} / {run.staff_count}名</small></span><strong>{Number(run.gross_pay_yen).toLocaleString("ja-JP")}円</strong></button></li>)}</ul>}</section>}
    {detail && <><section className={`${styles.card} ${styles.summaryCard}`}><button className={styles.secondaryButton} onClick={() => setDetail(null)}>履歴一覧へ戻る</button><div className={styles.registered}><span>{detail.run.period_start} 〜 {detail.run.period_end}</span><strong>{Number(detail.run.gross_pay_yen).toLocaleString("ja-JP")}円</strong><small>保存 {savedAt(detail.run.saved_at)} / {detail.items.length}名</small></div><p className={styles.revisionNote}>計算仕様 {detail.run.calculation_spec_version}</p></section><section className={styles.card}><h2>スタッフ別内訳</h2><div className={styles.staffGrid}>{detail.items.map((item) => <article className={styles.staffResultCard} key={item.staff_id}><div className={styles.staffIdentity}><strong>{item.legal_name_snapshot}</strong><span className={styles.inactive}>保存済み</span></div><div className={styles.registered}><span>控除前の総支給額</span><strong>{Number(item.gross_pay_yen).toLocaleString("ja-JP")}円</strong><small>実働 {hours(item.minutes_snapshot.worked)}</small></div><div className={styles.revisionBox}><strong>保存時の金額内訳</strong><ul className={styles.historyList}>{Object.entries(item.components_snapshot).map(([name, amount]) => <li key={name}><span>{componentLabel(name)}</span><strong>{Number(amount).toLocaleString("ja-JP")}円</strong></li>)}</ul></div></article>)}</div></section></>}
  </main>;
}
