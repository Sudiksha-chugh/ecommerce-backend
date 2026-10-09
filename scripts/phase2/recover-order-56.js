// Dry-run by default. Run --execute only after explicit approval and migrations.
const path=require('path');
const config=require('../../orders-service/node_modules/dotenv').config({path:path.resolve(__dirname,'../../.env'),quiet:true}).parsed;
const {Pool}=require('../../orders-service/node_modules/pg');
const orders=new Pool({host:'localhost',port:5435,user:'orders_app',password:config.ORDERS_APP_DB_PASSWORD,database:'orders_db'});
const inventory=new Pool({host:'localhost',port:5437,user:'inventory_user',password:config.INVENTORY_DB_PASSWORD,database:'inventory_db'});
const payments=new Pool({host:'localhost',port:5436,user:'payments_app',password:config.PAYMENTS_APP_DB_PASSWORD,database:'payments_db'});
(async()=>{
 const order=(await orders.query('SELECT o.*,s.state FROM orders o JOIN order_sagas s ON s.order_id=o.id WHERE o.id=56')).rows[0];
 const payment=(await payments.query('SELECT * FROM payments WHERE order_id=56')).rows;
 const refunds=(await payments.query('SELECT * FROM refunds WHERE order_id=56')).rows;
 const reservations=(await inventory.query('SELECT status,product_id,quantity FROM reservations WHERE order_id=56')).rows;
 const expiration=(await inventory.query("SELECT id FROM outbox_events WHERE event_type='inventory_expired' AND payload->>'orderId'='56'")).rows;
 if(!order||payment.length!==1||payment[0].status!=='succeeded'||Number(payment[0].amount)!==Number(order.total_amount)||String(payment[0].user_id)!==String(order.user_id))throw new Error('Payment preconditions failed');
 if(!reservations.length||reservations.some(r=>r.status!=='EXPIRED')||!expiration.length)throw new Error('Expiration verification failed');
 if(!['PAYMENT_AUTHORIZED','REFUND_PENDING','REFUND_FAILED','RELEASE_PENDING','CANCELLED'].includes(order.state))throw new Error('Unexpected Saga state');
 if(order.state==='CANCELLED' && (!refunds.length||refunds[0].status!=='refunded'))throw new Error('Cancellation lacks successful refund');
 console.log(JSON.stringify({orderId:56,state:order.state,payment:payment[0].status,amount:order.total_amount,reservations:reservations.map(r=>r.status),refund:refunds[0]?.status||'none',actions:['request refund once','verify inactive inventory without stock increment','cancel only after both results']}));
 if(process.argv.includes('--execute')){
  // Inject existing runtime pool so the normal transactional handler owns recovery.
  const dbPath=require.resolve('../../orders-service/src/db');
  require.cache[dbPath]={id:dbPath,filename:dbPath,loaded:true,exports:orders};
  const {processSagaEvent}=require('../../orders-service/src/sagaStore');
  if(order.state==='REFUND_FAILED') throw new Error('Use an explicitly reviewed cancellation retry after refund failure');
  if(order.state==='PAYMENT_AUTHORIZED')await processSagaEvent('inventory_expired',{eventId:'recovery:56:verified-expiration:v1',orderId:56,allInactive:true,requestId:'recovery-order-56',reason:'Verified paid order with expired reservation'});
  console.log('Recovery request committed; completion requires persisted refund and inventory result events.');
 }else console.log('Dry-run only; no runtime rows or messages modified.');
})().catch(error=>{console.error('Recovery stopped:',error.code||error.message);process.exitCode=1;}).finally(()=>Promise.all([orders.end(),inventory.end(),payments.end()]));
