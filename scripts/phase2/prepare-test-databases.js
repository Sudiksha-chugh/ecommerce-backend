// Copies schema only, never data; never drops or clears an existing database.
const {execFileSync}=require('child_process');const fs=require('fs');
for(const name of ['orders','inventory','payments']){
 const container=`${name}-db`;const user=name==='inventory'?'inventory_user':'postgres';const database=`${name}_phase2_test`;
 const invoke=(args,input)=>execFileSync('docker',['exec',...(input?['-i']:[]),container,...args],{input,encoding:'utf8',stdio:['pipe','pipe','pipe']});
 const exists=invoke(['psql','-U',user,'-d',`${name}_db`,'-tAc',`SELECT 1 FROM pg_database WHERE datname='${database}'`]).trim();
 if(exists)throw new Error(`${database} already exists; refusing to replace it`);
 invoke(['createdb','-U',user,database]);
 const schema=invoke(['pg_dump','-U',user,'-d',`${name}_db`,'--schema-only','--no-owner','--no-privileges']);
 invoke(['psql','-v','ON_ERROR_STOP=1','-U',user,'-d',database],schema);
 const migration=name==='inventory'?'inventory-service/migrations/001_command_dedup.sql':name==='orders'?'orders-service/migrations/002_saga_compensation.sql':name==='payments'?'payments-service/migrations/001_inbox.sql':null;
 if(migration)invoke(['psql','-v','ON_ERROR_STOP=1','-U',user,'-d',database],fs.readFileSync(migration,'utf8'));
 console.log(`${database}: isolated schema prepared, no runtime data copied`);
}
