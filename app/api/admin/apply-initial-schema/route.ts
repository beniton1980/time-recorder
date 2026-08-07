import { NextResponse } from "next/server";
import { getSql } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const targetTables = [
  "stores",
  "store_entry_tokens",
  "staff",
  "staff_states",
  "punch_events",
  "correction_requests",
] as const;

export async function GET() {
  const sql = getSql();

  const existing = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY(${targetTables})
  `;

  if (existing.length > 0) {
    return NextResponse.json(
      {
        ok: false,
        status: "not_applied",
        reason: "target_tables_already_exist",
        existingTables: existing.map((row) => row.table_name),
      },
      { status: 409 },
    );
  }

  await sql.transaction([
    sql`CREATE EXTENSION IF NOT EXISTS pgcrypto`,
    sql`
      CREATE TABLE stores (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        name TEXT NOT NULL,
        timezone TEXT NOT NULL DEFAULT 'Asia/Tokyo',
        business_day_start_minute INTEGER NOT NULL DEFAULT 300
          CHECK (
            business_day_start_minute >= 0
            AND business_day_start_minute < 1440
          ),
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        closing_rule TEXT NOT NULL DEFAULT 'month_end',
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'suspended', 'closed')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`
      CREATE TABLE store_entry_tokens (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id),
        token_hash TEXT NOT NULL UNIQUE,
        active BOOLEAN NOT NULL DEFAULT TRUE,
        expires_at TIMESTAMPTZ,
        revoked_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`CREATE INDEX idx_store_entry_tokens_store_id ON store_entry_tokens(store_id)`,
    sql`
      CREATE TABLE staff (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id),
        line_user_id TEXT NOT NULL,
        legal_name TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'active'
          CHECK (status IN ('active', 'inactive')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE (store_id, line_user_id)
      )
    `,
    sql`CREATE INDEX idx_staff_store_id ON staff(store_id)`,
    sql`CREATE INDEX idx_staff_line_user_id ON staff(line_user_id)`,
    sql`
      CREATE TABLE staff_states (
        staff_id UUID PRIMARY KEY REFERENCES staff(id),
        state TEXT NOT NULL DEFAULT 'OFF_DUTY'
          CHECK (state IN ('OFF_DUTY', 'WORKING', 'ON_BREAK')),
        last_event_id UUID,
        last_event_at TIMESTAMPTZ,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`
      CREATE TABLE punch_events (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id),
        staff_id UUID NOT NULL REFERENCES staff(id),
        event_type TEXT NOT NULL
          CHECK (
            event_type IN (
              'CHECK_IN',
              'BREAK_START',
              'BREAK_END',
              'CHECK_OUT'
            )
          ),
        occurred_at TIMESTAMPTZ NOT NULL,
        received_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        business_date DATE NOT NULL,
        client_request_id UUID NOT NULL UNIQUE,
        latitude DOUBLE PRECISION,
        longitude DOUBLE PRECISION,
        gps_accuracy_m DOUBLE PRECISION,
        distance_from_store_m DOUBLE PRECISION,
        location_status TEXT NOT NULL DEFAULT 'UNAVAILABLE'
          CHECK (location_status IN ('OK', 'WARNING', 'UNAVAILABLE')),
        validation_status TEXT NOT NULL DEFAULT 'VALID'
          CHECK (validation_status IN ('VALID', 'WARNING')),
        validation_code TEXT,
        source TEXT NOT NULL DEFAULT 'LIFF'
          CHECK (source IN ('LIFF', 'MANAGER', 'IMPORT', 'SYSTEM')),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`CREATE INDEX idx_punch_events_staff_time ON punch_events(staff_id, occurred_at DESC)`,
    sql`CREATE INDEX idx_punch_events_store_date ON punch_events(store_id, business_date)`,
    sql`CREATE INDEX idx_punch_events_business_date ON punch_events(business_date)`,
    sql`
      ALTER TABLE staff_states
        ADD CONSTRAINT fk_staff_states_last_event
        FOREIGN KEY (last_event_id)
        REFERENCES punch_events(id)
    `,
    sql`
      CREATE TABLE correction_requests (
        id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        store_id UUID NOT NULL REFERENCES stores(id),
        staff_id UUID NOT NULL REFERENCES staff(id),
        operation TEXT NOT NULL
          CHECK (operation IN ('ADD', 'REPLACE', 'VOID')),
        target_event_id UUID REFERENCES punch_events(id),
        requested_event_type TEXT
          CHECK (
            requested_event_type IS NULL
            OR requested_event_type IN (
              'CHECK_IN',
              'BREAK_START',
              'BREAK_END',
              'CHECK_OUT'
            )
          ),
        requested_occurred_at TIMESTAMPTZ,
        reason TEXT,
        status TEXT NOT NULL DEFAULT 'PENDING'
          CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
        requested_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        approved_by TEXT,
        approved_at TIMESTAMPTZ,
        rejected_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `,
    sql`CREATE INDEX idx_correction_requests_store_status ON correction_requests(store_id, status)`,
    sql`CREATE INDEX idx_correction_requests_staff ON correction_requests(staff_id)`,
  ]);

  const created = await sql`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = ANY(${targetTables})
    ORDER BY table_name
  `;

  return NextResponse.json({
    ok: true,
    status: "applied",
    tables: created.map((row) => row.table_name),
  });
}
