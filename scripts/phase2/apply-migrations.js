// Execute only as part of the approved local rollout; tracks only new migrations.
const fs=require('fs');const {execFileSync}=require('child_process');
for(const [service,filename] of [['orders','002_saga_compensation.sql'],['inventory','001_command_dedup.sql'],['payments','001_inbox.sql']]){
 const user=service==='inventory'?'inventory_user':'postgres';
 const sql=`BEGIN;
 CREATE TABLE IF NOT EXISTS schema_migrations(filename VARCHAR(255) PRIMARY KEY,applied_at TIMESTAMP DEFAULT NOW());
 SELECT EXISTS(SELECT 1 FROM schema_migrations WHERE filename='${filename}') AS already_applied \\gset
 \\if :already_applied
 \\echo Migration already applied
 \\else
 ${fs.readFileSync(`${service}-service/migrations/${filename}`,'utf8')}
 INSERT INTO schema_migrations(filename) VALUES('${filename}');
 \\endif
 COMMIT;`;
 execFileSync('docker',['exec','-i',`${service}-db`,'psql','-v','ON_ERROR_STOP=1','-U',user,'-d',`${service}_db`],{input:sql,stdio:['pipe','pipe','pipe']});
 console.log(`${service}: ${filename} applied or already present`);
}
