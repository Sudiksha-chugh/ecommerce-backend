CREATE TABLE IF NOT EXISTS inbox_events (
 event_id VARCHAR(255) PRIMARY KEY,
 event_type VARCHAR(100) NOT NULL,
 order_id INTEGER NOT NULL,
 processed_at TIMESTAMP NOT NULL DEFAULT NOW()
);
DO $$ BEGIN
 IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname='payments_app') THEN
  GRANT SELECT, INSERT ON inbox_events TO payments_app;
 END IF;
END $$;
