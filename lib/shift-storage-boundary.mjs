// Server boundary helpers; tests use injected fetch/SQL. Never accepts a browser's
// claimed LINE user ID or manager flag. No attendance DB/channel fallback.
const ATTENDANCE_CHANNEL = '2010761826';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const actions = new Set(['memberships', 'bootstrap', 'createPeriod', 'self', 'manager', 'saveDraft', 'submit', 'proxySubmit', 'closePeriod']);

export function shiftConfiguration(env) {
  const fail = () => { throw new Error('SHIFT_NOT_CONFIGURED'); };
  if (env.ONOGAMI_PRODUCT !== 'shift' || !env.SHIFT_DATABASE_URL || !env.SHIFT_ORIGIN
    || !/^\d+$/.test(env.SHIFT_LINE_LOGIN_CHANNEL_ID || '')
    || env.SHIFT_LINE_LOGIN_CHANNEL_ID === ATTENDANCE_CHANNEL) fail();
  let database, origin;
  try { database = new URL(env.SHIFT_DATABASE_URL); origin = new URL(env.SHIFT_ORIGIN); } catch { fail(); }
  if (!['postgres:', 'postgresql:'].includes(database.protocol) || !database.hostname || !database.username
    || origin.protocol !== 'https:' || origin.origin !== env.SHIFT_ORIGIN) fail();
  // Separate deployment must not receive attendance secrets at all.
  for (const key of ['DATABASE_URL', 'CRON_SECRET', 'LINE_MESSAGING_CHANNEL_ACCESS_TOKEN', 'ONOGAMI_STORE_QR_ENCRYPTION_KEY']) {
    if (env[key]) fail();
  }
  if (env.VERCEL_ENV === 'preview' && (env.SHIFT_PREVIEW_DATABASE_ISOLATED !== 'true'
    || !env.SHIFT_PRODUCTION_DATABASE_HOST
    || database.hostname.toLowerCase() === env.SHIFT_PRODUCTION_DATABASE_HOST.trim().toLowerCase())) fail();
  return { databaseUrl: env.SHIFT_DATABASE_URL, origin: origin.origin, channelId: env.SHIFT_LINE_LOGIN_CHANNEL_ID };
}

export async function verifyShiftIdentity(idToken, channelId, fetcher = fetch) {
  const fail = () => { throw new Error('SHIFT_UNAUTHENTICATED'); };
  if (typeof idToken !== 'string' || !idToken.length || idToken.length > 8192
    || !/^\d+$/.test(channelId || '') || channelId === ATTENDANCE_CHANNEL) fail();
  try {
    const response = await fetcher('https://api.line.me/oauth2/v2.1/verify', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ id_token: idToken, client_id: channelId }),
      cache: 'no-store', signal: AbortSignal.timeout(5000),
    });
    if (!response.ok) fail();
    const payload = await response.json();
    if (payload.aud !== channelId || payload.iss !== 'https://access.line.me'
      || typeof payload.sub !== 'string' || !/^[A-Za-z0-9_-]{1,255}$/.test(payload.sub)
      || !Number.isFinite(payload.exp) || payload.exp <= Date.now() / 1000) fail();
    return payload.sub;
  } catch { fail(); }
}

export async function executeShiftRequest({ sql, lineIdentity, storeId, action, input }) {
  if (!/^[A-Za-z0-9_-]{1,255}$/.test(lineIdentity || '') || (action !== 'memberships' && !uuid.test(storeId || ''))
    || !actions.has(action) || !input || Array.isArray(input) || typeof input !== 'object') {
    throw new Error('SHIFT_INVALID_REQUEST');
  }
  const encoded = JSON.stringify(input);
  if (Buffer.byteLength(encoded, 'utf8') > 20000) throw new Error('SHIFT_INVALID_REQUEST');
  // HTTP driver pins this batch to one transaction; pooled context never survives it.
  const result = await sql.transaction(tx => [
    tx`SELECT shift.assert_runtime()`,
    tx`SELECT set_config('shift.product','shift',true), set_config('shift.line_user_id',${lineIdentity},true), set_config('shift.store_id',${action === 'memberships' ? '' : storeId.toLowerCase()},true)`,
    action === 'memberships' ? tx`SELECT shift.memberships() AS value` : tx`SELECT shift.request(${action},${encoded}::jsonb) AS value`,
  ]);
  return result[2][0].value;
}
