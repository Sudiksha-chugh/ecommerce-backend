const express = require('express');
const pool = require('./db');
const app = express();
app.use(express.json());

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});
app.get('/payments/:orderId', async (req, res) => {
  try {
    const { orderId } = req.params;

    const result = await pool.query(
      `SELECT
         order_id,
         user_id,
         amount,
         status,
         transaction_id,
         created_at,
         updated_at
       FROM payments
       WHERE order_id = $1`,
      [orderId]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({
        error: 'Payment not found',
      });
    }

    res.status(200).json(result.rows[0]);
  } catch (err) {
    console.error('Failed to fetch payment', err);
    res.status(500).json({
      error: 'Internal server error',
    });
  }
});
module.exports = app;
