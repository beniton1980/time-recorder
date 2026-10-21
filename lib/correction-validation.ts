const messages: Record<string, string> = {
  ATTENTION_CHANGED: "対象の勤務記録が更新されています。入力は保持しています。勤務の確認を更新し、対象を確認してください。",
  ATTENTION_ALREADY_PENDING: "この勤務には確認待ちの申請があります。既存の申請の状況を確認してください。",
  CORRECTION_BREAK_START_REQUIRED: "休憩開始の記録がありません。",
  CORRECTION_SEQUENCE_INVALID: "前後の打刻とつながりません。種類と日時を確認してください。",
  CORRECTION_TIME_CONFLICT: "同じ時刻の打刻がすでにあります。日時を確認してください。",
  CORRECTION_PENDING_CONFLICT: "同じ種類・時刻の申請が承認待ちです。管理者の確認をお待ちください。",
  INVALID_CORRECTION_REQUEST: "打刻の種類と日時を確認してください。",
  OCCURRED_AT_IN_FUTURE: "未来の日時は申請できません。実際に勤務した日時を入力してください。",
  OCCURRED_AT_OUT_OF_RANGE: "申請できる期間外です。日時を確認し、管理者に相談してください。",
};

export function correctionValidationMessage(code: unknown): string | null {
  return typeof code === "string" && Object.hasOwn(messages, code) ? messages[code] : null;
}
