import {Miniflare} from 'miniflare';import assert from 'node:assert/strict';import {resolve}from'node:path';
const mf=new Miniflare({modules:true,scriptPath:resolve('.bundle/worker.js'),compatibilityDate:'2025-10-01',durableObjects:{ROOMS:{className:'WordCloudRoom',useSQLite:true}},bindings:{SETUP_KEY:'local-test-setup-key-keep-private-123456789'},serviceBindings:{ASSETS:()=>new Response('asset stub')}});
let sockets=[];let packets=0;
try{
 const make=await mf.dispatchFetch('https://wordcloud.test/api/new',{method:'POST',headers:{Authorization:'Bearer local-test-setup-key-keep-private-123456789'}});const links=await make.json();assert.equal(make.status,200,JSON.stringify(links));const room=links.room,base='https://wordcloud.test/r/'+room,key=links.host.split('#key=')[1];
 const first=await(await mf.dispatchFetch(base+'/api/state')).json();assert(!('adminHash'in first));
 sockets=await Promise.all(Array.from({length:200},async()=>{const r=await mf.dispatchFetch(base+'/ws',{headers:{Upgrade:'websocket'}});assert.equal(r.status,101);const s=r.webSocket;s.addEventListener('message',e=>{packets++;try{s.latest=JSON.parse(e.data)}catch{}});s.accept();return s}));
 console.log('200 WebSocket connections accepted');
 const post=async(path,body,i)=>{const r=await mf.dispatchFetch(base+path,{method:'POST',headers:{'Content-Type':'application/json',Cookie:'junba_wordcloud_voter='+i.toString(16).padStart(32,'0')},body:JSON.stringify(body)});const v=await r.json();assert.equal(r.status,200,JSON.stringify(v));return v};
 await Promise.all(Array.from({length:200},(_,i)=>post('/api/submit',{room,round:first.round,text:'勇氣'},i)));
 await Promise.all(Array.from({length:200},(_,i)=>post('/api/like',{room,round:first.round,text:'勇氣'},i)));
 const result=await(await mf.dispatchFetch(base+'/api/state')).json();assert.equal(result.responses,200);assert.equal(result.likesTotal,200);assert.equal(result.words[0].count+result.words[0].likes,400);
 for(let i=0;i<40&&!sockets.every(s=>s.latest?.likesTotal===200);i++)await new Promise(r=>setTimeout(r,100));assert(sockets.every(s=>s.latest?.responses===200&&s.latest?.likesTotal===200),'not all clients received final state');
 const duplicate=await mf.dispatchFetch(base+'/api/like',{method:'POST',headers:{'Content-Type':'application/json',Cookie:'junba_wordcloud_voter='+'0'.repeat(32)},body:JSON.stringify({room,round:first.round,text:'勇氣'})});assert.equal(duplicate.status,409);
 const unauthorized=await mf.dispatchFetch(base+'/api/admin/action',{method:'POST',body:JSON.stringify({action:'clear'})});assert.equal(unauthorized.status,403);
 const clear=await mf.dispatchFetch(base+'/api/admin/action',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({action:'clear'})});assert.equal(clear.status,200);const clean=await(await mf.dispatchFetch(base+'/api/state')).json();assert.equal(clean.responses,0);assert.equal(clean.likesTotal,0);assert.equal(clean.words.length,0);
 console.log('200 submissions + 200 likes broadcast to all clients; duplicate, access and clear checks passed; packets:',packets);
 const qr=await mf.dispatchFetch(base+'/qr.png');assert.equal(qr.status,200);assert((await qr.text()).includes('<svg'));console.log('Online QR SVG generation passed');
}finally{for(const s of sockets)try{s.close()}catch{}await mf.dispose()}
