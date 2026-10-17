import {DurableObject} from 'cloudflare:workers';
import qrcode from 'qrcode-generator';
import {RoomCore,UserError,csv} from './core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>crypto.randomUUID().replaceAll('-','');
async function body(request){const s=await request.text();if(s.length>65536)throw new UserError('資料過大',413);try{return JSON.parse(s)}catch{throw new UserError('資料格式不正確')}}
function secure(response,url){if(response.status===101)return response;const r=new Response(response.body,response);r.headers.set('X-Content-Type-Options','nosniff');r.headers.set('Referrer-Policy','no-referrer');r.headers.set('X-Frame-Options','DENY');r.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' "+url.origin.replace('https:','wss:').replace('http:','ws:')+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");return r}
export default{async fetch(request,env){const url=new URL(request.url);try{
 if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)throw new UserError('請從本活動頁面操作',403);
 if(url.pathname==='/api/new'&&request.method==='POST'){
  if(!env.SETUP_KEY||env.SETUP_KEY.length<24)throw new UserError('尚未設定活動管理碼，請依架設說明完成設定',503);
  if(await digest(request.headers.get('Authorization')||'')!==await digest('Bearer '+env.SETUP_KEY))throw new UserError('活動管理碼不正確',403);
  const room=token().slice(0,24),adminKey=token(),stub=env.ROOMS.get(env.ROOMS.idFromName(room));
  await stub.initialize(await digest(adminKey));
  return secure(json({room,host:url.origin+'/r/'+room+'/host#key='+adminKey,join:url.origin+'/r/'+room+'/join?room='+room,screen:url.origin+'/r/'+room+'/screen'}),url);
 }
 const match=url.pathname.match(/^\/r\/([a-z0-9]{12,40})(\/.*)?$/);
 if(match){const path=match[2]||'/host';if(path.startsWith('/api/')||path==='/qr.png'||path==='/ws'){const stub=env.ROOMS.get(env.ROOMS.idFromName(match[1]));return secure(await stub.fetch(request),url)}
  if(path==='/lite')return secure(await env.ASSETS.fetch(new Request(url.origin+'/legacy',request)),url);
  if(['/host','/join','/screen'].includes(path))return secure(await env.ASSETS.fetch(new Request(url.origin+'/',request)),url);
  return json({error:'找不到頁面'},404);
 }
 if(url.pathname==='/'||url.pathname==='/create')return secure(await env.ASSETS.fetch(new Request(url.origin+'/create',request)),url);
 return secure(await env.ASSETS.fetch(request),url);
 }catch(e){return secure(json({error:e instanceof UserError?e.message:'伺服器暫時無法完成操作，請稍後再試'},e.status||500),url)}}};
export class WordCloudRoom extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.core=new RoomCore(ctx.storage.sql,fn=>ctx.storage.transactionSync(fn));this.rates=new Map()}
 async initialize(adminHash){this.core.create(adminHash);return true}
 broadcast(){const message=JSON.stringify(this.core.state());for(const ws of this.ctx.getWebSockets()){try{ws.send(message)}catch{try{ws.close(1011,'重新連線')}catch{}}}}
 async fetch(request){const url=new URL(request.url),match=url.pathname.match(/^\/r\/([a-z0-9]{12,40})(.*)$/),room=match?.[1],path=match?.[2]||'/';let newCookie=false;let voter=(request.headers.get('Cookie')||'').match(/(?:^|;\s*)junba_wordcloud_voter=([a-f0-9]{32})(?:;|$)/)?.[1];if(!voter){voter=token();newCookie=true}
 const reply=r=>{if(newCookie)r.headers.append('Set-Cookie','junba_wordcloud_voter='+voter+'; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict'+(url.protocol==='https:'?'; Secure':''));return r};
 try{
  const meta=this.core.meta();if(!meta)throw new UserError('活動不存在，請確認 QR Code',404);
  if(path.startsWith('/api/admin/')){const key=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');if(await digest(key)!==meta.adminHash)throw new UserError('主持台憑證無效',403)}
  const join=url.origin+'/r/'+room+'/join?room='+room;
  if(path==='/api/state'&&request.method==='GET')return reply(json(this.core.state(voter)));
  if(path==='/api/join'&&request.method==='GET')return reply(json({join}));
  if(path==='/api/admin/config')return reply(json({links:[join],join,dataPath:'活動雲端儲存',version:'1.1.0',online:true,questions:meta.questions}));
  if(path==='/qr.png'){const qr=qrcode(0,'M');qr.addData(join);qr.make();return new Response(qr.createSvgTag({scalable:true,margin:4}),{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}})}
  if(path==='/ws'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
   if(this.ctx.getWebSockets().length>=256)throw new UserError('連線較多，將切換定時更新',503);
   const pair=new WebSocketPair(),[client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);server.send(JSON.stringify(this.core.state()));return new Response(null,{status:101,webSocket:client});
  }
  if(path==='/api/admin/export'){return new Response(csv(this.core.state()),{headers:{'Content-Type':'text/csv; charset=utf-8','Content-Disposition':'attachment; filename="Junba_WordCloud.csv"'}})}
  if(path==='/api/admin/backup'){const state=this.core.state(),votes={};for(const row of this.ctx.storage.sql.exec('SELECT voter,text FROM votes').toArray())(votes[row.voter]??=[]).push(row.text);return reply(new Response(JSON.stringify({...state,votes,questions:meta.questions},null,2),{headers:{'Content-Type':'application/json','Content-Disposition':'attachment; filename="Junba_WordCloud_backup.json"'}}))}
  if(request.method==='POST'){
   const input=await body(request);
   if(path==='/api/submit'||path==='/api/like'){
    if(input.room!==room)throw new UserError('活動連結不正確，請重新掃碼',403);
    const now=Date.now(),recent=(this.rates.get(voter)||[]).filter(t=>now-t<10000);if(recent.length>=10)throw new UserError('送出太快囉，請稍等 10 秒',429);this.rates.set(voter,[...recent,now]);if(this.rates.size>5000)for(const [k,v]of this.rates)if(now-v[v.length-1]>10000)this.rates.delete(k);
    if(path==='/api/submit')this.core.submit(input);else this.core.like(input,voter);
   }else if(path==='/api/admin/action')this.core.action(input);else throw new UserError('不支援的操作',404);
   this.broadcast();return reply(json({ok:true,liked:this.core.liked(voter)}));
  }
  throw new UserError('找不到功能',404);
 }catch(e){return reply(json({error:e instanceof UserError?e.message:'暫時無法儲存，請稍後再試'},e.status||500))}}
 webSocketMessage(ws,message){if(message==='ping')ws.send('pong')}
 webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch{}}
 webSocketError(ws){try{ws.close(1011,'重新連線')}catch{}}
}
