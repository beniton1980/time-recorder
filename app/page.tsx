"use client";

import liff from "@line/liff";
import { useEffect, useRef, useState } from "react";
import type { FormEvent } from "react";

const LIFF_ID = "2010761826-6FNSE1PD";

type WorkState = "OFF_DUTY" | "WORKING" | "ON_BREAK";
type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";

type PunchLocation = {
  latitude: number;
  longitude: number;
  accuracy: number;
};

type Membership = {
  staff_id: string;
  legal_name: string;
  store_id: string;
  store_name: string;
  state: WorkState;
  last_event_at: string | null;
  last_event_type: EventType | null;
};

type ViewState =
  | { kind: "loading" }
  | { kind: "unregistered" }
  | { kind: "store_required"; message: string }
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


function formatDate(value: Date) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "long",
    day: "numeric",
    weekday: "short",
  }).format(value);
}

function formatTime(value: Date | string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function getCurrentLocation(): Promise<PunchLocation | null> {
  if (!("geolocation" in navigator)) {
    return Promise.resolve(null);
  }

  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      (position) => {
        resolve({
          latitude: position.coords.latitude,
          longitude: position.coords.longitude,
          accuracy: position.coords.accuracy,
        });
      },
      () => resolve(null),
      {
        enableHighAccuracy: true,
        timeout: 10000,
        maximumAge: 30000,
      },
    );
  });
}

export default function Home() {
  const [view, setView] = useState<ViewState>({ kind: "loading" });
  const [submitting, setSubmitting] = useState<EventType | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [now, setNow] = useState<Date | null>(null);
  const [showCorrection, setShowCorrection] = useState(false);
  const [correctionEvent, setCorrectionEvent] =
    useState<EventType>("CHECK_IN");
  const [correctionAt, setCorrectionAt] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionSubmitting, setCorrectionSubmitting] = useState(false);
  const storeTokenRef = useRef<string | null>(null);

  useEffect(() => {
    setNow(new Date());
    const timer = window.setInterval(() => setNow(new Date()), 1000);

    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    let active = true;

    async function bootstrap() {
      try {
        await liff.init({ liffId: LIFF_ID });

        const storeToken = new URLSearchParams(window.location.search).get(
          "store_token",
        );

        if (!storeToken) {
          setView({
            kind: "store_required",
            message: "店舗に設置されたQRコードから開いてください。",
          });
          return;
        }

        storeTokenRef.current = storeToken;

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
          body: JSON.stringify({ idToken, storeToken }),
        });

        const data = await response.json();

        if (!response.ok || !data.ok) {
          if (
            data.code === "STORE_TOKEN_REQUIRED" ||
            data.code === "STORE_TOKEN_INVALID"
          ) {
            setView({
              kind: "store_required",
              message: "この店舗QRコードは利用できません。",
            });
            return;
          }

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


  function openCorrectionForm() {
    const current = new Date();
    const local = new Date(
      current.getTime() - current.getTimezoneOffset() * 60_000,
    );

    setCorrectionAt(local.toISOString().slice(0, 16));
    setCorrectionReason("");
    setNotice(null);
    setShowCorrection(true);
  }

  async function submitCorrectionRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (
      view.kind !== "ready" ||
      correctionSubmitting ||
      !correctionAt ||
      !correctionReason.trim()
    ) {
      return;
    }

    setCorrectionSubmitting(true);
    setNotice(null);

    try {
      const idToken = liff.getIDToken();

      if (!idToken) {
        throw new Error("LINEの認証情報を取得できませんでした。");
      }

      const response = await fetch("/api/correction-requests", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          storeToken: storeTokenRef.current,
          eventType: correctionEvent,
          occurredAt: new Date(correctionAt).toISOString(),
          reason: correctionReason.trim(),
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error("修正申請を送信できませんでした。");
      }

      setShowCorrection(false);
      setNotice("打刻修正を申請しました（承認待ち）");
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "修正申請を送信できませんでした。",
      );
    } finally {
      setCorrectionSubmitting(false);
    }
  }

  async function submitPunch(eventType: EventType) {
    if (view.kind !== "ready" || submitting) return;

    setSubmitting(eventType);
    setNotice(null);

    try {
      const idToken = liff.getIDToken();

      if (!idToken) {
        throw new Error("LINEの認証情報を取得できませんでした。");
      }

      const location = await getCurrentLocation();

      const response = await fetch("/api/punch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          eventType,
          clientRequestId: crypto.randomUUID(),
          storeToken: storeTokenRef.current,
          location,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        if (
          data.code === "INVALID_STATE_TRANSITION" &&
          (data.currentState === "OFF_DUTY" ||
            data.currentState === "WORKING" ||
            data.currentState === "ON_BREAK")
        ) {
          setView({
            kind: "ready",
            membership: {
              ...view.membership,
              state: data.currentState as WorkState,
            },
          });
          setNotice(
            "勤務状態を最新に更新しました。もう一度操作してください。",
          );
          return;
        }

        throw new Error("打刻を完了できませんでした。");
      }

      const nextState = data.punch.state as WorkState;

      setView({
        kind: "ready",
        membership: {
          ...view.membership,
          state: nextState,
          last_event_at: data.punch.occurred_at as string,
          last_event_type: eventType,
        },
      });

      const locationStatus = data.punch.location_status as string;

      if (locationStatus === "OK") {
        setNotice(`${eventLabels[eventType]}を記録しました`);
      } else if (locationStatus === "WARNING") {
        setNotice(
          `${eventLabels[eventType]}を記録しました（位置情報を確認してください）`,
        );
      } else {
        setNotice(
          `${eventLabels[eventType]}を記録しました（位置情報は未確認）`,
        );
      }
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

        {view.kind === "store_required" && (
          <div className="message">
            <p className="status">店舗QRコードが必要です</p>
            <p className="note">{view.message}</p>
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
            {now && (
              <div className="clock" aria-label="現在時刻">
                <p className="clock-date">{formatDate(now)}</p>
                <p className="clock-time">{formatTime(now)}</p>
              </div>
            )}

            <p className="store">{view.membership.store_name}</p>
            <p className="status">{view.membership.legal_name}さん</p>
            <p className="state">{stateLabels[view.membership.state]}</p>

            {view.membership.last_event_at &&
              view.membership.last_event_type && (
                <p className="last-punch">
                  {formatTime(view.membership.last_event_at)} に
                  {eventLabels[view.membership.last_event_type]}
                </p>
              )}

            <div className="punch-actions">
              {actionsByState[view.membership.state].map((eventType) => (
                <button
                  className={
                    eventType === "BREAK_START"
                      ? "punch-button punch-button-secondary"
                      : "punch-button"
                  }
                  type="button"
                  key={eventType}
                  disabled={submitting !== null}
                  onClick={() => void submitPunch(eventType)}
                >
                  {submitting === eventType
                    ? "位置情報を確認しています…"
                    : eventLabels[eventType]}
                </button>
              ))}
            </div>


            {!showCorrection && (
              <button
                className="correction-link"
                type="button"
                disabled={submitting !== null}
                onClick={openCorrectionForm}
              >
                打刻修正
              </button>
            )}

            {showCorrection && (
              <form
                className="correction-form"
                onSubmit={(event) => void submitCorrectionRequest(event)}
              >
                <p className="correction-title">打刻漏れの修正申請</p>

                <label>
                  打刻の種類
                  <select
                    value={correctionEvent}
                    onChange={(event) =>
                      setCorrectionEvent(event.target.value as EventType)
                    }
                  >
                    <option value="CHECK_IN">出勤</option>
                    <option value="BREAK_START">休憩開始</option>
                    <option value="BREAK_END">休憩終了</option>
                    <option value="CHECK_OUT">退勤</option>
                  </select>
                </label>

                <label>
                  打刻日時
                  <input
                    type="datetime-local"
                    required
                    value={correctionAt}
                    onChange={(event) => setCorrectionAt(event.target.value)}
                  />
                </label>

                <label>
                  理由
                  <textarea
                    required
                    maxLength={500}
                    rows={3}
                    placeholder="例：退勤ボタンを押し忘れたため"
                    value={correctionReason}
                    onChange={(event) => setCorrectionReason(event.target.value)}
                  />
                </label>

                <div className="correction-actions">
                  <button
                    className="correction-cancel"
                    type="button"
                    disabled={correctionSubmitting}
                    onClick={() => setShowCorrection(false)}
                  >
                    キャンセル
                  </button>
                  <button
                    className="correction-submit"
                    type="submit"
                    disabled={correctionSubmitting}
                  >
                    {correctionSubmitting ? "送信中…" : "申請する"}
                  </button>
                </div>
              </form>
            )}

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
