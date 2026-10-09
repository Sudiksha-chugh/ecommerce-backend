let server, startupTimer, shuttingDown=false;
const app = require('./app');
const {
  startInventoryExpirationWorker,
} = require('./inventoryExpiration');
const { startOutboxPoller } = require('./outboxPoller');
const {
  connectInventoryConsumer,
} = require('./consumer');

const PORT = process.env.PORT || 4005;

async function start() {
  if(shuttingDown)return;
  server = app.listen(PORT, () => {
    console.log(`Inventory service running on port ${PORT}`);

    startInventoryExpirationWorker();
    if(shuttingDown)return;
  startOutboxPoller();
  });

  try {
    await connectInventoryConsumer();
  } catch (err) {
    console.error(
      'Failed to start inventory RabbitMQ consumer:',
      err.message
    );

    setTimeout(() => {
      connectInventoryConsumer().catch((retryErr) => {
        console.error(
          'Inventory consumer retry failed:',
          retryErr.message
        );
      });
    }, 3000);
  }
}

start();
async function shutdown(){
 if(shuttingDown)return;shuttingDown=true;clearTimeout(startupTimer);
 await require('./outboxPoller').stopOutboxPoller();
 await require("./inventoryExpiration").stopInventoryExpirationWorker();
 await require("./consumer").stopInventoryConsumer();
 if(server)await new Promise(resolve=>server.close(resolve));
 await require('./rabbitmq').closeRabbitMQ();
 await require('./db').end();
 require('./logger').close();
}
for(const signal of ['SIGTERM','SIGINT'])process.on(signal,()=>shutdown().catch(()=>{process.exitCode=1;}));
