const {randomUUID}=require('crypto');
const run=`logging-verification-${randomUUID()}`;
const loggers=['orders','inventory','payments'].map(service=>require(`../../${service}-service/src/logger`));
let failed=false;for(const logger of loggers)logger.on('error',()=>{failed=true;});
async function request(path,method='GET',body){const response=await fetch(`http://localhost:9200${path}`,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const result=await response.json();if(!response.ok)throw new Error(JSON.stringify(result));return result;}
(async()=>{
 for(const logger of loggers)for(const eventId of ['56:refund_requested:1',123])logger.info('Synthetic logging compatibility verification',{eventId,orderId:56,requestId:run,operationId:'synthetic-operation',correlationId:run,verificationRun:run});
 await request(`/ecommerce-logs-write/_doc/${run}-raw?refresh=true`,'PUT',{'@timestamp':new Date().toISOString(),service:'synthetic-ingest-test',level:'info',message:'Synthetic legacy ingest verification',meta:{eventId:456,orderId:56,requestId:run,verificationRun:run}});
 let hits=[];for(let i=0;i<10;i++){await new Promise(r=>setTimeout(r,1000));await request('/ecommerce-logs-write/_refresh','POST');hits=(await request('/ecommerce-logs-write/_search','POST',{size:20,query:{term:{'meta.verificationRun.keyword':run}}})).hits.hits;if(hits.length===7)break;}
 if(failed||hits.length!==7||hits.some(h=>typeof h._source.meta.eventId!=='string'||typeof h._source.meta.orderId!=='string'))throw new Error('Logging pipeline verification failed');
 const history=(await request('/logs/_count')).count;if(history<15305)throw new Error('Historical logs unexpectedly reduced');
 console.log(JSON.stringify({syntheticRecords:hits.length,eventIds:[...new Set(hits.map(h=>h._source.meta.eventId))],historyCount:history,indexingErrors:failed,run}));
})().catch(e=>{console.error(e.message);process.exitCode=1;}).finally(()=>{for(const logger of loggers)logger.close();});
