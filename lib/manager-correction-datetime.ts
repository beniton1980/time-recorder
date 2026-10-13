// Correction inputs describe the actual calendar date/time in the attendance timezone,
// not the business date used to group a shift.
export function managerCorrectionInputParts(value: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Tokyo",
    year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", hourCycle: "h23",
  }).formatToParts(new Date(value));
  const part = (type: string) => parts.find((item) => item.type === type)?.value ?? "";
  return {
    date: `${part("year")}-${part("month")}-${part("day")}`,
    time: `${part("hour")}:${part("minute")}`,
  };
}

export function managerCorrectionTimestamp(date: string, time: string) {
  return new Date(`${date}T${time}:00+09:00`).toISOString();
}
