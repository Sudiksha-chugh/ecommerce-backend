const pool = require('./db');
const logger = require('./logger');

const EXPIRATION_INTERVAL_MS =
  Number(process.env.INVENTORY_EXPIRATION_INTERVAL_MS) || 60 * 1000;

let expirationRunInProgress = false;

async function releaseExpiredReservations() {
  if (expirationRunInProgress) {
    return;
  }

  expirationRunInProgress = true;

  let client;

  try {
    client = await pool.connect();

    await client.query('BEGIN');

    const expiredReservations = await client.query(
      `SELECT id, order_id, product_id, quantity
       FROM reservations
       WHERE status = 'PENDING'
         AND expires_at IS NOT NULL
         AND expires_at <= NOW()
       FOR UPDATE SKIP LOCKED`
    );

    for (const reservation of expiredReservations.rows) {
      await client.query(
        `UPDATE inventory
         SET quantity = quantity + $1,
             updated_at = NOW()
         WHERE product_id = $2`,
        [reservation.quantity, reservation.product_id]
      );

      const expired = await client.query(
        `UPDATE reservations
         SET status = 'EXPIRED'
         WHERE id = $1
           AND status = 'PENDING'
         RETURNING *`,
        [reservation.id]
      );

      if (expired.rows.length === 1) {
        await client.query(
          `INSERT INTO outbox_events (event_type, payload)
           VALUES ($1, $2)`,
          [
            'inventory_expired',
            JSON.stringify({
              reservationId: reservation.id,
              orderId: reservation.order_id,
              productId: reservation.product_id,
              quantity: reservation.quantity,
            }),
          ]
        );
      }
    }

    await client.query('COMMIT');

    for (const reservation of expiredReservations.rows) {
      logger.info('Expired inventory reservation released', {
        reservationId: reservation.id,
        orderId: reservation.order_id,
        productId: reservation.product_id,
        quantity: reservation.quantity,
      });
    }

    if (expiredReservations.rows.length > 0) {
      logger.info('Expired reservations processed', {
        count: expiredReservations.rows.length,
      });
    }
  } catch (error) {
    if (client) {
      try {
        await client.query('ROLLBACK');
      } catch (rollbackError) {
        logger.error('Failed to rollback expired reservation transaction', {
          error: rollbackError.message,
        });
      }
    }

    logger.error('Failed to release expired reservations', {
      error: error.message,
    });
  } finally {
    if (client) {
      client.release();
    }

    expirationRunInProgress = false;
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
