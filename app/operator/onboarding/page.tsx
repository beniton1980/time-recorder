"use client";

import liff from "@line/liff";
import { useCallback, useEffect, useState } from "react";
import styles from "../../onboarding/onboarding.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";
type Status = "PENDING" | "APPROVED" | "REJECTED" | "PROVISIONED";
type Item = {
  id: string;
  business_name: string;
  store_name: string;
  manager_legal_name: string;
  contact_email: string;
  store_address: string;
  business_day_start_minute: number;
  closing_rule: string;
  status: Status;
  submitted_at: string;
  rejection_reason: string | null;
};

const labels: Record<Status, string> = {
  PENDING: "未確認",
  APPROVED: "承認済み",
  REJECTED: "却下",
  PROVISIONED: "店舗作成済み",
};

function timeLabel(minutes: number) {
  const hour = String(Math.floor(minutes / 60)).padStart(2, "0");
  const minute = String(minutes % 60).padStart(2, "0");
  return hour + ":" + minute;
}

export default function OperatorOnboardingPage() {
  const [status, setStatus] = useState<Status>("PENDING");
  const [items, setItems] = useState<Item[]>([]);
  const [reasons, setReasons] = useState<Record<string, string>>({});
  const [invites, setInvites] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(true);
  const [working, setWorking] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const idToken = () => {
    const token = liff.getIDToken();
    if (!token) throw new Error("LINEの認証情報を取得できませんでした。");
    return token;
  };

  const load = useCallback(async (nextStatus: Status) => {
    setLoading(true);
    setError(null);
    try {
      const response = await fetch("/api/operator/onboarding/requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: idToken(), status: nextStatus }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        if (data.code === "OPERATOR_ACCESS_REQUIRED") {
          throw new Error("この画面を利用できるONOGAMI運営者権限がありません。");
        }
        throw new Error("申請一覧を読み込めませんでした。");
      }
      setItems(data.requests as Item[]);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申請一覧を読み込めませんでした。");
    } finally {
      setLoading(false);
    }
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
        if (active) await load("PENDING");
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "運営者画面を開始できませんでした。");
          setLoading(false);
        }
      }
    }
    void start();
    return () => { active = false; };
  }, [load]);

  async function switchStatus(next: Status) {
    setStatus(next);
    setInvites({});
    await load(next);
  }

  async function decide(item: Item, decision: "APPROVED" | "REJECTED") {
    const reason = reasons[item.id]?.trim() ?? "";
    if (decision === "REJECTED" && !reason) {
      setError("却下理由を入力してください。");
      return;
    }
    const wording = decision === "APPROVED" ? "承認" : "却下";
    if (!window.confirm(item.store_name + "の申請を" + wording + "しますか？")) return;
    setWorking(item.id);
    setError(null);
    try {
      const response = await fetch("/api/operator/onboarding/requests/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken: idToken(),
          requestId: item.id,
          decision,
          rejectionReason: decision === "REJECTED" ? reason : undefined,
        }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.code === "ONBOARDING_REQUEST_ALREADY_REVIEWED"
          ? "この申請は既に処理されています。"
          : "申請を更新できませんでした。");
      }
      await load(status);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申請を更新できませんでした。");
    } finally {
      setWorking(null);
    }
  }

  async function provision(item: Item) {
    if (!window.confirm(item.store_name + "を作成し、管理者招待を発行しますか？")) return;
    setWorking(item.id);
    setError(null);
    try {
      const response = await fetch("/api/operator/onboarding/requests/provision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: idToken(), requestId: item.id }),
      });
      const data = await response.json();
      if (!response.ok || !data.ok) {
        throw new Error(data.code === "ONBOARDING_REQUEST_ALREADY_PROVISIONED"
          ? "この申請は既に店舗作成済みです。"
          : "店舗と招待を作成できませんでした。");
      }
      setInvites((current) => ({ ...current, [item.id]: data.managerInvite.url as string }));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "店舗と招待を作成できませんでした。");
    } finally {
      setWorking(null);
    }
  }

  return <main className={styles.page}><section className={styles.shell}>
    <p className={styles.brand}>ONOGAMI OPERATOR</p>
    <h1>店舗申請管理</h1>
    <p className={styles.lead}>申請内容を確認し、承認後に店舗と一度限りの管理者招待を作成します。</p>
    <nav className={styles.tabs} aria-label="申請状態">
      {(Object.keys(labels) as Status[]).map((value) =>
        <button key={value} className={status === value ? styles.selected : ""} type="button" onClick={()=>void switchStatus(value)}>{labels[value]}</button>
      )}
    </nav>
    {error && <p className={styles.error} role="alert">{error}</p>}
    {loading ? <p className={styles.notice}>読み込み中…</p> : items.length === 0 ? <p className={styles.notice}>{labels[status]}の申請はありません。</p> :
      <ul className={styles.list}>{items.map((item)=><li className={styles.item} key={item.id}>
        <h2>{item.store_name}</h2>
        <p className={styles.meta}>申請 {new Date(item.submitted_at).toLocaleString("ja-JP")}</p>
        <dl className={styles.details}>
          <dt>事業者</dt><dd>{item.business_name}</dd>
          <dt>管理者</dt><dd>{item.manager_legal_name}</dd>
          <dt>連絡先</dt><dd>{item.contact_email}</dd>
          <dt>住所</dt><dd>{item.store_address}</dd>
          <dt>営業日切替</dt><dd>{timeLabel(item.business_day_start_minute)}</dd>
          <dt>締め日</dt><dd>{item.closing_rule === "month_end" ? "月末" : item.closing_rule === "day_15" ? "15日" : "25日"}</dd>
        </dl>
        {item.rejection_reason && <p className={styles.error}>却下理由：{item.rejection_reason}</p>}
        {status === "PENDING" && <>
          <textarea className={styles.reason} maxLength={500} placeholder="却下する場合の理由" value={reasons[item.id] ?? ""} onChange={(event)=>setReasons((current)=>({...current,[item.id]:event.target.value}))} />
          <div className={styles.actions}>
            <button className={styles.primary} type="button" disabled={working !== null} onClick={()=>void decide(item,"APPROVED")}>承認</button>
            <button className={styles.danger} type="button" disabled={working !== null} onClick={()=>void decide(item,"REJECTED")}>理由を付けて却下</button>
          </div>
        </>}
        {status === "APPROVED" && <div className={styles.actions}>
          <button className={styles.primary} type="button" disabled={working !== null || Boolean(invites[item.id])} onClick={()=>void provision(item)}>店舗と管理者招待を作成</button>
        </div>}
        {invites[item.id] && <div className={styles.invite}>
          <strong>管理者へ送る招待リンク</strong>
          <a href={invites[item.id]}>{invites[item.id]}</a>
          <p className={styles.tokenWarning}>7日間有効・一度だけ利用可能です。閉じる前にコピーしてください。</p>
          <button className={styles.secondary} type="button" onClick={()=>void navigator.clipboard.writeText(invites[item.id])}>リンクをコピー</button>
        </div>}
      </li>)}</ul>
    }
  </section></main>;
}
