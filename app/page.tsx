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

type PunchHistoryItem = {
  effective_id: string;
  original_event_id: string | null;
  event_type: EventType;
  occurred_at: string;
  corrected: boolean;
};

type ActiveStoreConflict = {
  store_id: string;
  store_name: string;
  state: "WORKING" | "ON_BREAK";
};

type Membership = {
  staff_id: string;
  legal_name: string;
  store_id: string;
  store_name: string;
  state: WorkState;
  last_event_id: string | null;
  last_event_at: string | null;
  last_event_type: EventType | null;
  recent_punches: PunchHistoryItem[];
};

type ViewState =
  | { kind: "loading" }
  | { kind: "unregistered" }
  | { kind: "store_required"; message: string }
  | {
      kind: "active_store_conflict";
      requestedStoreName: string;
      activeStore: ActiveStoreConflict;
    }
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
  const [correctionCategory, setCorrectionCategory] =
    useState<"MISTAKE" | "MISSED" | "OTHER">("MISTAKE");
  const [correctionEvent, setCorrectionEvent] =
    useState<EventType>("CHECK_IN");
  const [correctionDate, setCorrectionDate] = useState("");
  const [correctionTime, setCorrectionTime] = useState("");
  const [correctionReason, setCorrectionReason] = useState("");
  const [correctionReview, setCorrectionReview] = useState(false);
  const [correctionError, setCorrectionError] = useState<string | null>(null);
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

        const membership = data.memberships[0] as Membership;
        const activeStoreConflict =
          data.activeStoreConflict as ActiveStoreConflict | null;

        if (activeStoreConflict) {
          setView({
            kind: "active_store_conflict",
            requestedStoreName: membership.store_name,
            activeStore: activeStoreConflict,
          });
          return;
        }

        setView({
          kind: "ready",
          membership,
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


  function canCorrectLastPunch(membership: Membership) {
    return (
      membership.last_event_id !== null &&
      membership.last_event_at !== null &&
      (membership.last_event_type === "CHECK_OUT" ||
        membership.last_event_type === "BREAK_START")
    );
  }

  function correctedLastEvent(membership: Membership): EventType | null {
    if (membership.last_event_type === "CHECK_OUT") return "BREAK_START";
    if (membership.last_event_type === "BREAK_START") return "CHECK_OUT";
    return null;
  }

  function openCorrectionForm() {
    if (view.kind !== "ready") return;

    setCorrectionCategory(
      canCorrectLastPunch(view.membership) ? "MISTAKE" : "MISSED",
    );
    setCorrectionDate("");
    setCorrectionTime("");
    setCorrectionReason("");
    setCorrectionReview(false);
    setCorrectionError(null);
    setNotice(null);
    setShowCorrection(true);
  }

  function reviewCorrectionRequest(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (view.kind !== "ready") return;

    if (
      correctionCategory === "MISTAKE" &&
      !canCorrectLastPunch(view.membership)
    ) {
      setCorrectionError(
        "前回の打刻は、この画面から種類を変更できません。",
      );
      return;
    }

    if (correctionCategory === "MISSED") {
      if (!correctionDate) {
        setCorrectionError("追加する打刻の日付を選択してください。");
        return;
      }

      if (!correctionTime) {
        setCorrectionError("追加する打刻の時刻を選択してください。");
        return;
      }
    }

    if (correctionCategory === "OTHER" && !correctionReason.trim()) {
      setCorrectionError(
        "店長に確認してほしい内容を入力してください。",
      );
      return;
    }

    setCorrectionError(null);
    setCorrectionReview(true);
  }

  async function submitCorrectionRequest() {
    if (view.kind !== "ready" || correctionSubmitting) return;

    setCorrectionSubmitting(true);
    setCorrectionError(null);
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
          category: correctionCategory,
          eventType:
            correctionCategory === "MISSED" ? correctionEvent : undefined,
          occurredAt:
            correctionCategory === "MISSED"
              ? new Date(
                  `${correctionDate}T${correctionTime}`,
                ).toISOString()
              : undefined,
          reason:
            correctionCategory === "OTHER"
              ? correctionReason.trim()
              : undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        throw new Error("修正申請を送信できませんでした。");
      }

      if (
        correctionCategory === "MISTAKE" &&
        data.status === "applied" &&
        (data.correctionRequest.state === "OFF_DUTY" ||
          data.correctionRequest.state === "ON_BREAK") &&
        (data.correctionRequest.requested_event_type === "CHECK_OUT" ||
          data.correctionRequest.requested_event_type === "BREAK_START")
      ) {
        setView({
          kind: "ready",
          membership: {
            ...view.membership,
            state: data.correctionRequest.state as WorkState,
            last_event_at:
              data.correctionRequest.requested_occurred_at as string,
            last_event_type:
              data.correctionRequest.requested_event_type as EventType,
            recent_punches: view.membership.recent_punches.map((punch) =>
              punch.original_event_id === view.membership.last_event_id
                ? {
                    ...punch,
                    event_type:
                      data.correctionRequest
                        .requested_event_type as EventType,
                    occurred_at:
                      data.correctionRequest
                        .requested_occurred_at as string,
                    corrected: true,
                  }
                : punch,
            ),
          },
        });
        setShowCorrection(false);
        setNotice("前回の打刻を修正しました");
        return;
      }

      setShowCorrection(false);
      setNotice("打刻修正を申請しました（承認待ち）");
    } catch (error) {
      setCorrectionError(
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

        if (data.code === "ACTIVE_AT_OTHER_STORE") {
          throw new Error(
            typeof data.message === "string"
              ? data.message
              : "別の店舗で勤務中です。勤務中の店舗で退勤してから出勤してください。",
          );
        }

        throw new Error("打刻を完了できませんでした。");
      }

      const nextState = data.punch.state as WorkState;

      setView({
        kind: "ready",
        membership: {
          ...view.membership,
          state: nextState,
          last_event_id: data.punch.event_id as string,
          last_event_at: data.punch.occurred_at as string,
          last_event_type: eventType,
          recent_punches: [
            ...view.membership.recent_punches,
            {
              effective_id: data.punch.event_id as string,
              original_event_id: data.punch.event_id as string,
              event_type: eventType,
              occurred_at: data.punch.occurred_at as string,
              corrected: false,
            },
          ].slice(-8),
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

  function closeApp() {
    if (liff.isInClient()) {
      liff.closeWindow();
      return;
    }

    window.close();
  }

  return (
    <main>
      <section className="card" aria-live="polite">
        <p className="eyebrow">ONOGAMI</p>
        <h1>勤怠</h1>

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

        {view.kind === "active_store_conflict" && (
          <div className="message">
            <p className="status">別の店舗で勤務中です</p>
            <p className="note">
              現在{view.activeStore.store_name}で
              {view.activeStore.state === "ON_BREAK" ? "休憩中" : "勤務中"}です。
              {view.activeStore.store_name}で退勤してから
              {view.requestedStoreName}で出勤してください。
            </p>
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
                noValidate
                onSubmit={reviewCorrectionRequest}
              >
                <p className="correction-title">打刻修正</p>

                {!correctionReview ? (
                  <>
                    <label>
                      修正内容
                      <select
                        value={correctionCategory}
                        onChange={(event) => {
                          setCorrectionCategory(
                            event.target.value as
                              | "MISTAKE"
                              | "MISSED"
                              | "OTHER",
                          );
                          setCorrectionError(null);
                        }}
                      >
                        <option value="MISTAKE">
                          前回の打刻を押し間違えた
                        </option>
                        <option value="MISSED">打刻を押し忘れた</option>
                        <option value="OTHER">その他</option>
                      </select>
                    </label>

                    {correctionCategory === "MISTAKE" &&
                      view.membership.last_event_at &&
                      view.membership.last_event_type &&
                      correctedLastEvent(view.membership) && (
                        <div className="last-punch-correction">
                          <p>前回の打刻を次のように修正します。</p>
                          <div>
                            <span>
                              {formatTime(view.membership.last_event_at)}{" "}
                              {eventLabels[view.membership.last_event_type]}
                            </span>
                            <strong aria-hidden="true">→</strong>
                            <span>
                              {formatTime(view.membership.last_event_at)}{" "}
                              {
                                eventLabels[
                                  correctedLastEvent(
                                    view.membership,
                                  ) as EventType
                                ]
                              }
                            </span>
                          </div>
                        </div>
                      )}

                    {correctionCategory === "MISTAKE" &&
                      !canCorrectLastPunch(view.membership) && (
                        <p className="correction-error" role="alert">
                          前回の打刻は種類の押し間違いとして修正できません。
                          「打刻を押し忘れた」または「その他」を選択してください。
                        </p>
                      )}

                    {correctionCategory === "MISSED" && (
                      <>
                        <label>
                          追加する打刻
                          <select
                            value={correctionEvent}
                            onChange={(event) => {
                              setCorrectionEvent(
                                event.target.value as EventType,
                              );
                              setCorrectionError(null);
                            }}
                          >
                            <option value="CHECK_IN">出勤</option>
                            <option value="BREAK_START">休憩開始</option>
                            <option value="BREAK_END">休憩終了</option>
                            <option value="CHECK_OUT">退勤</option>
                          </select>
                        </label>

                        <div className="correction-date-time">
                          <label>
                            日付
                            <input
                              type="date"
                              value={correctionDate}
                              onChange={(event) => {
                                setCorrectionDate(event.target.value);
                                setCorrectionError(null);
                              }}
                            />
                          </label>
                          <label>
                            時刻
                            <input
                              type="time"
                              step="60"
                              value={correctionTime}
                              onChange={(event) => {
                                setCorrectionTime(event.target.value);
                                setCorrectionError(null);
                              }}
                            />
                          </label>
                        </div>
                      </>
                    )}

                    {correctionCategory === "OTHER" && (
                      <label>
                        店長に確認してほしい内容
                        <span className="field-help">
                          どの記録をどのように直したいか入力してください。
                        </span>
                        <textarea
                          maxLength={500}
                          rows={4}
                          placeholder="例：休憩終了の時刻が分からないため確認してほしい"
                          value={correctionReason}
                          onChange={(event) => {
                            setCorrectionReason(event.target.value);
                            setCorrectionError(null);
                          }}
                        />
                      </label>
                    )}

                    {correctionError && (
                      <p className="correction-error" role="alert">
                        {correctionError}
                      </p>
                    )}

                    <div className="correction-actions">
                      <button
                        className="correction-cancel"
                        type="button"
                        onClick={() => setShowCorrection(false)}
                      >
                        キャンセル
                      </button>
                      <button className="correction-submit" type="submit">
                        内容を確認
                      </button>
                    </div>
                  </>
                ) : (
                  <>
                    <div className="correction-review">
                      <p>以下の内容で申請します。</p>
                      <dl>
                        <div>
                          <dt>内容</dt>
                          <dd>
                            {correctionCategory === "MISTAKE"
                              ? "前回の打刻を押し間違えた"
                              : correctionCategory === "MISSED"
                                ? "打刻を押し忘れた"
                                : "その他"}
                          </dd>
                        </div>
                        {correctionCategory === "MISTAKE" &&
                          view.membership.last_event_at &&
                          view.membership.last_event_type &&
                          correctedLastEvent(view.membership) && (
                            <div>
                              <dt>修正</dt>
                              <dd>
                                {formatTime(view.membership.last_event_at)}{" "}
                                {eventLabels[view.membership.last_event_type]}
                                {" → "}
                                {
                                  eventLabels[
                                    correctedLastEvent(
                                      view.membership,
                                    ) as EventType
                                  ]
                                }
                              </dd>
                            </div>
                          )}
                        {correctionCategory === "MISSED" && (
                          <>
                            <div>
                              <dt>種類</dt>
                              <dd>{eventLabels[correctionEvent]}</dd>
                            </div>
                            <div>
                              <dt>日時</dt>
                              <dd>
                                {correctionDate.replaceAll("-", "/")}{" "}
                                {correctionTime}
                              </dd>
                            </div>
                          </>
                        )}
                        {correctionCategory === "OTHER" && (
                          <div>
                            <dt>内容</dt>
                            <dd>{correctionReason.trim()}</dd>
                          </div>
                        )}
                      </dl>
                    </div>

                    {correctionError && (
                      <p className="correction-error" role="alert">
                        {correctionError}
                      </p>
                    )}

                    <div className="correction-actions">
                      <button
                        className="correction-cancel"
                        type="button"
                        disabled={correctionSubmitting}
                        onClick={() => {
                          setCorrectionReview(false);
                          setCorrectionError(null);
                        }}
                      >
                        入力に戻る
                      </button>
                      <button
                        className="correction-submit"
                        type="button"
                        disabled={correctionSubmitting}
                        onClick={() => void submitCorrectionRequest()}
                      >
                        {correctionSubmitting ? "送信中…" : "この内容で申請"}
                      </button>
                    </div>
                  </>
                )}
              </form>
            )}

            {notice && <p className="punch-notice">{notice}</p>}

            <button
              className="close-app-button"
              type="button"
              disabled={submitting !== null || correctionSubmitting}
              onClick={closeApp}
            >
              打刻画面を閉じる
            </button>

            <div className="punch-history">
              <p className="punch-history-title">本日の打刻履歴</p>
              {view.membership.recent_punches.length > 0 ? (
                <ol>
                  {view.membership.recent_punches.map((punch) => (
                    <li key={punch.effective_id}>
                      <time dateTime={punch.occurred_at}>
                        {formatTime(punch.occurred_at)}
                      </time>
                      <span>{eventLabels[punch.event_type]}</span>
                      {punch.corrected && <small>修正済み</small>}
                    </li>
                  ))}
                </ol>
              ) : (
                <p className="punch-history-empty">本日の打刻はありません</p>
              )}
            </div>

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
