import 'server-only';
import { neon } from '@neondatabase/serverless';
import { executeShiftRequest, shiftConfiguration, verifyShiftIdentity } from './shift-storage-boundary.mjs';

/** Foundation for the separate shift deployment. No route is mounted in attendance. */
export async function requestShiftStorage(request: {
  origin: string | null;
  idToken: string;
  storeId: string;
  action: string;
  input: Record<string, unknown>;
}) {
  const config = shiftConfiguration(process.env);
  if (request.origin !== config.origin) throw new Error('SHIFT_FORBIDDEN');
  const lineIdentity = await verifyShiftIdentity(request.idToken, config.channelId);
  return executeShiftRequest({
    sql: neon(config.databaseUrl), lineIdentity, storeId: request.storeId,
    action: request.action, input: request.input,
  });
}
