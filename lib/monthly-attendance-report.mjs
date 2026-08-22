const labels = { CHECK_IN: "出勤", BREAK_START: "休憩開始", BREAK_END: "休憩終了", CHECK_OUT: "退勤" };

function duration(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

function businessDateKey(value) {
  if (typeof value === "string") return value.slice(0, 10);
  if (value instanceof Date && Number.isFinite(value.valueOf())) return value.toISOString().slice(0, 10);
  const parsed = new Date(value);
  if (Number.isFinite(parsed.valueOf())) return parsed.toISOString().slice(0, 10);
  throw new TypeError("Invalid business date");
}

function dayDisplay(day) {
  return day.status === "CONFIRMED" ? duration(day.workedMinutes) : "";
}

function dayEventSummary(events) {
  const checkIn = events.find((event) => event.label === "出勤")?.time ?? "";
  const checkOut = events.findLast((event) => event.label === "退勤")?.time ?? "";
  const breakPeriods = [];
  let breakStart = null;
  for (const event of events) {
    if (event.label === "休憩開始") breakStart = event.time;
    if (event.label === "休憩終了" && breakStart) {
      breakPeriods.push(`${breakStart}-${event.time}`);
      breakStart = null;
    }
  }
  if (breakStart) breakPeriods.push(`${breakStart}-未終了`);
  return { checkIn, checkOut, breakPeriods };
}

export function buildMonthlyAttendanceReport(input) {
  const assessment = new Map(input.days.map((day) => [`${day.staffId}:${businessDateKey(day.businessDate)}`, day]));
  const staff = new Map();
  for (const day of input.days) {
    if (!day.legalName) continue;
    const businessDate = businessDateKey(day.businessDate);
    if (!staff.has(day.staffId)) staff.set(day.staffId, { name: day.legalName, byDate: new Map(), events: [] });
    const member = staff.get(day.staffId);
    if (!member.byDate.has(businessDate)) member.byDate.set(businessDate, []);
  }
  for (const event of input.events) {
    const businessDate = businessDateKey(event.business_date);
    if (!staff.has(event.staff_id)) staff.set(event.staff_id, { name: event.legal_name, byDate: new Map(), events: [] });
    const member = staff.get(event.staff_id);
    if (!member.byDate.has(businessDate)) member.byDate.set(businessDate, []);
    member.byDate.get(businessDate).push(event);
    const day = assessment.get(`${event.staff_id}:${businessDate}`);
    member.events.push({
      businessDate,
      time: new Intl.DateTimeFormat("ja-JP", { timeZone: input.timezone, hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(event.occurred_at)),
      label: labels[event.event_type] ?? event.event_type,
      corrected: Boolean(event.corrected),
      gpsIssue: Boolean(day?.gpsIssues.some((issue) => issue.effectiveId === event.effective_id)),
    });
  }
  return {
    storeName: input.storeName,
    label: input.label,
    period: input.period,
    generatedAt: new Intl.DateTimeFormat("ja-JP", { timeZone: input.timezone, dateStyle: "medium", timeStyle: "short" }).format(input.generatedAt),
    staff: [...staff.entries()].map(([staffId, member]) => {
      let workMinutes = 0;
      let breakMinutes = 0;
      let lateNightMinutes = 0;
      let workDays = 0;
      const reasons = [];
      let gpsIssueCount = 0;
      const dailyAttendance = [];
      for (const [businessDate] of member.byDate) {
        const day = assessment.get(`${staffId}:${businessDate}`);
        const eventSummary = dayEventSummary(member.events.filter((event) => event.businessDate === businessDate));
        gpsIssueCount += day?.gpsIssues.length ?? 0;
        if (!day || day.status !== "CONFIRMED") {
          const dayReasons = day?.attendanceReasons ?? ["MISSING_DAILY_ATTENDANCE"];
          reasons.push(`${businessDate}: ${dayReasons.join(" / ")}`);
          dailyAttendance.push({
            businessDate,
            status: "NEEDS_REVIEW",
            workedMinutes: null,
            breakMinutes: null,
            lateNightMinutes: null,
            attendanceReasons: dayReasons,
            gpsIssueCount: day?.gpsIssues.length ?? 0,
            hasCorrection: Boolean(day?.hasCorrection),
            workIntervals: day?.workIntervals ?? [],
            breakIntervals: day?.breakIntervals ?? [],
            ...eventSummary,
          });
          continue;
        }
        workMinutes += day.workedMinutes;
        breakMinutes += day.breakMinutes;
        lateNightMinutes += day.lateNightMinutes;
        if (day.workedMinutes > 0) workDays += 1;
        dailyAttendance.push({
          businessDate,
          status: day.status,
          workedMinutes: day.workedMinutes,
          breakMinutes: day.breakMinutes,
          lateNightMinutes: day.lateNightMinutes,
          attendanceReasons: [],
          gpsIssueCount: day.gpsIssues.length,
          hasCorrection: day.hasCorrection,
          workIntervals: day.workIntervals,
          breakIntervals: day.breakIntervals,
          ...eventSummary,
          workedDuration: dayDisplay(day),
          breakDuration: duration(day.breakMinutes),
          lateNightDuration: duration(day.lateNightMinutes),
        });
      }
      return {
        name: member.name,
        workDays,
        workMinutes,
        breakMinutes,
        lateNightMinutes,
        workDuration: duration(workMinutes),
        breakDuration: duration(breakMinutes),
        lateNightDuration: duration(lateNightMinutes),
        attendanceIssueDays: reasons.length,
        gpsIssueCount,
        attendanceReasons: reasons,
        dailyAttendance: dailyAttendance.sort((a, b) => a.businessDate.localeCompare(b.businessDate)),
        events: member.events,
      };
    }),
  };
}

export function monthlyAttendanceIssues(report) {
  return report.staff.flatMap((staff) => staff.dailyAttendance
    .filter((day) => day.status === "NEEDS_REVIEW")
    .map((day) => ({
      staffName: staff.name,
      businessDate: day.businessDate,
      reasons: day.attendanceReasons,
    })));
}
