let active=0, consumerChannel;
const consumerTags=[];
const amqp = require('amqplib');
const service = require('./inventoryService');
let connection, timer, connecting=false, stopped=false;
const operations={inventory_reserve_requested:'reserveInventory',inventory_confirm_requested:'confirmInventory',inventory_release_requested:'releaseInventory'};
function validate(payload, type) {
 if(!payload || !Number.isInteger(payload.orderId) || payload.orderId<=0) throw Object.assign(new Error('Invalid order ID'),{permanent:true});
 if(type==='inventory_reserve_requested' && (!Array.isArray(payload.items)||!payload.items.length||new Set(payload.items.map(i=>i.productId)).size!==payload.items.length||payload.items.some(i=>!Number.isInteger(i.productId)||i.productId<=0||!Number.isInteger(i.quantity)||i.quantity<=0))) throw Object.assign(new Error('Invalid reservation items'),{permanent:true});
}
async function connectInventoryConsumer() {
 if(stopped||connection||connecting)return;connecting=true;
 try {
  const conn=await amqp.connect(process.env.RABBITMQ_URL);if(stopped){await conn.close();return;}connection=conn;
  conn.on('error',()=>{});conn.on('close',()=>{if(connection===conn)connection=null;if(!stopped)timer=setTimeout(connectInventoryConsumer,3000);});
  const channel=await conn.createConfirmChannel();consumerChannel=channel;channel.on('error',()=>{});
  await channel.assertExchange('app.events','direct',{durable:true});await channel.prefetch(1);
  for(const [type,operation] of Object.entries(operations)) {
   for(const q of [type,`${type}_dlq`]) {await channel.assertQueue(q,{durable:true});await channel.bindQueue(q,'app.events',q);}
   const subscription=await channel.consume(type,async msg=>{
    if(!msg)return;active++;
    try {
     let payload;try {payload=JSON.parse(msg.content.toString());}catch {throw Object.assign(new Error('Invalid JSON'),{permanent:true});}
     validate(payload,type);
     for(let attempt=0;;attempt++) {try {await service[operation](payload);break;}catch(error){if(attempt===2)throw error;await new Promise(r=>setTimeout(r,250*(attempt+1)));}}
     channel.ack(msg);
    }catch {
     try {await new Promise((resolve,reject)=>channel.publish('app.events',`${type}_dlq`,msg.content,{persistent:true,contentType:'application/json'},e=>e?reject(e):resolve()));channel.ack(msg);}
     catch {await conn.close().catch(()=>{});}
    }finally{active--;}
   });
   consumerTags.push(subscription.consumerTag);
  }
  console.log('Inventory subscribed to all three command queues');return channel;
 }catch {if(connection)await connection.close().catch(()=>{});connection=null;if(!stopped)timer=setTimeout(connectInventoryConsumer,3000);}
 finally {connecting=false;}
}
async function stopInventoryConsumer(){stopped=true;clearTimeout(timer);if(consumerChannel)for(const tag of consumerTags.splice(0))await consumerChannel.cancel(tag).catch(()=>{});while(active)await new Promise(r=>setTimeout(r,25));if(connection)await connection.close();connection=null;}
module.exports={connectInventoryConsumer,stopInventoryConsumer,validate};
