module.exports=function(service,pg){
 if(process.env.NODE_ENV!=='test'||!['orders_phase2_test','payments_phase2_test','inventory_phase2_test'].includes(process.env.DB_NAME_TEST))throw new Error('Privileged fixtures require the exact isolated Phase 2 database');
 const path=require('path');const config=require(path.resolve(process.cwd(),'node_modules/dotenv')).parse(require('fs').readFileSync(path.resolve(__dirname,'../../../.env')));
 const pool=new pg.Pool({host:'localhost',port:{orders:5435,payments:5436,inventory:5437}[service],user:service==='inventory'?'inventory_user':'postgres',password:config[`${service.toUpperCase()}_DB_PASSWORD`],database:`${service}_phase2_test`});
 return pool;
};
