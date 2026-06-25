CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  amount INTEGER NOT NULL,            -- minor units (paise)
  currency TEXT NOT NULL DEFAULT 'INR',
  vpa TEXT,                           -- payer UPI id
  status TEXT NOT NULL,               -- created|pending|success|failed|expired
  provider TEXT NOT NULL DEFAULT 'mock',
  provider_ref TEXT,                  -- gateway order id (e.g. Razorpay order_...)
  provider_payment_ref TEXT,          -- gateway payment id (needed to refund)
  order_id TEXT,
  idempotency_key TEXT UNIQUE,
  metadata TEXT,
  refunded_amount INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS refunds (
  id TEXT PRIMARY KEY,
  payment_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  amount INTEGER NOT NULL,
  status TEXT NOT NULL,               -- processing|processed|failed
  provider_ref TEXT,                  -- gateway refund id
  reason TEXT
);
CREATE TABLE IF NOT EXISTS payment_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  payment_id TEXT NOT NULL,
  at TEXT NOT NULL,
  type TEXT NOT NULL,
  data TEXT
);
CREATE INDEX IF NOT EXISTS idx_payments_status ON payments(status);
CREATE INDEX IF NOT EXISTS idx_payments_provider_ref ON payments(provider_ref);
CREATE INDEX IF NOT EXISTS idx_events_payment ON payment_events(payment_id);
CREATE INDEX IF NOT EXISTS idx_refunds_payment ON refunds(payment_id);
