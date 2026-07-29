const amqp = require('amqplib');
require('dotenv').config();

let channel = null;
let connecting = null;

async function connectRabbitMQ() {
  if (channel) return channel;
  if (connecting) return connecting;

  connecting = (async () => {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const ch = await connection.createChannel();
    await ch.assertQueue('order_placed', { durable: true });

    connection.on('error', (err) => {
      console.error('RabbitMQ connection error:', err.message);
      channel = null;
    });

    connection.on('close', () => {
      console.error('RabbitMQ connection closed');
      channel = null;
    });

    channel = ch;
    connecting = null;
    return channel;
  })();

  try {
    return await connecting;
  } catch (err) {
    connecting = null;
    throw err;
  }
}

function getChannel() {
  return channel;
}

module.exports = { connectRabbitMQ, getChannel };