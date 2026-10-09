// Opt-in live broker suite. No runtime DBs or vhost '/' are accessed.
const assert=require('assert/strict');const {execFileSync,fork}=require('child_process');const crypto=require('crypto');const path=require('path');
const config=require('../../orders-service/node_modules/dotenv').config({quiet:true}).parsed;
const {Pool}=require('../../orders-service/node_modules/pg');const amqp=require('../../orders-service/node_modules/amqplib');
const run=`phase2_live_test_${Date.now()}`;const password=crypto.randomBytes(32).toString('hex');
const broker=args=>execFileSync('docker',['exec','rabbitmq','rabbitmqctl',...args],{stdio:['pipe','pipe','pipe']});
const pools={};const workers=new Set();const signals=[];let connection,channel;
const report=[];const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function until(check,label){for(let n=0;n<150;n++){if(await check())return;await sleep(100);}throw new Error(`Timeout: ${label}`);}
function worker(service,hold=false){
 const child=fork(path.join(__dirname,'test-support/live-worker.js'),[],{env:{...process.env,NODE_ENV:'test',LIVE_SERVICE:service,LIVE_HOLD:String(hold),PAYMENT_OUTCOME:'succeeded',REFUND_OUTCOME:'refunded',DB_HOST:'localhost',DB_PORT:{orders:'5435',inventory:'5437',payments:'5436'}[service],DB_NAME:`${service}_db`,DB_NAME_TEST:`${service}_phase2_test`,DB_USER:service==='inventory'?'inventory_user':`${service}_app`,DB_PASSWORD:config[service==='inventory'?'INVENTORY_DB_PASSWORD':`${service.toUpperCase()}_APP_DB_PASSWORD`],RABBITMQ_URL:`amqp://${run}:${password}@localhost:5672/${run}`},stdio:['ignore','ignore','ignore','ipc']});
 workers.add(child);child.on('message',msg=>signals.push({...msg,service}));child.on('exit',()=>workers.delete(child));return child;
}
async function stop(child,signal='SIGTERM'){if(child.exitCode!==null||child.signalCode)return;const exit=new Promise(r=>child.once('exit',r));child.kill(signal);await Promise.race([exit,sleep(4000).then(()=>{if(child.exitCode===null)child.kill('SIGKILL');})]);await exit;}
async function publish(type,payload){await require('../../payments-service/src/publishConfirmed').publishConfirmed(channel,type,payload);}
async function rows(service,sql,args=[]){return (await pools[service].query(sql,args)).rows;}
(async()=>{
 for(const service of ['orders','inventory','payments']){
  pools[service]=new Pool({host:'localhost',port:{orders:5435,inventory:5437,payments:5436}[service],database:`${service}_phase2_test`,user:service==='inventory'?'inventory_user':'postgres',password:config[`${service.toUpperCase()}_DB_PASSWORD`]});
  assert.equal((await rows(service,'SELECT current_database() AS db'))[0].db,`${service}_phase2_test`);
 }
 // Fixtures affect only the three exact test databases.
 await pools.orders.query('TRUNCATE orders,order_sagas,inbox_events,outbox_events RESTART IDENTITY CASCADE');
 await pools.inventory.query('TRUNCATE inventory,reservations,inbox_events,inventory_order_operations,outbox_events RESTART IDENTITY');
 await pools.payments.query('TRUNCATE payments,refunds,inbox_events,outbox_events RESTART IDENTITY');
 broker(['add_vhost',run]);broker(['add_user',run,password]);broker(['set_permissions','-p',run,run,'^app\\.events$|^(inventory|payment|refund)_.*$','^app\\.events$|^(inventory|payment|refund)_.*$','^app\\.events$|^(inventory|payment|refund)_.*$']);
 connection=await amqp.connect(`amqp://${run}:${password}@localhost:5672/${run}`);channel=await connection.createConfirmChannel();await channel.assertExchange('app.events','direct',{durable:true});
 const types=['inventory_reserve_requested','inventory_confirm_requested','inventory_release_requested','payment_requested','refund_requested','inventory_reserved','inventory_reservation_failed','inventory_confirmed','inventory_confirmation_failed','inventory_released','inventory_expired','payment_processed','refund_processed'];
 for(const type of types)for(const queue of [type,`${type}_dlq`]){await channel.assertQueue(queue,{durable:true});await channel.bindQueue(queue,'app.events',queue);}
 await pools.inventory.query('INSERT INTO inventory(product_id,quantity) VALUES(900001,10)');
 const order=(await rows('orders',"INSERT INTO orders(user_id,items,total_amount) VALUES(900001,'[{\"productId\":900001,\"quantity\":2}]',20) RETURNING id,items"))[0];assert.notEqual(order.id,56);
 await pools.orders.query("INSERT INTO order_sagas(order_id,state) VALUES($1,'PENDING')",[order.id]);
 const reserve={eventId:`${run}:reserve`,orderId:order.id,userId:900001,amount:'20.00',items:order.items,requestId:run};
 let orders=worker('orders'),inventory=worker('inventory'),payments=worker('payments',true);
 await until(()=>Promise.resolve(signals.filter(x=>x.ready).length===3),'workers ready');
 await publish('inventory_reserve_requested',reserve);await publish('inventory_reserve_requested',reserve);
 await until(()=>Promise.resolve(signals.some(x=>x.committedBeforeAck)),'payment commit before ack');
 const queue=await channel.checkQueue('payment_requested');assert.equal(queue.consumerCount,1);
 await stop(payments,'SIGKILL');payments=worker('payments');
 await until(async()=>(await rows('orders','SELECT state FROM order_sagas WHERE order_id=$1',[order.id]))[0].state==='CONFIRMED','confirmed');
 assert.ok(signals.some(x=>x.redelivered==='payment_requested'));assert.equal((await rows('payments','SELECT * FROM payments')).length,1);
 const payment=(await rows('orders',"SELECT payload FROM outbox_events WHERE event_type='payment_requested'"))[0].payload;
 await publish('payment_requested',payment);await publish('payment_requested',payment);
 await until(()=>Promise.resolve(signals.some(x=>x.publicationRetried)),'outbox fault');await sleep(600);
 assert.equal((await rows('payments','SELECT * FROM payments')).length,1);assert.equal((await rows('inventory','SELECT quantity FROM inventory'))[0].quantity,8);
 const history=await rows('orders','SELECT * FROM saga_transitions');assert.equal(history.filter(x=>x.to_state==='PAYMENT_AUTHORIZED').length,1);assert.equal(history.filter(x=>x.to_state==='CONFIRMED').length,1);
 report.push('Duplicate payment, commit-before-ack kill/redelivery, duplicate reservation, confirmed-publication retry and Saga deduplication passed');
 orders.send({cancel:{eventId:`${run}:cancel`,orderId:order.id}});
 await until(async()=>(await rows('orders','SELECT state FROM order_sagas'))[0].state==='CANCELLED','cancelled');
 const refund=(await rows('orders',"SELECT payload FROM outbox_events WHERE event_type='refund_requested'"))[0].payload;
 const release=(await rows('orders',"SELECT payload FROM outbox_events WHERE event_type='inventory_release_requested'"))[0].payload;
 await publish('refund_requested',refund);await publish('refund_requested',refund);await publish('inventory_release_requested',release);await publish('inventory_release_requested',release);await sleep(700);
 assert.equal((await rows('payments','SELECT * FROM refunds')).length,1);assert.equal((await rows('inventory','SELECT quantity FROM inventory'))[0].quantity,10);
 const before=await rows('orders','SELECT * FROM saga_transitions');
 await Promise.all([stop(orders),stop(inventory),stop(payments)]);orders=worker('orders');inventory=worker('inventory');payments=worker('payments');await sleep(1000);
 assert.equal((await rows('orders','SELECT state FROM order_sagas'))[0].state,'CANCELLED');assert.equal((await rows('orders','SELECT * FROM saga_transitions')).length,before.length);
 report.push('Duplicate refunds/releases and worker restart preserve one refund, stock 10 and terminal CANCELLED');
 for(const type of ['payment_requested','refund_requested']){
  const failed={...payment,eventId:`${run}:failure:${type}`,operationId:`${order.id}:${type}`,requestId:'live-force-failure'};
  await publish(type,failed);await until(async()=>(await channel.checkQueue(`${type}_dlq`)).messageCount===1,`${type} DLQ`);
  assert.equal(signals.filter(x=>x.failureAttempt===type).length,3);
  const msg=await channel.get(`${type}_dlq`,{noAck:false});assert.deepEqual(JSON.parse(msg.content),failed);channel.nack(msg,false,true);
 }
 report.push('Payment and refund technical failures each make exactly three attempts then reach matching confirmed DLQ');
 for(const queue of ['inventory_reserve_requested','inventory_release_requested','payment_requested','refund_requested'])assert.equal((await channel.checkQueue(queue)).messageCount,0);
 console.log(JSON.stringify({passed:true,testVhost:run,testDatabases:Object.keys(pools).map(x=>`${x}_phase2_test`),results:report,orderId:order.id,payments:1,refunds:1,stock:10,saga:'CANCELLED',testDlqs:{payment_requested_dlq:1,refund_requested_dlq:1}}));
})().catch(error=>{console.error('Live test failed:',error.code||error.message);process.exitCode=1;}).finally(async()=>{await Promise.all([...workers].map(child=>stop(child)));if(connection)await connection.close().catch(()=>{});await Promise.all(Object.values(pools).map(pool=>pool.end()));console.log('Test vhost, queues and fixtures retained; no development resources accessed.');});
