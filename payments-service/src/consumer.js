const amqp = require('amqplib');
const { processPayment } = require('./payment-logic');

async function startConsumer() {
  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  const channel = await connection.createChannel();

  const incomingQueue = 'order_placed';
  const outgoingQueue = 'payment_processed';

  await channel.assertQueue(incomingQueue);
  await channel.assertQueue(outgoingQueue);

  console.log(`payments-service listening on "${incomingQueue}"...`);

  channel.consume(incomingQueue, async (msg) => {
    if (msg !== null) {
      const order = JSON.parse(msg.content.toString());
      console.log(`Received order ${order.id} for payment processing`);

      const paymentResult = processPayment(order);

      channel.sendToQueue(outgoingQueue, Buffer.from(JSON.stringify(paymentResult)));
      console.log(`Payment ${paymentResult.status} for order ${order.id}, published to "${outgoingQueue}"`);

      channel.ack(msg);
    }
  });
}

module.exports = { startConsumer };