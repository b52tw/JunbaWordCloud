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
 if(url.pathname==='/host'||url.pathname==='/host/'){
  if(!['GET','HEAD'].includes(request.method))throw new UserError('不支援的操作',405);
  return secure(new Response(null,{status:302,headers:{Location:url.origin+'/create','Cache-Control':'no-store'}}),url);
 }
 if(url.pathname==='/join'||url.pathname==='/join/'){
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
 broadcast(){this.broadcastEvent(this.core.state())}
 broadcastEvent(payload){const message=JSON.stringify(payload);for(const ws of this.ctx.getWebSockets()){try{ws.send(message)}catch{try{ws.close(1011,'重新連線')}catch{}}}}
 async fetch(request){const url=new URL(request.url),match=url.pathname.match(/^\/r\/([a-z0-9]{12,40})(.*)$/),room=match?.[1],path=match?.[2]||'/';let newCookie=false;let voter=(request.headers.get('Cookie')||'').match(/(?:^|;\s*)junba_wordcloud_voter=([a-f0-9]{32})(?:;|$)/)?.[1];if(!voter){voter=token();newCookie=true}
 const reply=r=>{if(newCookie)r.headers.append('Set-Cookie','junba_wordcloud_voter='+voter+'; Path=/; Max-Age=31536000; HttpOnly; SameSite=Strict'+(url.protocol==='https:'?'; Secure':''));return r};
 try{
  const meta=this.core.meta();if(!meta)throw new UserError('活動不存在，請確認 QR Code',404);
  if(path.startsWith('/api/admin/')){const key=(request.headers.get('Authorization')||'').replace(/^Bearer /,'');if(await digest(key)!==meta.adminHash)throw new UserError('主持台憑證無效',403)}
  const join=url.origin+'/r/'+room+'/join?room='+room,shortJoin=url.origin+'/p/'+room,shortHost=url.origin+'/h/'+room;
   if(path.startsWith('/api/admin/master-bank')){if(!this.env.BANK)throw new UserError('雲端總題庫尚未連接資料庫',503);await this.env.BANK.prepare('CREATE TABLE IF NOT EXISTS master_questions (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, category TEXT NOT NULL DEFAULT \'未分類\', question TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id,question))').run();const owner=await digest('junba-master-bank:'+this.env.ACTIVITY_CODE);const defaults=['用一個詞，說說你對未來的想像？','想到求職，你最在意的是什麼？','今天你最想帶走的一個收穫是什麼？','你願意為未來嘗試的一件事是什麼？','理想工作最重要的條件是什麼？','你們都來自於哪裡？','[破冰] 峻爸的五真一假','如果三年後回頭看，你希望自己完成了什麼？','你希望工作帶給你收入以外的什麼？','你最想培養、但還沒開始的職場能力是什麼？','面對 AI 普及，你最想升級哪一項能力？','選工作時，你會優先考慮薪資、成長還是生活平衡？','什麼樣的主管會讓你願意長期投入？','你理想中的第一份工作是什麼樣子？','遇到不擅長的任務，你通常會怎麼開始？','你最有成就感的一次經驗是什麼？','你希望同事如何形容你的工作表現？','如果可以跨領域學習，你最想跨到哪個領域？','你如何判斷一份工作適不適合自己？','面試時，你最想讓企業看見自己的哪個優勢？','你最需要哪一種求職資源或協助？','履歷上最難呈現的是哪一項能力？','你如何看待第一份工作與職涯長期發展的關係？','遇到職涯迷惘時，你會向誰或透過什麼方式求助？','你願意為理想工作做出什麼改變？','你期待工作與個人生活如何取得平衡？','如果不受科系限制，你最想嘗試什麼職業？','你認為未來五年最值得投資的職能是什麼？','實習經驗最希望帶給你什麼收穫？','你最想改善目前求職準備的哪個環節？','你如何面對工作中的挫折與失敗？','對你而言，有意義的工作是什麼？'];const now=new Date().toISOString();for(const question of defaults)await this.env.BANK.prepare('INSERT OR IGNORE INTO master_questions(id,owner_id,category,question,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(token(),owner,'未分類',question,now,now).run();if(request.method==='GET'){const search=String(url.searchParams.get('q')||'').slice(0,100),limit=url.searchParams.get('all')==='1'?1000:300;const result=await this.env.BANK.prepare("SELECT id,question,created_at AS createdAt,updated_at AS updatedAt FROM master_questions WHERE owner_id=? AND (?='' OR question LIKE '%'||?||'%') ORDER BY updated_at DESC LIMIT ?").bind(owner,search,search,limit).all();return reply(json({items:result.results||[]}))}if(path.endsWith('/import')&&request.method==='POST'){const input=await body(request);if(!Array.isArray(input.items)||input.items.length>500)throw new UserError('匯入題目需為 1～500 題');let inserted=0,skipped=0;const now=new Date().toISOString();for(const item of input.items){const question=String(typeof item==='string'?item:item?.question||'').trim().replace(/\\s+/g,' ');if(!question||[...question].length>100)throw new UserError('每題需為 1～100 字');const exists=await this.env.BANK.prepare('SELECT id FROM master_questions WHERE owner_id=? AND question=?').bind(owner,question).first();if(exists){skipped++;continue}await this.env.BANK.prepare('INSERT INTO master_questions(id,owner_id,category,question,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(token(),owner,'未分類',question,now,now).run();inserted++}return reply(json({ok:true,inserted,skipped}))}if(request.method==='POST'){const input=await body(request),question=String(input.question||'').trim().replace(/\\s+/g,' ');if(!question||[...question].length>100)throw new UserError('題目請填 1～100 字');const now=new Date().toISOString();if(input.id){const existing=await this.env.BANK.prepare('SELECT id FROM master_questions WHERE id=? AND owner_id=?').bind(String(input.id),owner).first();if(!existing)throw new UserError('找不到要更新的雲端題目',404);const duplicate=await this.env.BANK.prepare('SELECT id FROM master_questions WHERE owner_id=? AND question=? AND id<>?').bind(owner,question,String(input.id)).first();if(duplicate){await this.env.BANK.prepare('DELETE FROM master_questions WHERE id=? AND owner_id=?').bind(String(input.id),owner).run();await this.env.BANK.prepare('UPDATE master_questions SET updated_at=? WHERE id=? AND owner_id=?').bind(now,duplicate.id,owner).run();return reply(json({ok:true,id:duplicate.id,merged:true}))}await this.env.BANK.prepare('UPDATE master_questions SET question=?,updated_at=? WHERE id=? AND owner_id=?').bind(question,now,String(input.id),owner).run();return reply(json({ok:true,id:String(input.id)}))}const existing=await this.env.BANK.prepare('SELECT id FROM master_questions WHERE owner_id=? AND question=?').bind(owner,question).first();if(existing)return reply(json({ok:true,id:existing.id,existing:true}));const id=token();await this.env.BANK.prepare('INSERT INTO master_questions(id,owner_id,category,question,created_at,updated_at) VALUES(?,?,?,?,?,?)').bind(id,owner,'未分類',question,now,now).run();return reply(json({ok:true,id}))}if(request.method==='DELETE'){const id=String(url.searchParams.get('id')||'');if(!id)throw new UserError('缺少題目識別碼');await this.env.BANK.prepare('DELETE FROM master_questions WHERE id=? AND owner_id=?').bind(id,owner).run();return reply(json({ok:true,deleted:true}))}}
  if(path==='/api/state'&&request.method==='GET')return reply(json(this.core.state(voter)));
  if(path==='/api/my/history'&&request.method==='GET')return reply(json(this.core.participantHistory(voter,{limit:url.searchParams.get('limit'),cursor:url.searchParams.get('cursor')||'0'})));
  const publicHistoryMatch=path.match(/^\/api\/history\/([a-f0-9-]{36})$/);
  if(publicHistoryMatch&&request.method==='GET')return reply(json(this.core.archivedDetail(publicHistoryMatch[1],voter)));
  const publicHistoryAction=path.match(/^\/api\/history\/([a-f0-9-]{36})\/(submit|like)$/);
  if(publicHistoryAction&&request.method==='POST'){const input=await body(request);const now=Date.now(),recent=(this.rates.get(voter)||[]).filter(t=>now-t<10000);if(recent.length>=10)throw new UserError('送出太快囉，請稍等 10 秒',429);this.rates.set(voter,[...recent,now]);const result=publicHistoryAction[2]==='submit'?this.core.archivedSubmit(publicHistoryAction[1],input,voter):this.core.archivedLike(publicHistoryAction[1],input,voter);return reply(json(result))}

  if(path==='/api/feedback'&&request.method==='GET')return reply(json(this.core.wordFeedback({word:url.searchParams.get('word'),historyId:url.searchParams.get('historyId')||''},voter)));
  if(path==='/api/feedback'&&request.method==='POST'){const input=await body(request),result=this.core.createWordFeedback(input,voter,input.label||'匿名');this.broadcastEvent({type:'feedback',word:String(input.word||'').trim(),round:result.round||''});return reply(json(result))}
  if(path==='/api/feedback/notifications'&&request.method==='GET')return reply(json(this.core.feedbackNotifications(voter,{limit:url.searchParams.get('limit')})));
  const feedbackReadMatch=path.match(/^\/api\/feedback\/notifications\/([a-f0-9-]{36})\/read$/);
  if(feedbackReadMatch&&request.method==='POST')return reply(json(this.core.markFeedbackRead(feedbackReadMatch[1],voter)));
  if(path==='/api/join'&&request.method==='GET')return reply(json({join,shortJoin,room}));
  if(path==='/api/admin/config')return reply(json({links:[join],join,shortJoin,shortHost,dataPath:'活動雲端儲存',version:'1.3.0',online:true,questions:meta.questions,theme:meta.theme,font:meta.font,style:meta.style,motion:meta.motion,networkIcon:meta.networkIcon||'ai',motionAmplitude:meta.motionAmplitude||'medium',motionSpeed:meta.motionSpeed||'normal',participantHistoryEnabled:meta.participantHistoryEnabled!==false}));
  if(path==='/api/admin/history'&&request.method==='GET')return reply(json(this.core.history({limit:url.searchParams.get('limit'),cursor:url.searchParams.get('cursor')||'0',from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||'',includeDeleted:url.searchParams.get('trash')==='1'})));
  if(path==='/api/admin/history/import'&&request.method==='POST'){const input=await body(request);return reply(json(this.core.importHistory(input)))}
  const historyAccessMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/access$/);
  if(historyAccessMatch&&request.method==='POST'){const input=await body(request);return reply(json({ok:true,...this.core.setHistoryAccess(historyAccessMatch[1],input.mode)}))}
  const historyOpenMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/open$/);
  if(historyOpenMatch&&request.method==='POST'){const input=await body(request);return reply(json({ok:true,...this.core.setHistoryOpen(historyOpenMatch[1],!!input.open)}))}
  const historyRenameMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/rename$/);
  if(historyRenameMatch&&request.method==='POST'){const input=await body(request);return reply(json(this.core.renameHistory(historyRenameMatch[1],input.title)))}
  const historyRestoreMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/restore$/);
  if(historyRestoreMatch&&request.method==='POST')return reply(json(this.core.restoreHistory(historyRestoreMatch[1])));
  const historyMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})$/);
  if(historyMatch&&request.method==='GET')return reply(json(this.core.historyDetail(historyMatch[1])));
  if(historyMatch&&request.method==='DELETE')return reply(json(this.core.deleteHistory(historyMatch[1])));
  if(path==='/api/admin/history-settings'&&request.method==='POST'){const input=await body(request);return reply(json(this.core.setParticipantHistoryEnabled(!!input.enabled)))}

  if(path==='/api/admin/host-qr'&&request.method==='GET')return reply(qrResponse((shortHost||url.origin+'/r/'+room+'/host')+'#key='+(request.headers.get('Authorization')||'').replace(/^Bearer /,'')));
  if(path==='/qr.png')return qrResponse(shortJoin||join);
  if(path==='/api/admin/audio'&&request.method==='POST'){const input=await body(request),action=String(input.action||'');if(!['play','pause','stop'].includes(action))throw new UserError('不支援的音樂控制');const track=['warm','upbeat','tech'].includes(input.track)?input.track:'warm';const rawVolume=Number(input.volume??0.22);if(!Number.isFinite(rawVolume)||rawVolume<0||rawVolume>1)throw new UserError('音量必須介於 0 到 1');const volume=rawVolume;const audio={type:'audioControl',action,track,volume,updatedAt:Date.now()};await this.ctx.storage.put('audioControlState',audio);this.broadcastEvent(audio);return reply(json({ok:true,audio}))}
  if(path==='/ws'&&request.headers.get('Upgrade')?.toLowerCase()==='websocket'){
   if(this.ctx.getWebSockets().length>=256)throw new UserError('連線較多，將切換定時更新',503);
   const pair=new WebSocketPair(),[client,server]=Object.values(pair);this.ctx.acceptWebSocket(server);server.send(JSON.stringify(this.core.state()));const audioState=await this.ctx.storage.get('audioControlState');if(audioState)server.send(JSON.stringify(audioState));return new Response(null,{status:101,webSocket:client});
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
   this.broadcast();if(path==='/api/like'&&input.hit===true&&['moles','fishing'].includes(input.gameStyle)&&input.gameStyle===this.core.state().style)this.broadcastEvent({type:'gameHit',text:String(input.text||''),style:input.gameStyle});return reply(json({ok:true,liked:this.core.liked(voter)}));
  }
  throw new UserError('找不到功能',404);
 }catch(e){return reply(json({error:e instanceof UserError?e.message:'暫時無法儲存，請稍後再試'},e.status||500))}}
 webSocketMessage(ws,message){if(message==='ping')ws.send('pong')}
 webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch{}}
 webSocketError(ws){try{ws.close(1011,'重新連線')}catch{}}
}
