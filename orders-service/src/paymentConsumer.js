const amqp = require('amqplib');
const pool = require('./db');

const RECONNECT_DELAY_MS = 3000;
const EVENTS_EXCHANGE = 'app.events';

const MAX_PROCESS_RETRIES = 3;
const RETRY_DELAY_MS = Number(process.env.RETRY_DELAY_MS || 1000);

const TRANSIENT_DB_ERROR_CODES = new Set([
  '40001',
  '40P01',
  '53300',
  '57P01',
  '08000',
  '08001',
  '08003',
  '08004',
  '08006',
]);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableError(error) {
  if (!error) return false;

  if (
    error.status === 408 ||
    error.status === 429 ||
    (error.status >= 500 && error.status <= 599)
  ) {
    return true;
  }

  if (error.code && TRANSIENT_DB_ERROR_CODES.has(error.code)) {
    return true;
  }

  if (
    error.code === 'ECONNRESET' ||
    error.code === 'ECONNREFUSED' ||
    error.code === 'ETIMEDOUT' ||
    error.code === 'EAI_AGAIN'
  ) {
    return true;
  }

  return !error.status && !error.code;
}

async function processWithRetry(operation) {
  let lastError;

  for (let attempt = 1; attempt <= MAX_PROCESS_RETRIES; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;

      if (
        !isRetryableError(error) ||
        attempt === MAX_PROCESS_RETRIES
      ) {
        throw lastError;
      }

      console.error(
        `Processing attempt ${attempt} failed, retrying in ${RETRY_DELAY_MS}ms:`,
        error.message
      );

      await sleep(RETRY_DELAY_MS);
    }
  }

  throw lastError;
}

async function startPaymentConsumer() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createConfirmChannel();

    const paymentQueue = 'payment_processed';
    const paymentDlq = 'payment_processed_dlq';

    const refundQueue = 'refund_processed';
    const refundDlq = 'refund_processed_dlq';

    await channel.assertExchange(EVENTS_EXCHANGE, 'direct', {
      durable: true,
    });

    await channel.assertQueue(paymentQueue, { durable: true });
    await channel.assertQueue(paymentDlq, { durable: true });
    await channel.assertQueue(refundQueue, { durable: true });
    await channel.assertQueue(refundDlq, { durable: true });

    await channel.bindQueue(
      paymentDlq,
      EVENTS_EXCHANGE,
      paymentDlq
    );

    await channel.bindQueue(
      refundDlq,
      EVENTS_EXCHANGE,
      refundDlq
    );

    await channel.prefetch(1);

    console.log(`orders-service listening on "${paymentQueue}" and "${refundQueue}"...`);

    connection.on('error', (err) => {
      console.error('RabbitMQ connection error (payment consumer), will reconnect:', err.message);
    });

    connection.on('close', () => {
      console.error(`RabbitMQ connection closed (payment consumer), reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      setTimeout(startPaymentConsumer, RECONNECT_DELAY_MS);
    });

    channel.consume(paymentQueue, async (msg) => {
      if (msg === null) return;

      try {
        const result = JSON.parse(msg.content.toString());
        const { orderId, status } = result;

        if (!orderId || !status) {
          throw new Error('payment_processed message missing orderId or status');
        }

        const updateResult = await processWithRetry(() =>
          pool.query(
            `UPDATE orders
             SET status = $1
             WHERE id = $2
               AND status = 'pending'
             RETURNING id`,
            [status, orderId]
          )
        );

        if (updateResult.rows.length === 0) {
          console.error(`payment_processed received for unknown order ${orderId}, ignoring`);
        } else {
          console.log(`Order ${orderId} status updated to "${status}"`);
        }

        channel.ack(msg);
      } catch (err) {
        console.error('Failed to process payment_processed message:', err.message);

        channel.publish(
          EVENTS_EXCHANGE,
          paymentDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        await channel.waitForConfirms();

        channel.ack(msg);
      }
    });

    channel.consume(refundQueue, async (msg) => {
      if (msg === null) return;

      try {
        const result = JSON.parse(msg.content.toString());
        const { orderId, status } = result;

        if (!orderId || !status) {
          throw new Error('refund_processed message missing orderId or status');
        }

        const updateResult = await processWithRetry(() =>
          pool.query(
            `UPDATE orders
             SET status = $1
             WHERE id = $2
               AND status = 'refund_pending'
             RETURNING id`,
            [status, orderId]
          )
        );

        if (updateResult.rows.length === 0) {
          console.error(`refund_processed received for unknown order ${orderId}, ignoring`);
        } else {
          console.log(`Order ${orderId} status updated to "${status}" (refund complete)`);
        }

        channel.ack(msg);
      } catch (err) {
        console.error('Failed to process refund_processed message:', err.message);

        channel.publish(
          EVENTS_EXCHANGE,
          refundDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        await channel.waitForConfirms();

        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error(`Failed to connect to RabbitMQ (payment consumer), retrying in ${RECONNECT_DELAY_MS}ms:`, err.message);
    setTimeout(startPaymentConsumer, RECONNECT_DELAY_MS);
  }
}

module.exports = { startPaymentConsumer };