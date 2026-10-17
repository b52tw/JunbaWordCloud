import {Miniflare} from 'miniflare';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {resolve} from 'node:path';
import qrcode from 'qrcode-generator';

const origin='https://wordcloud.test',secret='short-link-runtime-test-key-123456789';
const html=await readFile(resolve('web/index.html'),'utf8');
const options={modules:true,scriptPath:resolve('.bundle/worker.js'),compatibilityDate:'2025-10-01',durableObjects:{ROOMS:{className:'WordCloudRoom',useSQLite:true}},bindings:{SETUP_KEY:secret},serviceBindings:{ASSETS:()=>new Response(html,{headers:{'Content-Type':'text/html'}})}};
const mf=new Miniflare(options);
try{
 assert.equal((await mf.dispatchFetch(origin+'/join')).status,404);
 const created=await mf.dispatchFetch(origin+'/api/new',{method:'POST',headers:{Authorization:'Bearer '+secret}});
 assert.equal(created.status,200);const links=await created.json(),base=origin+'/r/'+links.room,key=links.host.split('#key=')[1];
 await mf.setOptions({...options,bindings:{SETUP_KEY:secret,PUBLIC_JOIN_ROOM:links.room}});
 for(const path of ['/join','/join/']){
  const entry=await mf.dispatchFetch(origin+path);assert.equal(entry.status,200);assert.equal(entry.headers.get('Location'),null);assert.match(entry.headers.get('Cache-Control'),/no-store/);
  const page=await entry.text();assert(page.includes('<meta name="junba-room" content="'+links.room+'">'));assert(!page.includes(key));assert(!page.includes(secret));
 }
 const head=await mf.dispatchFetch(origin+'/join',{method:'HEAD'});assert.equal(head.status,200);assert.equal(await head.text(),'');
 assert.equal((await mf.dispatchFetch(origin+'/join',{method:'POST'})).status,405);
 const invitation=await(await mf.dispatchFetch(base+'/api/join')).json();assert.equal(invitation.shortJoin,origin+'/join');assert.equal(invitation.join,links.join);
 assert.equal(new URL(invitation.join).searchParams.get('room'),links.room,'existing participant pages must still recognize the long link');
 const config=await(await mf.dispatchFetch(base+'/api/admin/config',{headers:{Authorization:'Bearer '+key}})).json();assert.equal(config.shortJoin,origin+'/join');
 assert.equal((await mf.dispatchFetch(base+'/api/admin/config')).status,403);
 const qr=qrcode(0,'M');qr.addData(origin+'/join');qr.make();
 assert.equal(await(await mf.dispatchFetch(base+'/qr.png')).text(),qr.createSvgTag({scalable:true,margin:4}));
 let state=await(await mf.dispatchFetch(base+'/api/state')).json();
 for(const path of ['/api/submit','/api/like']){
  const posted=await mf.dispatchFetch(base+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({room:links.room,round:state.round,text:'固定入口'})});assert.equal(posted.status,200);
 }
 state=await(await mf.dispatchFetch(base+'/api/state')).json();assert.equal(state.responses,1);assert.equal(state.likesTotal,1);
 for(const action of [{action:'settings',question:'更換題目後固定網址仍然有效',theme:state.theme},{action:'clear'}]){
  const changed=await mf.dispatchFetch(base+'/api/admin/action',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify(action)});assert.equal(changed.status,200);
  assert.equal((await(await mf.dispatchFetch(base+'/api/join')).json()).shortJoin,origin+'/join');
 }
 const other=await(await mf.dispatchFetch(origin+'/api/new',{method:'POST',headers:{Authorization:'Bearer '+secret}})).json();
 assert.equal((await(await mf.dispatchFetch(origin+'/r/'+other.room+'/api/join')).json()).shortJoin,undefined,'new activities must not take over a previously shared fixed link');
 assert((await(await mf.dispatchFetch(origin+'/join')).text()).includes('content="'+links.room+'"'));
 console.log('PASS: fixed entry, QR, old links, submission, like, host access, topic/reset and separate activities');
}finally{await mf.dispose()}
