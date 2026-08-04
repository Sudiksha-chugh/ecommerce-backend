const express = require('express');
const pool = require('./db');
const { getChannel } = require('./rabbitmq');
const authenticateToken = require('./middleware/auth');
require('dotenv').config();

const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

function publishOrderPlaced(order) {
  const channel = getChannel();

  if (!channel) {
    console.error(`Could not publish order_placed for order ${order.id}: no RabbitMQ channel`);
    return false;
  }

  try {
    channel.sendToQueue(
      'order_placed',
      Buffer.from(JSON.stringify(order)),
      { persistent: true }
    );
    console.log(`Published order_placed event for order id ${order.id}`);
    return true;
  } catch (err) {
    console.error(`Failed to publish order_placed for order ${order.id}:`, err.message);
    return false;
  }
}
app.post('/orders', authenticateToken, async (req, res) => {
  const userId = req.user.userId;
  const { items, totalAmount } = req.body;

  if (!items || !totalAmount) {
    return res.status(400).json({ error: 'items and totalAmount are required' });
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
      `INSERT INTO outbox_events (event_type, payload) VALUES ($1, $2)`,
      ['order_placed', JSON.stringify(newOrder)]
    );

    await client.query('COMMIT');
    client.release();

    res.status(201).json(newOrder);
  } catch (err) {
    if (client) {
      await client.query('ROLLBACK').catch(() => {});
      client.release(err);
    }
    console.error('Order creation failed, rolled back:', err.message);
    res.status(500).json({ error: 'Failed to create order' });
  }
});
app.patch('/orders/:id/cancel', authenticateToken, async (req, res) => {
  const orderId = req.params.id;
  const userId = req.user.userId;

  const client = await pool.connect();

  try {
    const orderResult = await client.query('SELECT * FROM orders WHERE id = $1', [orderId]);

    if (orderResult.rows.length === 0) {
      client.release();
      return res.status(404).json({ error: 'Order not found' });
    }

    const order = orderResult.rows[0];

    if (order.user_id !== userId) {
      client.release();
      return res.status(403).json({ error: 'You do not have permission to cancel this order' });
    }

    if (order.status === 'pending') {
      const updateResult = await client.query(
        `UPDATE orders SET status = 'cancelled' WHERE id = $1 RETURNING *`,
        [orderId]
      );
      client.release();
      return res.status(200).json(updateResult.rows[0]);
    }

    if (order.status === 'succeeded') {
      await client.query('BEGIN');

      const updateResult = await client.query(
        `UPDATE orders SET status = 'refund_pending' WHERE id = $1 RETURNING *`,
        [orderId]
      );

      await client.query(
        `INSERT INTO outbox_events (event_type, payload) VALUES ($1, $2)`,
        ['refund_requested', JSON.stringify({
          orderId: order.id,
          userId: order.user_id,
          amount: order.total_amount,
        })]
      );

      await client.query('COMMIT');
      client.release();

      return res.status(202).json(updateResult.rows[0]);
    }

    client.release();
    return res.status(409).json({ error: `Cannot cancel an order with status "${order.status}"` });
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    client.release(err);
    console.error('Failed to cancel order:', err.message);
    res.status(500).json({ error: 'Failed to cancel order' });
  }
});
module.exports = app;