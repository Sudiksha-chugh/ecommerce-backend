const amqp = require('amqplib');

async function consumeMessages() {
  const connection = await amqp.connect('amqp://guest:guest@localhost:5672');
  const channel = await connection.createChannel();

  const queueName = 'order_placed';
  await channel.assertQueue(queueName);

  console.log(`Waiting for messages in queue "${queueName}"...`);

  channel.consume(queueName, (msg) => {
    if (msg !== null) {
      console.log(`Received: "${msg.content.toString()}"`);
      channel.ack(msg);
    }
  });
}

consumeMessages();