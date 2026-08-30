type ManagerApiErrorPayload = { code?: unknown } | null | undefined;

export function managerApiAuthError(status: number, payload?: ManagerApiErrorPayload) {
  if (status === 401 || payload?.code === "INVALID_ID_TOKEN") {
    return new Error("LINEの認証期限が切れました。LINEから画面を開き直してください。");
  }
  if (status === 403 || payload?.code === "MANAGER_ACCESS_REQUIRED") {
    return new Error("この店舗の管理者権限がありません。管理者アカウントと店舗を確認してください。");
  }
  return null;
}
