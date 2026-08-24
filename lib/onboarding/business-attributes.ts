export type SelectOption<T extends string = string> = {
  value: T;
  label: string;
};

export const businessCategoryOptions = [
  { value: "food_service", label: "飲食業" },
  { value: "retail", label: "小売業" },
  { value: "personal_services", label: "生活関連サービス業" },
  { value: "lodging", label: "宿泊業" },
  { value: "medical_welfare", label: "医療・福祉" },
  { value: "education", label: "教育・学習支援業" },
  { value: "construction", label: "建設業" },
  { value: "manufacturing", label: "製造業" },
  { value: "other", label: "その他" },
] as const satisfies readonly SelectOption[];

export const staffCountRangeOptions = [
  { value: "1_4", label: "1〜4人" },
  { value: "5_9", label: "5〜9人" },
  { value: "10_19", label: "10〜19人" },
  { value: "20_49", label: "20〜49人" },
  { value: "50_plus", label: "50人以上" },
] as const satisfies readonly SelectOption[];

export const storeCountRangeOptions = [
  { value: "1", label: "1事業所" },
  { value: "2_4", label: "2〜4事業所" },
  { value: "5_9", label: "5〜9事業所" },
  { value: "10_plus", label: "10事業所以上" },
] as const satisfies readonly SelectOption[];

export const priorAttendanceMethodOptions = [
  { value: "paper", label: "紙・手書き" },
  { value: "spreadsheet", label: "Excel・スプレッドシート" },
  { value: "time_clock", label: "タイムレコーダー" },
  { value: "other_service", label: "他の勤怠管理サービス" },
  { value: "none", label: "特に管理していない" },
  { value: "other", label: "その他" },
] as const satisfies readonly SelectOption[];

export const reportedAcquisitionSourceOptions = [
  { value: "referral", label: "知人・取引先からの紹介" },
  { value: "business_group", label: "商工会・業界団体等からの案内" },
  { value: "web_search", label: "Web検索" },
  { value: "social_media", label: "SNS" },
  { value: "event", label: "イベント・セミナー" },
  { value: "other", label: "その他" },
] as const satisfies readonly SelectOption[];

export type BusinessCategory = (typeof businessCategoryOptions)[number]["value"];
export type StaffCountRange = (typeof staffCountRangeOptions)[number]["value"];
export type StoreCountRange = (typeof storeCountRangeOptions)[number]["value"];
export type PriorAttendanceMethod = (typeof priorAttendanceMethodOptions)[number]["value"];
export type ReportedAcquisitionSource = (typeof reportedAcquisitionSourceOptions)[number]["value"];

export function isOptionValue<T extends string>(
  options: readonly SelectOption<T>[],
  value: unknown,
): value is T {
  return typeof value === "string" && options.some((option) => option.value === value);
}

export function optionLabel<T extends string>(
  options: readonly SelectOption<T>[],
  value: string | null,
) {
  if (!value) return "未回答";
  return options.find((option) => option.value === value)?.label ?? "不明";
}
