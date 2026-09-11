ALTER TABLE inventory_reservations
ADD CONSTRAINT inventory_reservations_status_check
CHECK (status IN ('reserved', 'confirmed', 'released', 'refunded'));
