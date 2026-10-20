import { PGlite } from "@electric-sql/pglite";
import { btree_gist } from "@electric-sql/pglite/contrib/btree_gist";
import { readdir, readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { loadTs } from "./load-ts.mjs";

export const token = "FICTITIOUS_FIXTURE_QR_ONLY_20261010";
export const tokenHash = createHash("sha256").update(token).digest("hex");
export async function fixture({throughMigration = null} = {}) {
  const db = new PGlite({ extensions: { btree_gist }, parsers: { 1082: v => v, 1184: v => new Date(v).toISOString() } });
  const dir = new URL("../../db/migrations/", import.meta.url);
  const migrations = (await readdir(dir)).filter(n => n.endsWith(".sql") && (!throughMigration || n <= throughMigration)).sort();
  for (const name of migrations.filter(n => n < "0040_")) {
    const sql = (await readFile(new URL(name, dir), "utf8"))
      .replace("CREATE EXTENSION IF NOT EXISTS pgcrypto;", "")
      .replaceAll("DATABASE neondb", "DATABASE postgres").replaceAll("ROLE neondb_owner", "ROLE postgres");
    await db.exec(sql);
  }
  const store = randomUUID(), otherStore = randomUUID(), staff = randomUUID(), otherStaff = randomUUID();
  await db.query("INSERT INTO stores(id,name) VALUES ($1,'Fixture A'),($2,'Fixture B')", [store,otherStore]);
  await db.query("INSERT INTO staff(id,store_id,line_user_id,legal_name) VALUES ($1,$2,'fixture_actor','Fixture'),($3,$4,'fixture_other','Other')", [staff,store,otherStaff,otherStore]);
  await db.query("INSERT INTO staff_states(staff_id) VALUES ($1),($2)",[staff,otherStaff]);
  await db.query("INSERT INTO store_entry_tokens(store_id,token_hash) VALUES ($1,$2)",[store,tokenHash]);
  // Exercise an upgrade with existing correction history, not only an empty install.
  await db.query("INSERT INTO correction_requests(store_id,staff_id,operation,reason) VALUES ($1,$2,'REVIEW','Legacy fixture')",[store,staff]);
  for (const name of migrations.filter(n => n >= "0040_")) {
    await db.exec(await readFile(new URL(name,dir),"utf8"));
  }
  function getSql(context) {
    const query=(strings,params)=>({ text:strings.reduce((out,s,i)=>out+(i?"$"+i:"")+s,""), params });
    const run=queries=>db.transaction(async tx=>{
      await tx.exec("SET LOCAL ROLE onogami_app");
      for (const [k,v] of Object.entries({mode:context.mode,line_user_id:context.lineIdentity||"",store_token_hash:context.storeTokenHash||"",store_id:context.storeId||""})) {
        await tx.query("SELECT set_config($1,$2,true)",["app.request_"+k,v]);
      }
      const rows=[];for(const q of queries) rows.push((await tx.query(q.text,q.params)).rows);return rows;
    });
    const sql=async(strings,...params)=>(await run([query(strings,params)]))[0];
    sql.transaction=build=>run(build((strings,...params)=>query(strings,params)));
    return sql;
  }
  class LineTokenVerificationError extends Error {}
  const modules={
    "next/server":{NextResponse:{json:(value,options)=>Response.json(value,options)}},
    "@/lib/db":{getSql}, "@/lib/safe-log":{logServerError(){},logServerInfo(){}},
    "@/lib/line/verify-id-token":{LineTokenVerificationError,verifyLineIdToken:async id=>{
      if(!["fixture_actor","fixture_other","fixture_new","fixture_manager"].includes(id)) throw new LineTokenVerificationError();
      return {sub:id};
    }},
    "@/lib/store-entry-token":{hashStoreEntryToken:value=>typeof value==="string"?createHash("sha256").update(value).digest("hex"):null},
    "@/lib/api-security":{enforceRateLimit:async()=>null},
  };
  const api=path=>loadTs("app/api/"+path+"/route.ts",modules);
  const correction=api("correction-requests"), bootstrap=api("session/bootstrap"), punch=api("punch");
  const validate=api("correction-requests/validate"), decision=api("manager/corrections/decision"), dashboard=api("manager/dashboard");
  const call=async(route,body)=>{
    const response=await route.POST(new Request("http://fixture.local/api",{method:"POST",body:JSON.stringify({idToken:"fixture_actor",storeToken:token,...body})}));
    return {status:response.status,...await response.json()};
  };
  const add=async(type)=>{
    const id=randomUUID();
    await db.query("INSERT INTO punch_events(id,store_id,staff_id,event_type,occurred_at,business_date,client_request_id) VALUES ($1,$2,$3,$4,NOW(),CURRENT_DATE,$5)",[id,store,staff,type,randomUUID()]);
    await db.query("UPDATE staff_states SET state=$1,last_event_id=$2,last_event_at=NOW() WHERE staff_id=$3",[type==="CHECK_OUT"?"OFF_DUTY":type==="BREAK_START"?"ON_BREAK":"WORKING",id,staff]);
    return id;
  };
  return {db,store,otherStore,staff,otherStaff,getSql,call,correction,bootstrap,punch,validate,decision,dashboard,add,api};
}
