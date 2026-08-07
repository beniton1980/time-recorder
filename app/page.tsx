"use client";

import liff from "@line/liff";
import { useEffect, useState } from "react";

const LIFF_ID = "2010761826-6FNSE1PD";

type WorkState = "OFF_DUTY" | "WORKING" | "ON_BREAK";
type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";

type Membership = {
  staff_id: string;
  legal_name: string;
  store_id: string;
  store_name: string;
  state: WorkState;
  last_event_at: string | null;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "unregistered" }
  | { kind: "ready"; membership: Membership }
  | { kind: "error"; message: string };

const stateLabels: Record<WorkState, string> = {
  OFF_DUTY: "勤務前",
  WORKING: "勤務中",
  ON_BREAK: "休憩中",
};

const eventLabels: Record<EventType, string> = {
  CHECK_IN: "出勤",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  CHECK_OUT: "退勤",
};

const actionsByState: Record<WorkState, EventType[]> = {
  OFF_DUTY: ["CHECK_IN"],
  WORKING: ["CHECK_OUT", "BREAK_START"],
  ON_BREAK: ["BREAK_END"],
};

export default function Home() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState<EventType | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

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

  async function submitPunch(eventType: EventType) {
    if (view.kind !== "ready" || submitting) return;

    setSubmitting(eventType);
    setNotice(null);

    try {
      const idToken = liff.getIDToken();

      if (!idToken) {
        throw new Error("LINEの認証情報を取得できませんでした。");
      }

      const response = await fetch("/api/punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          eventType,
          clientRequestId: crypto.randomUUID(),
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error(
          data.code === "INVALID_STATE_TRANSITION"
            ? "勤務状態が更新されています。画面を開き直してください。"
            : "打刻を完了できませんでした。",
        );
      }

      const nextState = data.punch.state as WorkState;

      setView({
        kind: "ready",
        membership: {
          ...view.membership,
          state: nextState,
          last_event_at: data.punch.occurred_at as string,
        },
      });
      setNotice(`${eventLabels[eventType]}を記録しました`);
    } catch (error) {
      setNotice(
        error instanceof Error ? error.message : "打刻を完了できませんでした。",
      );
    } finally {
      setSubmitting(null);
    }
  }

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

            <div className="punch-actions">
              {actionsByState[view.membership.state].map((eventType) => (
                <button
                  className={
                    eventType === "CHECK_OUT"
                      ? "punch-button punch-button-secondary"
                      : "punch-button"
                  }
                  type="button"
                  key={eventType}
                  disabled={submitting !== null}
                  onClick={() => void submitPunch(eventType)}
                >
                  {submitting === eventType
                    ? "記録しています…"
                    : eventLabels[eventType]}
                </button>
              ))}
            </div>

            {notice && <p className="punch-notice">{notice}</p>}
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
