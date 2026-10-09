const pool = require('./db');
const crypto = require('crypto');
async function registerCommand(client, orderId, eventId) {
  if (!eventId) return true;
  const result = await client.query('INSERT INTO inbox_events(event_id,order_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING event_id',[eventId,orderId]);
  if (!result.rows.length) await client.query("UPDATE outbox_events SET published=FALSE WHERE payload->>'orderId'=$1",[String(orderId)]);
  return result.rows.length > 0;
}

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
  const eventId = crypto.randomUUID();

  await client.query(
    `INSERT INTO outbox_events (event_type, payload)
     VALUES ($1, $2)`,
    [
      eventType,
      JSON.stringify({
        eventId,
        ...payload,
      }),
    ]
  );
}

async function reserveInventory({
  orderId,
  userId,
  amount,
  items,
  requestId = null, eventId,
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [orderId]);
    if (!(await registerCommand(client,orderId,eventId))) {await client.query('COMMIT');return {duplicate:true};}

    await client.query('INSERT INTO inventory_order_operations(order_id) VALUES($1) ON CONFLICT DO NOTHING',[orderId]);
    const operation = (await client.query('SELECT closed FROM inventory_order_operations WHERE order_id=$1',[orderId])).rows[0];
    if(operation.closed) {
      await insertOutboxEvent(client,'inventory_reservation_failed',{orderId,requestId,reason:'Inventory operation already closed'});
      await client.query('COMMIT');return {failed:true,reason:'Inventory operation already closed'};
    }
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
        await client.query('UPDATE inventory_order_operations SET closed=TRUE WHERE order_id=$1',[orderId]);

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
        userId,
        amount,
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

async function confirmInventory({orderId, requestId = null, eventId}) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [orderId]);
    if (!(await registerCommand(client,orderId,eventId))) {await client.query('COMMIT');return {duplicate:true};}
    const rows = (await client.query('SELECT *, expires_at <= NOW() AS overdue FROM reservations WHERE order_id=$1 ORDER BY product_id FOR UPDATE',[orderId])).rows;
    if (!rows.length || rows.some(r => !['PENDING','CONFIRMED'].includes(r.status) || (r.status === 'PENDING' && r.overdue))) {
      await insertOutboxEvent(client,'inventory_confirmation_failed',{orderId,requestId,reason:'Reservation missing, inactive or expired',allInactive:rows.length>0 && rows.every(r=>['EXPIRED','RELEASED'].includes(r.status))});
      await client.query('COMMIT');return {confirmed:false,alreadyConfirmed:false,reservations:rows};
    }
    const result = await client.query("UPDATE reservations SET status='CONFIRMED' WHERE order_id=$1 AND status='PENDING' RETURNING *",[orderId]);
    await insertOutboxEvent(client,'inventory_confirmed',{orderId,requestId});
    await client.query('COMMIT');return {confirmed:true,alreadyConfirmed:result.rows.length===0,reservations:rows.map(r=>({...r,status:"CONFIRMED"}))};
  } catch(error) {await client.query('ROLLBACK').catch(()=>{});throw error;}
  finally {client.release();}
}

async function releaseInventory({
  orderId, requestId = null, eventId,
}) {
  const client = await pool.connect();

  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1)', [orderId]);
    if (!(await registerCommand(client,orderId,eventId))) {await client.query('COMMIT');return {duplicate:true};}

    await client.query('INSERT INTO inventory_order_operations(order_id,closed) VALUES($1,TRUE) ON CONFLICT(order_id) DO UPDATE SET closed=TRUE',[orderId]);
    const reservationsResult = await client.query(
      `SELECT *
       FROM reservations
       WHERE order_id = $1
         AND status IN ('PENDING', 'CONFIRMED')
       FOR UPDATE`,
      [orderId]
    );

    if (reservationsResult.rows.length === 0) {
      const releasedResult = await client.query(
        `SELECT *
         FROM reservations
         WHERE order_id = $1
           AND status IN ('RELEASED', 'EXPIRED')`,
        [orderId]
      );

      if (releasedResult.rows.length > 0) {
        await insertOutboxEvent(client, 'inventory_released', {orderId, requestId, allInactive: true});
        await client.query('COMMIT');

        return {
          released: true,
          alreadyReleased: true,
          reservations: releasedResult.rows,
        };
      }

      await insertOutboxEvent(client, 'inventory_released', {orderId, requestId, allInactive: true});
      await client.query('COMMIT');

      return {
        released: true,
        alreadyReleased: false,
        reservations: [],
      };
    }

    for (const reservation of reservationsResult.rows) {
      await client.query(
        `UPDATE inventory
         SET quantity = quantity + $1,
             updated_at = NOW()
         WHERE product_id = $2`,
        [
          reservation.quantity,
          reservation.product_id,
        ]
      );
    }

    const releaseResult = await client.query(
      `UPDATE reservations
       SET status = 'RELEASED'
       WHERE order_id = $1
         AND status IN ('PENDING', 'CONFIRMED')
       RETURNING *`,
      [orderId]
    );

    await insertOutboxEvent(
      client,
      'inventory_released',
      {
        orderId,
        reservations: releaseResult.rows, requestId, allInactive: true,
      }
    );

    await client.query('COMMIT');

    return {
      released: true,
      alreadyReleased: false,
      reservations: releaseResult.rows,
    };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}
module.exports = {
  reserveInventory,
  reservationsMatchItems,
  confirmInventory,
  releaseInventory,
};