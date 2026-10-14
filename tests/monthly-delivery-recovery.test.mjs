import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";
import { randomUUID } from "node:crypto";
import { coManagerFixture } from "./helpers/co-manager-fixture.mjs";

test("0044 repairs failed/stale claims for Cron and managers while preserving history, privileges and SENT exclusion",async()=>{
  const f=await coManagerFixture({throughMigration:"0043_zzzz"});
  try {
    await f.seedReport();
    const recipient=(await f.db.query("SELECT monthly_report_recipient_version_id id FROM stores WHERE id=$1",[f.store])).rows[0].id;
    const metadata=()=>f.db.query("SELECT proowner,proacl,proconfig,prosecdef FROM pg_proc WHERE oid='public.claim_monthly_attendance_delivery(uuid,date,date,text,uuid)'::regprocedure");
    const before=(await metadata()).rows;
    const versions=["initial","reissue-"+randomUUID()];
    const claim=(mode,version)=>f.getSql({mode,lineIdentity:"fixture_delegate",storeId:f.store})`SELECT * FROM claim_monthly_attendance_delivery(${f.store}::uuid,'2026-08-01'::date,'2026-08-31'::date,${version},${recipient}::uuid)`;
    for(const version of versions)await f.db.query("INSERT INTO monthly_attendance_deliveries(store_id,period_start,period_end,status,recipient,delivery_version)VALUES($1,'2026-08-01','2026-08-31','FAILED','fixture@example.invalid',$2)",[f.store,version]);
    await assert.rejects(claim("cron","initial"),error=>error.code==="42702");
    const saved=(await f.db.query("SELECT * FROM monthly_attendance_deliveries ORDER BY id")).rows;
    await f.db.exec(await readFile(new URL("../db/migrations/0044_monthly_delivery_retry_column.sql",import.meta.url),"utf8"));
    assert.deepEqual((await metadata()).rows,before);
    assert.deepEqual((await f.db.query("SELECT * FROM monthly_attendance_deliveries ORDER BY id")).rows,saved);
    for(const [index,version] of versions.entries()){
      const mode=index===0?"cron":"manager";
      const first=await claim(mode,version);assert.equal(first.length,1);
      assert.equal((await claim(mode,version)).length,0);
      await f.db.query("UPDATE monthly_attendance_deliveries SET updated_at=NOW()-INTERVAL '16 minutes' WHERE id=$1",[first[0].delivery_id]);
      const recovered=await claim(mode,version);assert.equal(recovered.length,1);assert.notEqual(recovered[0].attempt_id,first[0].attempt_id);
      const old=(await f.db.query("SELECT status,error_code FROM monthly_attendance_delivery_attempts WHERE id=$1",[first[0].attempt_id])).rows[0];
      assert.deepEqual(old,{status:"FAILED",error_code:"STALE_DELIVERY_RECOVERED"});
      await f.getSql({mode,lineIdentity:"fixture_delegate",storeId:f.store})`SELECT finish_monthly_attendance_delivery_attempt(${recovered[0].attempt_id}::uuid,TRUE,'fixture',NULL)`;
      assert.equal((await claim(mode,version)).length,0);
    }
    await assert.rejects(f.getSql({mode:"manager",lineIdentity:"fixture_actor",storeId:f.store})`SELECT * FROM claim_monthly_attendance_delivery(${f.store}::uuid,'2026-06-01'::date,'2026-06-30'::date,'initial',${recipient}::uuid)`,error=>error.message==="DELIVERY_ACCESS_REQUIRED");
  } finally {await f.db.close();}
});
