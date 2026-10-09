const amqp = require('amqplib');

const EVENTS_EXCHANGE = 'app.events';

let connection = null;
let channel = null;

async function getChannel() {
  if (channel) {
    return channel;
  }

  if (!connection) {
    connection = await amqp.connect(process.env.RABBITMQ_URL);

    connection.on('close', () => {
      connection = null;
      channel = null;
    });

    connection.on('error', (err) => {
      console.error('Inventory RabbitMQ connection error:', err.message);
    });
  }

  channel = await connection.createConfirmChannel();
  channel.on('error',()=>{channel=null;});
  channel.on('close',()=>{channel=null;});

  await channel.assertExchange(EVENTS_EXCHANGE, 'direct', {
    durable: true,
  });

  return channel;
}

async function publishEvent(eventType, payload) {
  const ch = await getChannel();
  return require('./publishConfirmed').publishConfirmed(ch,eventType,payload);
}

async function closeRabbitMQ() {if(connection)await connection.close();connection=null;channel=null;}
module.exports = {
  closeRabbitMQ,
  EVENTS_EXCHANGE,
  getChannel,
  publishEvent,
};