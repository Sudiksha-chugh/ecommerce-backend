const amqp = require('amqplib');
require('dotenv').config();

let channel = null;

async function connectRabbitMQ() {
  if (channel) return channel;

  const connection = await amqp.connect(process.env.RABBITMQ_URL);
  channel = await connection.createChannel();
  await channel.assertQueue('order_placed', { durable: true });

  connection.on('error', (err) => {
    console.error('RabbitMQ connection error:', err.message);
    channel = null;
  });

  return channel;
}

function getChannel() {
  return channel;
}

module.exports = { connectRabbitMQ, getChannel };