const labels = { CHECK_IN: "出勤", BREAK_START: "休憩開始", BREAK_END: "休憩終了", CHECK_OUT: "退勤" };

function duration(totalMinutes) {
  return `${String(Math.floor(totalMinutes / 60)).padStart(2, "0")}:${String(totalMinutes % 60).padStart(2, "0")}`;
}

export function buildMonthlyAttendanceReport(input) {
  const assessment = new Map(input.days.map((day) => [`${day.staffId}:${day.businessDate}`, day]));
  const staff = new Map();
  for (const event of input.events) {
    if (!staff.has(event.staff_id)) staff.set(event.staff_id, { name: event.legal_name, byDate: new Map(), events: [] });
    const member = staff.get(event.staff_id);
    if (!member.byDate.has(event.business_date)) member.byDate.set(event.business_date, []);
    member.byDate.get(event.business_date).push(event);
    const day = assessment.get(`${event.staff_id}:${event.business_date}`);
    member.events.push({
      businessDate: event.business_date,
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
      let workDays = 0;
      const reasons = [];
      let gpsIssueCount = 0;
      for (const [businessDate, rawEvents] of member.byDate) {
        const day = assessment.get(`${staffId}:${businessDate}`);
        gpsIssueCount += day?.gpsIssues.length ?? 0;
        if (day?.attendanceReasons.length) {
          reasons.push(`${businessDate}: ${day.attendanceReasons.join(" / ")}`);
          continue;
        }
        const events = [...rawEvents].sort((a, b) => new Date(a.occurred_at) - new Date(b.occurred_at));
        let workingSince = null;
        let breakSince = null;
        for (const event of events) {
          const at = new Date(event.occurred_at).valueOf();
          if (event.event_type === "CHECK_IN" || event.event_type === "BREAK_END") workingSince = at;
          if (event.event_type === "BREAK_START" && workingSince !== null) { workMinutes += Math.max(0, Math.round((at - workingSince) / 60000)); workingSince = null; breakSince = at; }
          if (event.event_type === "CHECK_OUT" && workingSince !== null) { workMinutes += Math.max(0, Math.round((at - workingSince) / 60000)); workingSince = null; }
          if (event.event_type === "BREAK_END" && breakSince !== null) { breakMinutes += Math.max(0, Math.round((at - breakSince) / 60000)); breakSince = null; }
        }
        if (events.some((event) => event.event_type === "CHECK_IN")) workDays += 1;
      }
      return { name: member.name, workDays, workDuration: duration(workMinutes), breakDuration: duration(breakMinutes), attendanceIssueDays: reasons.length, gpsIssueCount, attendanceReasons: reasons, events: member.events };
    }),
  };
}

