const event = (store_id, staff_id, legal_name, business_date, effective_id, event_type, occurred_at, extra = {}) => ({
  store_id,
  staff_id,
  legal_name,
  business_date,
  effective_id,
  event_type,
  occurred_at,
  source: "LIFF",
  ...extra,
});

export const monthlyAttendanceV1Events = [
  event("store-a", "sato-a", "佐藤 健", "2026-08-01", "D01-1", "CHECK_IN", "2026-08-01T17:00:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-01", "D01-2", "BREAK_START", "2026-08-01T19:10:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-01", "D01-3", "BREAK_END", "2026-08-01T19:30:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-01", "D01-4", "BREAK_START", "2026-08-01T21:40:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-01", "D01-5", "BREAK_END", "2026-08-01T22:05:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-01", "D01-6", "CHECK_OUT", "2026-08-01T23:15:00+09:00"),

  event("store-a", "sato-a", "佐藤 健", "2026-08-02", "D02-1", "CHECK_IN", "2026-08-02T21:30:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-02", "D02-2", "BREAK_START", "2026-08-02T23:45:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-02", "D02-3", "BREAK_END", "2026-08-03T00:15:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-02", "D02-4", "CHECK_OUT", "2026-08-03T02:30:00+09:00"),

  event("store-a", "sato-a", "佐藤 健", "2026-08-04", "D03-1", "CHECK_IN", "2026-08-04T09:00:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-04", "D03-2", "BREAK_START", "2026-08-04T12:00:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-04", "D03-3", "BREAK_END", "2026-08-04T13:00:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-04", "D03-4", "CHECK_OUT", "2026-08-04T18:00:00+09:00"),

  event("store-a", "sato-a", "佐藤 健", "2026-08-05", "D04-1", "CHECK_IN", "2026-08-05T18:00:00+09:00"),

  event("store-a", "sato-a", "佐藤 健", "2026-08-06", "D05-1", "CHECK_IN", "2026-08-06T17:00:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-06", "D05-2", "BREAK_START", "2026-08-06T20:00:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-06", "D05-3", "BREAK_END", "2026-08-06T20:30:00+09:00"),
  event("store-a", "sato-a", "佐藤 健", "2026-08-06", "D05-4", "CHECK_OUT", "2026-08-06T22:30:00+09:00", { source: "CORRECTION", corrected: true }),

  event("store-a", "sato-a", "佐藤 健", "2026-08-07", "D06-1", "CHECK_IN", "2026-08-07T10:00:00+09:00", { location_status: "WARNING", validation_code: "OUTSIDE_STORE_RADIUS" }),
  event("store-a", "sato-a", "佐藤 健", "2026-08-07", "D06-2", "CHECK_OUT", "2026-08-07T14:00:00+09:00"),

  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-01", "D07-1", "CHECK_IN", "2026-08-01T22:00:00+09:00"),
  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-01", "D07-2", "BREAK_START", "2026-08-02T01:00:00+09:00"),
  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-01", "D07-3", "BREAK_END", "2026-08-02T01:30:00+09:00"),
  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-01", "D07-4", "CHECK_OUT", "2026-08-02T05:00:00+09:00"),

  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-02", "D08-1", "CHECK_IN", "2026-08-03T04:30:00+09:00"),
  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-02", "D08-2", "CHECK_OUT", "2026-08-03T06:30:00+09:00"),

  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-03", "D09-1", "CHECK_IN", "2026-08-03T18:00:00+09:00"),
  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-03", "D09-2", "BREAK_START", "2026-08-03T20:00:00+09:00"),
  event("store-a", "suzuki-a", "鈴木 葵", "2026-08-03", "D09-3", "CHECK_OUT", "2026-08-03T23:00:00+09:00"),

  event("store-b", "sato-b", "佐藤 健", "2026-08-01", "D10-1", "CHECK_IN", "2026-08-01T12:00:00+09:00"),
  event("store-b", "sato-b", "佐藤 健", "2026-08-01", "D10-2", "CHECK_OUT", "2026-08-01T15:00:00+09:00"),
];

export const monthlyAttendanceV1Expected = {
  "store-a:sato-a": { workDays: 5, workedMinutes: 1620, breakMinutes: 165, lateNightMinutes: 340, needsReview: 1 },
  "store-a:suzuki-a": { workDays: 2, workedMinutes: 510, breakMinutes: 30, lateNightMinutes: 420, needsReview: 1 },
  "store-b:sato-b": { workDays: 1, workedMinutes: 180, breakMinutes: 0, lateNightMinutes: 0, needsReview: 0 },
};
