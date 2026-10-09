-- The existing upsert changes only these columns; retain all other restrictions.
GRANT UPDATE (status, updated_at) ON payments, refunds TO payments_app;
