const isoDatePattern = /^\d{4}-\d{2}-\d{2}$/;

function utcDate(value) {
  if (typeof value !== "string" || !isoDatePattern.test(value)) {
    throw new TypeError("A YYYY-MM-DD date is required");
  }
  const date = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(date.valueOf()) || date.toISOString().slice(0, 10) !== value) {
    throw new RangeError("Invalid calendar date");
  }
  return date;
}

function iso(date) {
  return date.toISOString().slice(0, 10);
}

function lastDay(year, monthIndex) {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

export function closingDay(closingRule, year, monthIndex) {
  if (closingRule === "month_end") return lastDay(year, monthIndex);
  const match = /^day_(\d{1,2})$/.exec(String(closingRule));
  if (!match) throw new RangeError(`Unsupported closing rule: ${closingRule}`);
  const day = Number(match[1]);
  if (day < 1 || day > 28) {
    throw new RangeError(`Unsupported fixed closing day: ${day}`);
  }
  return day;
}

export function calculateClosingPeriod(closingRule, closingDate) {
  const end = utcDate(closingDate);
  const year = end.getUTCFullYear();
  const month = end.getUTCMonth();
  if (end.getUTCDate() !== closingDay(closingRule, year, month)) {
    throw new RangeError("closingDate does not match closingRule");
  }
  const previousMonth = new Date(Date.UTC(year, month - 1, 1));
  const previousClose = new Date(Date.UTC(
    previousMonth.getUTCFullYear(),
    previousMonth.getUTCMonth(),
    closingDay(closingRule, previousMonth.getUTCFullYear(), previousMonth.getUTCMonth()),
  ));
  previousClose.setUTCDate(previousClose.getUTCDate() + 1);
  return { start: iso(previousClose), end: iso(end) };
}

const transitions = {
  OFF_DUTY: { CHECK_IN: "WORKING" },
  WORKING: { BREAK_START: "ON_BREAK", CHECK_OUT: "OFF_DUTY" },
  ON_BREAK: { BREAK_END: "WORKING" },
};

export const ATTENDANCE_CALCULATION_SPEC_VERSION = "2026-08-21-v1";
const MINUTE_MS = 60_000;
const TOKYO_OFFSET_MS = 9 * 60 * MINUTE_MS;
const LONG_BREAK_MINIMUM_WORK_SPAN_MS = 180 * MINUTE_MS;
const LONG_BREAK_RATIO = 0.8;
const VERY_SHORT_WORK_MS = 15 * MINUTE_MS;
const LONG_WORK_MS = 16 * 60 * MINUTE_MS;

function eventTime(event) {
  const value = new Date(event.occurred_at).valueOf();
  if (!Number.isFinite(value)) throw new TypeError("Invalid punch timestamp");
  return value;
}

function interval(start, end) {
  return { start: new Date(start).toISOString(), end: new Date(end).toISOString() };
}

function intervalMs(value) {
  return { start: new Date(value.start).valueOf(), end: new Date(value.end).valueOf() };
}

function mergeIntervals(values) {
  const ordered = values.map(intervalMs).sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const current of ordered) {
    const previous = merged.at(-1);
    if (!previous || current.start > previous.end) merged.push({ ...current });
    else previous.end = Math.max(previous.end, current.end);
  }
  return merged;
}

function durationMs(values) {
  return values.reduce((sum, value) => sum + Math.max(0, value.end - value.start), 0);
}

function intersectIntervals(left, right) {
  const intersections = [];
  for (const a of left) {
    for (const b of right) {
      const start = Math.max(a.start, b.start);
      const end = Math.min(a.end, b.end);
      if (start < end) intersections.push({ start, end });
    }
  }
  return mergeIntervals(intersections.map((value) => interval(value.start, value.end)));
}

function subtractIntervals(left, right) {
  const result = [];
  for (const source of left) {
    let fragments = [{ ...source }];
    for (const cut of right) {
      fragments = fragments.flatMap((fragment) => {
        if (cut.end <= fragment.start || cut.start >= fragment.end) return [fragment];
        const remaining = [];
        if (fragment.start < cut.start) remaining.push({ start: fragment.start, end: cut.start });
        if (cut.end < fragment.end) remaining.push({ start: cut.end, end: fragment.end });
        return remaining;
      });
    }
    result.push(...fragments);
  }
  return mergeIntervals(result.map((value) => interval(value.start, value.end)));
}

function tokyoDateKey(epochMs) {
  return new Date(epochMs + TOKYO_OFFSET_MS).toISOString().slice(0, 10);
}

function lateNightWindows(intervals) {
  if (intervals.length === 0) return [];
  const firstDay = Date.parse(`${tokyoDateKey(intervals[0].start)}T00:00:00Z`) - 86_400_000;
  const lastDay = Date.parse(`${tokyoDateKey(intervals.at(-1).end)}T00:00:00Z`);
  const windows = [];
  for (let day = firstDay; day <= lastDay; day += 86_400_000) {
    // 22:00 JST is 13:00 UTC; the following 05:00 JST is 20:00 UTC.
    windows.push({ start: day + 13 * 60 * MINUTE_MS, end: day + 20 * 60 * MINUTE_MS });
  }
  return windows;
}

function wholeMinutes(milliseconds) {
  // Convert once per completed daily category. Monthly totals sum these canonical values.
  return Math.round(milliseconds / MINUTE_MS);
}

export function classifyGps(event) {
  if (event.source === "CORRECTION" || event.validation_code === "STORE_LOCATION_UNAVAILABLE") {
    return null;
  }
  if (event.validation_code === "OUTSIDE_STORE_RADIUS") return "OUTSIDE_STORE_RADIUS";
  if (event.validation_code === "LOW_GPS_ACCURACY") return "LOW_GPS_ACCURACY";
  if (event.validation_code === "CLIENT_LOCATION_UNAVAILABLE") return "CLIENT_LOCATION_UNAVAILABLE";
  if (event.location_status === "WARNING") return "OTHER_LOCATION_WARNING";
  return null;
}

export function deriveDailyAttendanceRecords(events, pendingCorrections = []) {
  const days = new Map();
  const getDay = (storeId, staffId, businessDate, legalName) => {
    const key = `${storeId ?? ""}:${staffId}:${businessDate}`;
    if (!days.has(key)) days.set(key, {
      storeId,
      staffId,
      businessDate,
      legalName,
      reasons: new Set(),
      gps: [],
      workIntervals: [],
      breakIntervals: [],
      sourceEventIds: [],
      hasCorrection: false,
    });
    else if (legalName && !days.get(key).legalName) days.get(key).legalName = legalName;
    return days.get(key);
  };

  const ordered = [...events].sort((a, b) =>
    String(a.store_id ?? "").localeCompare(String(b.store_id ?? ""))
    || String(a.staff_id).localeCompare(String(b.staff_id))
    || String(a.business_date).localeCompare(String(b.business_date))
    || eventTime(a) - eventTime(b)
    || String(a.effective_id).localeCompare(String(b.effective_id))
  );
  let currentKey = null;
  let state = "OFF_DUTY";
  let workStartedAt = null;
  let breakStartedAt = null;
  for (const event of ordered) {
    const day = getDay(event.store_id, event.staff_id, event.business_date, event.legal_name);
    const key = `${event.store_id ?? ""}:${event.staff_id}:${event.business_date}`;
    if (key !== currentKey) {
      if (currentKey) finalize(days.get(currentKey), state);
      currentKey = key;
      state = "OFF_DUTY";
      workStartedAt = null;
      breakStartedAt = null;
    }
    const next = transitions[state]?.[event.event_type];
    if (!next) day.reasons.add("LOGICAL_CONTRADICTION");
    else {
      const at = eventTime(event);
      if (event.event_type === "CHECK_IN") workStartedAt = at;
      if (event.event_type === "BREAK_START") breakStartedAt = at;
      if (event.event_type === "BREAK_END") {
        if (breakStartedAt === null || at <= breakStartedAt) day.reasons.add("LOGICAL_CONTRADICTION");
        else day.breakIntervals.push(interval(breakStartedAt, at));
        breakStartedAt = null;
      }
      if (event.event_type === "CHECK_OUT") {
        if (workStartedAt === null || at <= workStartedAt) day.reasons.add("LOGICAL_CONTRADICTION");
        else day.workIntervals.push(interval(workStartedAt, at));
        workStartedAt = null;
      }
      state = next;
    }
    day.sourceEventIds.push(String(event.effective_id));
    day.hasCorrection ||= Boolean(event.corrected) || event.source === "CORRECTION";
    const gpsReason = classifyGps(event);
    if (gpsReason) day.gps.push({ effectiveId: event.effective_id, reason: gpsReason });
  }
  if (currentKey) finalize(days.get(currentKey), state);

  for (const correction of pendingCorrections) {
    getDay(correction.store_id, correction.staff_id, correction.business_date, correction.legal_name).reasons.add("PENDING_CORRECTION");
  }
  return [...days.values()].map(toDailyAttendanceRecord);
}

export function assessAttendance(events, pendingCorrections = []) {
  return deriveDailyAttendanceRecords(events, pendingCorrections);
}

function toDailyAttendanceRecord(day) {
  const work = mergeIntervals(day.workIntervals);
  const breaks = mergeIntervals(day.breakIntervals);
  const breakInsideWork = intersectIntervals(breaks, work);
  if (durationMs(breakInsideWork) !== durationMs(breaks)) day.reasons.add("LOGICAL_CONTRADICTION");
  const attendanceReasons = [...day.reasons];
  const confirmed = attendanceReasons.length === 0;
  const effectiveWork = confirmed ? subtractIntervals(work, breaks) : [];
  const grossWorkMs = durationMs(work);
  const breakMs = durationMs(breakInsideWork);
  const workedMs = durationMs(effectiveWork);
  const reviewReasons = [];
  if (
    confirmed
    && grossWorkMs >= LONG_BREAK_MINIMUM_WORK_SPAN_MS
    && (breakMs / grossWorkMs >= LONG_BREAK_RATIO || workedMs <= VERY_SHORT_WORK_MS)
  ) {
    reviewReasons.push("UNUSUALLY_LONG_BREAK");
  }
  if (confirmed && workedMs > LONG_WORK_MS) reviewReasons.push("UNUSUALLY_LONG_WORK");
  return {
    storeId: day.storeId,
    staffId: day.staffId,
    legalName: day.legalName,
    businessDate: day.businessDate,
    status: confirmed ? "CONFIRMED" : "NEEDS_REVIEW",
    workIntervals: work.map((value) => interval(value.start, value.end)),
    breakIntervals: breaks.map((value) => interval(value.start, value.end)),
    workedMinutes: confirmed ? wholeMinutes(workedMs) : null,
    breakMinutes: confirmed ? wholeMinutes(breakMs) : null,
    lateNightMinutes: confirmed
      ? wholeMinutes(durationMs(intersectIntervals(effectiveWork, lateNightWindows(effectiveWork))))
      : null,
    hasCorrection: day.hasCorrection,
    attendanceReasons,
    reviewReasons,
    gpsIssues: day.gps,
    sourceEventIds: day.sourceEventIds,
    calculationSpecVersion: ATTENDANCE_CALCULATION_SPEC_VERSION,
  };
}

function finalize(day, state) {
  if (state === "WORKING") day.reasons.add("UNCLOSED_SHIFT");
  if (state === "ON_BREAK") {
    day.reasons.add("UNCLOSED_BREAK");
    day.reasons.add("UNCLOSED_SHIFT");
  }
}
