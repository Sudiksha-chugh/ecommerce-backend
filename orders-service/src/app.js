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
      `INSERT INTO outbox_events (event_type, payload)
       VALUES ($1, $2)`,
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
module.exports = app;