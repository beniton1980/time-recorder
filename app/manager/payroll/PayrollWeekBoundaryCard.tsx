"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";
import { managerApiAuthError } from "@/lib/manager-api-auth-error";

const LIFF_ID = "2010761826-6FNSE1PD";
const weekdays = ["日曜日", "月曜日", "火曜日", "水曜日", "木曜日", "金曜日", "土曜日"];

type Membership = { store_id: string; store_name: string };
type Rule = "CALENDAR_DEFAULT" | "EXPLICIT_WEEKDAY" | "OTHER_REVIEW_REQUIRED";

export default function PayrollWeekBoundaryCard() {
  const [memberships, setMemberships] = useState<Membership[]>([]);
  const [storeId, setStoreId] = useState("");
  const [rule, setRule] = useState<Rule>("OTHER_REVIEW_REQUIRED");
  const [weekday, setWeekday] = useState(0);
  const [message, setMessage] = useState("1週間の区切りを確認しています…");
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  async function callApi(targetStoreId: string, action: "load" | "save", values?: { weekStartRule: Rule; weekStartsOn: number }) {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");
    const response = await fetch("/api/manager/payroll/week-boundary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken, storeId: targetStoreId, action, ...values }),
    });
    const data = await response.json();
    if (!response.ok || !data.ok) {
      const authError = managerApiAuthError(response.status, data);
      if (authError) throw authError;
      throw new Error("1週間の区切りを保存できませんでした。");
    }
    return data;
  }

  async function load(targetStoreId: string) {
    setError(null);
    setMessage("1週間の区切りを確認しています…");
    const data = await callApi(targetStoreId, "load");
    setRule(data.weekStartRule as Rule);
    setWeekday(Number(data.weekStartsOn ?? 0));
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
        const response = await fetch("/api/manager/session", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });
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
        await load(firstStoreId);
      } catch (caught) {
        if (!active) return;
        setError(caught instanceof Error ? caught.message : "1週間の区切りを読み込めませんでした。");
        setMessage("");
      }
    })();
    return () => { active = false; };
  }, []);

  async function changeStore(nextStoreId: string) {
    setStoreId(nextStoreId);
    try { await load(nextStoreId); }
    catch (caught) { setError(caught instanceof Error ? caught.message : "1週間の区切りを読み込めませんでした。"); }
  }

  async function save() {
    if (!storeId) return;
    setSaving(true); setError(null);
    try {
      const data = await callApi(storeId, "save", { weekStartRule: rule, weekStartsOn: weekday });
      setRule(data.weekStartRule as Rule);
      setWeekday(Number(data.weekStartsOn ?? 0));
      setMessage("1週間の区切りを保存しました。");
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "保存できませんでした。");
    } finally { setSaving(false); }
  }

  return (
    <section style={{ maxWidth: 760, margin: "24px auto 96px", padding: "20px", border: "1px solid #ddd", borderRadius: 16, background: "#fff" }}>
      <h2 style={{ marginTop: 0 }}>3. 1週間の区切り</h2>
      <p style={{ lineHeight: 1.7, color: "#555" }}>
        週40時間超などを正しく判定するための設定です。就業規則などで週の始まりを定めていなければ、日曜日〜土曜日として扱います。
      </p>
      {memberships.length > 1 && (
        <label style={{ display: "grid", gap: 6, marginBottom: 16 }}>店舗
          <select value={storeId} onChange={(event) => void changeStore(event.target.value)} style={{ padding: 10 }}>
            {memberships.map((membership) => <option key={membership.store_id} value={membership.store_id}>{membership.store_name}</option>)}
          </select>
        </label>
      )}
      <label style={{ display: "grid", gap: 6 }}>
        1週間の始まり
        <select value={rule} onChange={(event) => setRule(event.target.value as Rule)} style={{ padding: 10 }}>
          <option value="OTHER_REVIEW_REQUIRED">分からない・要確認</option>
          <option value="CALENDAR_DEFAULT">特に定めなし（日曜日〜土曜日）</option>
          <option value="EXPLICIT_WEEKDAY">就業規則等で曜日を定めている</option>
        </select>
      </label>
      {rule === "EXPLICIT_WEEKDAY" && (
        <label style={{ display: "grid", gap: 6, marginTop: 12 }}>
          週の開始曜日
          <select value={weekday} onChange={(event) => setWeekday(Number(event.target.value))} style={{ padding: 10 }}>
            {weekdays.map((name, index) => <option key={name} value={index}>{name}</option>)}
          </select>
        </label>
      )}
      <p style={{ fontSize: 13, lineHeight: 1.6, color: "#666" }}>
        「分からない」のままでも保存できます。その場合、給与プレビューは要確認として扱い、誤って確定しません。
      </p>
      {message && <p>{message}</p>}
      {error && <p style={{ color: "#b42318" }}>{error}</p>}
      <button type="button" onClick={() => void save()} disabled={saving} style={{ width: "100%", padding: "12px 16px", border: 0, borderRadius: 10, background: "#111", color: "#fff", fontWeight: 700 }}>
        {saving ? "保存中…" : "1週間の区切りを保存"}
      </button>
    </section>
  );
}
