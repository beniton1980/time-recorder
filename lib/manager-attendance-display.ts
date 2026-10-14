export type AttendanceDisplayEvent = {
  businessDate: string;
  eventType: string;
  occurredAt: string;
};

type DayTimes = { checkIn: string; checkOut: string; breakPeriods: string[] };

// Screen-only labels. Keep the report's first-in / last-out and break pairing;
// events arrive in report order; daily attendance remains the sole source for
// durations and review status.
export function attendanceDisplayTimes(events: AttendanceDisplayEvent[] = [], timezone?: string): Map<string, DayTimes> {
  const result = new Map<string, DayTimes>();
  if (!timezone) return result;
  let formatter: Intl.DateTimeFormat;
  try {
    formatter = new Intl.DateTimeFormat("en-CA", {
      timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
      hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
    });
  } catch { return result; }

  const grouped = new Map<string, AttendanceDisplayEvent[]>();
  for (const event of events) {
    const day = grouped.get(event.businessDate) ?? [];
    day.push(event);
    grouped.set(event.businessDate, day);
  }
  for (const [businessDate, dayEvents] of grouped) {
    const businessDay = new Date(`${businessDate}T00:00:00Z`);
    if (!Number.isFinite(businessDay.getTime()) || businessDay.toISOString().slice(0, 10) !== businessDate) continue;
    // Missing or invalid dates must never become an inferred "next day".
    if (dayEvents.some(event => !Number.isFinite(new Date(event.occurredAt).getTime()))) continue;
    function label(event: AttendanceDisplayEvent, seconds = false) {
      const parts = Object.fromEntries(formatter.formatToParts(new Date(event.occurredAt)).map(part => [part.type, part.value]));
      const actualDate = `${parts.year}-${parts.month}-${parts.day}`;
      const clock = `${parts.hour}:${parts.minute}${seconds ? `:${parts.second}` : ""}`;
      if (actualDate === businessDate) return clock;
      const offset = Math.round((Date.parse(`${actualDate}T00:00:00Z`) - businessDay.getTime()) / 86400000);
      const relative = offset === 1 ? "翌日" : offset === -1 ? "前日" : `${Math.abs(offset)}日${offset > 0 ? "後" : "前"}`;
      const date = `${actualDate.slice(0, 4) === businessDate.slice(0, 4) ? "" : `${parts.year}/`}${Number(parts.month)}/${Number(parts.day)}`;
      return `${relative} ${clock}（${date}）`;
    }
    const firstIn = dayEvents.find(event => event.eventType === "CHECK_IN");
    const lastOut = [...dayEvents].reverse().find(event => event.eventType === "CHECK_OUT");
    const breakPeriods: string[] = [];
    let breakStart: AttendanceDisplayEvent | null = null;
    for (const event of dayEvents) {
      if (event.eventType === "BREAK_START") breakStart = event;
      if (event.eventType === "BREAK_END" && breakStart) {
        breakPeriods.push(`${label(breakStart, true)}-${label(event, true)}`);
        breakStart = null;
      }
    }
    if (breakStart) breakPeriods.push(`${label(breakStart, true)}-未終了`);
    result.set(businessDate, { checkIn: firstIn ? label(firstIn) : "", checkOut: lastOut ? label(lastOut) : "", breakPeriods });
  }
  return result;
}
