const componentKeys = new Set([
  "basePay", "overtimePremium", "highOvertimePremium",
  "statutoryHolidayPremium", "lateNightPremium", "commutingAllowance", "adjustments",
]);

function csvCell(value) {
  if (typeof value === "number") return `"${value}"`;
  let text = String(value ?? "").replaceAll("\0", "");
  if (/^\s*[=+\-@]/u.test(text) || /^[\t\r\n]/u.test(text)) text = `'${text}`;
  return `"${text.replaceAll('"', '""')}"`;
}

function integer(value) {
  const number = Number(value ?? 0);
  if (!Number.isSafeInteger(number)) throw new RangeError("INVALID_PAYROLL_CSV_INTEGER");
  return number;
}

function joined(value) {
  return Array.isArray(value) ? value.map(String).join(" / ") : "";
}

export function createPayrollSnapshotCsv({ storeName, run, items }) {
  const headers = [
    "店舗名", "対象期間開始", "対象期間終了", "保存版", "保存ID", "保存日時",
    "スタッフ名", "使用時給(円)", "実働(分)", "法定時間外(分)", "月60時間超(分)",
    "法定休日(分)", "深夜(分)", "基本給(円)", "時間外割増(円)",
    "月60時間超割増(円)", "法定休日割増(円)", "深夜割増(円)", "通勤手当(円)", "調整額(円)",
    "控除前総支給額(円)", "給与計算仕様", "勤怠計算仕様", "その他内訳",
  ];
  const lines = [headers.map(csvCell).join(",")];
  for (const item of items) {
    const minutes = item.minutes_snapshot ?? {};
    const components = item.components_snapshot ?? {};
    const otherComponents = Object.entries(components)
      .filter(([key, amount]) => !componentKeys.has(key) && Number(amount) !== 0)
      .map(([key, amount]) => `${key}=${integer(amount)}`)
      .join(" / ");
    lines.push([
      storeName, run.period_start, run.period_end, `第${integer(run.version_number)}版`, run.id, run.saved_at,
      item.legal_name_snapshot, joined(item.hourly_rates_used), integer(minutes.worked),
      integer(minutes.statutoryOvertime), integer(minutes.highOvertime), integer(minutes.statutoryHoliday),
      integer(minutes.lateNight), integer(components.basePay), integer(components.overtimePremium),
      integer(components.highOvertimePremium), integer(components.statutoryHolidayPremium),
      integer(components.lateNightPremium), integer(components.commutingAllowance), integer(components.adjustments), integer(item.gross_pay_yen),
      item.calculation_spec_version, joined(item.source_attendance_spec_versions), otherComponents,
    ].map(csvCell).join(","));
  }
  return `\uFEFF${lines.join("\r\n")}\r\n`;
}
