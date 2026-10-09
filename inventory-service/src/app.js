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

for (const [route, operation] of [['confirm', require('./inventoryService').confirmInventory], ['release', require('./inventoryService').releaseInventory]]) {
  app.post(`/inventory/${route}`, authenticateInternalService, async (req,res) => {
    if (!Number.isInteger(req.body.orderId) || req.body.orderId <= 0) return res.status(400).json({error:'Invalid orderId'});
    try {const result=await operation({orderId:req.body.orderId,requestId:req.requestId});return res.status(result.confirmed === false ? 409 : 200).json({...result,message:route === "confirm" ? (result.alreadyConfirmed ? "Inventory reservation already confirmed" : "Inventory reservation confirmed") : (result.alreadyReleased ? "Inventory reservation already released" : "Inventory reservation released")});}
    catch(error) {logger.error('Inventory operation failed',{error:error.message});return res.status(500).json({error:'Inventory operation failed'});}
  });
}
module.exports = app;
