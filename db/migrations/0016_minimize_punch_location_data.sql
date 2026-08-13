-- Exact staff location telemetry is not needed after the punch has been
-- classified. Keep the attendance event and its validation result, but remove
-- historical coordinates, accuracy, and distance values.
UPDATE punch_events
SET
  latitude = NULL,
  longitude = NULL,
  gps_accuracy_m = NULL,
  distance_from_store_m = NULL
WHERE latitude IS NOT NULL
   OR longitude IS NOT NULL
   OR gps_accuracy_m IS NOT NULL
   OR distance_from_store_m IS NOT NULL;

COMMENT ON COLUMN punch_events.latitude IS
  'Deprecated privacy-sensitive field. Exact staff latitude is not stored.';
COMMENT ON COLUMN punch_events.longitude IS
  'Deprecated privacy-sensitive field. Exact staff longitude is not stored.';
COMMENT ON COLUMN punch_events.gps_accuracy_m IS
  'Deprecated privacy-sensitive field. Client GPS accuracy is not stored.';
COMMENT ON COLUMN punch_events.distance_from_store_m IS
  'Deprecated privacy-sensitive field. Exact distance is not stored.';
