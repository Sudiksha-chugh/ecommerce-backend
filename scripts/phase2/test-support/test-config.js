// Stage B configuration is deliberately independent of development .env files.
const fs=require('fs');const path=require('path');const os=require('os');const crypto=require('crypto');
const root=path.resolve(__dirname,'../../..');
const project='ecommerce-phase21-test';
const services=['orders','inventory','payments','catalog'];
const ports={orders:55435,payments:55436,inventory:55437,catalog:55438};
const directory=path.join(os.tmpdir(),`${project}-${crypto.createHash('sha256').update(root).digest('hex').slice(0,12)}`);
function checkDirectory(){const stat=fs.lstatSync(directory);if(!stat.isDirectory()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('Unsafe test secret directory');}
function loadTestConfig({initialize=false}={}){
 if(!fs.existsSync(directory)){if(!initialize)throw new Error('Test configuration missing; run isolated provisioning --start');fs.mkdirSync(directory,{mode:0o700});}
 checkDirectory();const file=path.join(directory,'config.json');
 if(!fs.existsSync(file)){
  if(!initialize)throw new Error('Test configuration missing');
  const credentials=Object.fromEntries(services.map(service=>[service,{adminPassword:crypto.randomBytes(32).toString('hex'),appPassword:crypto.randomBytes(32).toString('hex')} ]));
  fs.writeFileSync(file,JSON.stringify(credentials),{mode:0o600,flag:'wx'});
 }
 const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('Unsafe test credential file');
 const credentials=JSON.parse(fs.readFileSync(file,'utf8'));
 const result={root,project,directory,services:{}};
 for(const service of services){
  const c=credentials[service];if(!c||!/^\w{64}$/.test(c.adminPassword)||!/^\w{64}$/.test(c.appPassword)||c.adminPassword===c.appPassword)throw new Error('Invalid separated test credentials');
  const secret=path.join(directory,`${service}-admin`);
  if(initialize&&!fs.existsSync(secret))fs.writeFileSync(secret,c.adminPassword,{mode:0o600,flag:'wx'});
  if(fs.existsSync(secret)){const st=fs.lstatSync(secret);if(!st.isFile()||st.isSymbolicLink()||st.uid!==process.getuid()||(st.mode&0o077)||fs.readFileSync(secret,'utf8')!==c.adminPassword)throw new Error('Unsafe test admin secret');}
  result.services[service]={host:'127.0.0.1',port:ports[service],database:`${service}_phase21_test`,role:`${service}_app`,admin:{user:'phase21_admin',password:c.adminPassword},application:{user:`${service}_app`,password:c.appPassword}};
 }
 return result;
}
module.exports={loadTestConfig};

function writeApplicationConfig(config){
 const application={root:config.root,project:config.project,services:{}};
 for(const [service,spec]of Object.entries(config.services))application.services[service]={host:spec.host,port:spec.port,database:spec.database,role:spec.role,application:spec.application};
 const file=path.join(config.directory,'application.json');
 if(fs.existsSync(file)){const stat=fs.lstatSync(file);if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('Unsafe application credential target');}
 fs.writeFileSync(file,JSON.stringify(application),{mode:0o600});
}
function loadApplicationConfig(){
 checkDirectory();const file=path.join(directory,'application.json');const stat=fs.lstatSync(file);
 if(!stat.isFile()||stat.isSymbolicLink()||stat.uid!==process.getuid()||(stat.mode&0o077))throw new Error('Unsafe application test configuration');
 const config=JSON.parse(fs.readFileSync(file,'utf8'));
 for(const service of services){const spec=config.services[service];if(spec?.database!==`${service}_phase21_test`||spec.role!==`${service}_app`||spec.host!=='127.0.0.1'||spec.port!==ports[service]||spec.admin)throw new Error('Application test target mismatch');}
 return config;
}
function applicationEnvironment(service){const spec=loadApplicationConfig().services[service];if(!spec)throw new Error('Unknown test service');return {NODE_ENV:'test',PHASE2_INTEGRATION:'true',DB_HOST:spec.host,DB_PORT:String(spec.port),DB_USER:spec.role,DB_PASSWORD:spec.application.password,DB_NAME:'unused_runtime_db',DB_NAME_TEST:spec.database,INTERNAL_SERVICE_KEY:'synthetic-internal-key',AUTH0_DOMAIN:'test-tenant.auth0.com',AUTH0_AUDIENCE:'https://test-api.example.com',RABBITMQ_URL:'amqp://invalid:invalid@127.0.0.1:1/phase2_live_test_offline',ES_NODE:'http://127.0.0.1:59200'};}
async function verifyIdentity(client,spec,user){const row=(await client.query('SELECT current_database() AS database,current_user AS role')).rows[0];if(row?.database!==spec.database||row.role!==user)throw new Error('Test database/role identity mismatch');}
function guardApplicationPool(service,pool){
 const spec=loadApplicationConfig().services[service];const original=pool.connect.bind(pool);
 pool.connect=function(callback){
  if(typeof callback==='function')return original((error,client,release)=>{if(error)return callback(error);verifyIdentity(client,spec,spec.role).then(()=>callback(null,client,release),err=>{release(err);callback(err);});});
  return original().then(async client=>{try{await verifyIdentity(client,spec,spec.role);return client;}catch(error){client.release(error);throw error;}});
 };return pool;
}
module.exports.writeApplicationConfig=writeApplicationConfig;
module.exports.loadApplicationConfig=loadApplicationConfig;
module.exports.applicationEnvironment=applicationEnvironment;
module.exports.verifyIdentity=verifyIdentity;
module.exports.guardApplicationPool=guardApplicationPool;
