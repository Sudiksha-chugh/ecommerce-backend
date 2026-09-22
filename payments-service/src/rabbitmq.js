const amqp = require('amqplib');
require('dotenv').config();

const EVENTS_EXCHANGE = 'app.events';

let channel = null;
let connecting = null;

async function connectRabbitMQ() {
  if (channel) return channel;
  if (connecting) return connecting;

  connecting = (async () => {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    const ch = await connection.createConfirmChannel();

    await ch.assertExchange(EVENTS_EXCHANGE, 'direct', {
      durable: true,
    });

    await ch.assertQueue('order_placed', {
      durable: true,
    });

    await ch.bindQueue(
      'order_placed',
      EVENTS_EXCHANGE,
      'order_placed'
    );

    await ch.assertQueue('refund_requested', {
      durable: true,
    });

    await ch.bindQueue(
      'refund_requested',
      EVENTS_EXCHANGE,
      'refund_requested'
    );

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

module.exports = {
  connectRabbitMQ,
  getChannel,
  EVENTS_EXCHANGE,
};