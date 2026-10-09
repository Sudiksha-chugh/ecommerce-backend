let server, startupTimer, shuttingDown=false;
const { validateJwtConfig } = require('./config');
validateJwtConfig();
const { startInventoryConsumer } = require('./inventoryConsumer');
const app = require('./app');
const { connectRabbitMQ } = require('./rabbitmq');
const { startOutboxPoller } = require('./outboxPoller');

require('dotenv').config();

const PORT = process.env.PORT || 4003;
const STARTUP_RETRY_DELAY_MS = 3000;

async function start() {
  if(shuttingDown)return;
  try {
    await connectRabbitMQ();
  } catch (err) {
    console.error(`Failed to connect to RabbitMQ on startup, retrying in ${STARTUP_RETRY_DELAY_MS}ms:`, err.message);
    startupTimer=setTimeout(start, STARTUP_RETRY_DELAY_MS);
    return;
  }

  if(shuttingDown)return;
  startOutboxPoller();
  require("./sagaTimeout").start();
  await startInventoryConsumer();


  server = app.listen(PORT, () => {
    console.log(`orders-service running on port ${PORT}`);
  });
}

start();
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;clearTimeout(startupTimer);
 await require('./outboxPoller').stopOutboxPoller();
 await require("./sagaTimeout").stop();
 await require("./sagaConsumer").stop();
 if(server)await new Promise(resolve=>server.close(resolve));
 await require('./rabbitmq').closeRabbitMQ();
 await require('./db').end();
 require('./logger').close();
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>shutdown().catch(()=>{process.exitCode=1;}));
