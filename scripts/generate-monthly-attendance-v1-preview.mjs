import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { deriveDailyAttendanceRecords } from "../lib/monthly-attendance.mjs";
import { buildMonthlyAttendanceReport } from "../lib/monthly-attendance-report.mjs";
import { generateMonthlyAttendancePdf } from "../lib/monthly-attendance-pdf.mjs";
import { monthlyAttendanceV1Events } from "../tests/fixtures/monthly-attendance-v1.mjs";

const outputPath = resolve(process.argv[2] ?? "output/pdf/onogami-monthly-attendance-v1.pdf");
const events = monthlyAttendanceV1Events.filter((event) => event.store_id === "store-a");
const days = deriveDailyAttendanceRecords(events);
const report = buildMonthlyAttendanceReport({
  storeName: "小料理屋ひなた",
  timezone: "Asia/Tokyo",
  label: "2026年8月度",
  period: { start: "2026-08-01", end: "2026-08-31" },
  generatedAt: new Date("2026-09-01T09:00:00+09:00"),
  events,
  days,
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, await generateMonthlyAttendancePdf(report));
process.stdout.write(`${outputPath}\n`);
