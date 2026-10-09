CREATE TABLE order_sagas (
  order_id INTEGER PRIMARY KEY
    REFERENCES orders(id) ON DELETE CASCADE,

  state VARCHAR(40) NOT NULL DEFAULT 'PENDING',

  version INTEGER NOT NULL DEFAULT 1,

  last_error TEXT,

  created_at TIMESTAMP NOT NULL DEFAULT NOW(),

  updated_at TIMESTAMP NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_order_sagas_state
ON order_sagas (state);

CREATE TABLE inbox_events (
  event_id VARCHAR(255) PRIMARY KEY,

  event_type VARCHAR(100) NOT NULL,

  order_id INTEGER,

  received_at TIMESTAMP NOT NULL DEFAULT NOW(),

  processed_at TIMESTAMP
);

CREATE INDEX idx_inbox_events_order_id
ON inbox_events (order_id);
