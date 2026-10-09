const pool=require('./db');
let timer,running=false;
async function pollOnce(){
 if(running)return;running=true;
 let client;
 try{
  client=await pool.connect();
  await client.query('BEGIN');
  const overdue=await client.query(`SELECT * FROM order_sagas WHERE state IN ('PENDING','CANCEL_REQUESTED','STOCK_RESERVED','PAYMENT_AUTHORIZED','REFUND_PENDING','RELEASE_PENDING') AND updated_at < NOW()-($1*INTERVAL '1 millisecond') FOR UPDATE SKIP LOCKED`,[Number(process.env.SAGA_TIMEOUT_MS)||300000]);
  for(const saga of overdue.rows){
   // Reconcile with the owner. Never infer payment failure from elapsed time.
   const command={PENDING:'inventory_reserve_requested',CANCEL_REQUESTED:'inventory_reserve_requested',STOCK_RESERVED:'payment_requested',PAYMENT_AUTHORIZED:'inventory_confirm_requested',REFUND_PENDING:'refund_requested',RELEASE_PENDING:'inventory_release_requested'}[saga.state];
   const result=await client.query("SELECT id,payload FROM outbox_events WHERE event_type=$1 AND payload->>'orderId'=$2 ORDER BY id DESC LIMIT 1",[command,String(saga.order_id)]);
   const event=result.rows[0];
   if(!event||Number(event.payload.reconcileAttempts||0)>=3){await client.query("UPDATE order_sagas SET last_error='Saga timeout: manual reconciliation required',updated_at=NOW() WHERE order_id=$1",[saga.order_id]);continue;}
   // Same event ID: redelivery of the same operation, never a new charge/refund.
   await client.query('UPDATE outbox_events SET published=FALSE,payload=$2 WHERE id=$1',[event.id,JSON.stringify({...event.payload,reconcileAttempts:Number(event.payload.reconcileAttempts||0)+1})]);
   await client.query("UPDATE order_sagas SET last_error='Saga timeout: reconciliation requested',updated_at=NOW() WHERE order_id=$1",[saga.order_id]);
  }
  await client.query('COMMIT');
 }catch(error){if(client)await client.query('ROLLBACK').catch(()=>{});console.error('Saga timeout reconciliation failed',error.code||'unknown');}
 finally{if(client)client.release();running=false;}
}
function start(){if(!timer)timer=setInterval(()=>pollOnce().catch(()=>{}),60000);}
async function stop(){clearInterval(timer);timer=null;while(running)await new Promise(r=>setTimeout(r,25));}
module.exports={pollOnce,start,stop};
