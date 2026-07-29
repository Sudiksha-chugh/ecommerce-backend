const amqp = require('amqplib');
const { processPayment } = require('./payment-logic');

async function startConsumer() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  const incomingQueue = 'order_placed';
  const outgoingQueue = 'payment_processed';
  const dlq = 'order_placed_dlq';

  await channel.assertQueue(incomingQueue, { durable: true });
  await channel.assertQueue(outgoingQueue, { durable: true });
  await channel.assertQueue(dlq, { durable: true });
  await channel.prefetch(1);

  console.log(`payments-service listening on "${incomingQueue}"...`);

  channel.consume(incomingQueue, async (msg) => {
    if (msg === null) return;

    try {
      const order = JSON.parse(msg.content.toString());
      console.log(`Received order ${order.id} for payment processing`);

      const paymentResult = processPayment(order);

      channel.sendToQueue(
        outgoingQueue,
        Buffer.from(JSON.stringify(paymentResult)),
        { persistent: true }
      );

      console.log(`Payment ${paymentResult.status} for order ${order.id}, published to "${outgoingQueue}"`);

      channel.ack(msg);
    } catch (err) {
      console.error('Failed to process order_placed message:', err.message);

      channel.sendToQueue(
        dlq,
        Buffer.from(JSON.stringify({
          originalMessage: msg.content.toString(),
          error: err.message,
          failedAt: new Date().toISOString(),
        })),
        { persistent: true }
      );

      console.error(`Moved unprocessable message to "${dlq}"`);
      channel.ack(msg);
    }
  });
}

module.exports = { startConsumer };