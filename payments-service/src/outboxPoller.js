const pool = require('./db');
const { getChannel, connectRabbitMQ } = require('./rabbitmq');

const POLL_INTERVAL_MS = 3000;
let intervalHandle = null;

async function pollOnce() {
  const client = await pool.connect();

  try {
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
        await channel.assertQueue(event.event_type, { durable: true });

        channel.sendToQueue(
          event.event_type,
          Buffer.from(JSON.stringify(event.payload)),
          { persistent: true }
        );

        await channel.waitForConfirms();

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
    client.release();
  }
}

function startOutboxPoller() {
  intervalHandle = setInterval(pollOnce, POLL_INTERVAL_MS);
  console.log(
    `Payments outbox poller started, checking every ${POLL_INTERVAL_MS}ms`
  );
}

function stopOutboxPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = {
  startOutboxPoller,
  stopOutboxPoller,
  pollOnce,
};
