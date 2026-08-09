Exit code: 0
Wall time: 0.5 seconds
Output:
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

export function assessAttendance(events, pendingCorrections = []) {
  const days = new Map();
  const getDay = (staffId, businessDate) => {
    const key = `${staffId}:${businessDate}`;
    if (!days.has(key)) days.set(key, { staffId, businessDate, reasons: new Set(), gps: [] });
    return days.get(key);
  };

  const ordered = [...events].sort((a, b) =>
    String(a.staff_id).localeCompare(String(b.staff_id))
    || String(a.business_date).localeCompare(String(b.business_date))
    || String(a.occurred_at).localeCompare(String(b.occurred_at))
    || String(a.effective_id).localeCompare(String(b.effective_id))
  );
  let currentKey = null;
  let state = "OFF_DUTY";
  for (const event of ordered) {
    const day = getDay(event.staff_id, event.business_date);
    const key = `${event.staff_id}:${event.business_date}`;
    if (key !== currentKey) {
      if (currentKey) finalize(days.get(currentKey), state);
      currentKey = key;
      state = "OFF_DUTY";
    }
    const next = transitions[state]?.[event.event_type];
    if (!next) day.reasons.add("LOGICAL_CONTRADICTION");
    else state = next;
    const gpsReason = classifyGps(event);
    if (gpsReason) day.gps.push({ effectiveId: event.effective_id, reason: gpsReason });
  }
  if (currentKey) finalize(days.get(currentKey), state);

  for (const correction of pendingCorrections) {
    getDay(correction.staff_id, correction.business_date).reasons.add("PENDING_CORRECTION");
  }
  return [...days.values()].map((day) => ({
    staffId: day.staffId,
    businessDate: day.businessDate,
    attendanceReasons: [...day.reasons],
    gpsIssues: day.gps,
  }));
}

function finalize(day, state) {
  if (state === "WORKING") day.reasons.add("UNCLOSED_SHIFT");
  if (state === "ON_BREAK") {
    day.reasons.add("UNCLOSED_BREAK");
    day.reasons.add("UNCLOSED_SHIFT");
  }
}

