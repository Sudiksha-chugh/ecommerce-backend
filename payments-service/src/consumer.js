let active=0, consumerChannel;
const consumerTags=[];
const amqp=require('amqplib');
const {processRequest}=require('./paymentStore');
let connection,timer,starting=false,stopped=false;
async function startConsumer(){
 if(stopped||connection||starting)return;starting=true;
 try{
  const conn=await amqp.connect(process.env.RABBITMQ_URL);if(stopped){await conn.close();return;}connection=conn;conn.on('error',()=>{});conn.on('close',()=>{if(connection===conn)connection=null;if(!stopped)timer=setTimeout(startConsumer,3000);});
  const ch=await conn.createConfirmChannel();consumerChannel=ch;ch.on('error',()=>{});await ch.assertExchange('app.events','direct',{durable:true});await ch.prefetch(1);
  for(const type of ['payment_requested','refund_requested']){
   for(const q of [type,`${type}_dlq`]){await ch.assertQueue(q,{durable:true});await ch.bindQueue(q,'app.events',q);}
   const subscription=await ch.consume(type,async msg=>{
    if(!msg)return;active++;
    try{
     const event=JSON.parse(msg.content.toString());
     for(let attempt=0;;attempt++){try{await processRequest(type,event);break;}catch(error){if(error.permanent||attempt===2)throw error;await new Promise(r=>setTimeout(r,250*(attempt+1)));}}
     ch.ack(msg);
    }catch{
     try{await new Promise((resolve,reject)=>ch.publish('app.events',`${type}_dlq`,msg.content,{persistent:true},e=>e?reject(e):resolve()));ch.ack(msg);}
     catch{await conn.close().catch(()=>{});}
    }finally{active--;}
   });
   consumerTags.push(subscription.consumerTag);
  }
 }catch{if(connection)await connection.close().catch(()=>{});connection=null;if(!stopped)timer=setTimeout(startConsumer,3000);}
 finally{starting=false;}
}
async function stopConsumer(){stopped=true;clearTimeout(timer);if(consumerChannel)for(const tag of consumerTags.splice(0))await consumerChannel.cancel(tag).catch(()=>{});while(active)await new Promise(r=>setTimeout(r,25));if(connection)await connection.close();connection=null;}
module.exports={startConsumer,stopConsumer};
