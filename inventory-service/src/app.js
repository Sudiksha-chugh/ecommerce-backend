const express = require('express');
const pool = require('./db');
const logger = require('./logger');
const authenticateInternalService = require('./middleware/internalAuth');
const requestIdMiddleware = require('./requestId');
const {
  reserveInventory,
} = require('./inventoryService');

const app = express();
app.use(requestIdMiddleware);
app.use(express.json({ limit: '1mb' }));

async function insertOutboxEvent(client, eventType, payload) {
  await client.query(
    `INSERT INTO outbox_events (event_type, payload)
     VALUES ($1, $2)`,
    [eventType, JSON.stringify(payload)]
  );
}

app.get('/health', (req, res) => {
  res.status(200).json({ status: 'ok' });
});

app.post('/inventory/stock', authenticateInternalService, async (req, res) => {
  const { productId, quantity } = req.body;

  if (!Number.isInteger(productId) || productId <= 0) {
    return res.status(400).json({
      error: 'Valid productId is required',
    });
  }

  if (!Number.isInteger(quantity) || quantity < 0) {
    return res.status(400).json({
      error: 'quantity must be a non-negative integer',
    });
  }

  try {
    const result = await pool.query(
      `INSERT INTO inventory (product_id, quantity, updated_at)
       VALUES ($1, $2, NOW())
       ON CONFLICT (product_id)
       DO UPDATE SET
         quantity = EXCLUDED.quantity,
         updated_at = NOW()
       RETURNING *`,
      [productId, quantity]
    );

    logger.info('Inventory stock upserted', {
      productId,
      quantity,
      requestId: req.requestId,
    });

    return res.status(200).json(result.rows[0]);
  } catch (error) {
    logger.error('Failed to upsert inventory stock', {
      productId,
      error: error.message,
      requestId: req.requestId,
    });

    return res.status(500).json({
      error: 'Failed to upsert inventory stock',
    });
  }
});

app.get(
  '/inventory/:productId',
  authenticateInternalService,
  async (req, res) => {
    const productId = Number(req.params.productId);

    if (!Number.isInteger(productId) || productId <= 0) {
      return res.status(400).json({
        error: 'Valid productId is required',
      });
    }

    try {
      const result = await pool.query(
        `SELECT * FROM inventory WHERE product_id = $1`,
        [productId]
      );

      if (result.rows.length === 0) {
        return res.status(404).json({
          error: 'Inventory record not found',
        });
      }

      return res.status(200).json(result.rows[0]);
    } catch (error) {
      logger.error('Failed to look up inventory', {
        productId,
        error: error.message,
        requestId: req.requestId,
      });

      return res.status(500).json({
        error: 'Failed to look up inventory',
      });
    }
  }
);

app.post('/inventory/reserve', authenticateInternalService, async (req, res) => {
  const { orderId, items } = req.body;

  if (!orderId || !Number.isInteger(orderId)) {
    return res.status(400).json({
      error: 'Valid orderId is required',
    });
  }

  if (!Array.isArray(items) || items.length === 0) {
    return res.status(400).json({
      error: 'Items are required',
    });
  }

  const productIds = items.map((item) => item.productId);

  if (new Set(productIds).size !== productIds.length) {
    return res.status(400).json({
      error: 'Duplicate product IDs are not allowed',
    });
  }

  for (const item of items) {
    if (
      !Number.isInteger(item.productId) ||
      !Number.isInteger(item.quantity) ||
      item.quantity <= 0
    ) {
      return res.status(400).json({
        error: 'Each item must have a valid productId and positive quantity',
      });
    }
  }

  try {
    const result = await reserveInventory({
      orderId,
      items,
      requestId: req.requestId,
    });

    if (result.failed) {
  const error = new Error(result.reason);
  error.status = 409;
  throw error;
  }
    if (result.alreadyExists) {
      return res.status(200).json({
        message: 'Stock reservation already exists',
        reservations: result.reservations,
      });
    }

    return res.status(200).json({
      message: 'Stock reserved successfully',
      reservations: result.reservations,
    });
  } catch (error) {
    logger.error('Stock reservation failed', {
      orderId,
      error: error.message,
      requestId: req.requestId,
    });

    return res.status(error.status || 500).json({
      error: error.message,
    });
  }
});

app.post('/inventory/confirm', authenticateInternalService, async (req, res) => {
  const { orderId } = req.body;

  if (!orderId || !Number.isInteger(orderId)) {
    return res.status(400).json({
      error: 'Valid orderId is required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const result = await client.query(
      `UPDATE reservations
       SET status = 'CONFIRMED'
       WHERE order_id = $1
         AND status = 'PENDING'
       RETURNING *`,
      [orderId]
    );

    if (result.rows.length > 0) {
      await insertOutboxEvent(client, 'inventory_confirmed', {
        orderId,
        reservations: result.rows,
        requestId: req.requestId,
      });

      await client.query('COMMIT');

      logger.info('Inventory reservation confirmed', {
        orderId,
        reservations: result.rows,
        requestId: req.requestId,
      });

      return res.status(200).json({
        message: 'Inventory reservation confirmed',
        reservations: result.rows,
      });
    }

    const confirmedResult = await client.query(
      `SELECT *
       FROM reservations
       WHERE order_id = $1
         AND status = 'CONFIRMED'`,
      [orderId]
    );

    if (confirmedResult.rows.length > 0) {
      await client.query('COMMIT');

      logger.info('Inventory reservation already confirmed', {
        orderId,
        reservations: confirmedResult.rows,
        requestId: req.requestId,
      });

      return res.status(200).json({
        message: 'Inventory reservation already confirmed',
        reservations: confirmedResult.rows,
      });
    }

    await client.query('ROLLBACK');

    return res.status(404).json({
      error: 'No active inventory reservation found for this order',
    });
  } catch (error) {
    await client.query('ROLLBACK');

    logger.error('Failed to confirm inventory reservation', {
      orderId,
      error: error.message,
      requestId: req.requestId,
    });

    return res.status(500).json({
      error: 'Failed to confirm inventory reservation',
    });
  } finally {
    client.release();
  }
});

app.post('/inventory/release', authenticateInternalService, async (req, res) => {
  const { orderId } = req.body;

  if (!orderId || !Number.isInteger(orderId)) {
    return res.status(400).json({
      error: 'Valid orderId is required',
    });
  }

  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const reservationResult = await client.query(
      `SELECT *
       FROM reservations
       WHERE order_id = $1
         AND status IN ('PENDING', 'CONFIRMED')
       FOR UPDATE`,
      [orderId]
    );

    if (reservationResult.rows.length === 0) {
      const inactiveResult = await client.query(
        `SELECT *
         FROM reservations
         WHERE order_id = $1
           AND status IN ('RELEASED', 'EXPIRED')`,
        [orderId]
      );

      if (inactiveResult.rows.length > 0) {
        await client.query('COMMIT');

        logger.info('Inventory reservation already inactive', {
          orderId,
          reservations: inactiveResult.rows,
          requestId: req.requestId,
        });

        return res.status(200).json({
          message: 'Inventory reservation already released',
          reservations: inactiveResult.rows,
        });
      }

      await client.query('ROLLBACK');

      return res.status(404).json({
        error: 'No reserved inventory found for this order',
      });
    }

    for (const reservation of reservationResult.rows) {
      const stockResult = await client.query(
        `UPDATE inventory
         SET quantity = quantity + $1,
             updated_at = NOW()
         WHERE product_id = $2
         RETURNING *`,
        [reservation.quantity, reservation.product_id]
      );

      if (stockResult.rows.length === 0) {
        throw new Error(
          `Inventory record not found for product ${reservation.product_id}`
        );
      }
    }

    const releasedResult = await client.query(
      `UPDATE reservations
       SET status = 'RELEASED'
       WHERE order_id = $1
         AND status IN ('PENDING', 'CONFIRMED')
       RETURNING *`,
      [orderId]
    );

    await insertOutboxEvent(client, 'inventory_released', {
      orderId,
      reservations: releasedResult.rows,
      requestId: req.requestId,
    });

    await client.query('COMMIT');

    logger.info('Inventory reservation released', {
      orderId,
      reservations: releasedResult.rows,
      requestId: req.requestId,
    });

    return res.status(200).json({
      message: 'Inventory reservation released',
      reservations: releasedResult.rows,
    });
  } catch (error) {
    await client.query('ROLLBACK');

    logger.error('Failed to release inventory reservation', {
      orderId,
      error: error.message,
      requestId: req.requestId,
    });

    return res.status(500).json({
      error: 'Failed to release inventory reservation',
    });
  } finally {
    client.release();
  }
});

module.exports = app;
