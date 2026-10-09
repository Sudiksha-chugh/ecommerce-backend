// Dedicated Phase 2.1 stack only; never reads development .env or copies runtime schemas.
const {execFileSync}=require('child_process');const fs=require('fs');const path=require('path');const crypto=require('crypto');
const {Client}=require('../../orders-service/node_modules/pg');
const {loadTestConfig}=require('./test-support/test-config');
const {migrateTestDatabase}=require('./test-support/migration-runner');
function compose(config,args){return execFileSync('docker',['compose','-p',config.project,'-f',path.join(config.root,'docker-compose.test.yml'),...args],{env:{...process.env,PHASE21_SECRET_DIR:config.directory},stdio:['pipe','pipe','pipe'],encoding:'utf8'});}
function verifyStack(config,{catalogSearch=false}={}){
 const ids=compose(config,['ps','-q',...Object.keys(config.services).map(service=>`${service}-test-db`)]).trim().split('\n').filter(Boolean);if(ids.length!==4)throw new Error('Dedicated test stack unavailable; refusing fallback');
 const containers=JSON.parse(execFileSync('docker',['inspect',...ids],{encoding:'utf8',stdio:['pipe','pipe','pipe']}));
 for(const [service,spec]of Object.entries(config.services)){
  const node=containers.find(c=>c.Config.Labels['com.docker.compose.service']===`${service}-test-db`);
  if(!node||node.Config.Labels['com.docker.compose.project']!==config.project||!node.State.Running)throw new Error('Test container identity mismatch');
  const mounts=node.Mounts.filter(m=>m.Destination==='/var/lib/postgresql/data');
  if(mounts.length!==1||mounts[0].Type!=='volume'||mounts[0].Name!==`${config.project}_${service}-test-data`)throw new Error('Test volume identity mismatch');
  const bindings=node.NetworkSettings.Ports['5432/tcp'];
  if(!bindings?.some(b=>b.HostIp===spec.host&&b.HostPort===String(spec.port)))throw new Error('Test port identity mismatch');
 }
 if(catalogSearch){
  const id=compose(config,['ps','-q','catalog-test-es']).trim();if(!id)throw new Error('Catalog test Elasticsearch unavailable');
  const node=JSON.parse(execFileSync('docker',['inspect',id],{encoding:'utf8',stdio:['pipe','pipe','pipe']}))[0];
  if(node.Config.Labels['com.docker.compose.project']!==config.project||node.Config.Labels['com.docker.compose.service']!=='catalog-test-es'||!node.State.Running||!node.Mounts.some(m=>m.Type==='volume'&&m.Name===`${config.project}_catalog-test-es-data`)||!node.NetworkSettings.Ports['9200/tcp']?.some(b=>b.HostIp==='127.0.0.1'&&b.HostPort==='59200'))throw new Error('Catalog search isolation mismatch');
 }
}
async function connect(spec,which='admin',database=spec.database){const client=new Client({host:spec.host,port:spec.port,database,...spec[which],connectionTimeoutMillis:5000});await client.connect();return client;}
function grantSql(service){const text=fs.readFileSync(path.join(__dirname,'test-support/test-grants.sql'),'utf8');const pieces=text.split(/^-- service:/m).slice(1);const entry=pieces.find(p=>p.startsWith(`${service}\n`));if(!entry)throw new Error('Missing service grants');return entry.slice(entry.indexOf('\n')+1);}
async function applyTestGrants(client,service,spec){
 await client.query('BEGIN');try{
  // A fresh restricted role has no ownership or inherited memberships. Do not widen existing roles.
  await client.query(`REVOKE ALL ON SCHEMA public FROM PUBLIC`);
  await client.query(`REVOKE ALL ON DATABASE "${spec.database}" FROM PUBLIC`);
  await client.query(`GRANT CONNECT ON DATABASE "${spec.database}" TO "${spec.role}"`);
  await client.query(`GRANT USAGE ON SCHEMA public TO "${spec.role}"`);
  await client.query(grantSql(service));await client.query('COMMIT');
 }catch(error){await client.query('ROLLBACK');throw error;}
}
async function provisionService(service,spec){
 const control=await connect(spec,'admin','postgres');let databaseClient;
 try{
  await control.query('SELECT pg_advisory_lock(210022,1)');
  const roles=(await control.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=$1',[spec.role])).rows;
  if(!roles.length){const sql=(await control.query('SELECT format(\'CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS\',$1::text,$2::text) AS sql',[spec.role,spec.application.password])).rows[0].sql;await control.query(sql);}
  else if(Object.values(roles[0]).some(Boolean))throw new Error('Existing application role has elevated privileges');
  const memberships=await control.query('SELECT 1 FROM pg_auth_members WHERE member=(SELECT oid FROM pg_roles WHERE rolname=$1)',[spec.role]);if(memberships.rowCount)throw new Error('Unexpected application role memberships');
  const existing=(await control.query('SELECT oid FROM pg_database WHERE datname=$1',[spec.database])).rows;
  if(!existing.length)await control.query(`CREATE DATABASE "${spec.database}" OWNER phase21_admin TEMPLATE template0`);
  databaseClient=await connect(spec);
  if(!existing.length){
   await databaseClient.query('BEGIN');try{
    await databaseClient.query(`CREATE TABLE public.phase21_test_provenance(singleton BOOLEAN PRIMARY KEY CHECK(singleton),service TEXT NOT NULL,database_oid OID NOT NULL,token TEXT NOT NULL,origin TEXT NOT NULL CHECK(origin='created-empty-test'))`);
    await databaseClient.query('INSERT INTO public.phase21_test_provenance VALUES(TRUE,$1,(SELECT oid FROM pg_database WHERE datname=current_database()),$2,$3)',[service,crypto.randomBytes(32).toString('hex'),'created-empty-test']);
    await databaseClient.query('REVOKE ALL ON public.phase21_test_provenance FROM PUBLIC');await databaseClient.query('COMMIT');
   }catch(error){await databaseClient.query('ROLLBACK');throw error;}
  }
  const marker=(await databaseClient.query("SELECT to_regclass('public.phase21_test_provenance') AS name")).rows[0].name;if(!marker)throw new Error('Existing database lacks fresh-test provenance; refusing adoption');
  const token=(await databaseClient.query('SELECT token FROM public.phase21_test_provenance WHERE singleton=TRUE')).rows[0]?.token;
  const result=await migrateTestDatabase(databaseClient,{service,database:spec.database,provenanceToken:token});
  await applyTestGrants(databaseClient,service,spec);
  const app=await connect(spec,'application');try{const identity=(await app.query('SELECT current_user,current_database()')).rows[0];if(identity.current_user!==spec.role||identity.current_database!==spec.database)throw new Error('Restricted connection identity mismatch');}finally{await app.end();}
  return result;
 }finally{if(databaseClient)await databaseClient.end();await control.end();}
}
async function provision({start=false}={}){
 const config=loadTestConfig({initialize:start});if(start)compose(config,['up','-d','--wait','--wait-timeout','90']);verifyStack(config);
 const results=[];for(const [service,spec]of Object.entries(config.services))results.push(await provisionService(service,spec));return results;
}
if(require.main===module)provision({start:process.argv.includes('--start')}).then(results=>console.log(JSON.stringify({isolated:true,results}))).catch(error=>{console.error('Isolated provisioning failed:',error.code||'validation-or-runtime-error');process.exitCode=1;});
module.exports={provision,verifyStack,connect,applyTestGrants};
