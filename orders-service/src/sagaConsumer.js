let active=0, consumerChannel;
const consumerTags=[];
const amqp = require('amqplib');
const { processSagaEvent } = require('./sagaStore');
const types = ['inventory_reserved','inventory_reservation_failed','inventory_confirmed','inventory_released','inventory_expired','inventory_confirmation_failed','payment_processed','refund_processed'];
let connection, timer, starting, stopped = false;
async function start() {
  if (stopped || connection || starting) return;
  starting = true;
  try {
    const conn = await amqp.connect(process.env.RABBITMQ_URL);
    if(stopped){await conn.close();return;}
    connection = conn;
    conn.on('error',()=>{});
    conn.on('close',()=>{if(connection===conn) connection=null;if(!stopped) timer=setTimeout(start,3000);});
    const channel = await conn.createConfirmChannel(); consumerChannel=channel;
    channel.on('error',()=>{});
    await channel.assertExchange('app.events','direct',{durable:true});
    await channel.prefetch(1);
    for (const type of types) {
      const dlq = `${type}_dlq`;
      for (const q of [type,dlq]) {await channel.assertQueue(q,{durable:true});await channel.bindQueue(q,'app.events',q);}
      const subscription=await channel.consume(type,async msg=>{
        if (!msg) return; active++;
        try {
          const event=JSON.parse(msg.content.toString());
          // Legacy results have a single persisted operation per order.
          if (!event.eventId && ['payment_processed','refund_processed','inventory_expired'].includes(type)) event.eventId=`legacy:${type}:${event.orderId}:${event.reservationId || event.status}`;
          for (let attempt=0;;attempt++) {
            try {await processSagaEvent(type,event);break;}
            catch(error) {if(error.code==='INVALID_EVENT'||attempt===2) throw error;await new Promise(r=>setTimeout(r,250*(attempt+1)));}
          }
          channel.ack(msg);
        } catch(error) {
          try {await new Promise((resolve,reject)=>channel.publish('app.events',dlq,msg.content,{persistent:true,contentType:'application/json'},e=>e?reject(e):resolve()));channel.ack(msg);}
          catch {await conn.close().catch(()=>{});}
        } finally {active--;}
      });
      consumerTags.push(subscription.consumerTag);
    }
  } catch {if(connection) await connection.close().catch(()=>{});connection=null;if(!stopped) timer=setTimeout(start,3000);}
  finally {starting=false;}
}
async function stop() {stopped=true;clearTimeout(timer);if(consumerChannel)for(const tag of consumerTags.splice(0))await consumerChannel.cancel(tag).catch(()=>{});while(active)await new Promise(r=>setTimeout(r,25));if(connection) await connection.close();connection=null;}
module.exports={start,stop};
