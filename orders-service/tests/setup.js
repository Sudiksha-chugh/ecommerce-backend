const testConfig=require('../../scripts/phase2/test-support/test-config');
Object.assign(process.env,testConfig.applicationEnvironment('orders'),{TEST_SERVICE:'orders'});
jest.mock('dotenv',()=>({config:jest.fn(()=>({parsed:{}}))}));
process.env.JWT_CURRENT_SECRET =
  'test-current-secret-32-characters-long';
process.env.JWT_PREVIOUS_SECRET =
  'test-previous-secret-32-characters-long';


const actualDb=jest.requireActual('../src/db');
testConfig.guardApplicationPool('orders',actualDb);
