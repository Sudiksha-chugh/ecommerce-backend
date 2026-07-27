const express = require('express');
const amqp = require('amqplib');
const pool = require('./db');
require('dotenv').config();

const app = express();
app.use(express.json());

async function publishOrderPlaced(order) {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  const queueName = 'order_placed';
  await channel.assertQueue(queueName);

  const message = JSON.stringify(order);
  channel.sendToQueue(queueName, Buffer.from(message));

  console.log(`Published order_placed event for order id ${order.id}`);

  setTimeout(() => connection.close(), 500);
}

app.post('/orders', async (req, res) => {
  try {
    const { userId, items, totalAmount } = req.body;

    if (!userId || !items || !totalAmount) {
      return res.status(400).json({ error: 'userId, items, and totalAmount are required' });
    }

    const result = await pool.query(
      `INSERT INTO orders (user_id, items, total_amount)
       VALUES ($1, $2, $3)
       RETURNING *`,
      [userId, JSON.stringify(items), totalAmount]
    );

    const newOrder = result.rows[0];

    await publishOrderPlaced(newOrder);

    res.status(201).json(newOrder);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to create order' });
  }
});

module.exports = app;