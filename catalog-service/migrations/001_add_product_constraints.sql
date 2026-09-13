ALTER TABLE products
  ADD CONSTRAINT products_price_nonnegative CHECK (price >= 0);

ALTER TABLE products
  ADD CONSTRAINT products_stock_nonnegative CHECK (stock >= 0);
