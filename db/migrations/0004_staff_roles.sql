ALTER TABLE staff
  ADD COLUMN IF NOT EXISTS role TEXT NOT NULL DEFAULT 'STAFF';

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'staff_role_check'
      AND conrelid = 'staff'::regclass
  ) THEN
    ALTER TABLE staff
      ADD CONSTRAINT staff_role_check
      CHECK (role IN ('STAFF', 'MANAGER'));
  END IF;
END
$$;

CREATE INDEX IF NOT EXISTS idx_staff_store_role
  ON staff(store_id, role);
