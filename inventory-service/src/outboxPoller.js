const pool = require('./db');
const logger = require('./logger');
const rabbitmq = require('./rabbitmq');

const POLL_INTERVAL_MS =
  Number(process.env.OUTBOX_POLL_INTERVAL_MS) || 3000;

let pollerTimer = null;
let pollInProgress = false;

async function pollOnce() {
  if (pollInProgress) {
    return;
  }

  pollInProgress = true;

  try {
    const result = await pool.query(
      `SELECT *
       FROM outbox_events
       WHERE published = false
       ORDER BY created_at ASC
       LIMIT 10`
    );

    if (result.rows.length === 0) {
      return;
    }

    for (const event of result.rows) {
      try {
        await rabbitmq.publishEvent(event.event_type, event.payload);

        await pool.query(
          `UPDATE outbox_events
           SET published = true,
               published_at = NOW()
           WHERE id = $1
             AND published = false`,
          [event.id]
        );

        logger.info('Inventory outbox event published', {
          eventId: event.id,
          eventType: event.event_type,
        });
      } catch (err) {
        logger.error('Inventory outbox event publish failed', {
          eventId: event.id,
          eventType: event.event_type,
          error: err.message,
        });

        // IMPORTANT:
        // Do not mark the event as published.
        // The next poll will retry it.
      }
    }
  } catch (err) {
    logger.error('Inventory outbox poll failed', {
      error: err.message,
    });
  } finally {
    pollInProgress = false;
  }
}

function startOutboxPoller() {
  if (pollerTimer) {
    return;
  }

  pollerTimer = setInterval(pollOnce, POLL_INTERVAL_MS);

  logger.info(
    `Inventory outbox poller started, checking every ${POLL_INTERVAL_MS}ms`
  );
}

async function stopOutboxPoller() {
  if (pollerTimer) {
    clearInterval(pollerTimer);
    pollerTimer = null;
  }
  while (pollInProgress) await new Promise(resolve => setTimeout(resolve, 25));
}

module.exports = {
  startOutboxPoller,
  stopOutboxPoller,
  pollOnce,
};
