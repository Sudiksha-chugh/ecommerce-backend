const {execFileSync}=require('child_process');const fs=require('fs');
execFileSync('docker',['exec','-i','inventory-db','psql','-v','ON_ERROR_STOP=1','-U','inventory_user','-d','inventory_phase2_test'],{input:fs.readFileSync('inventory-service/migrations/001_command_dedup.sql'),stdio:['pipe','pipe','pipe']});console.log('Inventory test migration applied');
