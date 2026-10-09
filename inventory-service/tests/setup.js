const testConfig=require('../../scripts/phase2/test-support/test-config');
Object.assign(process.env,testConfig.applicationEnvironment('inventory'),{TEST_SERVICE:'inventory'});
jest.mock('dotenv',()=>({config:jest.fn(()=>({parsed:{}}))}));

const actualDb=jest.requireActual('../src/db');
testConfig.guardApplicationPool('inventory',actualDb);
