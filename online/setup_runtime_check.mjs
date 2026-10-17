import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {resolve} from 'node:path';

const scriptPath=resolve(process.argv[2]||'.bundle/worker.js');
const cases=[
 {label:'missing setup secret',bindings:{},code:'SETUP_KEY_MISSING'},
 {label:'23-character setup secret',bindings:{SETUP_KEY:'x'.repeat(23)},code:'SETUP_KEY_TOO_SHORT'},
 {label:'24-character setup secret',bindings:{SETUP_KEY:'x'.repeat(24)},code:null}
];
for(const scenario of cases){
 const mf=new Miniflare({modules:true,scriptPath,compatibilityDate:'2025-10-01',durableObjects:{ROOMS:{className:'WordCloudRoom',useSQLite:true}},bindings:scenario.bindings,serviceBindings:{ASSETS:()=>new Response('asset stub')}});
 try{
  const status=await mf.dispatchFetch('https://wordcloud.test/api/setup-status');
  assert.equal(status.status,200);
  assert.match(status.headers.get('cache-control'),/no-store/);
  const state=await status.json();
  assert.equal(state.ready,!scenario.code);
  assert(!('SETUP_KEY' in state));
  assert(!('length' in state));
  if(scenario.code)assert.equal(state.code,scenario.code);
  const denied=await mf.dispatchFetch('https://wordcloud.test/api/new',{method:'POST'});
  assert.equal(denied.status,scenario.code?503:403);
  const deniedBody=await denied.json();
  if(scenario.code)assert.equal(deniedBody.code,scenario.code);
  if(!scenario.code){
   const created=await mf.dispatchFetch('https://wordcloud.test/api/new',{method:'POST',headers:{Authorization:'Bearer '+scenario.bindings.SETUP_KEY}});
   assert.equal(created.status,200);
   const links=await created.json();
   assert.match(links.room,/^[a-f0-9]{24}$/);
   const roomState=await mf.dispatchFetch('https://wordcloud.test/r/'+links.room+'/api/state');
   assert.equal(roomState.status,200);
   assert(!('adminHash' in await roomState.json()));
  }
  console.log('PASS:',scenario.label);
 }finally{await mf.dispose();}
}
