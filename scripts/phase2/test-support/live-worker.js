// Test-only process: production consumers/stores/pollers, isolated env supplied by parent.
const assert=require('assert/strict');const path=require('path');
assert.equal(process.env.NODE_ENV,'test');assert.equal(process.env.DB_NAME_TEST,`${process.env.LIVE_SERVICE}_phase2_test`);
assert.ok(new URL(process.env.RABBITMQ_URL).pathname.startsWith('/phase2_live_test_'));
const root=path.resolve(__dirname,`../../../${process.env.LIVE_SERVICE}-service/src`);
const service=process.env.LIVE_SERVICE;
const amqp=require(path.resolve(root,'../node_modules/amqplib'));
const connect=amqp.connect;
amqp.connect=async(...args)=>{const connection=await connect(...args);const create=connection.createConfirmChannel.bind(connection);connection.createConfirmChannel=async()=>{const channel=await create();const consume=channel.consume.bind(channel);channel.consume=(queue,callback,...rest)=>consume(queue,message=>{if(message?.fields.redelivered)process.send({redelivered:queue});return callback(message);},...rest);return channel;};return connection;};
if(service==='payments'){
 const store=require(path.join(root,'paymentStore'));const original=store.processRequest;
 store.processRequest=async(type,event)=>{
  if(event.requestId==='live-force-failure'){process.send({failureAttempt:type});throw new Error('Synthetic database outage');}
  await original(type,event);
  if(process.env.LIVE_HOLD==='true'&&type==='payment_requested'){process.send({committedBeforeAck:true});await new Promise(()=>{});}
 };
}
let publicationFault=false;
if(service==='payments'){
 const publisher=require(path.join(root,'publishConfirmed'));const original=publisher.publishConfirmed;
 publisher.publishConfirmed=async(...args)=>{await original(...args);if(!publicationFault){publicationFault=true;process.send({publicationRetried:true});throw new Error('Synthetic crash window after broker confirm before outbox update');}};
}
const consumer=require(path.join(root,service==='orders'?'sagaConsumer':'consumer'));
const start=service==='orders'?consumer.start:service==='inventory'?consumer.connectInventoryConsumer:consumer.startConsumer;
const poller=require(path.join(root,'outboxPoller'));
let timer;
(async()=>{await start();timer=setInterval(()=>poller.pollOnce().catch(()=>{}),100);process.send({ready:true});})();
process.on('message',async message=>{if(message.cancel){await require(path.join(root,'sagaStore')).processSagaEvent('cancel_requested',message.cancel);process.send({cancelledRequested:true});}});
process.on('SIGTERM',async()=>{clearInterval(timer);await poller.stopOutboxPoller();await (consumer.stop||consumer.stopConsumer||consumer.stopInventoryConsumer)();await require(path.join(root,'rabbitmq')).closeRabbitMQ?.();await require(path.join(root,'db')).end();process.exit(0);});
