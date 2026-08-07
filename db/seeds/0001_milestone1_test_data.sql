WITH new_store AS (
  INSERT INTO stores (
    name,
    timezone,
    business_day_start_minute,
    closing_rule,
    status
  )
  VALUES (
    'テスト店舗（削除可）',
    'Asia/Tokyo',
    300,
    'month_end',
    'active'
  )
  RETURNING id
),
new_staff AS (
  INSERT INTO staff (
    store_id,
    line_user_id,
    legal_name,
    status
  )
  SELECT
    id,
    'test-line-user-v2',
    'テスト スタッフ',
    'active'
  FROM new_store
  RETURNING id
)
INSERT INTO staff_states (
  staff_id,
  state
)
SELECT
  id,
  'OFF_DUTY'
FROM new_staff;
