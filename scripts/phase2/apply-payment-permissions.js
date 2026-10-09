const fs=require('fs');const {execFileSync}=require('child_process');
const database=process.argv.includes('--test')?'payments_phase2_test':'payments_db';
const filename='002_operation_update_permissions.sql';
const sql=`BEGIN;
CREATE TABLE IF NOT EXISTS schema_migrations(filename VARCHAR(255) PRIMARY KEY,applied_at TIMESTAMP DEFAULT NOW());
DO $migration$ BEGIN
 IF NOT EXISTS (SELECT 1 FROM schema_migrations WHERE filename='${filename}') THEN
 ${fs.readFileSync(`payments-service/migrations/${filename}`,'utf8')}
 INSERT INTO schema_migrations(filename) VALUES('${filename}');
 END IF;
END $migration$;
COMMIT;`;
execFileSync('docker',['exec','-i','payments-db','psql','-v','ON_ERROR_STOP=1','-U','postgres','-d',database],{input:sql,stdio:['pipe','pipe','pipe']});
console.log(`${database}: tracked column-level upsert permission migration applied`);
