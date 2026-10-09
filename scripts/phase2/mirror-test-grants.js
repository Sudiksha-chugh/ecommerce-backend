const {execFileSync}=require('child_process');
for(const service of ['orders','payments']){
 const role=`${service}_app`;
 const args=['exec',`${service}-db`,'psql','-U','postgres','-d',`${service}_db`,'-tAc'];
 const sql=execFileSync('docker',[...args,`SELECT format('GRANT %s ON TABLE %I TO %I;',string_agg(privilege_type,','),table_name,grantee) FROM information_schema.role_table_grants WHERE grantee='${role}' AND table_schema='public' GROUP BY table_name,grantee;`],{encoding:'utf8'});
 const sequences=execFileSync('docker',[...args,`SELECT format('GRANT USAGE, SELECT ON SEQUENCE %I TO ${role};',sequencename) FROM pg_sequences WHERE schemaname='public' AND has_sequence_privilege('${role}',sequencename,'USAGE');`],{encoding:'utf8'});
 execFileSync('docker',['exec','-i',`${service}-db`,'psql','-v','ON_ERROR_STOP=1','-U','postgres','-d',`${service}_phase2_test`],{input:`BEGIN;${sql}${sequences}COMMIT;`,stdio:['pipe','pipe','pipe']});
 console.log(`${service}: production table and sequence grants mirrored to isolated test database`);
}
