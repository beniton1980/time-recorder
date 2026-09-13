export type ShiftConfiguration = { databaseUrl: string; origin: string; channelId: string };
export function shiftConfiguration(env: Record<string, string | undefined>): ShiftConfiguration;
export function verifyShiftIdentity(idToken: string, channelId: string, fetcher?: typeof fetch): Promise<string>;
export function executeShiftRequest(options: {
  sql: import('@neondatabase/serverless').NeonQueryFunction<false, false>;
  lineIdentity: string;
  storeId: string;
  action: string;
  input: Record<string, unknown>;
}): Promise<unknown>;
