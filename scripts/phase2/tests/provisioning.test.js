const {test} = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {loadManifest} = require('../test-support/migration-manifest');
const {migrateTestDatabase} = require('../test-support/migration-runner');
// No network/DB imports: exercise orchestration; real PostgreSQL validation is Stage B.
function fixture(service='orders') {
  const calls = [], history = [];
  const state = {database:`${service}_stage_a_test`, service, marker:true, token:'test-provenance',
    origin:'created-empty-test', oid:'123', objects:['phase21_test_provenance'], fail:null};
  let pending;
  const client = {async query(sql, values) {
    calls.push({sql,values});
    if (sql.startsWith('SELECT current_database')) return {rows:[{database:state.database,database_oid:'123'}]};
    if (sql.includes('to_regclass')) return {rows:[{relation:state.marker?'phase21_test_provenance':null}]};
    if (sql.includes('FROM public.phase21_test_provenance')) return {rows:[{service:state.service,database_oid:state.oid,token:state.token,origin:state.origin}]};
    if (sql.includes('FROM pg_class')) return {rows:state.objects.map(name=>({name}))};
    if (sql.startsWith('SELECT filename')) return {rows:history.map(row=>({...row}))};
    if (sql.startsWith('CREATE TABLE IF NOT EXISTS public.schema_migrations')) {if(!state.objects.includes('schema_migrations'))state.objects.push('schema_migrations');}
    if (sql==='BEGIN') pending=[];
    if (state.fail && sql.includes(state.fail)) throw new Error('synthetic failure');
    if (sql.startsWith('INSERT INTO public.schema_migrations')) pending.push({filename:values[1],checksum:values[2]});
    if (sql==='COMMIT') {history.push(...pending);pending=undefined;}
    if (sql==='ROLLBACK') pending=undefined;
    return {rows:[]};
  }};
  return {client,state,calls,history,options:{service,database:state.database,provenanceToken:state.token}};
}
function applicationSql(calls) {return calls.filter(c=>/^(--|CREATE TABLE orders|CREATE TABLE inventory|ALTER TABLE)/.test(c.sql));}
for (const service of ['orders','inventory','payments','catalog']) {
  test(`${service}: manifest is ordered, canonical and checksummed`,()=>{
    const migrations=loadManifest(service);
    assert.equal(migrations[0].filename,'000_initial_schema.sql');
    assert.equal(new Set(migrations.map(m=>m.filename)).size,migrations.length);
    for(const migration of migrations)assert.match(migration.checksum,/^[a-f0-9]{64}$/);
    if(service==='payments')assert.equal(migrations.at(-1).filename,'002_operation_update_permissions.sql');
    if(service==='catalog'){assert.deepEqual(migrations.slice(1,3).map(m=>m.filename),['001_add_product_constraints.sql','001_inventory_reservations.sql']);assert.equal(migrations.at(-1).authorizedFreshTest,true);assert.equal(migrations.at(-1).requiresFreshTest,true);}
  });
  test(`${service}: first run applies manifest, second skips every migration`,async()=>{
    const f=fixture(service);const first=await migrateTestDatabase(f.client,f.options);
    assert.deepEqual(first.applied,loadManifest(service).map(m=>m.filename));
    const before=f.calls.length;const second=await migrateTestDatabase(f.client,f.options);
    assert.equal(second.applied.length,0);assert.deepEqual(second.skipped,first.applied);
    assert.equal(f.calls.slice(before).filter(c=>c.sql==='BEGIN').length,0);
    assert.equal(f.history.length,first.applied.length);
  });
}
test('rejects development-like and mismatched targets before mutations',async()=>{
  const f=fixture();await assert.rejects(migrateTestDatabase(f.client,{...f.options,database:'orders_db'}),/explicit test/);assert.equal(f.calls.length,0);
  await assert.rejects(migrateTestDatabase(f.client,{...f.options,database:'other_test'}),/differs/);assert.equal(f.calls.filter(c=>c.sql==='BEGIN').length,0);
});
test('missing token is rejected before issuing queries',async()=>{const f=fixture();await assert.rejects(migrateTestDatabase(f.client,{...f.options,provenanceToken:''}),/provenance required/);assert.equal(f.calls.length,0);});
test('Catalog destructive migration cannot run without matching fresh provenance',async()=>{
  for(const change of [{marker:false},{token:'wrong'},{origin:'adopted-existing'},{oid:'999'},{service:'orders'}]){
    const f=fixture('catalog');Object.assign(f.state,change);
    await assert.rejects(migrateTestDatabase(f.client,f.options),/provenance/);
    assert.equal(applicationSql(f.calls).length,0);assert.ok(!f.calls.some(c=>c.sql.includes('DROP TABLE')));
  }
});
test('existing untracked schemas are not adopted',async()=>{const f=fixture();f.state.objects.push('orders');await assert.rejects(migrateTestDatabase(f.client,f.options),/untracked/);assert.equal(applicationSql(f.calls).length,0);});
test('checksum mismatch is rejected before pending migrations',async()=>{
  const f=fixture();f.state.objects.push('schema_migrations');f.history.push({filename:'000_initial_schema.sql',checksum:'changed'});
  await assert.rejects(migrateTestDatabase(f.client,f.options),/checksum/);assert.equal(applicationSql(f.calls).length,0);
});
test('unknown or out-of-order history is rejected',async()=>{
  const f=fixture();f.state.objects.push('schema_migrations');f.history.push({filename:'001_order_saga.sql',checksum:loadManifest('orders')[1].checksum});
  await assert.rejects(migrateTestDatabase(f.client,f.options),/prefix/);
});
test('failed migration rolls back its tracking record, retains prior commits and unlocks',async()=>{
  const f=fixture();f.state.fail='CREATE TABLE order_sagas';
  await assert.rejects(migrateTestDatabase(f.client,f.options),/orders\/001_order_saga/);
  assert.deepEqual(f.history.map(x=>x.filename),['000_initial_schema.sql']);
  const rollback=f.calls.findIndex(c=>c.sql==='ROLLBACK');assert.ok(rollback>0);
  assert.ok(f.calls.at(-1).sql.includes('pg_advisory_unlock'));
  f.state.fail=null;const resumed=await migrateTestDatabase(f.client,f.options);
  assert.deepEqual(resumed.skipped,['000_initial_schema.sql']);assert.equal(resumed.applied.length,2);
});
test('session lock encloses validation and all transactions; tracking precedes COMMIT',async()=>{
  const f=fixture();await migrateTestDatabase(f.client,f.options);
  assert.ok(f.calls[1].sql.includes('pg_advisory_lock'));assert.ok(f.calls.at(-1).sql.includes('pg_advisory_unlock'));
  const insert=f.calls.findIndex(c=>c.sql.startsWith('INSERT INTO public.schema_migrations'));
  assert.equal(f.calls[insert+1].sql,'COMMIT');
});
test('new baselines preserve established CI schema, without role provisioning',()=>{
  const orders=loadManifest('orders')[0].sql,payments=loadManifest('payments')[0].sql;
  assert.match(orders,/orders_user_id_idempotency_key_idx/);assert.match(orders,/WHERE idempotency_key IS NOT NULL/);
  assert.match(payments,/transaction_id VARCHAR\(255\)/);assert.match(payments,/CREATE TABLE refunds/);
  for(const sql of [orders,payments])assert.doesNotMatch(sql,/CREATE ROLE|ALTER ROLE|GRANT /);
});
test('manifest covers every SQL migration without rewriting historical files',()=>{
  for(const service of ['orders','inventory','payments','catalog']){
    const directory=path.resolve(__dirname,`../../../${service}-service/migrations`);
    assert.deepEqual(loadManifest(service).map(m=>m.filename).sort(),fs.readdirSync(directory).filter(f=>f.endsWith('.sql')).sort());
  }
});

if(process.env.PHASE21_POSTGRES==='true'){
 const {loadTestConfig}=require('../test-support/test-config');
 const {provision,verifyStack,connect}=require('../prepare-test-databases');
 const config=loadTestConfig();
 test('PostgreSQL: dedicated stack identity and repeat provisioning',async()=>{
  verifyStack(config);const results=await provision();
  for(const result of results){assert.equal(result.applied.length,0);assert.equal(result.skipped.length,loadManifest(result.service).length);}
 });
 for(const service of ['orders','inventory','payments','catalog'])test(`PostgreSQL: ${service} restricted identity, SQL privileges and metadata protection`,async()=>{
  const spec=config.services[service],client=await connect(spec,'application');
  try{
   const identity=(await client.query('SELECT current_user,current_database()')).rows[0];assert.equal(identity.current_user,spec.role);assert.equal(identity.current_database,spec.database);
   const flags=(await client.query('SELECT rolsuper,rolcreatedb,rolcreaterole,rolreplication,rolbypassrls FROM pg_roles WHERE rolname=current_user')).rows[0];assert.ok(Object.values(flags).every(x=>!x));
   assert.equal((await client.query("SELECT has_schema_privilege(current_user,'public','CREATE') AS allowed")).rows[0].allowed,false);
   await assert.rejects(client.query('SELECT * FROM public.phase21_test_provenance'),e=>e.code==='42501');
   await assert.rejects(client.query('SELECT * FROM public.schema_migrations'),e=>e.code==='42501');
   const ownership=await client.query("SELECT 1 FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relowner=(SELECT oid FROM pg_roles WHERE rolname=current_user)");assert.equal(ownership.rowCount,0);
   await client.query('BEGIN');
   if(service==='orders'){
    const id=(await client.query("INSERT INTO orders(user_id,items,total_amount,idempotency_key) VALUES(900001,'[]',20,'stage-b') RETURNING id")).rows[0].id;
    await client.query("INSERT INTO order_sagas(order_id) VALUES($1)",[id]);
    await client.query("UPDATE orders SET status='cancelled' WHERE id=$1",[id]);
    await client.query("UPDATE order_sagas SET state='CANCELLED',version=version+1,updated_at=NOW(),last_error='test' WHERE order_id=$1",[id]);
    await client.query("INSERT INTO inbox_events(event_id,event_type,order_id) VALUES('stage-b','test',$1)",[id]);
    await client.query("UPDATE inbox_events SET processed_at=NOW() WHERE event_id='stage-b'");
    await client.query("INSERT INTO saga_transitions(order_id,event_id,from_state,to_state) VALUES($1,'stage-b','PENDING','CANCELLED')",[id]);
   }else if(service==='payments'){
    for(const table of ['payments','refunds']){
     const sql=`INSERT INTO ${table}(order_id,user_id,amount,status) VALUES(900001,900001,20,$1) ON CONFLICT(order_id) DO UPDATE SET status=EXCLUDED.status,updated_at=NOW() RETURNING id`;
     await client.query(sql,['failed']);await client.query(sql,[table==='payments'?'succeeded':'refunded']);
     assert.equal((await client.query(`SELECT * FROM ${table} WHERE order_id=900001`)).rowCount,1);
    }
    await client.query("INSERT INTO inbox_events(event_id,event_type,order_id) VALUES('stage-b','test',900001) ON CONFLICT DO NOTHING");
    assert.equal((await client.query("SELECT has_column_privilege(current_user,'refunds','amount','UPDATE') AS allowed")).rows[0].allowed,false);
   }else if(service==='inventory'){
    await client.query('INSERT INTO inventory(product_id,quantity) VALUES(900001,10)');
    await client.query('UPDATE inventory SET quantity=quantity-2,updated_at=NOW() WHERE product_id=900001 RETURNING *');
    await client.query("INSERT INTO reservations(order_id,product_id,quantity,expires_at) VALUES(900001,900001,2,NOW()) RETURNING *");
    await client.query("UPDATE reservations SET status='EXPIRED' WHERE order_id=900001");
    await client.query('INSERT INTO inventory_order_operations(order_id,closed) VALUES(900001,TRUE) ON CONFLICT(order_id) DO UPDATE SET closed=TRUE');
    await client.query("INSERT INTO inbox_events(event_id,order_id) VALUES('stage-b',900001) ON CONFLICT DO NOTHING");
   }else{
    const id=(await client.query("INSERT INTO products(name,description,price) VALUES('Stage B','test',20) RETURNING id")).rows[0].id;
    assert.equal((await client.query('SELECT * FROM products WHERE id=$1',[id])).rowCount,1);
    assert.equal((await client.query("SELECT to_regclass('public.inventory_reservations') AS legacy")).rows[0].legacy,null);
   }
   if(service!=='catalog'){
    await client.query("INSERT INTO outbox_events(event_type,payload) VALUES('test','{}') RETURNING id");
    await client.query("UPDATE outbox_events SET published=TRUE,published_at=NOW() WHERE event_type='test'");
   }
   await client.query('ROLLBACK');
   const table=service==='orders'?'orders':service==='inventory'?'inventory':service==='payments'?'refunds':'products';
   await assert.rejects(client.query(`TRUNCATE ${table}`),e=>e.code==='42501');
   await assert.rejects(client.query(`DELETE FROM ${table} WHERE FALSE`),e=>e.code==='42501');
   assert.equal((await client.query("SELECT has_database_privilege(current_user,current_database(),'CREATE') AS allowed")).rows[0].allowed,false);
   const sequence=service==='orders'?'saga_transitions_id_seq':service==='inventory'?'reservations_id_seq':service==='payments'?'refunds_id_seq':'products_id_seq';
   assert.equal((await client.query("SELECT has_sequence_privilege(current_user,$1,'SELECT') AS allowed",[sequence])).rows[0].allowed,false);
   await assert.rejects(client.query('CREATE TABLE public.forbidden(id INTEGER)'),e=>e.code==='42501');
   if(service==='payments')await assert.rejects(client.query('UPDATE refunds SET amount=0'),e=>e.code==='42501');
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
 });
 test('PostgreSQL: unsafe target and provenance rejection leave tracking unchanged',async()=>{
  const spec=config.services.catalog,client=await connect(spec);
  try{
   const count=(await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n;
   await assert.rejects(migrateTestDatabase(client,{service:'catalog',database:'catalog_db',provenanceToken:'wrong'}),/explicit test/);
   await assert.rejects(migrateTestDatabase(client,{service:'catalog',database:spec.database,provenanceToken:'wrong'}),/provenance mismatch/);
   assert.equal((await client.query('SELECT COUNT(*)::int AS n FROM schema_migrations')).rows[0].n,count);
   await client.query('BEGIN');await client.query("UPDATE schema_migrations SET checksum='changed' WHERE position=0");
   const token=(await client.query('SELECT token FROM phase21_test_provenance')).rows[0].token;
   await assert.rejects(migrateTestDatabase(client,{service:'catalog',database:spec.database,provenanceToken:token}),/checksum/);
   await client.query('ROLLBACK');
  }finally{await client.query('ROLLBACK').catch(()=>{});await client.end();}
 });
 test('PostgreSQL: actual transactional DDL rollback, retry and lock held through tracking insertion',async()=>{
  const spec=config.services.payments,control=await connect(spec,'admin','postgres');
  // A new retained probe database in the dedicated test instance; never replaces a database.
  const database=`payments_probe_${Date.now()}_test`;let client,observer;
  try{
   await control.query(`CREATE DATABASE "${database}" OWNER phase21_admin TEMPLATE template0`);
   client=await connect(spec,'admin',database);observer=await connect(spec,'admin',database);
   await client.query("CREATE TABLE phase21_test_provenance(singleton BOOLEAN PRIMARY KEY CHECK(singleton),service TEXT,database_oid OID,token TEXT,origin TEXT)");
   await client.query("INSERT INTO phase21_test_provenance VALUES(TRUE,'payments',(SELECT oid FROM pg_database WHERE datname=current_database()),'probe','created-empty-test')");
   const oid=Number((await client.query('SELECT oid FROM pg_database WHERE datname=current_database()')).rows[0].oid)|0;
   const realQuery=client.query.bind(client);let inject=true,checkedExecution=false,checkedTracking=false;
   client.query=async(sql,...args)=>{
    if(sql===loadManifest('payments')[0].sql||sql.startsWith('INSERT INTO public.schema_migrations')){
     const locked=(await observer.query('SELECT pg_try_advisory_lock(210021,$1) AS acquired',[oid])).rows[0].acquired;assert.equal(locked,false);
     if(sql.startsWith('INSERT')){checkedTracking=true;if(inject){inject=false;return realQuery('SELECT 1/0');}}
     else checkedExecution=true;
    }
    return realQuery(sql,...args);
   };
   await assert.rejects(migrateTestDatabase(client,{service:'payments',database,provenanceToken:'probe'}),/000_initial_schema/);
   assert.equal((await realQuery("SELECT to_regclass('public.payments') AS relation")).rows[0].relation,null);
   assert.equal((await realQuery('SELECT * FROM schema_migrations')).rowCount,0);
   assert.equal((await observer.query('SELECT pg_try_advisory_lock(210021,$1) AS acquired',[oid])).rows[0].acquired,true);
   await observer.query('SELECT pg_advisory_unlock(210021,$1)',[oid]);
   const result=await migrateTestDatabase(client,{service:'payments',database,provenanceToken:'probe'});assert.equal(result.applied.length,3);assert.ok(checkedExecution&&checkedTracking);
   const second=await migrateTestDatabase(client,{service:'payments',database,provenanceToken:'probe'});assert.equal(second.skipped.length,3);
  }finally{if(observer)await observer.end();if(client)await client.end();await control.end();}
 });
 test('PostgreSQL: concurrent migration sessions serialize with one database lock',async()=>{
  const spec=config.services.orders,first=await connect(spec),second=await connect(spec);
  try{
   const token=(await first.query('SELECT token FROM phase21_test_provenance')).rows[0].token;
   const realQuery=first.query.bind(first);let release,entered;
   const enteredPromise=new Promise(r=>{entered=r;});const gate=new Promise(r=>{release=r;});
   first.query=async(sql,...args)=>{if(sql.includes("to_regclass('public.phase21_test_provenance')")){entered();await gate;}return realQuery(sql,...args);};
   const a=migrateTestDatabase(first,{service:'orders',database:spec.database,provenanceToken:token});await enteredPromise;
   let secondComplete=false;const b=migrateTestDatabase(second,{service:'orders',database:spec.database,provenanceToken:token}).then(r=>{secondComplete=true;return r;});
   try{await new Promise(r=>setTimeout(r,150));assert.equal(secondComplete,false);}finally{release();}
   assert.equal((await a).skipped.length,3);assert.equal((await b).skipped.length,3);
  }finally{await first.end();await second.end();}
 });
}
