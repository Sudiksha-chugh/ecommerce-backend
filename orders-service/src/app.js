const express = require('express');
const pool = require('./db');
const authenticateToken = require('./middleware/auth');
const logger = require('./logger');
require('dotenv').config();

const app = express();

app.use(express.json());

// Health check
app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

// Create order
app.post('/orders', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { items, totalAmount } = req.body;

  if (!items || !totalAmount) {
    logger.warn('Order creation validation failed', {
      userId,
      reason: 'items and totalAmount are required',
    });

    return res.status(400).json({
      error: 'items and totalAmount are required',
    });
  }

  let client;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    const orderResult = await client.query(
      `INSERT INTO orders (user_id, items, total_amount)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, JSON.stringify(items), totalAmount]
    );

    const newOrder = orderResult.rows[0];

    await client.query(
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
      ['order_placed', JSON.stringify(newOrder)]
    );

    await client.query('COMMIT');

    logger.info('Order created successfully', {
      orderId: newOrder.id,
      userId,
      totalAmount: newOrder.total_amount,
    });

    return res.status(201).json(newOrder);
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        logger.error('Order transaction rollback failed', {
          error: rollbackErr.message,
          userId,
        });
      });
    }

    logger.error('Order creation failed', {
      error: err.message,
      stack: err.stack,
      userId,
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

// Cancel order
app.patch('/orders/:id/cancel', authenticateToken, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.userId;

  let client;

  try {
    client = await pool.connect();

    const orderResult = await client.query(
      'SELECT * FROM orders WHERE id = $1',
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      logger.warn('Order cancellation failed: order not found', {
        orderId,
        userId,
      });

      return res.status(404).json({
        error: 'Order not found',
      });
    }

    const order = orderResult.rows[0];

    if (order.user_id !== userId) {
      logger.warn('Unauthorized order cancellation attempt', {
        orderId,
        userId,
        orderOwnerId: order.user_id,
      });

      return res.status(403).json({
        error: 'You do not have permission to cancel this order',
      });
    }

    // Payment has not succeeded yet
    if (order.status === 'pending') {
      const updateResult = await client.query(
        `UPDATE orders
         SET status = 'cancelled'
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );

      logger.info('Pending order cancelled successfully', {
        orderId,
        userId,
      });

      return res.status(200).json(updateResult.rows[0]);
    }

    // Payment already succeeded → refund required
    if (order.status === 'succeeded') {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE orders
         SET status = 'refund_pending'
         WHERE id = $1
         RETURNING *`,
        [orderId]
      );

      await client.query(
        `INSERT INTO outbox_events (event_type, payload)
         VALUES ($1, $2)`,
        [
          'refund_requested',
          JSON.stringify({
            orderId: order.id,
            userId: order.user_id,
            amount: order.total_amount,
          }),
        ]
      );

      await client.query('COMMIT');

      logger.info('Refund requested for order', {
        orderId,
        userId,
        amount: order.total_amount,
      });

      return res.status(202).json(updateResult.rows[0]);
    }

    logger.warn('Order cannot be cancelled in current state', {
      orderId,
      userId,
      status: order.status,
    });

    return res.status(409).json({
      error: `Cannot cancel an order with status "${order.status}"`,
    });
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch((rollbackErr) => {
        logger.error('Cancel order rollback failed', {
          error: rollbackErr.message,
          orderId,
          userId,
        });
      });
    }

    logger.error('Failed to cancel order', {
      error: err.message,
      stack: err.stack,
      orderId,
      userId,
    });

    return res.status(500).json({
      error: 'Failed to cancel order',
    });
  } finally {
    if (client) {
      client.release();
    }
  }
});

module.exports = app;