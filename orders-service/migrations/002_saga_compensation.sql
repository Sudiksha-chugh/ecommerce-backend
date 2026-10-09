ALTER TABLE order_sagas ADD COLUMN cancel_requested BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_sagas ADD COLUMN payment_succeeded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_sagas ADD COLUMN refund_succeeded BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_sagas ADD COLUMN inventory_inactive BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_sagas ADD COLUMN failure_state VARCHAR(40);
ALTER TABLE order_sagas ADD COLUMN command_generation INTEGER NOT NULL DEFAULT 0;
UPDATE order_sagas SET payment_succeeded = TRUE WHERE state IN ('PAYMENT_AUTHORIZED', 'CONFIRMED');
CREATE INDEX idx_order_sagas_updated_at ON order_sagas(updated_at);
CREATE TABLE saga_transitions (
 id BIGSERIAL PRIMARY KEY,
 order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
 event_id VARCHAR(255) NOT NULL,
 from_state VARCHAR(40) NOT NULL,
 to_state VARCHAR(40) NOT NULL,
 created_at TIMESTAMP NOT NULL DEFAULT NOW()
);

UPDATE order_sagas SET state='RELEASE_PENDING',failure_state='PAYMENT_FAILED' WHERE state='PAYMENT_FAILED';
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='orders_app') THEN
  GRANT SELECT, INSERT ON saga_transitions TO orders_app;
  GRANT USAGE, SELECT ON SEQUENCE saga_transitions_id_seq TO orders_app;
 END IF;
END $$;
