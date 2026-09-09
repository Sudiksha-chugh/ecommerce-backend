const pool = require('../src/db');
const {
  releaseExpiredReservations,
} = require('../src/inventoryExpiration');

describe('Inventory expiration worker', () => {
  let productId;

  beforeEach(async () => {
    const result = await pool.query(
      `INSERT INTO products
       (name, description, price, stock)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [
        'Expiration Test Product',
        'Product for expiration testing',
        100,
        10,
      ]
    );

    productId = result.rows[0].id;
  });

  afterEach(async () => {
    await pool.query(
      'DELETE FROM inventory_reservations'
    );

    await pool.query(
      'DELETE FROM products'
    );
  });

  it('releases an expired reservation and restores stock', async () => {
    await pool.query(
      `UPDATE products
       SET stock = stock - 2
       WHERE id = $1`,
      [productId]
    );

    const reservation = await pool.query(
      `INSERT INTO inventory_reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, 'reserved', NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [999, productId, 2]
    );

    await releaseExpiredReservations();

    const product = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    const reservationResult = await pool.query(
      `SELECT status
       FROM inventory_reservations
       WHERE id = $1`,
      [reservation.rows[0].id]
    );

    expect(product.rows[0].stock).toBe(10);
    expect(reservationResult.rows[0].status).toBe('released');
  });

  it('does not release a reservation that has not expired', async () => {
    const reservation = await pool.query(
      `INSERT INTO inventory_reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, 'reserved', NOW() + INTERVAL '15 minutes')
       RETURNING id`,
      [1000, productId, 2]
    );

    await releaseExpiredReservations();

    const reservationResult = await pool.query(
      `SELECT status
       FROM inventory_reservations
       WHERE id = $1`,
      [reservation.rows[0].id]
    );

    const product = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    expect(reservationResult.rows[0].status).toBe('reserved');
    expect(product.rows[0].stock).toBe(10);
  });

  it('releases multiple expired reservations', async () => {
    await pool.query(
      `UPDATE products
       SET stock = stock - 3
       WHERE id = $1`,
      [productId]
    );

    await pool.query(
      `INSERT INTO inventory_reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES
       ($1, $2, $3, 'reserved', NOW() - INTERVAL '2 minutes'),
       ($4, $2, $5, 'reserved', NOW() - INTERVAL '1 minute')`,
      [1001, productId, 1, 1002, 2]
    );

    await releaseExpiredReservations();

    const product = await pool.query(
      'SELECT stock FROM products WHERE id = $1',
      [productId]
    );

    const reservations = await pool.query(
      `SELECT status
       FROM inventory_reservations
       WHERE product_id = $1
       ORDER BY id`,
      [productId]
    );

    expect(product.rows[0].stock).toBe(10);
    expect(reservations.rows).toHaveLength(2);
    expect(reservations.rows[0].status).toBe('released');
    expect(reservations.rows[1].status).toBe('released');
  });
});