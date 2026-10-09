// Explicitly authorized local credential repair; never prints credentials.
const fs=require('fs');const crypto=require('crypto');const {execFileSync}=require('child_process');
const dotenv=require('../../inventory-service/node_modules/dotenv');
const file='.env';const contents=fs.readFileSync(file,'utf8');const config=dotenv.parse(contents);
if(!config.INVENTORY_RABBITMQ_URL)throw new Error('Missing Inventory URL');
const endpoint=new URL(config.INVENTORY_RABBITMQ_URL);
if(decodeURIComponent(endpoint.username)!=='inventory_app'||endpoint.hostname!=='rabbitmq')throw new Error('Unexpected Inventory endpoint');
const password=crypto.randomBytes(48).toString('base64url');endpoint.password=encodeURIComponent(password);
const updated=contents.replace(/^INVENTORY_RABBITMQ_URL=.*$/m,`INVENTORY_RABBITMQ_URL=${endpoint.toString()}`);
const temporary=`${file}.phase2-tmp`;fs.writeFileSync(temporary,updated,{mode:0o600});
try {
 execFileSync('docker',['exec','rabbitmq','rabbitmqctl','change_password','inventory_app',password],{stdio:'pipe'});
 fs.renameSync(temporary,file);console.log('Existing inventory_app password and local Inventory URL updated; credentials omitted.');
}catch {if(fs.existsSync(temporary))fs.unlinkSync(temporary);throw new Error('Credential repair failed; details suppressed');}
