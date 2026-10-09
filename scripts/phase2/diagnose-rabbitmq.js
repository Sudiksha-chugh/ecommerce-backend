const { execFileSync } = require('child_process');
const dotenv = require('../../inventory-service/node_modules/dotenv');
const amqp = require('../../inventory-service/node_modules/amqplib');
dotenv.config({quiet:true});
(async()=>{
 const live=JSON.parse(execFileSync('docker',['inspect','inventory-service','--format','{{json .Config.Env}}'],{encoding:'utf8'})).find(x=>x.startsWith('RABBITMQ_URL=')).slice(13);
 const configured=process.env.INVENTORY_RABBITMQ_URL;
 console.log(JSON.stringify({containerMatchesCompose:live===configured}));
 for(const [source,url] of [['container',live],['compose',configured]]) {
  const endpoint=new URL(url); endpoint.hostname='localhost';
  try {const connection=await amqp.connect(endpoint.toString());await connection.close();console.log(`${source}: credentials accepted`);}
  catch {console.log(`${source}: credentials rejected`);}
 }
})().catch(()=>{console.error('Diagnosis failed; details suppressed to protect credentials');process.exitCode=1;});
