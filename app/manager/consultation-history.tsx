"use client";
import liff from "@line/liff";
import { useEffect, useRef, useState } from "react";
import { consultationHref } from "@/lib/consultation";
import { withAttendanceDeadline } from "@/lib/attendance-request";
import styles from "./consultations/consultations.module.css";
type Cursor = { id: string; at: string };
type Item = Cursor & { staffName: string; reason: string };

export default function ConsultationHistory({ storeId }: { storeId: string }) {
  const [open, setOpen] = useState(false), [loading, setLoading] = useState(false), [error, setError] = useState("");
  const [items, setItems] = useState<Item[]>([]), [next, setNext] = useState<Cursor | null>(null);
  const life = useRef({ active: true, pending: false });
  useEffect(() => { const state = life.current; state.active = true; return () => { state.active = false; }; }, []);
  async function load(before: Cursor | null = null) {
    const state = life.current;
    if (state.pending) return;
    state.pending = true; setLoading(true); setError("");
    if (!before) { setItems([]); setNext(null); }
    try {
      const { response, data } = await withAttendanceDeadline(async signal => {
      const response = await fetch("/api/manager/consultations", { method: "POST", signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ idToken: liff.getIDToken(), storeId, action: "list", before }) });
      return { response, data: await response.json() };
      });
      if (!response.ok || !data.ok) throw new Error();
      if (state.active) { setItems(previous => before ? [...previous, ...data.items] : data.items); setNext(data.next); }
    } catch { if (state.active) setError("対応済みの相談を取得できませんでした。"); }
    finally { state.pending = false; if (state.active) setLoading(false); }
  }
  return <div className={`${styles.shell} ${styles.history}`}>
    <button className={styles.secondary} aria-expanded={open} onClick={() => { setOpen(!open); if (!open) void load(); }}>対応済みの相談を見る</button>
    {open && <div className={styles.card}>
      {error && <p className={styles.error} role="alert">{error}<button className={styles.secondary} onClick={() => void load()} disabled={loading}>再読込み</button></p>}
      {loading && <p role="status">確認中…</p>}
      {!loading && !error && !items.length && <p>対応済みの相談はありません。</p>}
      <ul className={styles.days}>{items.map(item => <li key={item.id}><a href={consultationHref(storeId, item.id)}>{item.staffName}さんの相談</a><p className={styles.reason}>{item.reason}</p><small>対応完了：{new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", dateStyle: "short", timeStyle: "short" }).format(new Date(item.at))}</small></li>)}</ul>
      {next && <button className={styles.secondary} disabled={loading} onClick={() => void load(next)}>以前の対応を見る</button>}
    </div>}
  </div>;
}
