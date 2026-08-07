BEGIN;

ALTER TABLE correction_requests
  DROP CONSTRAINT correction_requests_operation_check;

ALTER TABLE correction_requests
  ADD CONSTRAINT correction_requests_operation_check
  CHECK (operation IN ('ADD', 'REPLACE', 'VOID', 'REVIEW'));

COMMIT;
