// Controlled single-message recovery. Never creates an outbox command or operation identity.
const {execFileSync}=require('child_process');
const config=require('../../orders-service/node_modules/dotenv').config({quiet:true}).parsed;
const {Pool}=require('../../orders-service/node_modules/pg');
const amqp=require('../../payments-service/node_modules/amqplib');
const assert=require('assert/strict');
const pools=[['orders',5435,'orders_app','ORDERS_APP_DB_PASSWORD'],['inventory',5437,'inventory_user','INVENTORY_DB_PASSWORD'],['payments',5436,'payments_app','PAYMENTS_APP_DB_PASSWORD']].map(([name,port,user,key])=>new Pool({host:'localhost',port,user,password:config[key],database:`${name}_db`}));
const [orders,inventory,payments]=pools;
const docker=args=>execFileSync('docker',args,{encoding:'utf8',stdio:['pipe','pipe','pipe']});
const broker=args=>docker(['exec','rabbitmq','rabbitmqctl',...args]);
let connection,channel,permissions,replayed=false,acknowledged=false;
async function snapshot(){
 const saga=(await orders.query('SELECT o.status,s.* FROM orders o JOIN order_sagas s ON s.order_id=o.id WHERE o.id=56')).rows[0];
 const commands=(await orders.query("SELECT payload,published FROM outbox_events WHERE event_type='refund_requested' AND payload->>'orderId'='56'")).rows;
 const paid=(await payments.query('SELECT order_id,user_id,amount,status FROM payments WHERE order_id=56')).rows;
 const refunds=(await payments.query('SELECT order_id,user_id,amount,status FROM refunds WHERE order_id=56')).rows;
 const reservations=(await inventory.query('SELECT product_id,quantity,status FROM reservations WHERE order_id=56')).rows;
 const stock=(await inventory.query('SELECT quantity FROM inventory WHERE product_id=1')).rows[0].quantity;
 assert.equal(commands.length,1);assert.equal(commands[0].payload.eventId,'56:refund_requested:1');assert.equal(commands[0].payload.operationId,'56:refund_requested');assert.equal(commands[0].published,true);
 assert.equal(paid.length,1);assert.equal(paid[0].status,'succeeded');assert.equal(paid[0].amount,'20.00');assert.equal(String(paid[0].user_id),String(commands[0].payload.userId));
 assert.equal(reservations.length,1);assert.equal(reservations[0].status,'EXPIRED');assert.equal(reservations[0].quantity,2);assert.equal(stock,10);
 return {saga,commands,paid,refunds,reservations,stock};
}
(async()=>{
 for(const service of ['orders-service','payments-service'])assert.equal(docker(['inspect','--format','{{.State.Running}}',service]).trim(),'false');
 const initial=await snapshot();assert.equal(initial.saga.state,'REFUND_PENDING');assert.equal(initial.refunds.length,0);
 const privileges=(await payments.query("SELECT has_column_privilege(current_user,'refunds','status','UPDATE') AS status_update,has_column_privilege(current_user,'refunds','updated_at','UPDATE') AS timestamp_update,has_sequence_privilege(current_user,'refunds_id_seq','USAGE') AS sequence_usage")).rows[0];assert.ok(Object.values(privileges).every(Boolean));
 permissions=broker(['list_permissions','-p','/']).split('\n').find(line=>line.startsWith('payments_app\t')).trim().split('\t');
 const [,configure,write,read]=permissions;
 broker(['set_permissions','-p','/','payments_app',configure,write,`(?:${read})|^refund_requested_dlq$`]);
 const url=new URL(config.PAYMENTS_RABBITMQ_URL);url.hostname='localhost';
 connection=await amqp.connect(url.toString());connection.on('error',()=>{});
 channel=await connection.createConfirmChannel();channel.on('error',()=>{});
 const message=await channel.get('refund_requested_dlq',{noAck:false});assert.ok(message,'DLQ is empty; no replay');
 const candidate=JSON.parse(message.content.toString());
 for(const field of ['orderId','eventId','operationId','userId','amount','requestId'])assert.deepEqual(candidate[field],initial.commands[0].payload[field],`DLQ ${field} mismatch`);
 assert.deepEqual(candidate,initial.commands[0].payload,'DLQ payload differs from persisted command');
 const latest=await snapshot();assert.equal(latest.saga.state,'REFUND_PENDING');assert.equal(latest.refunds.length,0);
 assert.equal((await payments.query('SELECT event_id FROM inbox_events WHERE event_id=$1',[candidate.eventId])).rowCount,0);
 console.log(JSON.stringify({validated:true,orderId:candidate.orderId,eventId:candidate.eventId,operationId:candidate.operationId,userId:candidate.userId,amount:candidate.amount,requestId:candidate.requestId,deliveryHeld:true}));
 let returned=false;channel.on('return',()=>{returned=true;});
 channel.publish('app.events','refund_requested',message.content,{persistent:true,mandatory:true,contentType:'application/json',messageId:candidate.eventId});
 await channel.waitForConfirms();assert.equal(returned,false,'Replay unroutable');replayed=true;
 console.log('Original command durably accepted; starting updated Payments and Orders.');
 docker(['compose','up','-d','--no-deps','payments-service','orders-service']);
 let complete;
 for(let attempt=0;attempt<45;attempt++){
  const state=await snapshot();
  if(state.saga.state==='REFUND_FAILED')throw new Error('Refund failed; stopping');
  if(state.saga.state==='CANCELLED'){complete=state;break;}
  await new Promise(resolve=>setTimeout(resolve,1000));
 }
 assert.ok(complete,'Compensation timed out');assert.equal(complete.saga.status,'cancelled');assert.equal(complete.refunds.length,1);assert.equal(complete.refunds[0].status,'refunded');assert.equal(complete.refunds[0].amount,'20.00');assert.equal(complete.saga.refund_succeeded,true);assert.equal(complete.saga.inventory_inactive,true);
 const history=(await orders.query('SELECT from_state,to_state,event_id FROM saga_transitions WHERE order_id=56 ORDER BY id')).rows;
 assert.ok(history.some(x=>x.from_state==='REFUND_PENDING'&&x.to_state==='RELEASE_PENDING'));assert.ok(history.some(x=>x.from_state==='RELEASE_PENDING'&&x.to_state==='CANCELLED'));
 const result=(await payments.query("SELECT published,payload FROM outbox_events WHERE event_type='refund_processed' AND payload->>'eventId'=$1",[`${candidate.eventId}:result`])).rows;assert.equal(result.length,1);assert.equal(result[0].published,true);
 assert.equal((await orders.query('SELECT event_id FROM inbox_events WHERE event_id=$1',[`${candidate.eventId}:result`])).rowCount,1);
 channel.ack(message);await channel.checkQueue('refund_requested_dlq');acknowledged=true;
 console.log(JSON.stringify({verified:true,originalDlqAcknowledged:true,...complete,history,refundResult:result}));
})().catch(async error=>{
 console.error('Recovery stopped:',error instanceof assert.AssertionError?error.message:error.code||error.message);
 if(replayed&&!acknowledged){try{docker(['compose','stop','orders-service','payments-service']);console.error('Orders and Payments stopped for reconciliation; delivery will return on close.');}catch{console.error('Could not stop workers; inspect runtime before further action.');}}
 process.exitCode=1;
}).finally(async()=>{
 if(connection)await connection.close().catch(()=>{});
 if(permissions){const [,configure,write,read]=permissions;try{broker(['set_permissions','-p','/','payments_app',configure,write,read]);console.log('Temporary DLQ read permission restored.');}catch{console.error('Permission restoration failed');process.exitCode=1;}}
 await Promise.all(pools.map(pool=>pool.end()));
});
