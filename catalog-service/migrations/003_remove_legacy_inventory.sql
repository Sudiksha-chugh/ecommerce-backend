DROP TABLE IF EXISTS inventory_reservations;

ALTER TABLE products
DROP COLUMN IF EXISTS stock;
