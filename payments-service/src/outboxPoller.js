const pool = require('./db');
const { getChannel, connectRabbitMQ } = require('./rabbitmq');

const POLL_INTERVAL_MS = 3000;
let intervalHandle = null;
let isPolling = false;

async function pollOnce() {
  if (isPolling) return;

  isPolling = true;

  let client;
  try {
    client = await pool.connect();
    const result = await client.query(
      `SELECT *
       FROM outbox_events
       WHERE published = false
       ORDER BY created_at ASC
       LIMIT 10`
    );

    if (result.rows.length === 0) {
      return;
    }

    let channel = getChannel();

    if (!channel) {
      try {
        channel = await connectRabbitMQ();
        console.log('Payments outbox poller: reconnected to RabbitMQ');
      } catch (err) {
        console.error(
          `Payments outbox poller: RabbitMQ unavailable (${err.message}), will retry next cycle`
        );
        return;
      }
    }

    for (const event of result.rows) {
      try {
        await require('./publishConfirmed').publishConfirmed(channel,event.event_type,event.payload);

        await client.query(
          `UPDATE outbox_events
           SET published = true, published_at = NOW()
           WHERE id = $1`,
          [event.id]
        );

        console.log(
          `Payments outbox poller: published event ${event.id} to "${event.event_type}"`
        );
      } catch (err) {
        console.error(
          `Payments outbox poller: failed to publish event ${event.id}, will retry next cycle:`,
          err.message
        );
      }
    }
  } finally {
    if (client) client.release();
    isPolling = false;
  }
}

function startOutboxPoller() {
  intervalHandle = setInterval(() => pollOnce().catch(error => console.error("Outbox poll failed", error.code || "unknown")), POLL_INTERVAL_MS);
  console.log(
    `Payments outbox poller started, checking every ${POLL_INTERVAL_MS}ms`
  );
}

async function stopOutboxPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
  while (isPolling) await new Promise(resolve => setTimeout(resolve, 25));
}

module.exports = {
  startOutboxPoller,
  stopOutboxPoller,
  pollOnce,
};
