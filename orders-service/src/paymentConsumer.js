const amqp = require('amqplib');
const pool = require('./db');

const RECONNECT_DELAY_MS = 3000;

async function startPaymentConsumer() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();

    const paymentQueue = 'payment_processed';
    const paymentDlq = 'payment_processed_dlq';

    const refundQueue = 'refund_processed';
    const refundDlq = 'refund_processed_dlq';

    await channel.assertQueue(paymentQueue, { durable: true });
    await channel.assertQueue(paymentDlq, { durable: true });
    await channel.assertQueue(refundQueue, { durable: true });
    await channel.assertQueue(refundDlq, { durable: true });
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

        const updateResult = await pool.query(
          `UPDATE orders SET status = $1 WHERE id = $2 RETURNING id`,
          [status, orderId]
        );

        if (updateResult.rows.length === 0) {
          console.error(`payment_processed received for unknown order ${orderId}, ignoring`);
        } else {
          console.log(`Order ${orderId} status updated to "${status}"`);
        }

        channel.ack(msg);
      } catch (err) {
        console.error('Failed to process payment_processed message:', err.message);

        channel.sendToQueue(
          paymentDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

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

        const updateResult = await pool.query(
          `UPDATE orders SET status = $1 WHERE id = $2 RETURNING id`,
          [status, orderId]
        );

        if (updateResult.rows.length === 0) {
          console.error(`refund_processed received for unknown order ${orderId}, ignoring`);
        } else {
          console.log(`Order ${orderId} status updated to "${status}" (refund complete)`);
        }

        channel.ack(msg);
      } catch (err) {
        console.error('Failed to process refund_processed message:', err.message);

        channel.sendToQueue(
          refundDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error(`Failed to connect to RabbitMQ (payment consumer), retrying in ${RECONNECT_DELAY_MS}ms:`, err.message);
    setTimeout(startPaymentConsumer, RECONNECT_DELAY_MS);
  }
}

module.exports = { startPaymentConsumer };