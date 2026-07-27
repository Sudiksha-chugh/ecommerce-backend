const amqp = require('amqplib');

async function publishMessage() {
  const connection = await amqp.connect('amqp://guest:guest@localhost:5672');
  const channel = await connection.createChannel();

  const queueName = 'order_placed';
  await channel.assertQueue(queueName);

  const message = 'Hello from orders-service!';
  channel.sendToQueue(queueName, Buffer.from(message));

  console.log(`Sent: "${message}" to queue "${queueName}"`);

  setTimeout(() => {
    connection.close();
  }, 500);
}

publishMessage();