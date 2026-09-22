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

    await ch.assertQueue('payment_processed', {
      durable: true,
    });

    await ch.bindQueue(
      'payment_processed',
      EVENTS_EXCHANGE,
      'payment_processed'
    );

    await ch.assertQueue('refund_processed', {
      durable: true,
    });

    await ch.bindQueue(
      'refund_processed',
      EVENTS_EXCHANGE,
      'refund_processed'
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