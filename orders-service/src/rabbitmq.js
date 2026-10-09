const amqp = require('amqplib');
require('dotenv').config();

const EVENTS_EXCHANGE = 'app.events';

let channel = null;
let publisherConnection = null;
let connecting = null;

async function connectRabbitMQ() {
  if (channel) return channel;
  if (connecting) return connecting;

  connecting = (async () => {
    const connection = await amqp.connect(process.env.RABBITMQ_URL);
    publisherConnection = connection;
    connection.on('error', () => {channel=null;});
    const ch = await connection.createConfirmChannel();
    ch.on('error',()=>{channel=null;});
    ch.on('close',()=>{channel=null;});

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

    await ch.assertQueue('inventory_reserved', {
      durable: true,
    });

    await ch.bindQueue(
      'inventory_reserved',
      EVENTS_EXCHANGE,
      'inventory_reserved'
    );

    await ch.assertQueue('inventory_reservation_failed', {
      durable: true,
    });

    await ch.bindQueue(
      'inventory_reservation_failed',
      EVENTS_EXCHANGE,
      'inventory_reservation_failed'
    );

    await ch.assertQueue('inventory_confirmed', {
      durable: true,
    });

    await ch.bindQueue(
      'inventory_confirmed',
      EVENTS_EXCHANGE,
      'inventory_confirmed'
    );

    await ch.assertQueue('inventory_released', {
      durable: true,
    });

    await ch.bindQueue(
      'inventory_released',
      EVENTS_EXCHANGE,
      'inventory_released'
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
    if(publisherConnection) await publisherConnection.close().catch(()=>{});
    publisherConnection=null;
    throw err;
  }
}

function getChannel() {
  return channel;
}

async function closeRabbitMQ() {if(publisherConnection) await publisherConnection.close();publisherConnection=null;channel=null;}
module.exports = {
  closeRabbitMQ,
  connectRabbitMQ,
  getChannel,
  EVENTS_EXCHANGE,
};