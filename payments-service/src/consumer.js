const amqp = require('amqplib');
const { processPayment, processRefund } = require('./payment-logic');
const pool = require('./db');
const logger = require('./logger');

const RECONNECT_DELAY_MS = 3000;

async function startConsumer() {
  try {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const channel = await connection.createChannel();

    const incomingQueue = 'order_placed';
    const outgoingQueue = 'payment_processed';
    const dlq = 'order_placed_dlq';
    const refundQueue = 'refund_requested';
    const refundResultQueue = 'refund_processed';
    const refundDlq = 'refund_requested_dlq';
    await channel.assertQueue(incomingQueue, { durable: true });
    await channel.assertQueue(outgoingQueue, { durable: true });
    await channel.assertQueue(dlq, { durable: true });
    await channel.assertQueue(refundQueue, { durable: true });
    await channel.assertQueue(refundResultQueue, { durable: true });
    await channel.assertQueue(refundDlq, { durable: true });
    await channel.prefetch(1);
       logger.info('payments-service listening', { queues: [incomingQueue, refundQueue] });

    connection.on('error', (err) => {
      logger.error('RabbitMQ connection error, will reconnect', { error: err.message });
    });

    connection.on('close', () => {
      logger.warn('RabbitMQ connection closed, reconnecting', { delayMs: RECONNECT_DELAY_MS });
      setTimeout(startConsumer, RECONNECT_DELAY_MS);
    });

    channel.consume(incomingQueue, async (msg) => {
      if (msg === null) return;

      try {
        const order = JSON.parse(msg.content.toString());

        try {
          await pool.query('INSERT INTO processed_orders (order_id) VALUES ($1)', [order.id]);
        } catch (dbErr) {
                  if (dbErr.code === '23505') {
            logger.info('Order already processed, skipping (idempotency check)', { orderId: order.id });
            channel.ack(msg);
            return;
          }
          throw dbErr;
        }

        logger.info('Received order for payment processing', { orderId: order.id });

        const paymentResult = processPayment(order);

        channel.sendToQueue(
          outgoingQueue,
          Buffer.from(JSON.stringify(paymentResult)),
          { persistent: true }
        );

        logger.info('Payment processed', { orderId: order.id, status: paymentResult.status });

        channel.ack(msg);
      } catch (err) {
        logger.error('Failed to process order_placed message', { error: err.message });

        channel.sendToQueue(
          dlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        logger.warn('Moved unprocessable message to DLQ', { dlq });
        channel.ack(msg);
      }
    });

    channel.consume(refundQueue, async (msg) => {
      if (msg === null) return;

      try {
        const refundRequest = JSON.parse(msg.content.toString());
              logger.info('Received refund request', { orderId: refundRequest.orderId });

        const refundResult = processRefund(refundRequest);

        channel.sendToQueue(
          refundResultQueue,
          Buffer.from(JSON.stringify(refundResult)),
          { persistent: true }
        );

        logger.info('Refund processed', { orderId: refundResult.orderId, status: refundResult.status });

        channel.ack(msg);
      } catch (err) {
        logger.error('Failed to process refund_requested message', { error: err.message });

        channel.sendToQueue(
          refundDlq,
          Buffer.from(JSON.stringify({
            originalMessage: msg.content.toString(),
            error: err.message,
            failedAt: new Date().toISOString(),
          })),
          { persistent: true }
        );

        logger.warn('Moved unprocessable message to DLQ', { dlq: refundDlq });
        channel.ack(msg);
      }
    });
  } catch (err) {
    logger.error('Failed to connect to RabbitMQ, retrying', { delayMs: RECONNECT_DELAY_MS, error: err.message });
    setTimeout(startConsumer, RECONNECT_DELAY_MS);
  }
}

module.exports = { startConsumer };