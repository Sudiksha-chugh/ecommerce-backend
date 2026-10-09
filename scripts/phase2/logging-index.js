const ids=['eventId','orderId','requestId','operationId','correlationId','userId','productId','reservationId','orderOwnerId','createdBy'];
async function request(path,method='GET',body){const response=await fetch(`http://localhost:9200${path}`,{method,headers:{'content-type':'application/json'},body:body?JSON.stringify(body):undefined});const data=await response.json();if(!response.ok)throw new Error(JSON.stringify(data));return data;}
(async()=>{
 const mapping=await request('/logs/_mapping');
 const templates=await request('/_index_template');const legacy=await request('/_template');
 console.log(JSON.stringify({historicalFields:mapping.logs.mappings.properties.meta.properties,matchingTemplates:templates.index_templates.filter(t=>t.index_template.index_patterns.some(p=>p.includes('logs')||p==='*')).map(t=>({name:t.name,patterns:t.index_template.index_patterns})),legacyTemplates:Object.entries(legacy).filter(([,t])=>t.index_patterns.some(p=>p.includes('logs')||p==='*')).map(([name,t])=>({name,patterns:t.index_patterns})),historyCount:(await request('/logs/_count')).count}));
 if(!process.argv.includes('--repair'))return;
 await request('/_ingest/pipeline/ecommerce-log-identifiers-v2','PUT',{description:'Normalize opaque log identifiers to strings',processors:ids.map(id=>({convert:{field:`meta.${id}`,type:'string',ignore_missing:true}}))});
 const properties=Object.fromEntries(ids.map(id=>[id,{type:'keyword'}]));
 const mappings={properties:{'@timestamp':{type:'date'},service:{type:'keyword'},level:{type:'keyword'},message:{type:'text'},meta:{properties}}};
 await request('/_index_template/ecommerce-logs-v2','PUT',{index_patterns:['ecommerce-logs-v2-*'],priority:500,template:{settings:{number_of_shards:1,number_of_replicas:0,default_pipeline:'ecommerce-log-identifiers-v2'},mappings}});
 const exists=await fetch('http://localhost:9200/ecommerce-logs-v2-000001',{method:'HEAD'});
 if(exists.status===404)await request('/ecommerce-logs-v2-000001','PUT',{});else if(!exists.ok)throw new Error('Index check failed');
 const actual=(await request('/ecommerce-logs-v2-000001/_mapping'))['ecommerce-logs-v2-000001'].mappings.properties.meta.properties;
 for(const id of ids)if(actual[id]?.type!=='keyword')throw new Error(`Incompatible ${id}`);
 const aliases=await request('/_alias');
 const actions=[];for(const [index,value]of Object.entries(aliases))if(value.aliases['ecommerce-logs-write'])actions.push({remove:{index,alias:'ecommerce-logs-write'}});
 actions.push({add:{index:'ecommerce-logs-v2-000001',alias:'ecommerce-logs-write',is_write_index:true}});
 actions.push({add:{index:'logs',alias:'ecommerce-logs-history'}});
 actions.push({add:{index:'ecommerce-logs-v2-000001',alias:'ecommerce-logs-history'}});
 await request('/_aliases','POST',{actions});
 console.log('Versioned keyword index and atomic write-alias migration complete; historical logs retained');
})().catch(e=>{console.error(e.message);process.exitCode=1;});
