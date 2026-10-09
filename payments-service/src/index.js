let server, startupTimer, shuttingDown=false;
const app = require('./app');
const { connectRabbitMQ } = require('./rabbitmq');
const { startConsumer } = require('./consumer');
const { startOutboxPoller } = require('./outboxPoller');
require('dotenv').config();

const PORT = process.env.PORT || 4004;

async function start() {
  if(shuttingDown)return;
  try {
    await connectRabbitMQ();
    console.log('Payments RabbitMQ topology initialized');

    server = app.listen(PORT, () => {
      console.log(`payments-service HTTP server running on port ${PORT}`);
    });

    await startConsumer();
    if(shuttingDown)return;
    startOutboxPoller();
  } catch (err) {
    console.error(
      `Failed to initialize Payments RabbitMQ: ${err.message}`
    );
    process.exit(1);
  }
}

start();
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;clearTimeout(startupTimer);
 await require('./outboxPoller').stopOutboxPoller();

 await require("./consumer").stopConsumer();
 if(server)await new Promise(resolve=>server.close(resolve));
 await require('./rabbitmq').closeRabbitMQ();
 await require('./db').end();
 require('./logger').close();
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>shutdown().catch(()=>{process.exitCode=1;}));
