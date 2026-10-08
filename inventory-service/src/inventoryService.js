const pool = require('./db');

const RESERVATION_EXPIRATION_MINUTES =
  Number(process.env.RESERVATION_EXPIRATION_MINUTES) || 15;

function reservationsMatchItems(reservations, items) {
  return (
    reservations.length === items.length &&
    items.every((item) => {
      const reservation = reservations.find(
        (row) => row.product_id === item.productId
      );

      return (
        reservation &&
        reservation.quantity === item.quantity
      );
    })
  );
}

async function insertOutboxEvent(client, eventType, payload) {
  await client.query(
    `INSERT INTO outbox_events (event_type, payload)
     VALUES ($1, $2)`,
    [eventType, JSON.stringify(payload)]
  );
}

async function reserveInventory({
  orderId,
  items,
  requestId = null,
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');

    const existingReservations = await client.query(
      `SELECT *
       FROM reservations
       WHERE order_id = $1
       FOR UPDATE`,
      [orderId]
    );

    if (existingReservations.rows.length > 0) {
      if (
        !reservationsMatchItems(
          existingReservations.rows,
          items
        )
      ) {
        await insertOutboxEvent(
          client,
          'inventory_reservation_failed',
          {
            orderId,
            items,
            reason:
              'Order already has a different inventory reservation',
            requestId,
          }
        );

        await client.query('COMMIT');

        return {
          failed: true,
          alreadyExists: false,
          reason:
            'Order already has a different inventory reservation',
        };
      }

      const hasInactiveReservation =
        existingReservations.rows.some(
          (reservation) =>
            reservation.status === 'RELEASED' ||
            reservation.status === 'EXPIRED'
        );

      if (hasInactiveReservation) {
        await insertOutboxEvent(
          client,
          'inventory_reservation_failed',
          {
            orderId,
            items,
            reason:
              'Order inventory reservation is no longer active',
            requestId,
          }
        );

        await client.query('COMMIT');

        return {
          failed: true,
          alreadyExists: false,
          reason:
            'Order inventory reservation is no longer active',
        };
      }

      await client.query('COMMIT');

      return {
        failed: false,
        alreadyExists: true,
        reservations: existingReservations.rows,
      };
    }

    /*
     * Savepoint lets us undo any stock updates already made
     * during this reservation attempt while keeping the
     * surrounding transaction alive.
     */
    await client.query(
      'SAVEPOINT inventory_reservation_attempt'
    );

    const sortedItems = [...items].sort(
      (a, b) => a.productId - b.productId
    );

    const reservations = [];

    for (const item of sortedItems) {
      const stockResult = await client.query(
        `UPDATE inventory
         SET quantity = quantity - $1,
             updated_at = NOW()
         WHERE product_id = $2
           AND quantity >= $1
         RETURNING *`,
        [item.quantity, item.productId]
      );

      if (stockResult.rows.length === 0) {
        /*
         * Undo all stock/reservation changes from this
         * reservation attempt.
         */
        await client.query(
          'ROLLBACK TO SAVEPOINT inventory_reservation_attempt'
        );

        await insertOutboxEvent(
          client,
          'inventory_reservation_failed',
          {
            orderId,
            items,
            reason:
              `Insufficient stock for product ${item.productId}`,
            requestId,
          }
        );

        await client.query('COMMIT');

        return {
          failed: true,
          alreadyExists: false,
          reason:
            `Insufficient stock for product ${item.productId}`,
        };
      }

      const reservationResult = await client.query(
        `INSERT INTO reservations
          (
            order_id,
            product_id,
            quantity,
            status,
            expires_at
          )
         VALUES (
            $1,
            $2,
            $3,
            'PENDING',
            NOW() + ($4 * INTERVAL '1 minute')
         )
         RETURNING *`,
        [
          orderId,
          item.productId,
          item.quantity,
          RESERVATION_EXPIRATION_MINUTES,
        ]
      );

      reservations.push(reservationResult.rows[0]);
    }

    await insertOutboxEvent(
      client,
      'inventory_reserved',
      {
        orderId,
        items: reservations.map((reservation) => ({
          productId: reservation.product_id,
          quantity: reservation.quantity,
          status: reservation.status,
        })),
        requestId,
      }
    );

    await client.query('COMMIT');

    return {
      failed: false,
      alreadyExists: false,
      reservations,
    };
  } catch (error) {
    await client.query('ROLLBACK');

    if (error.code === '23505') {
      const existingReservations = await pool.query(
        `SELECT *
         FROM reservations
         WHERE order_id = $1`,
        [orderId]
      );

      if (
        reservationsMatchItems(
          existingReservations.rows,
          items
        )
      ) {
        return {
          failed: false,
          alreadyExists: true,
          reservations: existingReservations.rows,
        };
      }

      const conflictError = new Error(
        'Order already has a different inventory reservation'
      );

      conflictError.status = 409;

      throw conflictError;
    }

    throw error;
  } finally {
    client.release();
  }
}

module.exports = {
  reserveInventory,
  reservationsMatchItems,
};