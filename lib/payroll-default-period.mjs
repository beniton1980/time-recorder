import { calculateClosingPeriod, closingDay } from "./monthly-attendance.mjs";

function assertIsoDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error("INVALID_DATE");
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString().slice(0, 10) !== value) throw new Error("INVALID_DATE");
}

function assertPayrollMonth(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}$/.test(value)) throw new Error("INVALID_PAYROLL_MONTH");
  const [yearText, monthText] = value.split("-");
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || month < 1 || month > 12) throw new Error("INVALID_PAYROLL_MONTH");
}

function isoDate(year, monthIndex, day) {
  return new Date(Date.UTC(year, monthIndex, day)).toISOString().slice(0, 10);
}

export function payrollPeriodForMonth(closingRule, payrollMonth) {
  assertPayrollMonth(payrollMonth);
  const [yearText, monthText] = payrollMonth.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const closingDate = isoDate(year, monthIndex, closingDay(closingRule, year, monthIndex));
  return calculateClosingPeriod(closingRule, closingDate);
}

export function currentPayrollPeriod(closingRule, today) {
  assertIsoDate(today);
  const [yearText, monthText, dayText] = today.split("-");
  const year = Number(yearText);
  const monthIndex = Number(monthText) - 1;
  const day = Number(dayText);
  const thisMonthClosingDay = closingDay(closingRule, year, monthIndex);
  const payrollMonth = day <= thisMonthClosingDay
    ? `${yearText}-${monthText}`
    : isoDate(year, monthIndex + 1, 1).slice(0, 7);
  return payrollPeriodForMonth(closingRule, payrollMonth);
}
