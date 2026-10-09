jest.mock('dotenv',()=>({config:jest.fn()}));
test.each([undefined,'payments_db','payments_phase2_test'])('rejects absent, development, or same-as-runtime test database %s',name=>{
 const previous={NODE_ENV:process.env.NODE_ENV,DB_NAME:process.env.DB_NAME,DB_NAME_TEST:process.env.DB_NAME_TEST};
 process.env.NODE_ENV='test';process.env.DB_NAME='payments_phase2_test';if(name===undefined)delete process.env.DB_NAME_TEST;else process.env.DB_NAME_TEST=name;
 try{jest.isolateModules(()=>{expect(()=>require('../src/db')).toThrow('isolated DB_NAME_TEST');});}
 finally{for(const [key,value]of Object.entries(previous)){if(value===undefined)delete process.env[key];else process.env[key]=value;}}
});
