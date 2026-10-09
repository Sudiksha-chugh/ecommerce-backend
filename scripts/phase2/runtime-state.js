const config=require('../../orders-service/node_modules/dotenv').config({quiet:true}).parsed;const {Pool}=require('../../orders-service/node_modules/pg');
const specs=[['orders',5435,'orders_app','ORDERS_APP_DB_PASSWORD'],['inventory',5437,'inventory_user','INVENTORY_DB_PASSWORD'],['payments',5436,'payments_app','PAYMENTS_APP_DB_PASSWORD']];
const pools=specs.map(([name,port,user,key])=>new Pool({host:'localhost',port,user,password:config[key],database:`${name}_db`}));
(async()=>{
 const [orders,inventory,payments]=pools;
 const saga=(await orders.query('SELECT o.status,s.* FROM orders o JOIN order_sagas s ON s.order_id=o.id WHERE o.id=56')).rows[0];
 const outbox=(await orders.query("SELECT id,event_type,published,payload->>'eventId' AS event_id FROM outbox_events WHERE payload->>'orderId'='56' ORDER BY id")).rows;
 const history=(await orders.query('SELECT from_state,to_state,event_id FROM saga_transitions WHERE order_id=56 ORDER BY id')).rows;
 const refunds=(await payments.query('SELECT order_id,amount,status FROM refunds WHERE order_id=56')).rows;
 const paid=(await payments.query('SELECT order_id,amount,status FROM payments WHERE order_id=56')).rows;
 const reservations=(await inventory.query('SELECT order_id,product_id,quantity,status FROM reservations WHERE order_id=56')).rows;
 const stock=(await inventory.query('SELECT product_id,quantity FROM inventory WHERE product_id=1')).rows;
 console.log(JSON.stringify({saga,outbox,history,paid,refunds,reservations,stock}));
 if(paid.length!==1||paid[0].status!=='succeeded'||paid[0].amount!=='20.00'||reservations.length!==1||reservations[0].status!=='EXPIRED'||stock[0].quantity!==10)throw new Error('Critical financial or stock invariant failed');
 const refundCommands=outbox.filter(e=>e.event_type==='refund_requested');if(refundCommands.length!==1||refundCommands[0].event_id!=='56:refund_requested:1')throw new Error('Refund command identity/count changed');
 if(process.argv.includes('--pending')&&(saga.state!=='REFUND_PENDING'||saga.status!=='refund_pending'||refunds.length||refundCommands[0].published))throw new Error('Paused preconditions changed');
 if(process.argv.includes('--complete')&&(saga.state!=='CANCELLED'||saga.status!=='cancelled'||refunds.length!==1||refunds[0].status!=='refunded'||refunds[0].amount!=='20.00'||!saga.refund_succeeded||!saga.inventory_inactive||!refundCommands[0].published))throw new Error('Recovery incomplete');
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>Promise.all(pools.map(p=>p.end())));
