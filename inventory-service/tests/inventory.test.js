const fixtureDb=require('../../scripts/phase2/test-support/admin-db')('inventory',require('pg'));
const request = require('supertest');
const app = require('../src/app');
const pool = require('../src/db');

const internalServiceKey = process.env.INTERNAL_SERVICE_KEY;

async function seedStock(productId, quantity) {
  await pool.query(
    `INSERT INTO inventory (product_id, quantity)
     VALUES ($1, $2)
     ON CONFLICT (product_id)
     DO UPDATE SET quantity = EXCLUDED.quantity, updated_at = NOW()`,
    [productId, quantity]
  );
}

describe('inventory APIs', () => {
  afterEach(async () => {
    await fixtureDb.query('DELETE FROM outbox_events');
    await fixtureDb.query('DELETE FROM reservations');
    await fixtureDb.query('DELETE FROM inventory');
    await fixtureDb.query('DELETE FROM inbox_events');
    await fixtureDb.query('DELETE FROM inventory_order_operations');
  });

  describe('POST /inventory/stock', () => {
    it('rejects requests without an internal service key', async () => {
      const res = await request(app)
        .post('/inventory/stock')
        .send({ productId: 1, quantity: 10 });

      expect(res.statusCode).toBe(401);
    });

    it('upserts available stock for a product', async () => {
      const res = await request(app)
        .post('/inventory/stock')
        .set('x-internal-service-key', internalServiceKey)
        .send({ productId: 11, quantity: 8 });

      expect(res.statusCode).toBe(200);
      expect(res.body.product_id).toBe(11);
      expect(res.body.quantity).toBe(8);

      const dbResult = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [11]
      );

      expect(dbResult.rows[0].quantity).toBe(8);
    });
  });

  describe('POST /inventory/reserve', () => {
    it('reserves stock with an atomic conditional update', async () => {
      await seedStock(21, 5);

      const res = await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 101,
          items: [{ productId: 21, quantity: 2 }],
        });

      expect(res.statusCode).toBe(200);
      expect(res.body.reservations).toHaveLength(1);
      expect(res.body.reservations[0].status).toBe('PENDING');

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [21]
      );

      expect(stock.rows[0].quantity).toBe(3);

      const outbox = await pool.query(
        `SELECT event_type, published
         FROM outbox_events
         WHERE event_type = $1`,
        ['inventory_reserved']
      );

      expect(outbox.rows).toHaveLength(1);
      expect(outbox.rows[0].published).toBe(false);
    });

    it('is idempotent for the same reservation request', async () => {
      await seedStock(22, 5);

      const payload = {
        orderId: 102,
        items: [{ productId: 22, quantity: 2 }],
      };

      const first = await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send(payload);

      const second = await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send(payload);

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);
      expect(second.body.message).toBe('Stock reservation already exists');

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [22]
      );

      expect(stock.rows[0].quantity).toBe(3);

      const reservations = await pool.query(
        'SELECT * FROM reservations WHERE order_id = $1',
        [102]
      );

      expect(reservations.rows).toHaveLength(1);
    });

    it('rejects reservation when stock is insufficient', async () => {
      await seedStock(23, 1);

      const res = await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 103,
          items: [{ productId: 23, quantity: 2 }],
        });

      expect(res.statusCode).toBe(409);

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [23]
      );

      expect(stock.rows[0].quantity).toBe(1);

      const reservations = await pool.query(
        'SELECT * FROM reservations WHERE order_id = $1',
        [103]
      );

      expect(reservations.rows).toHaveLength(0);
    });

    it('does not oversell under concurrent reserve requests', async () => {
      await seedStock(24, 1);

      const [first, second] = await Promise.all([
        request(app)
          .post('/inventory/reserve')
          .set('x-internal-service-key', internalServiceKey)
          .send({
            orderId: 104,
            items: [{ productId: 24, quantity: 1 }],
          }),
        request(app)
          .post('/inventory/reserve')
          .set('x-internal-service-key', internalServiceKey)
          .send({
            orderId: 105,
            items: [{ productId: 24, quantity: 1 }],
          }),
      ]);

      const statuses = [first.statusCode, second.statusCode].sort();
      expect(statuses).toEqual([200, 409]);

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [24]
      );

      expect(stock.rows[0].quantity).toBe(0);

      const reservations = await pool.query(
        `SELECT order_id, status
         FROM reservations
         WHERE product_id = $1`,
        [24]
      );

      expect(reservations.rows).toHaveLength(1);
      expect(reservations.rows[0].status).toBe('PENDING');
    });
  });

  describe('POST /inventory/confirm', () => {
    it('confirms a pending reservation without changing stock', async () => {
      await seedStock(31, 3);

      await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 201,
          items: [{ productId: 31, quantity: 2 }],
        });

      const res = await request(app)
        .post('/inventory/confirm')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 201 });

      expect(res.statusCode).toBe(200);
      expect(res.body.reservations[0].status).toBe('CONFIRMED');

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [31]
      );

      expect(stock.rows[0].quantity).toBe(1);

      const outbox = await pool.query(
        `SELECT event_type FROM outbox_events WHERE event_type = $1`,
        ['inventory_confirmed']
      );

      expect(outbox.rows).toHaveLength(1);
    });

    it('is idempotent when the reservation is already confirmed', async () => {
      await seedStock(32, 3);

      await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 202,
          items: [{ productId: 32, quantity: 1 }],
        });

      await request(app)
        .post('/inventory/confirm')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 202 });

      const res = await request(app)
        .post('/inventory/confirm')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 202 });

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe(
        'Inventory reservation already confirmed'
      );
    });
  });

  describe('POST /inventory/release', () => {
    it('releases a pending reservation and restores stock', async () => {
      await seedStock(41, 3);

      await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 301,
          items: [{ productId: 41, quantity: 2 }],
        });

      const res = await request(app)
        .post('/inventory/release')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 301 });

      expect(res.statusCode).toBe(200);
      expect(res.body.reservations[0].status).toBe('RELEASED');

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [41]
      );

      expect(stock.rows[0].quantity).toBe(3);
    });

    it('releases a confirmed reservation as compensation', async () => {
      await seedStock(42, 3);

      await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 302,
          items: [{ productId: 42, quantity: 2 }],
        });

      await request(app)
        .post('/inventory/confirm')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 302 });

      const res = await request(app)
        .post('/inventory/release')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 302 });

      expect(res.statusCode).toBe(200);
      expect(res.body.reservations[0].status).toBe('RELEASED');

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [42]
      );

      expect(stock.rows[0].quantity).toBe(3);
    });

    it('is idempotent when releasing an already released reservation', async () => {
      await seedStock(43, 3);

      await request(app)
        .post('/inventory/reserve')
        .set('x-internal-service-key', internalServiceKey)
        .send({
          orderId: 303,
          items: [{ productId: 43, quantity: 1 }],
        });

      await request(app)
        .post('/inventory/release')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 303 });

      const res = await request(app)
        .post('/inventory/release')
        .set('x-internal-service-key', internalServiceKey)
        .send({ orderId: 303 });

      expect(res.statusCode).toBe(200);
      expect(res.body.message).toBe(
        'Inventory reservation already released'
      );

      const stock = await pool.query(
        'SELECT quantity FROM inventory WHERE product_id = $1',
        [43]
      );

      expect(stock.rows[0].quantity).toBe(3);
    });
  });
});

afterAll(() => pool.end());

afterAll(()=>fixtureDb.end());
