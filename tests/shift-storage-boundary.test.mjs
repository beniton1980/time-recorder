import test from 'node:test';
import assert from 'node:assert/strict';
import { shiftConfiguration, verifyShiftIdentity, executeShiftRequest } from '../lib/shift-storage-boundary.mjs';

const env = {
  ONOGAMI_PRODUCT: 'shift', SHIFT_DATABASE_URL: 'postgresql://shift_runtime:fixture@dev.example.test/neondb',
  SHIFT_ORIGIN: 'https://shift.example.test', SHIFT_LINE_LOGIN_CHANNEL_ID: '9999999999',
  VERCEL_ENV: 'preview', SHIFT_PREVIEW_DATABASE_ISOLATED: 'true', SHIFT_PRODUCTION_DATABASE_HOST: 'prod.example.test',
};

test('shift configuration requires isolated credentials, audience, origin and preview DB', () => {
  assert.equal(shiftConfiguration(env).origin, env.SHIFT_ORIGIN);
  for (const change of [
    { ONOGAMI_PRODUCT: 'attendance' }, { SHIFT_DATABASE_URL: '' }, { SHIFT_ORIGIN: 'http://shift.example.test' },
    { SHIFT_ORIGIN: 'https://shift.example.test/path' }, { SHIFT_LINE_LOGIN_CHANNEL_ID: '2010761826' },
    { DATABASE_URL: env.SHIFT_DATABASE_URL }, { CRON_SECRET: 'fixture' },
    { LINE_MESSAGING_CHANNEL_ACCESS_TOKEN: 'fixture' }, { ONOGAMI_STORE_QR_ENCRYPTION_KEY: 'fixture' },
    { SHIFT_PREVIEW_DATABASE_ISOLATED: 'false' }, { SHIFT_PRODUCTION_DATABASE_HOST: 'dev.example.test' },
    { SHIFT_PRODUCTION_DATABASE_HOST: '' },
  ]) assert.throws(() => shiftConfiguration({ ...env, ...change }), /SHIFT_NOT_CONFIGURED/);
});

const token = { aud: env.SHIFT_LINE_LOGIN_CHANNEL_ID, sub: 'U_fixture_shift', iss: 'https://access.line.me', exp: Date.now() / 1000 + 60 };
test('LINE verification uses the shift audience and returns only verified subject', async () => {
  const identity = await verifyShiftIdentity('fixture-token', token.aud, async (url, request) => {
    assert.equal(url, 'https://api.line.me/oauth2/v2.1/verify');
    assert.equal(request.body.get('client_id'), token.aud);
    assert.equal(request.body.get('id_token'), 'fixture-token');
    assert.equal(request.cache, 'no-store');
    return { ok: true, json: async () => token };
  });
  assert.equal(identity, 'U_fixture_shift');
});

test('wrong audience, expired token, malformed identity and upstream failure fail closed', async () => {
  for (const change of [{ aud: '2010761826' }, { exp: 1 }, { exp: '9999999999' }, { sub: '' }, { iss: 'https://other.example.test' }]) {
    await assert.rejects(verifyShiftIdentity('fixture-token', token.aud, async () => ({ ok: true, json: async () => ({ ...token, ...change }) })), /SHIFT_UNAUTHENTICATED/);
  }
  await assert.rejects(verifyShiftIdentity('fixture-token', token.aud, async () => { throw new Error('sensitive upstream body'); }), /^Error: SHIFT_UNAUTHENTICATED$/);
  await assert.rejects(verifyShiftIdentity('fixture-token', '2010761826', async () => assert.fail('must not fetch')), /SHIFT_UNAUTHENTICATED/);
});

test('role guard, identity context and command share one transaction with bound parameters', async () => {
  const queries = [];
  const sql = { transaction: async callback => {
    const result = callback((strings, ...params) => { queries.push({ sql: strings.join('?'), params }); return []; });
    assert.equal(result.length, 3);
    return [[], [], [{ value: { saved: true } }]];
  } };
  assert.deepEqual(await executeShiftRequest({ sql, lineIdentity: token.sub, storeId: '10000000-0000-4000-8000-000000000001', action: 'self', input: { periodId: 'fixture' } }), { saved: true });
  assert.match(queries[0].sql, /assert_runtime/);
  assert.match(queries[1].sql, /set_config.*true/);
  assert.deepEqual(queries[1].params, [token.sub, '10000000-0000-4000-8000-000000000001']);
  assert.deepEqual(queries[2].params, ['self', '{"periodId":"fixture"}']);
  for (const change of [{ action: 'rawSQL' }, { storeId: 'invalid' }, { lineIdentity: "x';SELECT 1" }, { input: { huge: 'a'.repeat(20001) } }]) {
    await assert.rejects(executeShiftRequest({ sql: { transaction: () => assert.fail('must not query') }, lineIdentity: token.sub,
      storeId: '10000000-0000-4000-8000-000000000001', action: 'self', input: {}, ...change }), /SHIFT_INVALID_REQUEST/);
  }
});
