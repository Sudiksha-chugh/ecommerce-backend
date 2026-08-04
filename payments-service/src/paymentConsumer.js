const amqp = require('amqplib');
const { processPayment, processRefund } = require('./payment-logic');
const pool = require('./db');

const RECONNECT_DELAY_MS = 3000;

async function startConsumer() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();

    const orderQueue = 'order_placed';
    const paymentQueue = 'payment_processed';
    const orderDlq = 'order_placed_dlq';

    const refundQueue = 'refund_requested';
    const refundResultQueue = 'refund_processed';
    const refundDlq = 'refund_requested_dlq';

    await channel.assertQueue(orderQueue, { durable: true });
    await channel.assertQueue(paymentQueue, { durable: true });
    await channel.assertQueue(orderDlq, { durable: true });
    await channel.assertQueue(refundQueue, { durable: true });
    await channel.assertQueue(refundResultQueue, { durable: true });
    await channel.assertQueue(refundDlq, { durable: true });
    await channel.prefetch(1);

    console.log(`payments-service listening on "${orderQueue}" and "${refundQueue}"...`);

    connection.on('error', (err) => {
      console.error('RabbitMQ connection error, will reconnect:', err.message);
    });

    connection.on('close', () => {
      console.error(`RabbitMQ connection closed, reconnecting in ${RECONNECT_DELAY_MS}ms...`);
      setTimeout(startConsumer, RECONNECT_DELAY_MS);
    });

    channel.consume(orderQueue, async (msg) => {
      if (msg === null) return;

      try {
        const order = JSON.parse(msg.content.toString());

        try {
          await pool.query('INSERT INTO processed_orders (order_id) VALUES ($1)', [order.id]);
        } catch (dbErr) {
          if (dbErr.code === '23505') {
            console.log(`Order ${order.id} already processed, skipping (idempotency check)`);
            channel.ack(msg);
            return;
          }
          throw dbErr;
        }

        console.log(`Received order ${order.id} for payment processing`);

        const paymentResult = processPayment(order);

        channel.sendToQueue(
          paymentQueue,
          Buffer.from(JSON.stringify(paymentResult)),
          { persistent: true }
        );

        console.log(`Payment ${paymentResult.status} for order ${order.id}, published to "${paymentQueue}"`);

        channel.ack(msg);
      } catch (err) {
        console.error('Failed to process order_placed message:', err.message);

        channel.sendToQueue(
          orderDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        console.error(`Moved unprocessable message to "${orderDlq}"`);
        channel.ack(msg);
      }
    });

    channel.consume(refundQueue, async (msg) => {
      if (msg === null) return;

      try {
        const refundRequest = JSON.parse(msg.content.toString());

        console.log(`Received refund request for order ${refundRequest.orderId}`);

        const refundResult = processRefund(refundRequest);

        channel.sendToQueue(
          refundResultQueue,
          Buffer.from(JSON.stringify(refundResult)),
          { persistent: true }
        );

        console.log(`Refund ${refundResult.status} for order ${refundResult.orderId}, published to "${refundResultQueue}"`);

        channel.ack(msg);
      } catch (err) {
        console.error('Failed to process refund_requested message:', err.message);

        channel.sendToQueue(
          refundDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        console.error(`Moved unprocessable message to "${refundDlq}"`);
        channel.ack(msg);
      }
    });
  } catch (err) {
    console.error(`Failed to connect to RabbitMQ, retrying in ${RECONNECT_DELAY_MS}ms:`, err.message);
    setTimeout(startConsumer, RECONNECT_DELAY_MS);
  }
}

module.exports = { startConsumer };