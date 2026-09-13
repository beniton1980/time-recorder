import { createHmac } from 'node:crypto';
import { shiftConfiguration, verifyShiftIdentity, executeShiftRequest } from './shift-storage-boundary.mjs';

const messages = {
  SHIFT_NOT_CONFIGURED: [503, 'シフトの利用準備中です。時間をおいてお試しください。'],
  SHIFT_UNAUTHENTICATED: [401, 'LINEにログインし直してください。'],
  SHIFT_FORBIDDEN: [403, 'この店舗のシフトを確認する権限がありません。'],
  SHIFT_CONFLICT: [409, '別の画面で内容が更新されました。入力を控えてから最新の内容を読み込み、確認してください。'],
  SHIFT_CLOSED: [409, '受付を締め切りました。変更は管理者へご相談ください。'],
  SHIFT_RATE_LIMITED: [429, '操作が続いています。1分ほど待ってからお試しください。'],
  SHIFT_TOO_LARGE: [413, '入力が多すぎます。内容を確認してください。'],
  SHIFT_INVALID_REQUEST: [400, '入力内容を確認してください。'],
  SHIFT_UNAVAILABLE: [503, '接続できませんでした。入力を残したまま、時間をおいてお試しください。'],
};
const headers = { 'Cache-Control': 'private, no-store, max-age=0', Pragma: 'no-cache', 'X-Content-Type-Options': 'nosniff' };

export function shiftAppConfiguration(env) {
  const config = shiftConfiguration(env);
  if (!/^\d+-[A-Za-z0-9]+$/.test(env.SHIFT_LIFF_ID || '') || (env.SHIFT_RATE_LIMIT_SECRET || '').length < 32) throw new Error('SHIFT_NOT_CONFIGURED');
  return { ...config, liffId: env.SHIFT_LIFF_ID, rateSecret: env.SHIFT_RATE_LIMIT_SECRET };
}

async function readJson(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type') || '')) throw new Error('SHIFT_INVALID_REQUEST');
  const maximum = 32768;
  if (Number(request.headers.get('content-length')) > maximum) throw new Error('SHIFT_TOO_LARGE');
  const reader = request.body?.getReader();
  if (!reader) throw new Error('SHIFT_INVALID_REQUEST');
  let bytes = 0; const chunks = [];
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      bytes += value.byteLength;
      if (bytes > maximum) { await reader.cancel(); throw new Error('SHIFT_TOO_LARGE'); }
      chunks.push(Buffer.from(value));
    }
  } finally { reader.releaseLock(); }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('SHIFT_INVALID_REQUEST'); }
  if (!body || Array.isArray(body) || typeof body !== 'object' || typeof body.action !== 'string'
    || (body.action !== 'memberships' && typeof body.storeId !== 'string')
    || !body.input || typeof body.input !== 'object' || Array.isArray(body.input)) throw new Error('SHIFT_INVALID_REQUEST');
  return body;
}

async function consume(sql, scope, key) {
  const result = await sql.transaction(tx => [tx`SELECT shift.assert_runtime()`, tx`SELECT shift.consume_limit(${scope},${key}) AS allowed`]);
  if (result[1][0]?.allowed !== true) throw new Error('SHIFT_RATE_LIMITED');
}

/** Dependencies are injected only by tests; the deployed route uses real LINE + SQL. */
export async function handleShiftHttp(request, { env, connect, verify = verifyShiftIdentity, execute = executeShiftRequest, limit = consume }) {
  try {
    const config = shiftAppConfiguration(env);
    if (request.method !== 'POST' || request.headers.get('origin') !== config.origin) throw new Error('SHIFT_FORBIDDEN');
    const idToken = request.headers.get('authorization')?.match(/^Bearer ([^\s]{1,8192})$/)?.[1];
    if (!idToken) throw new Error('SHIFT_UNAUTHENTICATED');
    const body = await readJson(request);
    const sql = connect(config.databaseUrl);
    const fingerprint = value => createHmac('sha256',config.rateSecret).update(value).digest('hex');
    await limit(sql,'global',fingerprint('all'));
    await limit(sql,'client',fingerprint(request.headers.get('x-vercel-forwarded-for')?.split(',')[0].trim() || 'unknown'));
    const lineIdentity = await verify(idToken,config.channelId);
    await limit(sql,'subject',fingerprint(lineIdentity));
    const data = await execute({ sql, lineIdentity, storeId: body.storeId || '', action: body.action, input: body.input });
    return Response.json({ ok: true, data },{ headers });
  } catch (error) {
    let code = error instanceof Error ? error.message : '';
    if (['SHIFT_INVALID_PAYLOAD','SHIFT_INVALID_DEADLINE','SHIFT_INVALID_ACTION'].includes(code)
      || ['22P02','22007','22008','23514','23502'].includes(error?.code)) code='SHIFT_INVALID_REQUEST';
    if (error?.code === '23505') code='SHIFT_CONFLICT';
    if (!Object.hasOwn(messages,code)) code='SHIFT_UNAVAILABLE';
    const [status,message] = messages[code];
    return Response.json({ ok:false,code,message },{ status,headers:{ ...headers,...(status===429?{'Retry-After':'60'}:{}) } });
  }
}
