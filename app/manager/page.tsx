"use client";

import liff from "@line/liff";
import { useCallback, useEffect, useState } from "react";
import styles from "./manager.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";

type WorkState = "OFF_DUTY" | "WORKING" | "ON_BREAK";
type EventType = "CHECK_IN" | "BREAK_START" | "BREAK_END" | "CHECK_OUT";

type Attendance = {
  staff_id: string;
  legal_name: string;
  state: WorkState;
  last_event_type: EventType | null;
  last_event_at: string | null;
  punch_count: number;
};

type DayEvent = {
  effective_id: string;
  original_event_id: string | null;
  correction_request_id: string | null;
  event_type: EventType;
  occurred_at: string;
  corrected: boolean;
};

type Correction = {
  id: string;
  operation: "ADD" | "REPLACE" | "VOID" | "REVIEW";
  requested_event_type: EventType | null;
  requested_occurred_at: string | null;
  reason: string | null;
  requested_at: string;
  legal_name: string;
  target_event_type: EventType | null;
  target_occurred_at: string | null;
  day_events: DayEvent[];
};

type Dashboard = {
  manager: {
    legal_name: string;
    store_name: string;
  };
  attendance: Attendance[];
  corrections: Correction[];
};

type ReviewDraft = {
  eventType: EventType;
  date: string;
  time: string;
};

const stateLabels: Record<WorkState, string> = {
  OFF_DUTY: "勤務前・退勤済み",
  WORKING: "勤務中",
  ON_BREAK: "休憩中",
};

const eventLabels: Record<EventType, string> = {
  CHECK_IN: "出勤",
  BREAK_START: "休憩開始",
  BREAK_END: "休憩終了",
  CHECK_OUT: "退勤",
};

function formatTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

function formatDateTime(value: string) {
  return new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(value));
}

export default function ManagerPage() {
  const [dashboard, setDashboard] = useState<Dashboard | null>(null);
  const [message, setMessage] = useState("店長権限を確認しています");
  const [error, setError] = useState<string | null>(null);
  const [deciding, setDeciding] = useState<string | null>(null);
  const [reviewDrafts, setReviewDrafts] = useState<Record<string, ReviewDraft>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  const loadDashboard = useCallback(async () => {
    const idToken = liff.getIDToken();
    if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");

    const response = await fetch("/api/manager/dashboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ idToken }),
    });
    const data = await response.json();

    if (!response.ok || !data.ok) {
      if (data.code === "MANAGER_ACCESS_REQUIRED") {
        throw new Error("この画面を利用できる店長権限がありません。");
      }
      throw new Error("店長画面を読み込めませんでした。");
    }

    setDashboard(data as Dashboard);
    setMessage("");
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
        if (active) await loadDashboard();
      } catch (caught) {
        if (active) {
          setError(caught instanceof Error ? caught.message : "店長画面を読み込めませんでした。");
        }
      }
    }

    void start();
    return () => {
      active = false;
    };
  }, [loadDashboard]);

  function updateReviewDraft(id: string, values: Partial<ReviewDraft>) {
    setFieldErrors((current) => {
      const next = { ...current };
      delete next[id];
      return next;
    });
    setReviewDrafts((current) => ({
      ...current,
      [id]: {
        eventType: current[id]?.eventType ?? "CHECK_IN",
        date: current[id]?.date ?? "",
        time: current[id]?.time ?? "",
        ...values,
      },
    }));
  }

  async function decide(correction: Correction, decision: "APPROVED" | "REJECTED") {
    const draft = reviewDrafts[correction.id];

    if (
      decision === "APPROVED" &&
      correction.operation === "REVIEW" &&
      (!draft?.date || !draft?.time)
    ) {
      setFieldErrors((current) => ({
        ...current,
        [correction.id]: "追加する打刻の日付と時刻を入力してください。",
      }));
      return;
    }

    const verb = decision === "APPROVED" ? "承認" : "却下";
    if (!window.confirm(`${correction.legal_name}さんの申請を${verb}しますか？`)) return;

    setDeciding(correction.id);
    setError(null);

    try {
      const idToken = liff.getIDToken();
      if (!idToken) throw new Error("LINEの認証情報を取得できませんでした。");

      const response = await fetch("/api/manager/corrections/decision", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          idToken,
          requestId: correction.id,
          decision,
          resolvedEventType:
            correction.operation === "REVIEW" ? draft?.eventType : undefined,
          resolvedOccurredAt:
            correction.operation === "REVIEW" && draft
              ? new Date(`${draft.date}T${draft.time}`).toISOString()
              : undefined,
        }),
      });
      const data = await response.json();

      if (!response.ok || !data.ok) {
        if (data.code === "RESOLUTION_REQUIRED" || data.code === "INVALID_RESOLUTION_TIME") {
          throw new Error("追加する打刻の種類・日付・時刻を確認してください。");
        }
        throw new Error("申請を更新できませんでした。");
      }

      setFieldErrors((current) => {
        const next = { ...current };
        delete next[correction.id];
        return next;
      });
      await loadDashboard();
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "申請を更新できませんでした。");
    } finally {
      setDeciding(null);
    }
  }

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <p className={styles.eyebrow}>ONOGAMI</p>
          <h1>店長画面</h1>
          {dashboard && (
            <>
              <p className={styles.store}>{dashboard.manager.store_name}</p>
              <p className={styles.manager}>{dashboard.manager.legal_name}さん</p>
            </>
          )}
        </header>

        {!dashboard && !error && <p className={styles.loading}>{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {dashboard && (
          <>
            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>本日の勤務状況</h2>
                <button type="button" onClick={() => void loadDashboard()}>更新</button>
              </div>
              <ul className={styles.attendanceList}>
                {dashboard.attendance.map((staff) => (
                  <li key={staff.staff_id}>
                    <div>
                      <strong>{staff.legal_name}</strong>
                      <span className={`${styles.state} ${styles[staff.state]}`}>
                        {stateLabels[staff.state]}
                      </span>
                    </div>
                    <p>
                      {staff.last_event_at && staff.last_event_type
                        ? `最終 ${formatTime(staff.last_event_at)} ${eventLabels[staff.last_event_type]}`
                        : "本日の打刻なし"}
                      <small>{staff.punch_count}件</small>
                    </p>
                  </li>
                ))}
              </ul>
            </section>

            <section className={styles.section}>
              <div className={styles.sectionHeading}>
                <h2>未処理の訂正申請</h2>
                <span>{dashboard.corrections.length}件</span>
              </div>

              {dashboard.corrections.length === 0 ? (
                <p className={styles.empty}>未処理の申請はありません</p>
              ) : (
                <ul className={styles.correctionList}>
                  {dashboard.corrections.map((correction) => (
                    <li key={correction.id}>
                      <div className={styles.correctionTop}>
                        <strong>{correction.legal_name}</strong>
                        <time dateTime={correction.requested_at}>
                          申請 {formatDateTime(correction.requested_at)}
                        </time>
                      </div>

                      {correction.operation === "ADD" && correction.requested_event_type && correction.requested_occurred_at ? (
                        <p className={styles.requestDetail}>
                          打刻漏れを追加：{formatDateTime(correction.requested_occurred_at)}{" "}
                          {eventLabels[correction.requested_event_type]}
                        </p>
                      ) : (
                        <p className={styles.requestDetail}>内容確認が必要な申請</p>
                      )}

                      {correction.reason && <p className={styles.reason}>{correction.reason}</p>}

                      <div className={styles.dayHistory}>
                        <p>対象日の有効な打刻履歴</p>
                        {correction.day_events.length === 0 ? (
                          <span>打刻履歴はありません</span>
                        ) : (
                          <ol>
                            {correction.day_events.map((dayEvent) => (
                              <li key={dayEvent.effective_id}>
                                <time dateTime={dayEvent.occurred_at}>
                                  {formatTime(dayEvent.occurred_at)}
                                </time>
                                <strong>{eventLabels[dayEvent.event_type]}</strong>
                                {dayEvent.corrected && <small>訂正</small>}
                              </li>
                            ))}
                          </ol>
                        )}
                      </div>

                      {correction.operation === "REVIEW" && (
                        <div className={styles.resolution}>
                          <p>店長が確認した内容を入力してください</p>
                          <label>
                            追加する打刻
                            <select
                              value={reviewDrafts[correction.id]?.eventType ?? "CHECK_IN"}
                              onChange={(event) =>
                                updateReviewDraft(correction.id, {
                                  eventType: event.target.value as EventType,
                                })
                              }
                            >
                              <option value="CHECK_IN">出勤</option>
                              <option value="BREAK_START">休憩開始</option>
                              <option value="BREAK_END">休憩終了</option>
                              <option value="CHECK_OUT">退勤</option>
                            </select>
                          </label>
                          <div className={styles.resolutionDateTime}>
                            <label>
                              日付
                              <input
                                type="date"
                                value={reviewDrafts[correction.id]?.date ?? ""}
                                onChange={(event) =>
                                  updateReviewDraft(correction.id, {
                                    date: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label>
                              時刻
                              <input
                                type="time"
                                step="60"
                                value={reviewDrafts[correction.id]?.time ?? ""}
                                onChange={(event) =>
                                  updateReviewDraft(correction.id, {
                                    time: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                          {fieldErrors[correction.id] && (
                            <p className={styles.fieldError} role="alert">
                              {fieldErrors[correction.id]}
                            </p>
                          )}
                          <small>
                            承認すると、この打刻が訂正データとして追加されます。
                          </small>
                        </div>
                      )}

                      <div className={styles.actions}>
                        <button
                          type="button"
                          className={styles.reject}
                          disabled={deciding !== null}
                          onClick={() => void decide(correction, "REJECTED")}
                        >
                          却下
                        </button>
                        <button
                          type="button"
                          className={styles.approve}
                          disabled={deciding !== null}
                          onClick={() => void decide(correction, "APPROVED")}
                        >
                          {deciding === correction.id ? "処理中…" : "承認"}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </section>
    </main>
  );
}
