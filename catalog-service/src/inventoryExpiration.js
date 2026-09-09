const pool = require('./db');
const logger = require('./logger');

const EXPIRATION_INTERVAL_MS =
  Number(process.env.INVENTORY_EXPIRATION_INTERVAL_MS) || 60 * 1000;

async function releaseExpiredReservations() {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const expiredReservations = await client.query(
      `SELECT id, order_id, product_id, quantity
       FROM inventory_reservations
       WHERE status = 'reserved'
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()
       FOR UPDATE`
    );

    for (const reservation of expiredReservations.rows) {
      await client.query(
        `UPDATE products
         SET stock = stock + $1
         WHERE id = $2`,
        [reservation.quantity, reservation.product_id]
      );

      await client.query(
        `UPDATE inventory_reservations
         SET status = 'released'
         WHERE id = $1`,
        [reservation.id]
      );

      logger.info('Expired inventory reservation released', {
        reservationId: reservation.id,
        orderId: reservation.order_id,
        productId: reservation.product_id,
        quantity: reservation.quantity,
      });
    }

    await client.query('COMMIT');

    if (expiredReservations.rows.length > 0) {
      logger.info('Expired reservations processed', {
        count: expiredReservations.rows.length,
      });
    }
  } catch (error) {
    await client.query('ROLLBACK');

    logger.error('Failed to release expired reservations', {
      error: error.message,
    });
  } finally {
    client.release();
  }
}

function startInventoryExpirationWorker() {
  releaseExpiredReservations();

  setInterval(
    releaseExpiredReservations,
    EXPIRATION_INTERVAL_MS
  );

  logger.info('Inventory expiration worker started', {
    intervalMs: EXPIRATION_INTERVAL_MS,
  });
}

module.exports = {
  releaseExpiredReservations,
  startInventoryExpirationWorker,
};