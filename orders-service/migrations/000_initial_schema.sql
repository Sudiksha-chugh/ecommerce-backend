-- Canonical empty-database baseline. Existing installations must not replay it.
CREATE TABLE orders (
  id SERIAL PRIMARY KEY,
  user_id INTEGER NOT NULL,
  items JSONB NOT NULL,
  total_amount NUMERIC(10,2) NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP DEFAULT NOW(),
  idempotency_key VARCHAR(255)
);
CREATE UNIQUE INDEX orders_user_id_idempotency_key_idx
ON orders (user_id, idempotency_key)
WHERE idempotency_key IS NOT NULL;
CREATE TABLE outbox_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP
);
