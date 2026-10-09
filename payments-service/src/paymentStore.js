const pool=require('./db');
const {processPayment,processRefund}=require('./payment-logic');
async function processRequest(type,event) {
 if(!event || !Number.isInteger(event.orderId)||event.orderId<=0||!event.userId||!Number.isFinite(Number(event.amount))||Number(event.amount)<=0)throw Object.assign(new Error('Invalid payment request'),{permanent:true});
 if(!['payment_requested','refund_requested'].includes(type))throw Object.assign(new Error('Invalid operation type'),{permanent:true});
 const operationId=`${event.orderId}:${type}`;
 if(event.operationId && event.operationId!==operationId)throw Object.assign(new Error('Conflicting operation identity'),{permanent:true});
 const refund=type==='refund_requested';
 const table=refund?'refunds':'payments';
 const eventId=event.eventId||`legacy:${type}:${event.orderId}`;
 const client=await pool.connect();
 try {
  await client.query('BEGIN');await client.query('SELECT pg_advisory_xact_lock($1)',[event.orderId]);
  const inbox=await client.query('INSERT INTO inbox_events(event_id,event_type,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id',[eventId,type,event.orderId]);
  if(!inbox.rows.length){await client.query("UPDATE outbox_events SET published=FALSE WHERE payload->>'eventId'=$1",[`${eventId}:result`]);await client.query('COMMIT');return;}
  const existing=(await client.query(`SELECT * FROM ${table} WHERE order_id=$1`,[event.orderId])).rows[0];
  if(existing && (String(existing.user_id)!==String(event.userId)||Number(existing.amount)!==Number(event.amount)))throw Object.assign(new Error('Conflicting operation payload'),{permanent:true});
  let result;
  if(existing && (!refund||existing.status==='refunded')) result={orderId:event.orderId,userId:existing.user_id,amount:existing.amount,status:existing.status};
  else {
   if(refund) {
    const paid=(await client.query('SELECT * FROM payments WHERE order_id=$1',[event.orderId])).rows[0];
    if(!paid||paid.status!=='succeeded'||String(paid.user_id)!==String(event.userId)||Number(paid.amount)!==Number(event.amount))throw Object.assign(new Error('Refund does not match successful payment'),{permanent:true});
   }
   // Current repository uses a local simulator, not an external processor.
   // A future provider must use operationId as its durable idempotency key.
   result=refund?processRefund(event):processPayment(event);
   await client.query(`INSERT INTO ${table}(order_id,user_id,amount,status) VALUES($1,$2,$3,$4) ON CONFLICT(order_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW()`,[result.orderId,result.userId,result.amount,result.status]);
  }
  const outgoing=refund?'refund_processed':'payment_processed';
  await client.query('INSERT INTO outbox_events(event_type,payload) VALUES($1,$2)',[outgoing,JSON.stringify({...result,eventId:`${eventId}:result`,operationId,requestId:event.requestId||null})]);
  await client.query('COMMIT');
  require('./logger').info('Payment operation committed',{orderId:event.orderId,eventId,eventType:type,status:result.status,requestId:event.requestId||null});
 }catch(error){await client.query('ROLLBACK').catch(()=>{});throw error;}
 finally{client.release();}
}
module.exports={processRequest};
