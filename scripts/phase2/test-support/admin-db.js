// Administrative secrets are loaded only by this privileged fixture helper.
module.exports=function(service,pg){
 if(process.env.NODE_ENV!=='test')throw new Error('Fixtures require test mode');
 const {loadTestConfig,verifyIdentity}=require('./test-config');const spec=loadTestConfig().services[service];
 if(!spec||process.env.DB_NAME_TEST!==require('./test-config').loadApplicationConfig().services[process.env.TEST_SERVICE||service]?.database)throw new Error('Explicit isolated fixture target required');
 const pool=new pg.Pool({host:spec.host,port:spec.port,database:spec.database,...spec.admin});
 // Every fixture statement verifies identity on the same client before execution.
 pool.query=async function(sql,values){const client=await pool.connect();try{await verifyIdentity(client,spec,spec.admin.user);return await client.query(sql,values);}finally{client.release();}};
 return pool;
};
