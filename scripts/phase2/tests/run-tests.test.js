const {test}=require('node:test');const assert=require('node:assert/strict');const {exitCode}=require('../run-tests');
test('zero and nonzero child exits propagate',()=>{assert.equal(exitCode({status:0}),0);assert.equal(exitCode({status:2}),2);});
test('spawn failures never report success',()=>{assert.equal(exitCode({status:null,error:{code:'ENOENT'}}),1);});
test('signals and absent statuses fail',()=>{assert.equal(exitCode({status:null,signal:'SIGTERM'}),143);assert.equal(exitCode({status:null}),1);});
