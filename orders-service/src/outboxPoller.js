const pool = require('./db');
const { getChannel } = require('./rabbitmq');

const POLL_INTERVAL_MS = 3000;
let intervalHandle = null;

async function pollOnce() {
  const client = await pool.connect();

  try {
    const result = await client.query(
      `SELECT * FROM outbox_events WHERE published = false ORDER BY created_at ASC LIMIT 10`
    );

    if (result.rows.length === 0) {
      return;
    }

    let channel = getChannel();
    if (!channel) {
      try {
        channel = await connectRabbitMQ();
        console.log('Outbox poller: reconnected to RabbitMQ');
      } catch (err) {
        console.error(`Outbox poller: RabbitMQ unavailable (${err.message}), will retry ${result.rows.length} event(s) next cycle`);
        return;
      }
    }

    for (const event of result.rows) {
      try {
        channel.sendToQueue(
          'order_placed',
          Buffer.from(JSON.stringify(event.payload)),
          { persistent: true }
        );

        await client.query(
          `UPDATE outbox_events SET published = true, published_at = NOW() WHERE id = $1`,
          [event.id]
        );

        console.log(`Outbox poller: published event ${event.id} (order ${event.payload.id})`);
      } catch (err) {
        console.error(`Outbox poller: failed to publish event ${event.id}, will retry next cycle:`, err.message);
      }
    }
  } finally {
    client.release();
  }
}

function startOutboxPoller() {
  intervalHandle = setInterval(pollOnce, POLL_INTERVAL_MS);
  console.log(`Outbox poller started, checking every ${POLL_INTERVAL_MS}ms`);
}

function stopOutboxPoller() {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}

module.exports = { startOutboxPoller, stopOutboxPoller, pollOnce };