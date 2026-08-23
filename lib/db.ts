import {
  neon,
  type HTTPTransactionOptions,
  type NeonQueryFunctionInTransaction,
  type NeonQueryInTransaction,
  type QueryRows,
} from "@neondatabase/serverless";
import { assertDatabaseEnvironmentSafety } from "@/lib/environment-safety.mjs";

export type DatabaseRequestContext =
  | { mode: "rate_limit" }
  | { mode: "staff" | "registration"; lineIdentity: string; storeTokenHash: string }
  | { mode: "manager"; lineIdentity: string; storeId?: string }
  | { mode: "operator"; lineIdentity: string }
  | { mode: "cron" }
  | { mode: "onboarding_public"; clientRequestId: string }
  | { mode: "monthly_email_verification"; storeId: string }
  | { mode: "invite_claim"; lineIdentity: string; inviteTokenHash: string };

const safeContextValue = /^[A-Za-z0-9_-]+$/;

function assertContextValue(name: string, value: string) {
  if (value.length === 0 || value.length > 255 || !safeContextValue.test(value)) {
    throw new Error(`Invalid database request context: ${name}`);
  }
}

function requestContextValues(
  context: DatabaseRequestContext,
) {
  const values: Record<string, string> = {
    mode: context.mode,
  };

  if ("lineIdentity" in context) values.line_user_id = context.lineIdentity;
  if ("storeTokenHash" in context) values.store_token_hash = context.storeTokenHash;
  if ("storeId" in context && context.storeId) values.store_id = context.storeId;
  if ("clientRequestId" in context) values.client_request_id = context.clientRequestId;
  if ("inviteTokenHash" in context) values.invite_token_hash = context.inviteTokenHash;

  for (const [name, value] of Object.entries(values)) assertContextValue(name, value);

  return values;
}

type TransactionSql = NeonQueryFunctionInTransaction<false, false>;

export type ScopedSql = {
  (strings: TemplateStringsArray, ...params: unknown[]): Promise<QueryRows<false>>;
  transaction(
    buildQueries: (sql: TransactionSql) => NeonQueryInTransaction[],
    options?: HTTPTransactionOptions<false, false>,
  ): Promise<QueryRows<false>[]>;
};

function contextQuery(sql: TransactionSql, context: DatabaseRequestContext) {
  const values = requestContextValues(context);
  return sql`
    SELECT
      set_config('app.request_mode', ${values.mode}, TRUE),
      set_config('app.request_line_user_id', ${values.line_user_id ?? ""}, TRUE),
      set_config('app.request_store_token_hash', ${values.store_token_hash ?? ""}, TRUE),
      set_config('app.request_store_id', ${values.store_id ?? ""}, TRUE),
      set_config('app.request_client_request_id', ${values.client_request_id ?? ""}, TRUE),
      set_config('app.request_invite_token_hash', ${values.invite_token_hash ?? ""}, TRUE)
  `;
}

export function getSql(context: DatabaseRequestContext): ScopedSql {
  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is not configured");
  }

  assertDatabaseEnvironmentSafety(databaseUrl);

  const rawSql = neon(databaseUrl);
  const scopedSql = (async (
    strings: TemplateStringsArray,
    ...params: unknown[]
  ) => {
    const results = await rawSql.transaction((sql) => [
      contextQuery(sql, context),
      sql(strings, ...params),
    ]);
    return results[1];
  }) as ScopedSql;

  scopedSql.transaction = async (buildQueries, options) => {
    const results = await rawSql.transaction(
      (sql) => [contextQuery(sql, context), ...buildQueries(sql)],
      options,
    );
    return results.slice(1);
  };

  return scopedSql;
}
