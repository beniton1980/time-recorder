export function shiftAppConfiguration(env: Record<string,string|undefined>): { databaseUrl:string; origin:string; channelId:string; liffId:string; rateSecret:string };
export function handleShiftHttp(request:Request, dependencies:{env:Record<string,string|undefined>;connect:typeof import('@neondatabase/serverless').neon}):Promise<Response>;
