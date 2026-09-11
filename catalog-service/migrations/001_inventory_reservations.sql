ALTER TABLE inventory_reservations
ADD CONSTRAINT unique_order_product
UNIQUE (order_id, product_id);

CREATE INDEX idx_inventory_reservations_expiration
ON inventory_reservations (expires_at)
WHERE status = 'reserved';
