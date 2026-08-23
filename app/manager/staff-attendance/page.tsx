"use client";

import liff from "@line/liff";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "next/navigation";
import styles from "./staff-attendance.module.css";

const LIFF_ID = "2010761826-6FNSE1PD";

type Day = {
  businessDate: string;
  status: "CONFIRMED" | "NEEDS_REVIEW";
  workedMinutes: number | null;
  breakMinutes: number | null;
  lateNightMinutes: number | null;
  attendanceReasons: string[];
  reviewReasons: string[];
  gpsIssueCount: number;
  hasCorrection: boolean;
  checkIn: string;
  checkOut: string;
  breakPeriods: string[];
  workedDuration?: string;
  breakDuration?: string;
};

type Payload = {
  ok: true;
  store: { id: string; name: string };
  staff: { id: string; legalName: string };
  month: string;
  summary: { workDays: number; workDuration: string; breakDuration: string; issueDays: number; gpsIssueCount: number };
  days: Day[];
};

const reasonLabels: Record<string, string> = {
  MISSING_CHECK_IN: "出勤がありません",
  MISSING_CHECK_OUT: "退勤がありません",
  OPEN_BREAK: "休憩終了がありません",
  INVALID_SEQUENCE: "打刻の順序を確認してください",
  PENDING_CORRECTION: "未処理の修正申請があります",
  MISSING_DAILY_ATTENDANCE: "勤怠を確認してください",
};

function currentMonth() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo", year: "numeric", month: "2-digit" })
    .format(new Date());
}

function monthLabel(value: string) {
  const [year, month] = value.split("-");
  return `${year}年${Number(month)}月`;
}

function dateLabel(value: string) {
  const date = new Date(`${value}T00:00:00+09:00`);
  return new Intl.DateTimeFormat("ja-JP", { timeZone: "Asia/Tokyo", month: "numeric", day: "numeric", weekday: "short" }).format(date);
}

function displayReason(reason: string) {
  return reasonLabels[reason] ?? "確認が必要です";
}

export default function StaffAttendancePage() {
  const params = useSearchParams();
  const storeId = params.get("store_id") ?? "";
  const staffId = params.get("staff_id") ?? "";
  const [month, setMonth] = useState(currentMonth);
  const [payload, setPayload] = useState<Payload | null>(null);
  const [message, setMessage] = useState("勤怠を読み込んでいます");
  const [error, setError] = useState<string | null>(null);
  const [reviewOnly, setReviewOnly] = useState(false);

  useEffect(() => {
    let active = true;
    async function load() {
      try {
        await liff.init({ liffId: LIFF_ID });
        if (!liff.isLoggedIn()) {
          liff.login({ redirectUri: window.location.href });
          return;
        }
        const idToken = liff.getIDToken();
        if (!idToken || !storeId || !staffId) throw new Error("対象スタッフを確認できませんでした。");
        setMessage("勤怠を読み込んでいます");
        setError(null);
        const response = await fetch("/api/manager/staff-attendance", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ idToken, storeId, staffId, month }),
        });
        const data = await response.json();
        if (!response.ok || !data.ok) {
          if (data.code === "MANAGER_ACCESS_REQUIRED") throw new Error("この店舗の管理者権限を確認できませんでした。");
          if (data.code === "STAFF_NOT_FOUND") throw new Error("この店舗に対象スタッフが見つかりませんでした。");
          throw new Error("個人の勤怠を読み込めませんでした。");
        }
        if (active) setPayload(data as Payload);
      } catch (caught) {
        if (active) setError(caught instanceof Error ? caught.message : "個人の勤怠を読み込めませんでした。");
      } finally {
        if (active) setMessage("");
      }
    }
    void load();
    return () => { active = false; };
  }, [month, staffId, storeId]);

  const visibleDays = useMemo(() => {
    const days = payload?.days ?? [];
    const selected = reviewOnly
      ? days.filter((day) => day.status === "NEEDS_REVIEW" || day.attendanceReasons.length > 0 || day.reviewReasons.length > 0 || day.gpsIssueCount > 0)
      : days;
    return [...selected].sort((a, b) => b.businessDate.localeCompare(a.businessDate));
  }, [payload, reviewOnly]);

  return (
    <main className={styles.page}>
      <section className={styles.shell}>
        <header className={styles.header}>
          <button type="button" className={styles.back} onClick={() => history.back()}>← 管理画面へ戻る</button>
          <p className={styles.eyebrow}>ONOGAMI 勤怠</p>
          <h1>{payload?.staff.legalName ?? "個人の勤怠"}</h1>
          {payload && <p className={styles.store}>{payload.store.name}</p>}
        </header>

        <label className={styles.monthSelector}>
          表示する月
          <input type="month" value={month} onChange={(event) => setMonth(event.target.value)} />
        </label>

        {message && <p className={styles.loading}>{message}</p>}
        {error && <p className={styles.error} role="alert">{error}</p>}

        {payload && !error && (
          <>
            <section className={styles.summary}>
              <div><span>出勤日数</span><strong>{payload.summary.workDays}日</strong></div>
              <div><span>実働</span><strong>{payload.summary.workDuration}</strong></div>
              <div><span>休憩</span><strong>{payload.summary.breakDuration}</strong></div>
              <div><span>要確認</span><strong>{payload.summary.issueDays}日</strong></div>
            </section>

            <div className={styles.toolbar}>
              <strong>{monthLabel(payload.month)}</strong>
              <div role="group" aria-label="表示する勤怠">
                <button type="button" className={!reviewOnly ? styles.activeFilter : ""} onClick={() => setReviewOnly(false)}>すべて</button>
                <button type="button" className={reviewOnly ? styles.activeFilter : ""} onClick={() => setReviewOnly(true)}>要確認のみ</button>
              </div>
            </div>

            {visibleDays.length === 0 ? (
              <p className={styles.empty}>{reviewOnly ? "要確認の勤怠はありません" : "この月の勤怠はありません"}</p>
            ) : (
              <ol className={styles.dayList}>
                {visibleDays.map((day) => {
                  const reasons = [...day.attendanceReasons, ...day.reviewReasons];
                  const needsReview = day.status === "NEEDS_REVIEW" || reasons.length > 0;
                  return (
                    <li key={day.businessDate} className={needsReview ? styles.reviewDay : undefined}>
                      <div className={styles.dayHeader}>
                        <strong>{dateLabel(day.businessDate)}</strong>
                        <div className={styles.badges}>
                          {needsReview && <span className={styles.reviewBadge}>要確認</span>}
                          {day.hasCorrection && <span className={styles.correctionBadge}>訂正あり</span>}
                          {day.gpsIssueCount > 0 && <span className={styles.gpsBadge}>GPS確認</span>}
                        </div>
                      </div>
                      <dl className={styles.times}>
                        <div><dt>出勤</dt><dd>{day.checkIn || "—"}</dd></div>
                        <div><dt>退勤</dt><dd>{day.checkOut || "—"}</dd></div>
                        <div><dt>実働</dt><dd>{day.workedDuration || "—"}</dd></div>
                        <div><dt>休憩</dt><dd>{day.breakDuration || "—"}</dd></div>
                      </dl>
                      {day.breakPeriods.length > 0 && <p className={styles.breaks}>休憩 {day.breakPeriods.join(" / ")}</p>}
                      {reasons.length > 0 && (
                        <ul className={styles.reasons}>{reasons.map((reason, index) => <li key={`${reason}-${index}`}>{displayReason(reason)}</li>)}</ul>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
          </>
        )}
      </section>
    </main>
  );
}
