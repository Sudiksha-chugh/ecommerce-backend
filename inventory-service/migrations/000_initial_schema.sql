CREATE TABLE inventory (
  product_id INTEGER PRIMARY KEY,
  quantity INTEGER NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  updated_at TIMESTAMP DEFAULT NOW()
);

CREATE TABLE reservations (
  id SERIAL PRIMARY KEY,
  order_id INTEGER NOT NULL,
  product_id INTEGER NOT NULL,
  quantity INTEGER NOT NULL CHECK (quantity > 0),
  status VARCHAR(20) NOT NULL DEFAULT 'PENDING',
  created_at TIMESTAMP DEFAULT NOW(),
  expires_at TIMESTAMP,
  CONSTRAINT unique_order_product UNIQUE (order_id, product_id),
  CONSTRAINT reservations_status_check
    CHECK (status IN ('PENDING', 'CONFIRMED', 'RELEASED', 'EXPIRED'))
);

CREATE INDEX idx_reservations_expiration
ON reservations (expires_at)
WHERE status = 'PENDING';

CREATE TABLE outbox_events (
  id SERIAL PRIMARY KEY,
  event_type VARCHAR(50) NOT NULL,
  payload JSONB NOT NULL,
  published BOOLEAN NOT NULL DEFAULT FALSE,
  created_at TIMESTAMP DEFAULT NOW(),
  published_at TIMESTAMP
);
