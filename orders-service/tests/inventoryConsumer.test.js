const fixtureDb=process.env.PHASE2_INTEGRATION==='true' ? require('../../scripts/phase2/test-support/admin-db')('orders',require('pg')) : require('../src/db');
const pool = require('../src/db');

const {
  processInventoryReserved,
  processInventoryReservationFailed,
  processInventoryConfirmed,
  processInventoryReleased,
} = require('../src/inventoryConsumer');

describe('Inventory Saga consumer', () => {
  let testOrderId;

  beforeEach(async () => {
    await fixtureDb.query('DELETE FROM inbox_events');
    await fixtureDb.query('DELETE FROM outbox_events');
    await fixtureDb.query('DELETE FROM order_sagas');
    await fixtureDb.query('DELETE FROM orders');

    const result = await pool.query(
      `INSERT INTO orders
        (user_id, items, total_amount)
       VALUES ($1, $2, $3)
       RETURNING id`,
      [
        1,
        JSON.stringify([
          {
            productId: 1,
            quantity: 2,
          },
        ]),
        '20.00',
      ]
    );

    testOrderId = result.rows[0].id;

    await pool.query(
      `INSERT INTO order_sagas
        (order_id, state)
       VALUES ($1, 'PENDING')`,
      [testOrderId]
    );
  });

  afterEach(async () => {
    await fixtureDb.query('DELETE FROM inbox_events');
    await fixtureDb.query('DELETE FROM outbox_events');
    await fixtureDb.query('DELETE FROM order_sagas');
    await fixtureDb.query('DELETE FROM orders');
  });

  afterAll(async () => {
    await pool.end();
  });

  it('moves Saga from PENDING to STOCK_RESERVED', async () => {
    const event = {
      eventId: 'inventory-event-1',
      orderId: testOrderId,
      items: [
        {
          productId: 1,
          quantity: 2,
          status: 'PENDING',
        },
      ],
      requestId: 'request-1',
    };

    await processInventoryReserved(event);

    const saga = await pool.query(
      `SELECT state, version, last_error
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('STOCK_RESERVED');
    expect(saga.rows[0].version).toBe(2);
    expect(saga.rows[0].last_error).toBeNull();
  });

  it('creates payment_requested after inventory is reserved', async () => {
    const event = {
      eventId: 'inventory-event-2',
      orderId: testOrderId,
      items: [
        {
          productId: 1,
          quantity: 2,
          status: 'PENDING',
        },
      ],
      requestId: 'request-2',
    };

    await processInventoryReserved(event);

    const result = await pool.query(
      `SELECT event_type, payload
       FROM outbox_events
       WHERE event_type = 'payment_requested'`
    );

    expect(result.rows.length).toBe(1);

    expect(result.rows[0].payload.orderId).toBe(testOrderId);
    expect(result.rows[0].payload.items).toEqual(event.items.map(({productId,quantity})=>({productId,quantity})));
    expect(result.rows[0].payload.requestId).toBe('request-2');
  });

  it('records the inventory event in inbox_events', async () => {
    const event = {
      eventId: 'inventory-event-3',
      orderId: testOrderId,
      items: [],
      requestId: 'request-3',
    };

    await processInventoryReserved(event);

    const result = await pool.query(
      `SELECT *
       FROM inbox_events
       WHERE event_id = $1`,
      [event.eventId]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].event_type).toBe('inventory_reserved');
    expect(result.rows[0].order_id).toBe(testOrderId);
    expect(result.rows[0].processed_at).not.toBeNull();
  });

  it('does not process the same inventory_reserved event twice', async () => {
    const event = {
      eventId: 'inventory-event-duplicate',
      orderId: testOrderId,
      items: [
        {
          productId: 1,
          quantity: 2,
          status: 'PENDING',
        },
      ],
      requestId: 'request-4',
    };

    await processInventoryReserved(event);
    await processInventoryReserved(event);

    const paymentEvents = await pool.query(
      `SELECT *
       FROM outbox_events
       WHERE event_type = 'payment_requested'`
    );

    expect(paymentEvents.rows.length).toBe(1);

    const inboxEvents = await pool.query(
      `SELECT *
       FROM inbox_events
       WHERE event_id = $1`,
      [event.eventId]
    );

    expect(inboxEvents.rows.length).toBe(1);
  });

  it('records stock failure and completes cancellation', async () => {
    const event = {
      eventId: 'inventory-failed-1',
      orderId: testOrderId,
      items: [
        {
          productId: 1,
          quantity: 2,
        },
      ],
      reason: 'Insufficient stock for product 1',
      requestId: 'request-5',
    };

    await processInventoryReservationFailed(event);

    const saga = await pool.query(
      `SELECT state, version, last_error
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('CANCELLED');
    expect(saga.rows[0].version).toBe(2);
    expect(saga.rows[0].last_error).toBe(
      'Insufficient stock for product 1'
    );
  });

  it('marks the order cancelled when reservation fails', async () => {
    const event = {
      eventId: 'inventory-failed-2',
      orderId: testOrderId,
      items: [],
      reason: 'Insufficient stock',
      requestId: 'request-6',
    };

    await processInventoryReservationFailed(event);

    const order = await pool.query(
      `SELECT status
       FROM orders
       WHERE id = $1`,
      [testOrderId]
    );

    expect(order.rows[0].status).toBe('cancelled');
  });

  it('does not create payment_requested when inventory reservation fails', async () => {
    const event = {
      eventId: 'inventory-failed-3',
      orderId: testOrderId,
      items: [],
      reason: 'Insufficient stock',
      requestId: 'request-7',
    };

    await processInventoryReservationFailed(event);

    const result = await pool.query(
      `SELECT *
       FROM outbox_events
       WHERE event_type = 'payment_requested'`
    );

    expect(result.rows.length).toBe(0);
  });

  it('does not process the same inventory failure event twice', async () => {
    const event = {
      eventId: 'inventory-failed-duplicate',
      orderId: testOrderId,
      items: [],
      reason: 'Insufficient stock',
      requestId: 'request-8',
    };

    await processInventoryReservationFailed(event);
    await processInventoryReservationFailed(event);

    const inboxEvents = await pool.query(
      `SELECT *
       FROM inbox_events
       WHERE event_id = $1`,
      [event.eventId]
    );

    expect(inboxEvents.rows.length).toBe(1);

    const saga = await pool.query(
      `SELECT state, version
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('CANCELLED');
    expect(saga.rows[0].version).toBe(2);
  });

    it('moves Saga from PAYMENT_AUTHORIZED to CONFIRMED and succeeds the order', async () => {
    await pool.query(
      `UPDATE order_sagas
       SET state = 'PAYMENT_AUTHORIZED',
           version = 3
       WHERE order_id = $1`,
      [testOrderId]
    );

    const event = {
      eventId: 'inventory-confirmed-1',
      orderId: testOrderId,
      reservations: [],
      requestId: 'request-confirm-1',
    };

    await processInventoryConfirmed(event);

    const saga = await pool.query(
      `SELECT state, version, last_error
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('CONFIRMED');
    expect(saga.rows[0].version).toBe(4);
    expect(saga.rows[0].last_error).toBeNull();

    const order = await pool.query(
      `SELECT status
       FROM orders
       WHERE id = $1`,
      [testOrderId]
    );

    expect(order.rows[0].status).toBe('succeeded');
  });

  it('records inventory_confirmed in inbox_events', async () => {
    await pool.query(
      `UPDATE order_sagas
       SET state = 'PAYMENT_AUTHORIZED'
       WHERE order_id = $1`,
      [testOrderId]
    );

    const event = {
      eventId: 'inventory-confirmed-2',
      orderId: testOrderId,
      reservations: [],
      requestId: 'request-confirm-2',
    };

    await processInventoryConfirmed(event);

    const result = await pool.query(
      `SELECT event_type, order_id, processed_at
       FROM inbox_events
       WHERE event_id = $1`,
      [event.eventId]
    );

    expect(result.rows.length).toBe(1);
    expect(result.rows[0].event_type).toBe(
      'inventory_confirmed'
    );
    expect(result.rows[0].order_id).toBe(testOrderId);
    expect(result.rows[0].processed_at).not.toBeNull();
  });

  it('does not process the same inventory_confirmed event twice', async () => {
    await pool.query(
      `UPDATE order_sagas
       SET state = 'PAYMENT_AUTHORIZED'
       WHERE order_id = $1`,
      [testOrderId]
    );

    const event = {
      eventId: 'inventory-confirmed-duplicate',
      orderId: testOrderId,
      reservations: [],
      requestId: 'request-confirm-3',
    };

    await processInventoryConfirmed(event);
    await processInventoryConfirmed(event);

    const inboxEvents = await pool.query(
      `SELECT *
       FROM inbox_events
       WHERE event_id = $1`,
      [event.eventId]
    );

    expect(inboxEvents.rows.length).toBe(1);

    const saga = await pool.query(
      `SELECT state, version
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('CONFIRMED');
    expect(saga.rows[0].version).toBe(2);
  });

  it('moves Saga from RELEASE_PENDING to CANCELLED after inventory verification', async () => {
    await pool.query(
      `UPDATE order_sagas
       SET state = 'RELEASE_PENDING',
           version = 3
       WHERE order_id = $1`,
      [testOrderId]
    );

    await pool.query(
      `UPDATE orders
       SET status = 'payment_failed'
       WHERE id = $1`,
      [testOrderId]
    );

    const event = {
      eventId: 'inventory-released-1',
      orderId: testOrderId,
      reservations: [],
      requestId: 'request-release-1',
    };

    await processInventoryReleased(event);

    const saga = await pool.query(
      `SELECT state, version, last_error
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('CANCELLED');
    expect(saga.rows[0].version).toBe(4);
    expect(saga.rows[0].last_error).toBeNull();

    const order = await pool.query(
      `SELECT status
       FROM orders
       WHERE id = $1`,
      [testOrderId]
    );

    expect(order.rows[0].status).toBe('cancelled');
  });

  it('does not process the same inventory_released event twice', async () => {
    await pool.query(
      `UPDATE order_sagas
       SET state = 'RELEASE_PENDING'
       WHERE order_id = $1`,
      [testOrderId]
    );

    await pool.query(
      `UPDATE orders
       SET status = 'payment_failed'
       WHERE id = $1`,
      [testOrderId]
    );

    const event = {
      eventId: 'inventory-released-duplicate',
      orderId: testOrderId,
      reservations: [],
      requestId: 'request-release-2',
    };

    await processInventoryReleased(event);
    await processInventoryReleased(event);

    const inboxEvents = await pool.query(
      `SELECT *
       FROM inbox_events
       WHERE event_id = $1`,
      [event.eventId]
    );

    expect(inboxEvents.rows.length).toBe(1);

    const saga = await pool.query(
      `SELECT state, version
       FROM order_sagas
       WHERE order_id = $1`,
      [testOrderId]
    );

    expect(saga.rows[0].state).toBe('CANCELLED');
    expect(saga.rows[0].version).toBe(2);

    const order = await pool.query(
      `SELECT status
       FROM orders
       WHERE id = $1`,
      [testOrderId]
    );

    expect(order.rows[0].status).toBe('cancelled');
  });

});
if(process.env.PHASE2_INTEGRATION==='true')afterAll(()=>fixtureDb.end());
