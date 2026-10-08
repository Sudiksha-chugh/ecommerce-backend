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

  await channel.assertExchange(EVENTS_EXCHANGE, 'direct', {
    durable: true,
  });

  return channel;
}

async function publishEvent(eventType, payload) {
  const ch = await getChannel();

  return new Promise((resolve, reject) => {
    ch.publish(
      EVENTS_EXCHANGE,
      eventType,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        contentType: 'application/json',
      },
      (err) => {
        if (err) {
          return reject(err);
        }

        resolve();
      }
    );
  });
}

module.exports = {
  EVENTS_EXCHANGE,
  getChannel,
  publishEvent,
};