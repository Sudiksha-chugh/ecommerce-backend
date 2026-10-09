const pool = require('../src/db');
const {
  releaseExpiredReservations,
} = require('../src/inventoryExpiration');

describe('Inventory expiration worker', () => {
  const productId = 91;

  beforeEach(async () => {
    await pool.query(
      `INSERT INTO inventory (product_id, quantity)
       VALUES ($1, $2)`,
      [productId, 10]
    );
  });

  afterEach(async () => {
    await pool.query('DELETE FROM outbox_events');
    await pool.query('DELETE FROM reservations');
    await pool.query('DELETE FROM inventory');
  });

  it('expires a pending reservation and restores stock', async () => {
    await pool.query(
      `UPDATE inventory
       SET quantity = quantity - 2
       WHERE product_id = $1`,
      [productId]
    );

    const reservation = await pool.query(
      `INSERT INTO reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, 'PENDING', NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [999, productId, 2]
    );

    await releaseExpiredReservations();

    const product = await pool.query(
      'SELECT quantity FROM inventory WHERE product_id = $1',
      [productId]
    );

    const reservationResult = await pool.query(
      `SELECT status
       FROM reservations
       WHERE id = $1`,
      [reservation.rows[0].id]
    );

    expect(product.rows[0].quantity).toBe(10);
    expect(reservationResult.rows[0].status).toBe('EXPIRED');
  });

  it('does not expire a reservation that has not expired', async () => {
    const reservation = await pool.query(
      `INSERT INTO reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, 'PENDING', NOW() + INTERVAL '15 minutes')
       RETURNING id`,
      [1000, productId, 2]
    );

    await releaseExpiredReservations();

    const reservationResult = await pool.query(
      `SELECT status
       FROM reservations
       WHERE id = $1`,
      [reservation.rows[0].id]
    );

    const product = await pool.query(
      'SELECT quantity FROM inventory WHERE product_id = $1',
      [productId]
    );

    expect(reservationResult.rows[0].status).toBe('PENDING');
    expect(product.rows[0].quantity).toBe(10);
  });

  it('is safe to run expiration more than once', async () => {
    await pool.query(
      `UPDATE inventory
       SET quantity = quantity - 2
       WHERE product_id = $1`,
      [productId]
    );

    await pool.query(
      `INSERT INTO reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, 'PENDING', NOW() - INTERVAL '1 minute')`,
      [1001, productId, 2]
    );

    await releaseExpiredReservations();
    await releaseExpiredReservations();

    const product = await pool.query(
      'SELECT quantity FROM inventory WHERE product_id = $1',
      [productId]
    );

    const reservations = await pool.query(
      `SELECT status
       FROM reservations
       WHERE order_id = $1`,
      [1001]
    );

    expect(product.rows[0].quantity).toBe(10);
    expect(reservations.rows).toHaveLength(1);
    expect(reservations.rows[0].status).toBe('EXPIRED');
  });

  it('serializes expiration and confirmation for the same reservation', async () => {
    await pool.query(
      `UPDATE inventory
       SET quantity = quantity - 2
       WHERE product_id = $1`,
      [productId]
    );

    const reservation = await pool.query(
      `INSERT INTO reservations
       (order_id, product_id, quantity, status, expires_at)
       VALUES ($1, $2, $3, 'PENDING', NOW() - INTERVAL '1 minute')
       RETURNING id`,
      [1003, productId, 2]
    );

    const reservationId = reservation.rows[0].id;

    const confirmationPromise = pool.query(
      `UPDATE reservations
       SET status = 'CONFIRMED'
       WHERE id = $1
         AND status = 'PENDING'
       RETURNING *`,
      [reservationId]
    );

    const expirationPromise = releaseExpiredReservations();

    await Promise.all([
      confirmationPromise,
      expirationPromise,
    ]);

    const reservationResult = await pool.query(
      `SELECT status
       FROM reservations
       WHERE id = $1`,
      [reservationId]
    );

    const productResult = await pool.query(
      'SELECT quantity FROM inventory WHERE product_id = $1',
      [productId]
    );

    expect(['CONFIRMED', 'EXPIRED']).toContain(
      reservationResult.rows[0].status
    );

    if (reservationResult.rows[0].status === 'CONFIRMED') {
      expect(productResult.rows[0].quantity).toBe(8);
    } else {
      expect(productResult.rows[0].quantity).toBe(10);
    }
  });
});

afterAll(() => pool.end());
