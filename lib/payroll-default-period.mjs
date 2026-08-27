import { calculateClosingPeriod, closingDay } from "./monthly-attendance.mjs";

function assertIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_DATE");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("INVALID_DATE");
}

function isoDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

export function currentPayrollPeriod(closingRule, today) {
  assertIsoDate(today);
  const [yearText, monthText, dayText] = today.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const thisMonthClosingDay = closingDay(closingRule, year, monthIndex);
  const closingDate = day <= thisMonthClosingDay
    ? isoDate(year, monthIndex, thisMonthClosingDay)
    : isoDate(year, monthIndex + 1, closingDay(closingRule, year, monthIndex + 1));
  return calculateClosingPeriod(closingRule, closingDate);
}
