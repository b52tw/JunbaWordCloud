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
 if(url.pathname==='/fixed-host'||url.pathname==='/fixed-host/'){
  if(!['GET','HEAD'].includes(request.method))throw new UserError('不支援的操作',405);
  const html='<!doctype html><html lang="zh-Hant"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><title>峻爸文字雲｜固定活動主持人入口</title><link rel="stylesheet" href="/style.css"></head><body><main class="join-page"><header class="mobile-brand"><span class="brand-icon">雲</span>峻爸文字雲 · 固定活動</header><section class="join-form-card"><div class="eyebrow">HOST ACCESS · FIXED ROOM</div><h1>主持人專用入口</h1><p class="join-intro">此入口已鎖定指定活動。請貼上原主持人連結中 #key= 後方的完整憑證；不要輸入建立活動時的管理碼。系統會直接向原活動伺服器驗證，不會建立新活動。</p><div class="field-hint">固定活動 ID：8082f8ffa91e4f2c89ec6346</div><form id="fixedHostForm"><label for="hostKey">主持人 Key</label><input id="hostKey" type="password" autocomplete="current-password" autocapitalize="off" spellcheck="false" required placeholder="請輸入原本的主持人 Key"><button id="fixedHostButton" class="primary wide" type="submit">驗證並進入主持台 ↗</button></form><p id="fixedHostStatus" class="submit-status" role="status" aria-live="polite"></p><div class="privacy-note">Key 僅送至固定活動伺服器驗證，不會放入網址。作者：峻爸</div></section></main><script src="/fixed-host.js?v=20261112-01"></script></body></html>';
  return secure(new Response(request.method==='HEAD'?null:html,{headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'no-store'}}),url);
 }
 if(url.pathname==='/'||url.pathname==='/create')return secure(await env.ASSETS.fetch(new Request(url.origin+'/create',request)),url);
 return secure(await env.ASSETS.fetch(request),url);
 }catch(e){return secure(json({error:e instanceof UserError?e.message:'伺服器暫時無法完成操作，請稍後再試'},e.status||500),url)}}};
export class WordCloudRoom extends DurableObject{
 constructor(ctx,env){super(ctx,env);this.ctx=ctx;this.env=env;this.core=new RoomCore(ctx.storage.sql,fn=>ctx.storage.transactionSync(fn));this.rates=new Map()}
 async initialize(adminHash){this.core.create(adminHash);return true}
 broadcast(){this.broadcastEvent(this.core.state())}
 broadcastEvent(payload){const message=JSON.stringify(payload);for(const ws of this.ctx.getWebSockets()){try{ws.send(message)}catch{try{ws.close(1011,'重新連線')}catch{}}}}
 async ensureGlobalHistoryStore(){
  if(!this.env.BANK)throw new UserError('跨活動歷史總庫尚未連接 Staging D1',503);
  if(!this.env.ACTIVITY_CODE)throw new UserError('歷史總庫識別設定未完成',503);
  const owner=await digest('junba-global-history:'+this.env.ACTIVITY_CODE);
  await this.env.BANK.prepare("CREATE TABLE IF NOT EXISTS global_topic_history (id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, room_id TEXT NOT NULL, title TEXT NOT NULL, question TEXT NOT NULL, created_at TEXT NOT NULL, category TEXT NOT NULL DEFAULT '未分類', access_mode TEXT NOT NULL DEFAULT 'view', deleted_at TEXT, library_hidden_at TEXT, data TEXT NOT NULL)").run();
  await this.env.BANK.prepare('CREATE INDEX IF NOT EXISTS global_topic_history_owner_date ON global_topic_history(owner_id,created_at DESC)').run();
  await this.env.BANK.prepare('CREATE INDEX IF NOT EXISTS global_topic_history_owner_room ON global_topic_history(owner_id,room_id)').run();
  return owner;
 }
 async syncGlobalHistory(room){
  const owner=await this.ensureGlobalHistoryStore();
  const rows=this.ctx.storage.sql.exec('SELECT id,title,question,created_at,data,access_mode,deleted_at,category FROM topic_history').toArray();
  let inserted=0;
  for(const row of rows){
   let topic;try{topic=JSON.parse(row.data)}catch{continue}
   if(topic?._globalSource)continue;
   const result=await this.env.BANK.prepare("INSERT OR IGNORE INTO global_topic_history(id,owner_id,room_id,title,question,created_at,category,access_mode,deleted_at,data) VALUES(?,?,?,?,?,?,?,?,?,?)").bind(row.id,owner,room,row.title,row.question,row.created_at,row.category||'未分類',row.access_mode||'view',row.deleted_at||null,row.data).run();
   if(result.meta?.changes)inserted++;
   await this.env.BANK.prepare('UPDATE global_topic_history SET access_mode=?,deleted_at=? WHERE owner_id=? AND id=? AND room_id=?').bind(row.access_mode||'view',row.deleted_at||null,owner,row.id,room).run();
  }
  return {scanned:rows.length,inserted};
 }
 async globalHistoryPage(room,url){
  const owner=await this.ensureGlobalHistoryStore();
  await this.syncGlobalHistory(room);
  const size=Math.max(1,Math.min(50,Number.parseInt(url.searchParams.get('limit')||'20',10)||20));
  const offset=Math.max(0,Math.min(1000000,Number.parseInt(url.searchParams.get('cursor')||'0',10)||0));
  const clauses=['owner_id=?'],args=[owner];
  if(url.searchParams.get('trash')==='1')clauses.push("(library_hidden_at IS NOT NULL OR deleted_at IS NOT NULL OR access_mode='hidden')");
  else clauses.push("library_hidden_at IS NULL AND deleted_at IS NULL AND COALESCE(access_mode,'view')!='hidden'");
  const from=url.searchParams.get('from')||'',to=url.searchParams.get('to')||'',q=String(url.searchParams.get('q')||'').trim().slice(0,100),category=String(url.searchParams.get('category')||'');
  if(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(from)){clauses.push('created_at>=?');args.push(from+'T00:00:00.000Z')}
  if(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(to)){clauses.push('created_at<?');args.push(new Date(Date.parse(to+'T00:00:00.000Z')+86400000).toISOString())}
  if(q){clauses.push('(title LIKE ? OR question LIKE ? OR data LIKE ?)');const term='%'+q+'%';args.push(term,term,term)}
  if(category){clauses.push('category=?');args.push(category)}
  const where=' WHERE '+clauses.join(' AND ');
  const count=await this.env.BANK.prepare('SELECT COUNT(*) AS n FROM global_topic_history'+where).bind(...args).first();
  const query=await this.env.BANK.prepare('SELECT id,room_id,title,question,created_at,category,access_mode,deleted_at,library_hidden_at,data FROM global_topic_history'+where+' ORDER BY created_at DESC LIMIT ? OFFSET ?').bind(...args,size+1,offset).all();
  const rows=query.results||[],hasMore=rows.length>size;
  const items=rows.slice(0,size).map(row=>{let data={};try{data=JSON.parse(row.data)}catch{}return {id:row.id,roomId:row.room_id,title:row.title,question:row.question,createdAt:row.created_at,category:row.category||'未分類',responses:data.responses||0,likesTotal:data.likesTotal||0,wordCount:data.wordCount??(Array.isArray(data.words)?data.words.length:0),accessMode:row.access_mode||'view',deletedAt:row.deleted_at||row.library_hidden_at||null,libraryHiddenAt:row.library_hidden_at||null}});
  return {items,nextCursor:hasMore?String(offset+size):null,limit:size,total:Number(count?.n)||0,scope:'all-activities'};
 }
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
  if(path==='/api/admin/global-history'&&request.method==='GET')return reply(json(await this.globalHistoryPage(room,url)));
  if(path==='/api/admin/global-history/import'&&request.method==='POST'){
   const input=await body(request);const payload=input&&Array.isArray(input.items)?input.items:Array.isArray(input)?input:null;
   if(!payload||payload.length>500)throw new UserError('歷史匯入檔格式不正確，或超過 500 筆');
   const owner=await this.ensureGlobalHistoryStore();let inserted=0,skipped=0;
   for(const raw of payload){
    const item=raw?.item||raw;if(!item||typeof item.question!=='string'||!Array.isArray(item.words))throw new UserError('歷史檔案內容不完整');
    const id=typeof item.id==='string'&&/^[a-f0-9-]{36}$/i.test(item.id)?item.id:token();
    const exists=await this.env.BANK.prepare('SELECT id FROM global_topic_history WHERE owner_id=? AND id=?').bind(owner,id).first();if(exists){skipped++;continue}
    const createdAt=Number.isFinite(Date.parse(item.createdAt||''))?new Date(item.createdAt).toISOString():new Date().toISOString(),title=String(item.title||new Date(createdAt).toLocaleString('zh-TW',{hour12:false})+'｜'+item.question);
    const category=['未分類','破冰交流','職涯探索','求職實戰','職場適應','AI與數位','永續議題','其他'].includes(item.category)?item.category:'未分類';
    await this.env.BANK.prepare("INSERT INTO global_topic_history(id,owner_id,room_id,title,question,created_at,category,access_mode,deleted_at,library_hidden_at,data) VALUES(?,?,?,?,?,?,?,'view',NULL,NULL,?)").bind(id,owner,'imported',title,item.question,createdAt,category,JSON.stringify({...item,id,title,createdAt,category})).run();inserted++;
   }
   return reply(json({ok:true,inserted,skipped,total:payload.length}));
  }
  const globalAccessMatch=path.match(/^\/api\/admin\/global-history\/([a-f0-9-]{36})\/access$/);
  if(globalAccessMatch&&request.method==='POST'){
   const input=await body(request),owner=await this.ensureGlobalHistoryStore(),row=await this.env.BANK.prepare('SELECT room_id FROM global_topic_history WHERE owner_id=? AND id=?').bind(owner,globalAccessMatch[1]).first();
   if(!row)throw new UserError('找不到這筆歷史主題',404);
   if(row.room_id!=='imported'&&row.room_id!==room)throw new UserError('跨活動歷史可搜尋、預覽與載入；互動開放狀態請回到原活動主持台調整。',403);
   if(row.room_id!=='imported'){
    const result=this.core.setHistoryAccess(globalAccessMatch[1],input.mode);await this.syncGlobalHistory(room);return reply(json({ok:true,...result}));
   }
   const mode=['view','open','hidden'].includes(input.mode)?input.mode:'view';
   await this.env.BANK.prepare('UPDATE global_topic_history SET access_mode=? WHERE owner_id=? AND id=?').bind(mode,owner,globalAccessMatch[1]).run();
   return reply(json({ok:true,id:globalAccessMatch[1],mode}));
  }
  const globalHistoryMatch=path.match(/^\/api\/admin\/global-history\/([a-f0-9-]{36})$/);
  if(globalHistoryMatch&&request.method==='GET'){
   const owner=await this.ensureGlobalHistoryStore(),row=await this.env.BANK.prepare('SELECT id,room_id,title,question,created_at,category,access_mode,deleted_at,library_hidden_at,data FROM global_topic_history WHERE owner_id=? AND id=?').bind(owner,globalHistoryMatch[1]).first();
   if(!row)throw new UserError('找不到這筆歷史主題',404);let item=JSON.parse(row.data);return reply(json({...item,id:row.id,title:row.title,question:row.question,createdAt:row.created_at,category:row.category||'未分類',roomId:row.room_id,accessMode:row.access_mode||'view',deletedAt:row.deleted_at||row.library_hidden_at||null}));
  }
  const globalCategoryMatch=path.match(/^\/api\/admin\/global-history\/([a-f0-9-]{36})\/category$/);
  if(globalCategoryMatch&&request.method==='POST'){
   const input=await body(request),categories=['未分類','破冰交流','職涯探索','求職實戰','職場適應','AI與數位','永續議題','其他'];if(!categories.includes(input.category))throw new UserError('不支援的歷史分類');
   const owner=await this.ensureGlobalHistoryStore(),result=await this.env.BANK.prepare('UPDATE global_topic_history SET category=? WHERE owner_id=? AND id=? AND library_hidden_at IS NULL').bind(input.category,owner,globalCategoryMatch[1]).run();
   if(!result.meta?.changes)throw new UserError('找不到這筆歷史主題',404);return reply(json({id:globalCategoryMatch[1],category:input.category,updated:true}));
  }
  const globalRestoreMatch=path.match(/^\/api\/admin\/global-history\/([a-f0-9-]{36})\/restore$/);
  if(globalRestoreMatch&&request.method==='POST'){
   const owner=await this.ensureGlobalHistoryStore(),row=await this.env.BANK.prepare('SELECT room_id,library_hidden_at,deleted_at FROM global_topic_history WHERE owner_id=? AND id=?').bind(owner,globalRestoreMatch[1]).first();
   if(!row)throw new UserError('找不到這筆歷史主題',404);
   if(row.room_id!=='imported'&&row.room_id!==room){
    if(!row.library_hidden_at)throw new UserError('這筆紀錄已在原活動回收區，請回到原活動主持台還原。',403);
    await this.env.BANK.prepare('UPDATE global_topic_history SET library_hidden_at=NULL WHERE owner_id=? AND id=?').bind(owner,globalRestoreMatch[1]).run();
    return reply(json({id:globalRestoreMatch[1],restored:true,libraryOnly:true}));
   }
   if(row.room_id!=='imported'){
    const result=this.core.restoreHistory(globalRestoreMatch[1]);await this.syncGlobalHistory(room);return reply(json(result));
   }
   await this.env.BANK.prepare("UPDATE global_topic_history SET library_hidden_at=NULL,access_mode='view' WHERE owner_id=? AND id=?").bind(owner,globalRestoreMatch[1]).run();
   return reply(json({id:globalRestoreMatch[1],restored:true}));
  }
  const globalUseMatch=path.match(/^\/api\/admin\/global-history\/([a-f0-9-]{36})\/use$/);
  if(globalUseMatch&&request.method==='POST'){
   const owner=await this.ensureGlobalHistoryStore(),row=await this.env.BANK.prepare("SELECT data,category FROM global_topic_history WHERE owner_id=? AND id=? AND library_hidden_at IS NULL AND deleted_at IS NULL").bind(owner,globalUseMatch[1]).first();
   if(!row)throw new UserError('找不到可使用的歷史題目',404);
   const source=JSON.parse(row.data),localId=crypto.randomUUID(),copy={...source,id:localId,createdAt:new Date().toISOString(),category:row.category||'未分類',_globalSource:globalUseMatch[1]};
   this.core.importHistory({items:[copy]});this.core.action({action:'historyUse',id:localId});await this.syncGlobalHistory(room);this.broadcast();
   return reply(json({ok:true,question:copy.question,sourceId:globalUseMatch[1],localId,sourceImmutable:true}));
  }
  const globalDeleteMatch=path.match(/^\/api\/admin\/global-history\/([a-f0-9-]{36})$/);
  if(globalDeleteMatch&&request.method==='DELETE'){
   const owner=await this.ensureGlobalHistoryStore(),result=await this.env.BANK.prepare('UPDATE global_topic_history SET library_hidden_at=? WHERE owner_id=? AND id=? AND library_hidden_at IS NULL').bind(new Date().toISOString(),owner,globalDeleteMatch[1]).run();
   if(!result.meta?.changes)throw new UserError('找不到這筆歷史主題',404);return reply(json({id:globalDeleteMatch[1],hidden:true,softDeleted:true}));
  }
  if(path==='/api/admin/history/stop-interactions'&&request.method==='POST'){
   const result=this.core.stopHistoryInteractions();
   await this.syncGlobalHistory(room);
   this.broadcastEvent({type:'historyExit',message:'主持人已結束歷史互動，請回到目前活動。',closed:result.closed});
   return reply(json({ok:true,...result}));
  }
  if(path==='/api/admin/history/diagnostics'&&request.method==='GET')return reply(json(this.core.historyDiagnostics()));
  if(path==='/api/admin/history'&&request.method==='GET')return reply(json(this.core.history({limit:url.searchParams.get('limit'),cursor:url.searchParams.get('cursor')||'0',from:url.searchParams.get('from')||'',to:url.searchParams.get('to')||'',q:url.searchParams.get('q')||'',category:url.searchParams.get('category')||'',includeDeleted:url.searchParams.get('trash')==='1'})));
  if(path==='/api/admin/history/import'&&request.method==='POST'){const input=await body(request),result=this.core.importHistory(input);await this.syncGlobalHistory(room);return reply(json(result))}
  const historyAccessMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/access$/);
  if(historyAccessMatch&&request.method==='POST'){const input=await body(request),result=this.core.setHistoryAccess(historyAccessMatch[1],input.mode);await this.syncGlobalHistory(room);return reply(json({ok:true,...result}))}
  const historyOpenMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/open$/);
  if(historyOpenMatch&&request.method==='POST'){const input=await body(request),result=this.core.setHistoryOpen(historyOpenMatch[1],!!input.open);await this.syncGlobalHistory(room);return reply(json({ok:true,...result}))}
  const historyRenameMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/rename$/);
  if(historyRenameMatch&&request.method==='POST'){const input=await body(request);return reply(json(this.core.renameHistory(historyRenameMatch[1],input.title)))}
  const historyCategoryMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/category$/);
  if(historyCategoryMatch&&request.method==='POST'){const input=await body(request),result=this.core.setHistoryCategory(historyCategoryMatch[1],input.category);await this.syncGlobalHistory(room);const owner=await this.ensureGlobalHistoryStore();await this.env.BANK.prepare('UPDATE global_topic_history SET category=? WHERE owner_id=? AND id=?').bind(input.category,owner,historyCategoryMatch[1]).run();return reply(json(result))}
  const historyRestoreMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})\/restore$/);
  if(historyRestoreMatch&&request.method==='POST'){const result=this.core.restoreHistory(historyRestoreMatch[1]);await this.syncGlobalHistory(room);return reply(json(result))}
  const historyMatch=path.match(/^\/api\/admin\/history\/([a-f0-9-]{36})$/);
  if(historyMatch&&request.method==='GET')return reply(json(this.core.historyDetail(historyMatch[1])));
  if(historyMatch&&request.method==='DELETE'){const result=this.core.deleteHistory(historyMatch[1]);await this.syncGlobalHistory(room);return reply(json(result))}
  if(path==='/api/admin/history-settings'&&request.method==='POST'){const input=await body(request);return reply(json(this.core.setParticipantHistoryEnabled(!!input.enabled)))}

  if(path==='/api/admin/host-qr'&&request.method==='GET')return reply(qrResponse((shortHost||url.origin+'/r/'+room+'/host')+'#key='+(request.headers.get('Authorization')||'').replace(/^Bearer /,'')));
  if(path==='/qr.png')return qrResponse(shortJoin||join);
  if(path==='/api/admin/audio'&&request.method==='POST'){const input=await body(request),action=String(input.action||'');if(!['play','pause','stop'].includes(action))throw new UserError('不支援的音樂控制');const track=['coffin','mario','warm','upbeat','tech'].includes(input.track)?input.track:'coffin';const loopMode=['playlist','single'].includes(input.loopMode)?input.loopMode:'playlist';const rawVolume=Number(input.volume??0.85);if(!Number.isFinite(rawVolume)||rawVolume<0||rawVolume>1)throw new UserError('音量必須介於 0 到 1');const volume=rawVolume;const audio={type:'audioControl',action,track,loopMode,volume,updatedAt:Date.now()};await this.ctx.storage.put('audioControlState',audio);this.broadcastEvent(audio);return reply(json({ok:true,audio}))}
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
   }else if(path==='/api/admin/action'){this.core.action(input);await this.syncGlobalHistory(room)}else throw new UserError('不支援的操作',404);
   this.broadcast();if(path==='/api/like'&&input.hit===true&&['moles','fishing'].includes(input.gameStyle)&&input.gameStyle===this.core.state().style)this.broadcastEvent({type:'gameHit',text:String(input.text||''),style:input.gameStyle});return reply(json({ok:true,liked:this.core.liked(voter)}));
  }
  throw new UserError('找不到功能',404);
 }catch(e){return reply(json({error:e instanceof UserError?e.message:'暫時無法儲存，請稍後再試'},e.status||500))}}
 webSocketMessage(ws,message){if(message==='ping')ws.send('pong')}
 webSocketClose(ws,code,reason){try{ws.close(code,reason)}catch{}}
 webSocketError(ws){try{ws.close(1011,'重新連線')}catch{}}
}
