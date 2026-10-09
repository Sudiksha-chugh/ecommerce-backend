const express = require('express');
const pool = require('./db');
const authenticateAuth0User = require('./middleware/auth0User');
const logger = require('./logger');
require('dotenv').config();
const requestIdMiddleware = require('./requestId');

const app = express();
app.use(requestIdMiddleware);

app.use(express.json({ limit: '1mb' }));

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Create order
app.post('/orders', authenticateAuth0User, async (req, res) => {
  const userId = req.user.userId;
  const { items, totalAmount } = req.body;
  const idempotencyKey = req.headers['idempotency-key'] || null;

  if (!Array.isArray(items) || !items.length || items.some(i => !Number.isInteger(i.productId) || i.productId <= 0 || !Number.isInteger(i.quantity) || i.quantity <= 0) || new Set(items.map(i=>i.productId)).size !== items.length || !Number.isFinite(Number(totalAmount)) || Number(totalAmount) <= 0) {
    logger.warn('Order creation validation failed', {
      userId,
      reason: 'items and totalAmount are required',
      requestId: req.requestId,
    });

    return res.status(400).json({
      error: 'items and totalAmount are required',
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    let newOrder;

    const orderResult = await client.query(
      `INSERT INTO orders (user_id, items, total_amount, idempotency_key)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (user_id, idempotency_key)
       WHERE idempotency_key IS NOT NULL
       DO NOTHING
       RETURNING *`,
      [userId, JSON.stringify(items), totalAmount, idempotencyKey]
    );

    if (orderResult.rows.length > 0) {
      newOrder = orderResult.rows[0];
    } else {
      const existingOrderResult = await client.query(
        `SELECT * FROM orders
         WHERE user_id = $1
           AND idempotency_key = $2`,
        [userId, idempotencyKey]
      );

      newOrder = existingOrderResult.rows[0];

      await client.query('COMMIT');

      logger.info('Returning existing order for idempotency key', {
        orderId: newOrder.id,
        userId,
        idempotencyKey,
        requestId: req.requestId,
      });

      return res.status(200).json(newOrder);
    }
      await client.query(
  `INSERT INTO order_sagas (order_id, state)
   VALUES ($1, $2)`,
  [newOrder.id, 'PENDING']
);

// Request Inventory Service to reserve stock
const inventoryReserveRequestedEvent = {
  eventId: `${newOrder.id}:inventory_reserve_requested:0`,
  orderId: newOrder.id,
  userId,
  amount: newOrder.total_amount,
  items: newOrder.items,
  requestId: req.requestId,
};

await client.query(
  `INSERT INTO outbox_events (event_type, payload)
   VALUES ($1, $2)`,
  [
    'inventory_reserve_requested',
    JSON.stringify(inventoryReserveRequestedEvent),
  ]
);

    await client.query('COMMIT');

    logger.info('Order created successfully', {
      orderId: newOrder.id,
      userId,
      totalAmount: newOrder.total_amount,
      idempotencyKey,
      requestId: req.requestId,
    });

    return res.status(201).json(newOrder);
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        logger.error('Order transaction rollback failed', {
          error: rollbackErr.message,
          userId,
          requestId: req.requestId,
        });
      });
    }

    logger.error('Order creation failed', {
      error: err.message,
      userId,
      requestId: req.requestId,
    });

    return res.status(500).json({
      error: 'Failed to create order',
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

// Cancellation is a durable Saga request, including a safe retry after refund failure.
app.patch('/orders/:id/cancel', authenticateAuth0User, async (req, res) => {
  const orderId = Number(req.params.id);
  if (!Number.isInteger(orderId) || orderId <= 0) return res.status(400).json({error:'Invalid order ID'});
  try {
    const result = await pool.query('SELECT * FROM orders WHERE id=$1',[orderId]);
    if (!result.rows.length) return res.status(404).json({error:'Order not found'});
    if (String(result.rows[0].user_id) !== String(req.user.userId)) return res.status(403).json({error:'Forbidden'});
    const { processSagaEvent } = require('./sagaStore');
    await processSagaEvent('cancel_requested',{eventId:require('crypto').randomUUID(),orderId,requestId:req.requestId});
    const updated = await pool.query('SELECT * FROM orders WHERE id=$1',[orderId]);
    return res.status(updated.rows[0].status === 'cancelled' ? 200 : 202).json(updated.rows[0]);
  } catch(error) { logger.error('Cancellation request failed',{orderId,error:error.message}); return res.status(500).json({error:'Cancellation request failed'}); }
});
module.exports = app;
