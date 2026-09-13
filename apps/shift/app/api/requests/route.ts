import { neon } from '@neondatabase/serverless';
import { handleShiftHttp } from '@shared/shift-http.mjs';
export const runtime='nodejs';
export const dynamic='force-dynamic';
export function POST(request:Request){return handleShiftHttp(request,{env:process.env,connect:neon});}
