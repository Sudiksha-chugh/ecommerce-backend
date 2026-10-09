-- Explicit application privileges only. Provisioning roles/metadata remain administrative.
-- service:orders
GRANT SELECT, INSERT ON orders, order_sagas, inbox_events, outbox_events, saga_transitions TO orders_app;
GRANT UPDATE (status) ON orders TO orders_app;
GRANT UPDATE (state, cancel_requested, payment_succeeded, refund_succeeded, inventory_inactive, failure_state, command_generation, version, updated_at, last_error) ON order_sagas TO orders_app;
GRANT UPDATE (processed_at) ON inbox_events TO orders_app;
GRANT UPDATE (published, published_at, payload) ON outbox_events TO orders_app;
-- Historical Orders 002 grants sequence SELECT; the application only needs nextval USAGE.
REVOKE SELECT ON SEQUENCE saga_transitions_id_seq FROM orders_app;
GRANT USAGE ON SEQUENCE orders_id_seq, outbox_events_id_seq, saga_transitions_id_seq TO orders_app;
-- service:inventory
GRANT SELECT, INSERT ON inventory, reservations, inbox_events, inventory_order_operations, outbox_events TO inventory_app;
GRANT UPDATE (quantity, updated_at) ON inventory TO inventory_app;
GRANT UPDATE (status) ON reservations TO inventory_app;
GRANT UPDATE (closed) ON inventory_order_operations TO inventory_app;
GRANT UPDATE (published, published_at) ON outbox_events TO inventory_app;
GRANT USAGE ON SEQUENCE reservations_id_seq, outbox_events_id_seq TO inventory_app;
-- service:payments
GRANT SELECT, INSERT ON payments, refunds, inbox_events, outbox_events TO payments_app;
-- UPDATE(status,updated_at) is supplied by canonical Payments migration 002.
GRANT UPDATE (published, published_at) ON outbox_events TO payments_app;
GRANT USAGE ON SEQUENCE payments_id_seq, refunds_id_seq, outbox_events_id_seq TO payments_app;
-- service:catalog
GRANT SELECT, INSERT ON products TO catalog_app;
GRANT USAGE ON SEQUENCE products_id_seq TO catalog_app;
