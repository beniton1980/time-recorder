"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import { managerApiAuthError } from "@/lib/manager-api-auth-error";
import styles from "../payroll.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
type Membership = { store_id: string; store_name: string };
type PayrollRun = { id: string; period_start: string; period_end: string; gross_pay_yen: number; calculation_spec_version: string; saved_at: string; staff_count: number; version_number: number; version_count: number; is_latest: boolean };
type PayrollItem = { staff_id: string; legal_name_snapshot: string; hourly_rates_used: number[]; minutes_snapshot: { worked?: number }; components_snapshot: Record<string, number>; gross_pay_yen: number };
type ValueChange = { key: string; previous: number; current: number; delta: number };
type StaffChange = { staffId: string; status: "ADDED" | "REMOVED" | "CHANGED"; previousName: string | null; currentName: string | null; previousGrossPayYen: number | null; currentGrossPayYen: number | null; grossPayDeltaYen: number; minuteChanges: ValueChange[]; componentChanges: ValueChange[]; nameChanged: boolean };
type Comparison = { previousRun: PayrollRun; summary: { previousGrossPayYen: number; currentGrossPayYen: number; grossPayDeltaYen: number; previousStaffCount: number; currentStaffCount: number; changedStaffCount: number; addedStaffCount: number; removedStaffCount: number }; changes: StaffChange[] };
type RunDetail = { run: PayrollRun; items: PayrollItem[]; comparison: Comparison | null };

function savedAt(value: string) { return new Date(value).toLocaleString("ja-JP", { timeZone: "Asia/Tokyo" }); }
function hours(minutes = 0) { return `${Math.floor(minutes / 60)}時間${minutes % 60}分`; }
function componentLabel(name: string) {
  return ({ basePay: "基本給", overtimePremium: "時間外割増", highOvertimePremium: "月60時間超割増", statutoryHolidayPremium: "法定休日割増", lateNightPremium: "深夜割増", adjustments: "調整額" } as Record<string, string>)[name] ?? name;
}
function minuteLabel(name: string) { return ({ worked: "実働", statutoryOvertime: "法定時間外", highOvertime: "月60時間超", statutoryHoliday: "法定休日", lateNight: "深夜" } as Record<string, string>)[name] ?? name; }
function yen(value: number | null) { return value == null ? "—" : `${Number(value).toLocaleString("ja-JP")}円`; }
function signedYen(value: number) { return `${value > 0 ? "+" : ""}${Number(value).toLocaleString("ja-JP")}円`; }
function signedMinutes(value: number) { const absolute = Math.abs(value); return `${value > 0 ? "+" : value < 0 ? "−" : ""}${hours(absolute)}`; }
function changeStatus(change: StaffChange) { return change.status === "ADDED" ? "今回の集計対象に追加" : change.status === "REMOVED" ? "今回の集計対象から外れた" : "金額・時間等に変更"; }
function versionLabel(run: PayrollRun) {
  if (run.version_count <= 1) return "保存済み";
  return run.is_latest ? `最新版・第${run.version_number}版` : `以前の保存・第${run.version_number}版`;
}

export default function PayrollHistoryPage() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [runs, setRuns] = useState<PayrollRun[]>([]);
  const [detail, setDetail] = useState<RunDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exportingRunId, setExportingRunId] = useState<string | null>(null);

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

  async function downloadCsv(run: PayrollRun) {
    if (!run.is_latest || exportingRunId) return;
    setExportingRunId(run.id); setError(null);
    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
      const response = await fetch("/api/manager/payroll/history/csv", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken, storeId, runId: run.id }),
      });
      if (!response.ok) {
        const result = await response.json();
        const authError = managerApiAuthError(response.status, result);
        if (authError) throw authError;
        if (result.code === "PAYROLL_RUN_NOT_LATEST") throw new Error("この期間には新しい保存結果があります。最新版を開いてCSVを出力してください。");
        if (result.code === "PAYROLL_SNAPSHOT_INCOMPLETE") throw new Error("保存結果の完全性を確認できないため、CSV出力を停止しました。");
        throw new Error("給与CSVを出力できませんでした。");
      }
      const blob = await response.blob();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = `ONOGAMI-控除前給与集計-${run.period_start}-${run.period_end}-第${run.version_number}版.csv`;
      document.body.appendChild(anchor); anchor.click(); anchor.remove(); URL.revokeObjectURL(url);
    } catch (caught) { setError(caught instanceof Error ? caught.message : "給与CSVを出力できませんでした。"); }
    finally { setExportingRunId(null); }
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
    {!detail && !loading && <section className={styles.card}><h2>保存履歴</h2>{runs.length === 0 ? <p className={styles.revisionNote}>保存済みの給与集計はありません。</p> : <ul className={styles.historyList}>{runs.map((run) => <li key={run.id}><button className={`${styles.secondaryButton} ${styles.fullButton}`} onClick={() => void loadDetail(run.id)}><span>{run.period_start} 〜 {run.period_end}<small>{versionLabel(run)} / 保存 {savedAt(run.saved_at)} / {run.staff_count}名</small></span><strong>{Number(run.gross_pay_yen).toLocaleString("ja-JP")}円</strong></button></li>)}</ul>}</section>}
    {detail && <><section className={`${styles.card} ${styles.summaryCard}`}><button className={styles.secondaryButton} onClick={() => setDetail(null)}>履歴一覧へ戻る</button><div className={styles.registered}><span>{detail.run.period_start} 〜 {detail.run.period_end}</span><strong>{Number(detail.run.gross_pay_yen).toLocaleString("ja-JP")}円</strong><small>{versionLabel(detail.run)} / 保存 {savedAt(detail.run.saved_at)} / {detail.items.length}名</small></div><p className={styles.revisionNote}>{detail.run.is_latest ? "この期間で最後に保存した結果です。" : "この期間の以前の保存結果です。最新の保存結果と間違えないようご注意ください。"} 計算仕様 {detail.run.calculation_spec_version}</p>{detail.run.is_latest ? <><button className={`${styles.primaryButton} ${styles.fullButton}`} disabled={exportingRunId !== null} onClick={() => void downloadCsv(detail.run)}>{exportingRunId === detail.run.id ? "CSVを作成中…" : "最新版の控除前給与集計をCSV出力"}</button><p className={styles.revisionNote}>税・社会保険等の控除、手取り額、振込情報は含みません。氏名と給与額を含むため、ファイルの取扱いにご注意ください。</p></> : <p className={styles.revisionNote}>以前の保存結果は誤使用を防ぐためCSV出力できません。履歴一覧から最新版を開いてください。</p>}</section>
    {detail.comparison && <section className={styles.card}><h2>前回保存版からの変更</h2><p className={styles.revisionNote}>第{detail.comparison.previousRun.version_number}版（{savedAt(detail.comparison.previousRun.saved_at)}）→ 第{detail.run.version_number}版（{savedAt(detail.run.saved_at)}）</p><div className={styles.diffSummary}><div><span>控除前総支給額</span><strong>{yen(detail.comparison.summary.previousGrossPayYen)} → {yen(detail.comparison.summary.currentGrossPayYen)}</strong><small>{signedYen(detail.comparison.summary.grossPayDeltaYen)}（{detail.comparison.summary.grossPayDeltaYen > 0 ? "増額" : detail.comparison.summary.grossPayDeltaYen < 0 ? "減額" : "変更なし"}）</small></div><div><span>集計対象</span><strong>{detail.comparison.summary.previousStaffCount}名 → {detail.comparison.summary.currentStaffCount}名</strong><small>変更 {detail.comparison.summary.changedStaffCount}名 / 追加 {detail.comparison.summary.addedStaffCount}名 / 対象外 {detail.comparison.summary.removedStaffCount}名</small></div></div>{detail.comparison.previousRun.calculation_spec_version !== detail.run.calculation_spec_version && <p className={styles.warningNote}>計算仕様が異なる保存版の比較です。差額には勤怠だけでなく、計算仕様変更の影響を含む可能性があります。</p>}<p className={styles.revisionNote}>これは2つの保存済み給与集計結果の比較です。勤怠の変更履歴や、確定・支払済みを示すものではありません。</p><p className={styles.revisionNote}>差額は控除前総支給額の増減です。税・社会保険・手取り・振込額は含みません。</p>{detail.comparison.changes.length === 0 ? <p className={styles.message}>スタッフ別の変更はありません。</p> : <div className={styles.staffGrid}>{detail.comparison.changes.map((change) => <article className={styles.staffResultCard} key={change.staffId}><div className={styles.staffIdentity}><strong>{change.previousName && change.currentName && change.previousName !== change.currentName ? `${change.previousName} → ${change.currentName}` : change.currentName ?? change.previousName}</strong><span className={styles.inactive}>{changeStatus(change)}</span></div><div className={styles.registered}><span>控除前の総支給額</span><strong>{yen(change.previousGrossPayYen)} → {yen(change.currentGrossPayYen)}</strong><small>{signedYen(change.grossPayDeltaYen)}</small></div>{change.minuteChanges.length > 0 && <div className={styles.revisionBox}><strong>時間の変更</strong><ul className={styles.historyList}>{change.minuteChanges.map((item) => <li key={item.key}><span>{minuteLabel(item.key)}</span><strong>{hours(item.previous)} → {hours(item.current)}（{signedMinutes(item.delta)}）</strong></li>)}</ul></div>}{change.componentChanges.length > 0 && <div className={styles.revisionBox}><strong>金額内訳の変更</strong><ul className={styles.historyList}>{change.componentChanges.map((item) => <li key={item.key}><span>{componentLabel(item.key)}</span><strong>{yen(item.previous)} → {yen(item.current)}（{signedYen(item.delta)}）</strong></li>)}</ul></div>}</article>)}</div>}</section>}
    <section className={styles.card}><h2>スタッフ別内訳</h2><div className={styles.staffGrid}>{detail.items.map((item) => <article className={styles.staffResultCard} key={item.staff_id}><div className={styles.staffIdentity}><strong>{item.legal_name_snapshot}</strong><span className={styles.inactive}>{detail.run.is_latest ? "最新版" : "以前の保存"}</span></div><div className={styles.registered}><span>控除前の総支給額</span><strong>{Number(item.gross_pay_yen).toLocaleString("ja-JP")}円</strong><small>実働 {hours(item.minutes_snapshot.worked)}</small></div><div className={styles.revisionBox}><strong>保存時の金額内訳</strong><ul className={styles.historyList}>{Object.entries(item.components_snapshot).map(([name, amount]) => <li key={name}><span>{componentLabel(name)}</span><strong>{Number(amount).toLocaleString("ja-JP")}円</strong></li>)}</ul></div></article>)}</div></section></>}
  </main>;
}
