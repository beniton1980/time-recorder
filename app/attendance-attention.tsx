"use client";
import liff from "@line/liff";
import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import type { ReactNode, RefObject } from "react";
import { withAttendanceDeadline } from "@/lib/attendance-request";
import type { AttentionItem } from "@/lib/attendance-attention";
import styles from "./attendance-attention.module.css";

const time = (value: string) => new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value));
type AttentionState = {
  items: AttentionItem[] | null; next: string | null; error: boolean; loading: boolean;
  checkCount: number; folded: string[]; fold: (id: string, closed: boolean) => void;
  load: (after?: string | null) => Promise<void>; panel: RefObject<HTMLElement | null>;
};
const AttentionContext = createContext<AttentionState | null>(null);
function useAttention() {
  const value = useContext(AttentionContext);
  if (!value) throw new Error("AttendanceAttentionProvider is required");
  return value;
}

export function AttendanceAttentionProvider({ getStoreToken, refreshKey, children }: {
  getStoreToken: () => string | null; refreshKey: string; children: ReactNode;
}) {
  const attention = useAttentionState(getStoreToken, refreshKey);
  return <AttentionContext.Provider value={attention}>{children}</AttentionContext.Provider>;
}

function useAttentionState(getStoreToken: () => string | null, refreshKey: string): AttentionState {
  const panel = useRef<HTMLElement | null>(null);
  const [checkCount, setCheckCount] = useState(0);
  const [loadedKey, setLoadedKey] = useState<string | null>(null);
  const [items, setItems] = useState<AttentionItem[] | null>(null);
  const [next, setNext] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [loading, setLoading] = useState(false);
  const [folded, setFolded] = useState<string[]>([]);
  const state = useRef({ generation: 0, pending: false });
  const load = useCallback(async (after: string | null = null) => {
    const current = state.current;
    if (current.pending) return;
    const generation = ++current.generation;
    current.pending = true; setLoading(true); setError(false);
    if (!after) { setItems(null); setNext(null); setCheckCount(0); }
    try {
      const idToken = liff.getIDToken(), storeToken = getStoreToken();
      if (!idToken || !storeToken) throw new Error("AUTH_REQUIRED");
      const data = await withAttendanceDeadline(async signal => {
        const response = await fetch("/api/attendance-attention", { method: "POST", signal,
          headers: { "Content-Type": "application/json" }, body: JSON.stringify({ idToken, storeToken, after }) });
        const data = await response.json();
        if (!response.ok || !data.ok || !Array.isArray(data.items) || !Number.isInteger(data.checkCount) || data.checkCount < 0) throw new Error("ATTENTION_UNAVAILABLE");
        return data;
      });
      if (generation !== current.generation) return;
      setItems(previous => after ? [...(previous ?? []), ...data.items] : data.items);
      setNext(data.next);
      setCheckCount(data.checkCount);
      setLoadedKey(refreshKey);
    } catch { if (generation === current.generation) setError(true); }
    finally { if (generation === current.generation) { current.pending = false; setLoading(false); } }
  }, [getStoreToken, refreshKey]);
  useEffect(() => {
    const current = state.current;
    current.generation++; current.pending = false;
    // Subscribe before starting I/O; cleanup also invalidates Strict Mode's first run.
    const generation = current.generation;
    void Promise.resolve().then(() => { if (generation === current.generation) return load(); });
    const resume = () => { if (document.visibilityState === "visible") void load(); };
    document.addEventListener("visibilitychange", resume);
    return () => { current.generation++; current.pending = false; document.removeEventListener("visibilitychange", resume); };
  }, [load, refreshKey]);
  const currentItems = loadedKey === refreshKey ? items : null;
  return { items: currentItems, next: currentItems ? next : null, error, loading, panel, folded, load,
    checkCount: currentItems ? Math.max(0, checkCount - currentItems.filter(item => item.continuing && folded.includes(item.id)).length) : 0,
    fold: (id, closed) => setFolded(previous => closed ? [...previous, id] : previous.filter(value => value !== id)),
  };
}

export function AttendanceAttentionNotice() {
  const { items, checkCount, error, loading, panel, folded } = useAttention();
  if (!error && !checkCount) return null;
  const first = items?.find(item => item.bucket === "check" && !(item.continuing && folded.includes(item.id)));
  return <div className={styles.notice}>
    <p>{error ? "勤務の確認事項を取得できませんでした。"
      : checkCount === 1 && first?.continuing ? first.message : `確認が必要な勤務が${checkCount}件あります。`}</p>
    <button type="button" disabled={loading} onClick={() => {
      panel.current?.focus({ preventScroll: true });
      panel.current?.scrollIntoView({ block: "start", behavior: "instant" });
    }}>確認する</button>
  </div>;
}

export default function AttendanceAttention({ disabled, onCorrect, onHistory }: {
  disabled: boolean;
  onCorrect: (item: AttentionItem, consult: boolean) => void; onHistory: (requestId: string) => void;
}) {
  const { items, next, error, loading, folded, fold, load, panel } = useAttention();
  return <section ref={panel} tabIndex={-1} className={styles.panel} aria-label="勤務の確認">
    <div className={styles.heading}><h2>勤務の確認</h2><button type="button" disabled={loading} onClick={() => void load()}>最新の状況を確認</button></div>
    {loading && <p role="status">確認中…</p>}
    {error && <p role="alert">勤務の確認事項を取得できませんでした。打刻は引き続き利用できます。もう一度確認してください。</p>}
    {!error && items?.length === 0 && <p className={styles.muted}>確認が必要な勤務はありません。</p>}
    {(["check", "waiting"] as const).map(bucket => {
      const group = items?.filter(item => item.bucket === bucket) ?? [];
      return group.length > 0 && <div key={bucket}>
        {bucket === "waiting" && <h3>管理者確認待ち</h3>}
        <ul className={styles.list}>{group.map(item => <li key={item.id}>
          {item.source && <p className={styles.muted}>{item.source.businessDate}の勤務 ／ {item.source.fromRequest ? "申請時点の記録" : "記録"}：{time(item.source.startedAt)}</p>}
          {folded.includes(item.id) && item.continuing ? <>
            <p role="status">勤務継続中として確認を閉じました。通常どおり打刻できます。</p>
            <button type="button" onClick={() => fold(item.id, false)}>申請・相談のボタンを表示</button>
          </> : <>
            <strong>{item.message}</strong>
            {item.source?.breakStartedAt && <p>休憩開始：{time(item.source.breakStartedAt)}</p>}
            {item.continuing && <p>まだ勤務中なら、通常どおり打刻できます。</p>}
            {item.bucket === "check" && <div className={styles.actions}>
              {item.continuing && <button type="button" onClick={() => fold(item.id, true)}>勤務を続けています</button>}
              {item.eventType && <button type="button" disabled={disabled || error || loading} onClick={() => onCorrect(item, false)}>{item.eventType === "BREAK_END" ? "休憩終了を申請" : "退勤を申請"}</button>}
              <button type="button" disabled={disabled || error || loading} onClick={() => onCorrect(item, true)}>時刻が不明・管理者に相談</button>
            </div>}
            {item.eventType === "BREAK_END" && <p className={styles.muted}>休憩終了の承認後に退勤を申請できます。まとめて確認したい場合は相談してください。</p>}
            {item.requestId && <button type="button" onClick={() => onHistory(item.requestId!)}>{item.bucket === "check" ? "却下された申請の結果を見る" : "この申請・相談の状況を見る"}</button>}
          </>}
        </li>)}</ul>
      </div>;
    })}
    {next && <button type="button" disabled={loading} onClick={() => void load(next)}>以前の確認事項を見る</button>}
  </section>;
}
