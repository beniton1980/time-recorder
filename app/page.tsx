"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";

const LIFF_ID = "2010761826-6FNSE1PD";

type Membership = {
  staff_id: string;
  legal_name: string;
  store_id: string;
  store_name: string;
  state: "OFF_DUTY" | "WORKING" | "ON_BREAK";
  last_event_at: string | null;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "unregistered" }
  | { kind: "ready"; membership: Membership }
  | { kind: "error"; message: string };

const stateLabels: Record<Membership["state"], string> = {
  OFF_DUTY: "勤務前",
  WORKING: "勤務中",
  ON_BREAK: "休憩中",
};

export default function Home() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        await liff.init({ liffId: LIFF_ID });

        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }

        const idToken = liff.getIDToken();

        if (!idToken) {
          throw new Error("LINEの認証情報を取得できませんでした。");
        }

        const response = await fetch("/api/session/bootstrap", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken }),
        });

        const data = await response.json();

        if (!response.ok || !data.ok) {
          throw new Error("認証を確認できませんでした。");
        }

        if (!active) return;

        if (!data.registered) {
          setView({ kind: "unregistered" });
          return;
        }

        setView({
          kind: "ready",
          membership: data.memberships[0] as Membership,
        });
      } catch (error) {
        if (!active) return;

        setView({
          kind: "error",
          message:
            error instanceof Error
              ? error.message
              : "画面を読み込めませんでした。",
        });
      }
    }

    void bootstrap();

    return () => {
      active = false;
    };
  }, []);

  return (
    <main>
      <section className="card" aria-live="polite">
        <p className="eyebrow">ONOGAMI</p>
        <h1>Time Recorder v2</h1>

        {view.kind === "loading" && (
          <div className="message">
            <span className="spinner" aria-hidden="true" />
            <p>LINE認証を確認しています</p>
          </div>
        )}

        {view.kind === "unregistered" && (
          <div className="message">
            <p className="status">スタッフ登録が見つかりません</p>
            <p className="note">店舗管理者へ登録を依頼してください。</p>
          </div>
        )}

        {view.kind === "ready" && (
          <div className="message">
            <p className="store">{view.membership.store_name}</p>
            <p className="status">{view.membership.legal_name}さん</p>
            <p className="state">{stateLabels[view.membership.state]}</p>
          </div>
        )}

        {view.kind === "error" && (
          <div className="message">
            <p className="status">接続を確認してください</p>
            <p className="note">{view.message}</p>
          </div>
        )}
      </section>
    </main>
  );
}
