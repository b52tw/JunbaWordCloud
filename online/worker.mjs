import {DurableObject} from 'cloudflare:workers';
import qrcode from 'qrcode-generator';
import {RoomCore,UserError,csv} from './core.mjs';
const json=(v,status=200)=>new Response(JSON.stringify(v),{status,headers:{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'}});
const digest=async s=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(s)))].map(b=>b.toString(16).padStart(2,'0')).join('');
const token=()=>crypto.randomUUID().replaceAll('-','');
const createFailures=new Map();
function createRateLimited(request){
 const ip=request.headers.get('CF-Connecting-IP')||'unknown',now=Date.now(),entry=createFailures.get(ip);
 if(!entry||now-entry.started>10*60*1000){createFailures.set(ip,{started:now,count:0});return false}
 return entry.count>=5;
}
function recordCreateFailure(request){
 const ip=request.headers.get('CF-Connecting-IP')||'unknown',now=Date.now(),entry=createFailures.get(ip);
 if(!entry||now-entry.started>10*60*1000)createFailures.set(ip,{started:now,count:1});
 else entry.count++;
 if(createFailures.size>5000)for(const [key,value] of createFailures)if(now-value.started>10*60*1000)createFailures.delete(key);
}
const publicJoinRoom=env=>/^[a-z0-9]{12,40}$/.test(env.PUBLIC_JOIN_ROOM||'')?env.PUBLIC_JOIN_ROOM:'';
function qrResponse(text){const qr=qrcode(0,'M');qr.addData(text);qr.make();return new Response(qr.createSvgTag({scalable:true,margin:4}),{headers:{'Content-Type':'image/svg+xml','Cache-Control':'no-store'}})}
function setupProblem(env){
 if(typeof env.ACTIVITY_CODE!=='string'||!/^\d{4}$/.test(env.ACTIVITY_CODE))return {code:'ACTIVITY_CODE_MISSING',error:'測試環境尚未設定 4 位數活動管理碼。請在 GitHub staging 環境新增 STAGING_ACTIVITY_CODE（4 位數字），再重新部署。'};
 return null;
}
async function body(request){const s=await request.text();if(s.length>65536)throw new UserError('資料過大',413);try{return JSON.parse(s)}catch{throw new UserError('資料格式不正確')}}
function secure(response,url){if(response.status===101)return response;const r=new Response(response.body,response);r.headers.set('X-Content-Type-Options','nosniff');r.headers.set('Referrer-Policy','no-referrer');r.headers.set('X-Frame-Options','DENY');r.headers.set('Content-Security-Policy',"default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self'; connect-src 'self' "+url.origin.replace('https:','wss:').replace('http:','ws:')+"; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");return r}
export default{async fetch(request,env){const url=new URL(request.url);try{
 if(request.method==='POST'&&request.headers.get('Origin')&&request.headers.get('Origin')!==url.origin)throw new UserError('請從本活動頁面操作',403);
 if(/^\/(join|host)\/?$/.test(url.pathname)){
  if(!['GET','HEAD'].includes(request.method))throw new UserError('不支援的操作',405);
  const room=publicJoinRoom(env);if(!room)throw new UserError('尚未設定固定參加入口，請使用主持台提供的 QR Code。',404);
  const asset=await env.ASSETS.fetch(new Request(url.origin+'/',request));if(!asset.ok)return secure(asset,url);
  const headers=new Headers(asset.headers);headers.delete('Content-Length');headers.set('Content-Type','text/html; charset=utf-8');headers.set('Cache-Control','no-store');
  const html=request.method==='HEAD'?null:(await asset.text()).replace('<head>','<head><meta name="junba-room" content="'+room+'">');
  return secure(new Response(html,{status:asset.status,headers}),url);
 }
 if(url.pathname==='/api/setup-status'&&request.method==='GET'){
  const problem=setupProblem(env);
  return secure(json(problem?{ready:false,...problem}:{ready:true}),url);
 }
 if(url.pathname==='/api/new'&&request.method==='POST'){
  const problem=setupProblem(env);if(problem)return secure(json(problem,503),url);
  if(createRateLimited(request))throw new UserError('嘗試次數過多，請 10 分鐘後再試。',429);
  if(await digest(request.headers.get('Authorization')||'')!==await digest('Bearer '+env.ACTIVITY_CODE)){recordCreateFailure(request);throw new UserError('活動管理碼不正確',403)}
  createFailures.delete(request.headers.get('CF-Connecting-IP')||'unknown');
  const room=token().slice(0,24),adminKey=token(),stub=env.ROOMS.get(env.ROOMS.idFromName(room));
  await stub.initialize(await digest(adminKey));
  return secure(json({room,host:url.origin+'/r/'+room+'/host#key='+adminKey,join:url.origin+'/r/'+room+'/join?room='+room,screen:url.origin+'/r/'+room+'/screen'}),url);
 }
 const shortMatch=url.pathname.match(/^\/(p|h|s)\/([a-z0-9]{12,40})\/?$/);if(shortMatch&&['GET','HEAD'].includes(request.method)){const room=shortMatch[2],target=shortMatch[1]==='p'?'/r/'+room+'/join?room='+room:shortMatch[1]==='h'?'/r/'+room+'/host':'/r/'+room+'/screen';return secure(new Response(null,{status:302,headers:{Location:url.origin+target,'Cache-Control':'no-store'}}),url)}
 const match=url.pathname.match(/^\/r\/([a-z0-9]{12,40})(\/.*)?$/);
 if(match){const path=match[2]||'/host';if(path.startsWith('/api/')||path==='/qr.png'||path==='/ws'){const stub=env.ROOMS.get(env.ROOMS.idFromName(match[1]));return secure(await stub.fetch(request),url)}
  if(path==='/lite')return secure(await env.ASSETS.fetch(new Request(url.origin+'/legacy',request)),url);
  if(['/host','/join','/screen','/history','/my-history'].includes(path))return secure(await env.ASSETS.fetch(new Request(url.origin+'/',request)),url);
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
  const join=url.origin+'/r/'+room+'/join?room='+room,shortJoin=url.origin+'/p/'+room,shortHost=url.origin+'/h/'+room;
  if(path.startsWith('/api/admin/master-bank')){if(!this.env.BANK)throw new UserError('雲端總題庫尚未連接資料庫',503);await this.env.BANK.prepare('CREATE TABLE IF NOT EXISTS master_questions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT \'未分類\', question TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id,question))').run();const owner=await digest('junba-master-bank:'+this.env.ACTIVITY_CODE);if(request.method==='GET'){const search=String(url.searchParams.get('q')||'').slice(0,100),category=String(url.searchParams.get('category')||'').slice(0,40);const result=await this.env.BANK.prepare("SELECT id,category,question,created_at AS createdAt,updated_at AS updatedAt FROM master_questions WHERE owner_id=? AND (?='' OR category=?) AND (?='' OR question LIKE '%'||?||'%') ORDER BY category,updated_at DESC LIMIT 300").bind(owner,category,category,search,search).all();return reply(json({items:result.results||[]}))}if(request.method==='POST'){const input=await body(request),question=String(input.question||'').trim().replace(/\\s+/g,' '),category=String(input.category||'未分類').trim().slice(0,40)||'未分類';if(!question||[...question].length>100)throw new UserError('題目請填 1～100 字');const now=new Date().toISOString(),id=String(input.id||token());if(input.id){await this.env.BANK.prepare('UPDATE master_questions SET category=?,question=?,updated_at=? WHERE id=? AND owner_id=?').bind(category,question,now,id,owner).run()}else{await this.env.BANK.prepare('INSERT INTO master_questions(id,owner_id,category,question,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id,owner,category,question,now,now).run()}return reply(json({ok:true,id}))}if(request.method==='DELETE'){const id=String(url.searchParams.get('id')||'');if(!id)throw new UserError('缺少題目識別碼');await this.env.BANK.prepare('DELETE FROM master_questions WHERE id=? AND owner_id=?').bind(id,owner).run();return reply(json({ok:true,deleted:true}))}}
  if(path==='/api/state'&&request.method==='GET')return reply(json(this.core.state(voter)));
  if(path==='/api/my/history'&&request.method==='GET')return reply(json(this.core.participantHistory(voter,{limit:url.searchParams.get('limit'),cursor:url.searchParams.get('cursor')||'0'})));
  const publicHistoryMatch=path.match(/^\/api\/history\/([a-f0-9-]{36})$/);
  if(publicHistoryMatch&&request.method==='GET')return reply(json(this.core.archivedDetail(publicHistoryMatch[1],voter)));
  const publicHistoryAction=path.match(/^\/api\/history\/([a-f0-9-]{36})\/(submit|like)$/);
  if(publicHistoryAction&&request.method==='POST'){const input=await body(request);const now=Date.now(),recent=(this.rates.get(voter)||[]).filter(t=>now-t<10000);if(recent.length>=10)throw new UserError('送出太快囉，請稍等 10 秒',429);this.rates.set(voter,[...recent,now]);const result=publicHistoryAction[2]==='submit'?this.core.archivedSubmit(publicHistoryAction[1],input,voter):this.core.archivedLike(publicHistoryAction[1],input,voter);return reply(json(result))}

  if(path==='/api/feedback'&&request.method==='GET')return reply(json(this.core.wordFeedback({word:url.searchParams.get('word'),historyId:url.searchParams.get('historyId')||''},voter)));
  if(path==='/api/feedback'&&request.method==='POST'){const input=await body(request);return reply(json(this.core.createWordFeedback(input,voter,input.label||'匿名')))}
  if(path==='/api/feedback/notifications'&&request.method==='GET')return reply(json(this.core.feedbackNotifications(voter,{limit:url.searchParams.get('limit')})));
  const feedbackReadMatch=path.match(/^\/api\/feedback\/notifications\/([a-f0-9-]{36})\/read$/);
  if(feedbackReadMatch&&request.method==='POST')return reply(json(this.core.markFeedbackRead(feedbackReadMatch[1],voter)));
  if(path==='/api/join'&&request.method==='GET')return reply(json({join,shortJoin,room}));
  if(path==='/api/admin/config')return reply(json({links:[join],join,shortJoin,shortHost,dataPath:'活動雲端儲存',version:'1.3.0',online:true,questions:meta.questions,theme:meta.theme,font:meta.font,style:meta.style,motion:meta.motion,networkIcon:meta.networkIcon||'ai',motionAmplitude:meta.motionAmplitude||'medium',motionSpeed:meta.motionSpeed||'normal',participantHistoryEnabled:meta.participantHistoryEnabled!==false}));
  if(path==='/api/admin/history'&&request.method==='GET')return reply(json(this.core.history({limit:url.searchParams.get('limit'),cursor:url.searchParams.get('cursor')||'0',from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||''})));
  const historyAccessMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/access$/);
  if(historyAccessMatch&&request.method==='POST'){const input=await body(request);return reply(json({ok:true,...this.core.setHistoryAccess(historyAccessMatch[1],input.mode)}))}
  const historyOpenMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/open$/);
  if(historyOpenMatch&&request.method==='POST'){const input=await body(request);return reply(json({ok:true,...this.core.setHistoryOpen(historyOpenMatch[1],!!input.open)}))}
  const historyMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})$/);
  if(historyMatch&&request.method==='GET')return reply(json(this.core.historyDetail(historyMatch[1])));
  if(historyMatch&&request.method==='DELETE')return reply(json(this.core.deleteHistory(historyMatch[1])));
  if(path==='/api/admin/history-settings'&&request.method==='POST'){const input=await body(request);return reply(json(this.core.setParticipantHistoryEnabled(!!input.enabled)))}

  if(path==='/api/admin/host-qr'&&request.method==='GET')return reply(qrResponse((shortHost||url.origin+'/r/'+room+'/host')+'#key='+(request.headers.get('Authorization')||'').replace(/^Bearer /,'')));
  if(path==='/qr.png')return qrResponse(shortJoin||join);
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
    if(path==='/api/submit')this.core.submit(input,voter);else this.core.like(input,voter);
   }else if(path==='/api/admin/action')this.core.action(input);else throw new UserError('不支援的操作',404);
   this.broadcast();return reply(json({ok:true,liked:this.core.liked(voter)}));
  }
  throw new UserError('找不到功能',404);
 }catch(e){return reply(json({error:e instanceof UserError?e.message:'暫時無法儲存，請稍後再試'},e.status||500))}}
 webSocketMessage(ws,message){if(message==='ping')ws.send('pong')}
 webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch{}}
 webSocketError(ws){try{ws.close(1011,'重新連線')}catch{}}
}
