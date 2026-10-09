const pool = require('./db');
const { decide } = require('./saga');
async function processSagaEvent(type, event) {
  if (!event || typeof event.eventId !== 'string' || !event.eventId || !Number.isInteger(Number(event.orderId)) || Number(event.orderId) <= 0) {
    const error = new Error('Invalid Saga event'); error.code = 'INVALID_EVENT'; throw error;
  }
  if (type === 'payment_processed' && !['succeeded', 'failed'].includes(event.status)) throw Object.assign(new Error('Invalid payment status'), { code: 'INVALID_EVENT' });
  if (type === 'refund_processed' && !['refunded', 'failed', 'refund_failed'].includes(event.status)) throw Object.assign(new Error('Invalid refund status'), { code: 'INVALID_EVENT' });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await client.query('SELECT * FROM order_sagas WHERE order_id=$1 FOR UPDATE', [event.orderId]);
    if (!result.rows.length) throw Object.assign(new Error('Unknown Saga'), { code: 'INVALID_EVENT' });
    const inbox = await client.query(`INSERT INTO inbox_events(event_id,event_type,order_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING RETURNING event_id`, [event.eventId,type,event.orderId]);
    if (!inbox.rows.length) { await client.query('COMMIT'); return; }
    const previous = result.rows[0];
    const premature = (type === 'payment_processed' && ['PENDING','CANCEL_REQUESTED'].includes(previous.state)) || (type === 'inventory_confirmed' && ['PENDING','CANCEL_REQUESTED','STOCK_RESERVED'].includes(previous.state)) || (type === 'refund_processed' && ['PENDING','STOCK_RESERVED','PAYMENT_AUTHORIZED','CONFIRMED'].includes(previous.state));
    if(premature) throw Object.assign(new Error('Out-of-order Saga result; preserve for reconciliation'),{code:'OUT_OF_ORDER'});
    if(event.reason) await client.query('UPDATE order_sagas SET last_error=$2 WHERE order_id=$1',[event.orderId,event.reason]);
    const { saga, commands } = decide(previous,type,event);
    const order = (await client.query('SELECT * FROM orders WHERE id=$1 FOR UPDATE',[event.orderId])).rows[0];
    if(saga.failure_state && saga.failure_state !== previous.failure_state) await client.query('INSERT INTO saga_transitions(order_id,event_id,from_state,to_state) VALUES($1,$2,$3,$4)',[event.orderId,event.eventId,previous.state,saga.failure_state]);
    if(saga.state !== previous.state) await client.query('INSERT INTO saga_transitions(order_id,event_id,from_state,to_state) VALUES($1,$2,$3,$4)',[event.orderId,event.eventId,saga.failure_state && saga.failure_state !== previous.failure_state ? saga.failure_state : previous.state,saga.state]);
    const generation = previous.command_generation + (commands.length ? 1 : 0);
    await client.query(`UPDATE order_sagas SET state=$2,cancel_requested=$3,payment_succeeded=$4,refund_succeeded=$5,inventory_inactive=$6,failure_state=$7,command_generation=$8,version=version+1,updated_at=NOW() WHERE order_id=$1`, [event.orderId,saga.state,saga.cancel_requested,saga.payment_succeeded,saga.refund_succeeded,saga.inventory_inactive,saga.failure_state,generation]);
    if (saga.orderStatus) await client.query('UPDATE orders SET status=$2 WHERE id=$1',[event.orderId,saga.orderStatus]);
    for (const command of commands) {
      await client.query('INSERT INTO outbox_events(event_type,payload) VALUES($1,$2)', [command,JSON.stringify({eventId:`${event.orderId}:${command}:${generation}`,orderId:Number(event.orderId),userId:order.user_id,amount:order.total_amount,items:order.items,requestId:event.requestId || null,operationId:`${event.orderId}:${command}`,attempt:generation})]);
    }
    await client.query('UPDATE inbox_events SET processed_at=NOW() WHERE event_id=$1',[event.eventId]);
    await client.query('COMMIT');
    require('./logger').info('Saga event committed',{orderId:Number(event.orderId),eventId:event.eventId,eventType:type,fromState:previous.state,state:saga.state,requestId:event.requestId||null});
  } catch(error) { await client.query('ROLLBACK').catch(()=>{}); throw error; }
  finally { client.release(); }
}
module.exports = { processSagaEvent };
