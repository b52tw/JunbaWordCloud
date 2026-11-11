'use strict';
const $=s=>document.querySelector(s);
const route=location.pathname.replace(/\/$/,'');const match=route.match(/^\/r\/([a-z0-9]{12,40})(?:\/|$)/);const cloudRoom=match?match[1]:$('meta[name="junba-room"]')?.content||'';const API_ROOT=cloudRoom?'/r/'+cloudRoom:'';const IS_CLOUD=!!cloudRoom;
const participantRoom=new URLSearchParams(location.search).get('room')||cloudRoom;
const mode=route.endsWith('/join')?'join':route.endsWith('/screen')?'screen':route.endsWith('/my-history')?'my-history':route.endsWith('/history')?'history':'host';
$('#'+mode).hidden=false;
const auth=new URLSearchParams(location.hash.slice(1)).get('key');
if(auth){sessionStorage.setItem('junba-host-key',auth);history.replaceState(null,'',location.pathname+location.search)}
const key=sessionStorage.getItem('junba-host-key')||'';
let state=null,config=null,link='',ready=false,connected=false,loading=false,submitting=false,lastPaint='',displayedRound='',endorseSignature='',toastTimer,networkLoaded=false;
const palette={night:['#f9d590','#92c6b7','#b1c5f5','#f49e86','#d2b8ec','#ebede9','#88bcd2'],paper:['#ad694b','#627f68','#aa8c47','#566b95','#a57486','#7a898c','#826d55'],orange:['#be5a31','#737d40','#957242','#a87967','#7c6554','#d28b37','#744c36']};
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000)}
function appDialog(kind,message,defaultValue=''){return new Promise(resolve=>{const dialog=$('#appDialog');if(!dialog){resolve(kind==='confirm'?false:null);return;}const title=$('#appDialogTitle'),body=$('#appDialogMessage'),input=$('#appDialogInput'),ok=$('#appDialogOK'),cancel=$('#appDialogCancel');title.textContent=kind==='confirm'?'請確認':kind==='prompt'?'請輸入':'提示';body.textContent=message;input.hidden=kind!=='prompt';input.value=defaultValue||'';cancel.hidden=kind==='alert';ok.textContent=kind==='confirm'?'確定':kind==='prompt'?'送出':'知道了';const done=value=>{dialog.close();dialog.removeEventListener('close',closed);resolve(value)};const closed=()=>resolve(kind==='confirm'?false:null);dialog.addEventListener('close',closed,{once:true});ok.onclick=()=>done(kind==='confirm'?true:kind==='prompt'?input.value:undefined);cancel.onclick=()=>done(kind==='confirm'?false:null);dialog.addEventListener('cancel',e=>{e.preventDefault();done(kind==='confirm'?false:null)},{once:true});dialog.showModal();if(kind==='prompt')input.focus();});}
const confirmUI=message=>appDialog('confirm',message);
const promptUI=(message,value='')=>appDialog('prompt',message,value);
const alertUI=message=>appDialog('alert',message);

async function api(path,{method='GET',body,admin=false}={}){
 const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(admin)headers.Authorization='Bearer '+key;
 const r=await fetch(API_ROOT+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
 if(!r.ok){let m;try{m=(await r.json()).error}catch{};throw Error(m||'連線失敗，請確認程式仍在執行。')}
 return r;
}
let feedbackNotificationUnread=0,activeFeedbackWord='';
function updateFeedbackNotificationBadge(unread){
 feedbackNotificationUnread=Math.max(0,Number(unread)||0);
 const badge=$('#feedbackNotificationCount'),button=$('#feedbackNotificationsButton');
 if(badge){badge.textContent=feedbackNotificationUnread>99?'99+':String(feedbackNotificationUnread);badge.hidden=feedbackNotificationUnread===0}
 if(button){button.setAttribute('aria-label',feedbackNotificationUnread?'回饋通知，'+feedbackNotificationUnread+' 則未讀':'回饋通知');button.title=feedbackNotificationUnread+' 則未讀回饋通知'}
}
async function refreshFeedbackNotificationBadge(){
 if(mode!=='join'||!IS_CLOUD)return;
 try{const data=await(await api('/api/feedback/notifications?limit=30')).json();updateFeedbackNotificationBadge(data.unread)}
 catch(e){/* Keep the last known badge during temporary network errors. */}
}
function appendFeedbackEntry(container,item,{showRead=false,onRead=null}={}){
 const card=document.createElement('article');card.className='feedback-entry'+(showRead&&!item.read_at?' is-unread':'');
 const heading=document.createElement('div');heading.className='feedback-entry-heading';
 const title=document.createElement('strong');title.textContent=(item.question?'題目：'+item.question+'｜':'')+(item.word||'詞語')+'｜'+(item.author_label||'匿名');
 const stamp=document.createElement('time');const date=Date.parse(item.created_at||'');stamp.textContent=Number.isFinite(date)?new Date(date).toLocaleString('zh-TW'):'時間未知';heading.append(title,stamp);card.append(heading);
 const body=String(item.body||'');
 if(body.length>160){const preview=document.createElement('p');preview.className='feedback-preview';preview.textContent=body.slice(0,120)+'…';const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='展開完整回饋';const full=document.createElement('p');full.className='feedback-full-text';full.textContent=body;details.append(summary,full);card.append(preview,details)}else{const text=document.createElement('p');text.className='feedback-full-text';text.textContent=body;card.append(text)}
 if(showRead){const footer=document.createElement('div');footer.className='feedback-entry-footer';const stateLabel=document.createElement('span');stateLabel.textContent=item.read_at?'已讀':'尚未讀取';footer.append(stateLabel);if(!item.read_at&&onRead){const button=document.createElement('button');button.type='button';button.className='secondary';button.textContent='標記已讀';button.onclick=onRead;footer.append(button)}card.append(footer)}
 container.append(card);
}
let feedbackTargetWord='',feedbackTargetQuestion='';
async function openFeedbackComposer(word){
 if(!state?.open){toast('主持人已暫停收件，目前無法新增回饋。');return}
 feedbackTargetWord=String(word||'');feedbackTargetQuestion=String(state.question||'');
 const dialog=$('#feedbackComposeDialog');$('#feedbackComposeWord').textContent='活動題目：「'+feedbackTargetQuestion+'」\n回饋對象：「'+feedbackTargetWord+'」';$('#feedbackComposeBody').value='';$('#feedbackComposeStatus').textContent='送出後，這則回饋會公開顯示給大家。';dialog.showModal();$('#feedbackComposeBody').focus();
}
async function openFeedbackThread(word){
 activeFeedbackWord=String(word||'');const dialog=$('#feedbackThreadDialog'),list=$('#feedbackThreadList'),status=$('#feedbackThreadStatus');$('#feedbackThreadTitle').textContent='「'+state.question+'」｜「'+word+'」的公開回饋';list.replaceChildren();status.textContent='正在載入回饋…';dialog.showModal();
 try{const data=await(await api('/api/feedback?word='+encodeURIComponent(word))).json();list.replaceChildren();if(!data.items?.length){status.textContent='目前還沒有回饋，歡迎成為第一位留言的人。';return}status.textContent='共 '+(data.total||data.items.length)+' 則回饋';data.items.forEach(item=>appendFeedbackEntry(list,item))}
 catch(e){status.textContent=e.message}
}
async function loadFeedbackNotifications(){
 const list=$('#feedbackNotificationsList'),status=$('#feedbackNotificationsStatus');list.replaceChildren();status.textContent='正在讀取通知…';
 try{const data=await(await api('/api/feedback/notifications?limit=30')).json();updateFeedbackNotificationBadge(data.unread);if(!data.items?.length){status.textContent='目前沒有回饋通知。';return}status.textContent=(data.unread||0)+' 則未讀通知';data.items.forEach(item=>appendFeedbackEntry(list,item,{showRead:true,onRead:async()=>{const button=list.querySelectorAll('button');button.forEach(b=>b.disabled=true);try{await api('/api/feedback/notifications/'+encodeURIComponent(item.id)+'/read',{method:'POST',body:{}});await loadFeedbackNotifications()}catch(e){status.textContent=e.message;button.forEach(b=>b.disabled=false)}}}))}
 catch(e){status.textContent=e.message}
}
async function openFeedbackNotifications(){
 const dialog=$('#feedbackNotificationsDialog');if(!dialog.open)dialog.showModal();await loadFeedbackNotifications();
}
async function act(body){await api('/api/admin/action',{method:'POST',body,admin:true});await refresh();}
function setConnection(ok){if(mode==='history')return;connected=ok;const label=mode==='host'?$('#connection'):mode==='screen'?$('#screenConnection'):$('#joinConnection');label.textContent=ok?(mode==='screen'?'':'即時連線中'):'連線中斷，重新連線中…';if(mode==='join'){updateSubmit();if(state)renderEndorsements();}}
async function refresh(){
 if(loading)return;loading=true;
 try{const next=await(await api('/api/state')).json();consume(next);}catch(e){setConnection(false)}finally{loading=false}
}
function consume(next){if(!Array.isArray(next.liked))next.liked=state&&state.voteEpoch===next.voteEpoch?(state.liked||[]):[];state=next;setConnection(true);render();ensureCloudFont();}
function updateSubmit(){if(!state)return;const b=$('#submitWords');b.disabled=submitting||!state.open||!ready||!connected;b.textContent=submitting?'送出中…':!ready?'活動連結無效':!connected?'等待重新連線…':state.open?'送出我的想法 ↗':'主持人已暫停收件';}
function render(){
 if(!state||mode==='history'||mode==='my-history')return;
 if(mode==='join'){
  const old=$('#joinQuestion').textContent;$('#joinQuestion').textContent=state.question;
  if(displayedRound&&displayedRound!==state.round){$('#submitStatus').textContent=old===state.question?'主持人已清空重來，現在可以重新投稿。':'題目已更新，請確認後再送出。';$('#submitStatus').className='submit-status';}
  displayedRound=state.round;
  $('#joinResponses').textContent=state.responses;$('#joinLikes').textContent=state.likesTotal||0;if($('#endorseTitle')){$('#endorseTitle').textContent=state.style==='moles'?'打地鼠！敲中喜歡的詞語':'也來讚同好想法';$('#endorseHelp').textContent=state.style==='moles'?'點選「敲一下」，每次敲中都會累計分數。':'點一下讚同，讓有共鳴的詞語長大。';}$('.participant-cloud').dataset.theme=state.theme;$('#joinCloudEmpty').hidden=state.words.length>0;const sig=JSON.stringify([state.words,state.theme,state.font,state.style,state.motion]);if(sig!==lastPaint){lastPaint=sig;paint()}renderEndorsements();
  updateSubmit();return;
 }
 const panel=mode==='host'?$('.cloud-panel'):$('#screen');panel.dataset.theme=state.theme;
 if(mode==='host'){
  $('#previewQuestion').textContent=state.question;renderParticipantLabels($('#hostParticipantLabelsList'),state.participantLabels);$('#responseCount').textContent=state.responses;$('#likeCount').textContent=state.likesTotal||0;$('#wordCount').textContent=state.words.length;$('#listCount').textContent=state.words.length;
  $('#statusLabel').textContent=state.open?'● 開放投稿中':'Ⅱ 已暫停收件';$('#pause').textContent=state.open?'暫停收件':'繼續收件';
  if(!networkLoaded){$('#question').value=state.question;$('#theme').value=state.theme;$('#font').value=state.font||'round';$('#cloudStyle').value=state.style||'clouds';$('#motion').value=state.motion||'gentle';networkLoaded=true}
  const container=$('#wordList');container.replaceChildren();
  state.words.forEach(w=>{const chip=document.createElement('div');chip.className='word-chip';const word=document.createElement('span');word.textContent=w.text;const count=document.createElement('strong');count.textContent='投稿 '+w.count+' · 讚同 '+(w.likes||0)+' · 熱度 '+heat(w);const del=document.createElement('button');del.type='button';del.textContent='×';del.title='刪除「'+w.text+'」';del.setAttribute('aria-label',del.title);del.onclick=async()=>{if(!await confirmUI('刪除「'+w.text+'」及其投稿與讚同計數？'))return;try{await act({action:'delete',text:w.text})}catch(e){toast(e.message)}};chip.append(word,count,del);container.append(chip)});
  $('#listEmpty').hidden=state.words.length>0;
 }else{
  $('#screenQuestion').textContent=state.question;$('#screenResponses').textContent=state.responses;$('#screenLikes').textContent=state.likesTotal||0;$('#screenStatus').textContent=state.open?'● 開放投稿中':'Ⅱ 暫停收件';
 }
 const signature=JSON.stringify([state.words,state.theme,state.font,state.style,state.motion]);if(signature!==lastPaint){lastPaint=signature;paint()}
 document.querySelectorAll('.empty-cloud').forEach(el=>el.hidden=state.words.length>0);
 if(mode==='screen')loadJoin();
}
const pendingLikes=new Set();let gamePositions=[],gameTargetStates=new Map(),gameHitUntil=new Map(),gameHitWord='',gameHitStyle='',gameHitBannerUntil=0;
function renderEndorsements(force=false){
 if(!state)return;const sig=JSON.stringify([state.words,state.liked,state.open,ready,connected,[...pendingLikes]]);if(!force&&sig===endorseSignature)return;endorseSignature=sig;
 const list=$('#endorseList');const scrollTop=list.scrollTop;list.replaceChildren();const liked=new Set(state.liked||[]);
 state.words.forEach(word=>{const row=document.createElement('div');row.className='endorse-row';const info=document.createElement('div');info.className='endorse-info';const name=document.createElement('strong');name.textContent=word.text;const meta=document.createElement('small');meta.textContent='投稿 '+word.count+' · 讚同 '+(word.likes||0)+' · 熱度 '+heat(word);info.append(name,meta);
 const b=document.createElement('button');b.type='button';b.hidden=false;b.className=liked.has(word.text)?'like-button liked':'like-button';const target=challengeTarget()===word.text;b.textContent=liked.has(word.text)?'✓ 已讚同':(state.style==='moles'?'🔨 按讚／打地鼠':state.style==='fishing'?'🎣 按讚／釣魚':target?'🎯 目標出現！挑戰按讚':'🎯 挑戰按讚');b.disabled=liked.has(word.text)||pendingLikes.has(word.text)||!state.open||!ready||!connected;b.setAttribute('aria-label',b.textContent+'「'+word.text+'」');
 b.onclick=async()=>{if(pendingLikes.has(word.text))return;pendingLikes.add(word.text);b.disabled=true;try{const wasUp=gameTargetStates.get(word.text)===true;await api('/api/like',{method:'POST',body:{text:word.text,room:participantRoom,round:state.round,hit:!!wasUp,gameStyle:state.style}});if(wasUp){gameHitUntil.set(word.text,performance.now()+3200);gameHitWord=word.text;gameHitStyle=state.style;gameHitBannerUntil=performance.now()+3200;const burst=document.createElement('span');burst.className='hit-burst';burst.textContent=state.style==='moles'?'✨⭐💛':'💦✨';row.append(burst);setTimeout(()=>burst.remove(),1000);b.classList.add('hit-success');toast(state.style==='moles'?'打中了「'+word.text+'」！':state.style==='fishing'?'釣到了「'+word.text+'」！':'挑戰成功！「'+word.text+'」')}else{toast('已記錄讚同「'+word.text+'」！下次目標出現時再挑戰。')}}catch(e){toast(e.message)}finally{pendingLikes.delete(word.text);await refresh();renderEndorsements(true)}};
 const feedback=document.createElement('button');feedback.type='button';feedback.className='secondary feedback-button';feedback.textContent='💬 回饋';feedback.disabled=!state.open||!ready||!connected;feedback.onclick=()=>openFeedbackComposer(word.text);const thread=document.createElement('button');thread.type='button';thread.className='secondary feedback-thread-button';thread.textContent='查看回饋';thread.onclick=()=>openFeedbackThread(word.text);row.append(info,b,feedback,thread);list.append(row)});list.scrollTop=scrollTop;$('#endorseEmpty').hidden=state.words.length>0;
}
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0}
function renderParticipantLabels(el,items){if(!el)return;el.replaceChildren();const list=Array.isArray(items)?items:[];list.forEach(item=>{const span=document.createElement('span');span.textContent=String(item.label)+(Number(item.submissions)>1?' ×'+item.submissions:'');el.append(span)});el.hidden=list.length===0;}
function heat(w){return w.count+(w.likes||0)}
function challengeTarget(){if(!state?.words?.length)return '';const visible=state.words.slice(0,state.motion==='eco'?60:200);const slot=Math.floor(Date.now()/6000);return visible[hash(String(state.round)+'|'+slot)%visible.length]?.text||'';}
const participantStorageKey='junba-participant-name:'+participantRoom;let participantName=localStorage.getItem(participantStorageKey)||'';function validParticipantName(v){return /^[\p{L}\p{N}]{1,5}$/u.test(v)}function syncParticipantName(){const s=$('#participantNameStatus');if(s)s.textContent=participantName?'目前使用小名：'+participantName:'尚未設定小名（匿名）';const b=$('#changeParticipantName');if(b)b.textContent=participantName?'更改小名':'設定小名';}function askParticipantName(force=false){const dialog=$('#participantNameDialog');if(!dialog)return;if(force||(!participantName&&!sessionStorage.getItem('junba-name-prompted-v2:'+participantRoom))){if(dialog.showModal)dialog.showModal();else dialog.setAttribute('open','');$('#participantNameInput').value=participantName;}}
function fontFamily(text){const choice=state.font==='mixed'?['round','serif','sans'][hash(text)%3]:(state.font||'round');return choice==='round'?'JunbaRound, "Microsoft JhengHei", sans-serif':choice==='serif'?'JunbaSerif, "Noto Serif CJK TC", serif':'"Microsoft JhengHei", "PingFang TC", sans-serif'}
function cloudLines(text){const chars=[...text],lines=[];for(let i=0;i<chars.length;i+=12)lines.push(chars.slice(i,i+12).join(''));return lines;}
function layoutWords(ctx,words,W,H,scale=1){
 if((state.style==='moles'||state.style==='fishing')&&words.length){const visible=words.slice(0,12),largest=heat(visible[0]),cell=Math.min(W,H)/3.15,d=cell*.88,cx=W/2,cy=H/2;return visible.map((word,i)=>{const angle=-Math.PI/2+i*Math.PI*2/visible.length+(state.style==='fishing'?-.12:0),ring=state.style==='fishing'?(visible.length<=4?.16:.31):.34,rad=Math.min(W,H)*ring,px=state.style==='fishing'?cx+Math.cos(angle)*rad:((i%4)+.5)*W/4,py=state.style==='fishing'?cy+Math.sin(angle)*rad*.72:((Math.floor(i/4))+.5)*H/3,x=px-d/2,y=py-d/2;return {text:word.text,count:word.count,likes:word.likes||0,participants:Array.isArray(word.participants)?word.participants:[],score:heat(word),size:Math.max(10,Math.min(19,d*.19*(.72+.28*Math.sqrt(heat(word)/largest)))),font:fontFamily(word.text),lines:[word.text],left:x,top:y,w:d,h:d,x:px,y:y+d*.79,color:palette[state.theme][hash(word.text)%7]}})}

 if(!words.length)return [];const style=state.style||'clouds',clouds=style==='clouds',largest=heat(words[0]);
 const weightedArea=words.reduce((sum,w)=>sum+Math.max(2,[...w.text].length)*Math.pow(.4+.6*Math.sqrt(heat(w)/largest),2),0);
 const ideal=Math.min(W*.14,H*.23,112,Math.sqrt(W*H*(clouds?.26:.42)/Math.max(6,weightedArea*1.4)))*scale;
 const grid=5,gw=Math.ceil(W/grid),gh=Math.ceil(H/grid),occ=new Uint8Array(gw*gh),positions=[];
 function free(x,y,w,h){if(x<8||y<8||x+w>W-8||y+h>H-8)return false;const x1=Math.floor(x/grid),y1=Math.floor(y/grid),x2=Math.ceil((x+w)/grid),y2=Math.ceil((y+h)/grid);for(let yy=y1;yy<y2;yy++)for(let xx=x1;xx<x2;xx++)if(occ[yy*gw+xx])return false;return true;}
 function mark(x,y,w,h){const x1=Math.floor(x/grid),y1=Math.floor(y/grid),x2=Math.ceil((x+w)/grid),y2=Math.ceil((y+h)/grid);for(let yy=y1;yy<y2;yy++)for(let xx=x1;xx<x2;xx++)occ[yy*gw+xx]=1;}
 words.forEach(word=>{
  let size=Math.max(11*scale,ideal*(.4+.6*Math.sqrt(heat(word)/largest)));const lines=clouds?cloudLines(word.text):[word.text];size=Math.min(size,(W-45)/Math.max(1,...lines.map(l=>[...l].length)));if(size<8)return;
  const font=fontFamily(word.text);ctx.font='700 '+size+'px '+font;const pad=style==='moles'?Math.max(18,size*.62):clouds?Math.max(12,size*.4):7;let w=Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width)))+pad*2,h=Math.ceil(size*1.14*lines.length+pad*2+(clouds?size*.35:0));if(style==='moles'||style==='stickers'){const diameter=style==='stickers'?Math.max(w*1.08,h*1.35,size*2.65):Math.max(w+size*.5,h+size*1.8,size*4.2);w=diameter;h=diameter;size=style==='stickers'?Math.min(size,diameter*.24):size;}const phase=(hash(word.text)%628)/100;
  for(let t=0;t<2400;t++){const angle=t*.37+phase+((hash(word.text)%17)-8)*.025,rad=Math.sqrt(t/2400)*(1.02+((hash(word.text)%13)/100));let sx=W/2+Math.cos(angle)*rad*W*.46,sy=H/2+Math.sin(angle)*rad*H*.46;const shape=state.style||'clouds',u=((hash(word.text)%997)/997+t/2400)%1;if(shape==='atom'){const a=u*Math.PI*2+phase,orbit=hash(word.text)%3,tilt=[0,Math.PI/3,-Math.PI/3][orbit];sx=W/2+Math.cos(a)*W*.34*Math.cos(tilt)-Math.sin(a)*H*.15*Math.sin(tilt);sy=H/2+Math.cos(a)*W*.34*Math.sin(tilt)+Math.sin(a)*H*.15*Math.cos(tilt)}else if(shape==='dna'){const a=u*Math.PI*5+phase;sx=W*.16+u*W*.68;sy=H/2+Math.sin(a)*H*.24+(hash(word.text)%2?0:Math.PI)*0.01*H;sy=H/2+Math.sin(a+(hash(word.text)%2?0:Math.PI))*H*.24}else if(shape==='heart'){const a=u*Math.PI*2;sx=W/2+16*Math.pow(Math.sin(a),3)*W/40;sy=H/2-(13*Math.cos(a)-5*Math.cos(2*a)-2*Math.cos(3*a)-Math.cos(4*a))*H/34}else if(shape==='star'){const a=u*Math.PI*2,r=(.18+.16*(.5+.5*Math.sin(5*a)))*Math.min(W,H);sx=W/2+Math.cos(a)*r;sy=H/2+Math.sin(a)*r}else if(shape==='network'){const nodes=[[.5,.48],[.22,.22],[.34,.72],[.7,.25],[.8,.65],[.15,.7],[.87,.18],[.57,.88],[.38,.12],[.9,.83],[.08,.43],[.68,.52],[.3,.42]];const n=nodes[hash(word.text)%nodes.length];sx=n[0]*W+Math.cos(angle)*W*.055;sy=n[1]*H+Math.sin(angle)*H*.055}const x=sx-w/2,y=sy-h/2;if(free(x,y,w,h)){mark(x,y,w,h);positions.push({text:word.text,count:word.count,likes:word.likes||0,participants:Array.isArray(word.participants)?word.participants:[],score:heat(word),size,font,lines,left:x,top:y,w,h,x:x+w/2,y:(style==='stickers')?y+h*.79:(style==='moles')?y+h*.78:y+h/2+size*.36-(lines.length-1)*size*.57,color:palette[state.theme][hash(word.text)%7]});break;}}
 });return positions;
}
const CLOUD_PATH='M38 108C15 108 3 96 8 78C10 64 21 56 36 56C32 34 49 17 70 20C80 1 112 0 126 20C151 9 176 26 173 51C207 48 215 98 184 106C165 115 58 117 38 108Z';
function drawMole(ctx,p,time=0,hit=false,up=true){
 const x=p.left,y=p.top,w=p.w,h=p.h,cx=p.x,unit=Math.min(w,h),bob=Math.sin(time*3.2+(hash(p.text)%100)*.17)*unit*.055,hitLift=hit?unit*.1:0;ctx.save();const holeY=y+h*.91;
 ctx.save();
 ctx.shadowColor='rgba(45,27,15,.25)';ctx.shadowBlur=10;ctx.fillStyle='#70452f';ctx.beginPath();ctx.ellipse(cx,holeY,unit*.36,unit*.075,0,0,Math.PI*2);ctx.fill();ctx.shadowBlur=0;if(!up){ctx.restore();return}ctx.translate(0,bob-hitLift);
 const r=unit*.285,cy=y+unit*.37,variant=hash(p.text)%4;
 ctx.fillStyle='#c8793f';ctx.beginPath();ctx.ellipse(cx,y+unit*.72,unit*.23,unit*.2,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#f6d9b4';ctx.beginPath();ctx.ellipse(cx,y+unit*.72,unit*.13,unit*.13,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#bd7041';ctx.strokeStyle='#8f4e2f';ctx.lineWidth=Math.max(1.5,unit*.012);
 [-1,1].forEach(side=>{ctx.beginPath();ctx.arc(cx+side*r*.68,cy-r*.67,r*.38,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#f6b6a1';ctx.beginPath();ctx.arc(cx+side*r*.68,cy-r*.67,r*.2,0,Math.PI*2);ctx.fill();ctx.fillStyle='#bd7041'});
 const grad=ctx.createRadialGradient(cx-r*.35,cy-r*.45,r*.1,cx,cy,r*1.2);grad.addColorStop(0,'#f4b66f');grad.addColorStop(.72,'#d88748');grad.addColorStop(1,'#a95c36');ctx.fillStyle=grad;ctx.strokeStyle='#914b2d';ctx.lineWidth=Math.max(2,unit*.018);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.stroke();
 ctx.fillStyle='#f7e4c9';ctx.beginPath();ctx.ellipse(cx,cy+r*.38,r*.68,r*.48,0,0,Math.PI*2);ctx.fill();
 ctx.fillStyle='#f2a2a0';[-1,1].forEach(side=>{ctx.beginPath();ctx.ellipse(cx+side*r*.62,cy+r*.22,r*.2,r*.12,0,0,Math.PI*2);ctx.fill()});
 ctx.fillStyle='#fff';[-1,1].forEach(side=>{ctx.beginPath();ctx.ellipse(cx+side*r*.34,cy-r*.12,r*.19,r*.24,0,0,Math.PI*2);ctx.fill()});
 ctx.fillStyle='#33241f';[-1,1].forEach(side=>{ctx.beginPath();ctx.arc(cx+side*r*.34,cy-r*.1,r*.105,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(cx+side*r*.37,cy-r*.17,r*.04,0,Math.PI*2);ctx.fill();ctx.fillStyle='#33241f'});
 ctx.fillStyle='#70402e';ctx.beginPath();ctx.ellipse(cx,cy+r*.28,r*.12,r*.085,0,0,Math.PI*2);ctx.fill();ctx.strokeStyle='#70402e';ctx.lineWidth=Math.max(1.5,unit*.012);ctx.lineCap='round';ctx.beginPath();ctx.moveTo(cx,cy+r*.34);ctx.quadraticCurveTo(cx-r*.17,cy+r*.53,cx-r*.28,cy+r*.37);ctx.moveTo(cx,cy+r*.34);ctx.quadraticCurveTo(cx+r*.17,cy+r*.53,cx+r*.28,cy+r*.37);ctx.stroke();
 ctx.strokeStyle='rgba(80,49,37,.7)';ctx.lineWidth=Math.max(1,unit*.007);[-1,1].forEach(side=>{ctx.beginPath();ctx.moveTo(cx+side*r*.55,cy+r*.35);ctx.lineTo(cx+side*r*.98,cy+r*.27);ctx.moveTo(cx+side*r*.55,cy+r*.43);ctx.lineTo(cx+side*r*.95,cy+r*.49);ctx.stroke()});
 const hat=variant===0?'#f5bd39':variant===1?'#e34d50':variant===2?'#55a7d8':'#8a72c5';ctx.fillStyle=hat;ctx.strokeStyle='#9b6237';ctx.lineWidth=Math.max(1.5,unit*.012);ctx.beginPath();ctx.ellipse(cx,cy-r*.72,r*.68,r*.2,0,Math.PI,Math.PI*2);ctx.lineTo(cx+r*.55,cy-r*.7);ctx.quadraticCurveTo(cx,cy-r*1.28,cx-r*.55,cy-r*.7);ctx.closePath();ctx.fill();ctx.stroke();if(hit){ctx.save();ctx.translate(cx,y+unit*.08);ctx.font='900 '+Math.max(18,unit*.24)+'px sans-serif';ctx.textAlign='center';ctx.lineWidth=4;ctx.strokeStyle='rgba(64,44,28,.8)';ctx.fillStyle='#ffe45c';ctx.strokeText('打中了！',0,-unit*.02);ctx.fillText('打中了！',0,-unit*.02);ctx.font='700 '+Math.max(16,unit*.2)+'px sans-serif';ctx.fillText('✦ ✨ ✦',0,unit*.22);ctx.restore()}ctx.restore();ctx.restore();
}
function drawFishingFish(ctx,p,time=0,up=true,hit=false){
 const cx=p.x,cy=p.top+p.h*.55,r=Math.min(p.w,p.h)*.28*(p.sizeScale||1),variant=hash(p.text)%6,fishColors=[['#ff9e43','#fff09a'],['#ff6f91','#ffd4e2'],['#59c7e8','#d8f7ff'],['#9c82ed','#e7dcff'],['#75c978','#e5ffd9'],['#e5a64d','#fff0c4']][variant];
 ctx.save();ctx.fillStyle='#145d7b';ctx.globalAlpha=.35;ctx.beginPath();ctx.ellipse(cx,p.top+p.h*.88,r*1.8,r*.32,0,0,Math.PI*2);ctx.fill();ctx.globalAlpha=1;
 if(up){const bob=Math.sin(time*4+(hash(p.text)%100)*.2)*r*.12-(hit?r*1.45:0);ctx.translate(0,bob);ctx.save();ctx.translate(cx,cy);ctx.rotate(Math.sin(time*1.8+hash(p.text)%10)*.08-(hit?.48:0));ctx.fillStyle=fishColors[0];ctx.strokeStyle='#8c4b27';ctx.lineWidth=Math.max(2,r*.08);ctx.beginPath();ctx.moveTo(-r*.75,0);ctx.lineTo(-r*1.25,-r*.55);ctx.lineTo(-r*1.2,r*.55);ctx.closePath();ctx.fill();ctx.stroke();const g=ctx.createLinearGradient(0,-r,0,r);g.addColorStop(0,fishColors[1]);g.addColorStop(.55,fishColors[0]);g.addColorStop(1,fishColors[0]);ctx.fillStyle=g;ctx.beginPath();ctx.ellipse(0,0,r,r*.58,0,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(r*.45,-r*.12,r*.15,0,Math.PI*2);ctx.fill();ctx.fillStyle='#203044';ctx.beginPath();ctx.arc(r*.49,-r*.12,r*.075,0,Math.PI*2);ctx.fill();ctx.restore();if(hit){ctx.save();ctx.font='900 '+Math.max(18,r*.78)+'px sans-serif';ctx.textAlign='center';ctx.lineWidth=4;ctx.strokeStyle='rgba(17,65,91,.9)';ctx.fillStyle='#fff4a8';ctx.strokeText('釣到了！',cx,p.top+r*.18);ctx.fillText('釣到了！',cx,p.top+r*.18);ctx.font='700 '+Math.max(16,r*.65)+'px sans-serif';ctx.fillText('💦 ✨',cx,p.top+r*.82);ctx.restore()}}
 ctx.restore();
}
function drawSticker(ctx,p,time=Date.now()/1000){
 const cx=p.x,cy=p.top+p.h*.5,r=Math.min(p.w,p.h)*.48,variant=hash(p.text)%8,blink=((time+(hash(p.text)%37)/10)%3.6)<.19,tilt=((hash(p.text)%9)-4)*.018;
 ctx.save();ctx.translate(cx,cy);ctx.rotate(tilt);ctx.translate(-cx,-cy);ctx.shadowColor='rgba(44,35,20,.22)';ctx.shadowBlur=12;ctx.shadowOffsetY=4;
 const grad=ctx.createRadialGradient(cx-r*.36,cy-r*.48,r*.06,cx,cy,r*1.15);grad.addColorStop(0,'#fffbd0');grad.addColorStop(.68,'#ffe45d');grad.addColorStop(1,'#f0ad28');
 ctx.fillStyle=grad;ctx.strokeStyle='#a97727';ctx.lineWidth=Math.max(3,r*.055);ctx.beginPath();ctx.arc(cx,cy,r,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.shadowBlur=0;ctx.shadowOffsetY=0;
 ctx.save();ctx.beginPath();ctx.arc(cx,cy,r*.94,0,Math.PI*2);ctx.clip();
 ctx.fillStyle='rgba(255,255,255,.55)';ctx.beginPath();ctx.ellipse(cx-r*.35,cy-r*.62,r*.22,r*.09,-.55,0,Math.PI*2);ctx.fill();
 const eyeY=cy-r*.27,dx=r*.34,eye=r*.28;
 const heart=(x,y,size)=>{ctx.beginPath();ctx.moveTo(x,y+size*.55);ctx.bezierCurveTo(x-size*1.2,y-size*.15,x-size*.95,y-size,x,y-size*.35);ctx.bezierCurveTo(x+size*.95,y-size,x+size*1.2,y-size*.15,x,y+size*.55);ctx.fill()};
 const star=(x,y,size)=>{ctx.beginPath();for(let i=0;i<10;i++){const ang=-Math.PI/2+i*Math.PI/5,rr=i%2?size*.42:size;if(i===0)ctx.moveTo(x+Math.cos(ang)*rr,y+Math.sin(ang)*rr);else ctx.lineTo(x+Math.cos(ang)*rr,y+Math.sin(ang)*rr)}ctx.closePath();ctx.fill()};
 [-1,1].forEach(side=>{const x=cx+side*dx;ctx.fillStyle='#382a25';if(blink||variant===5){ctx.strokeStyle='#382a25';ctx.lineWidth=Math.max(2,r*.055);ctx.lineCap='round';ctx.beginPath();ctx.moveTo(x-eye*.7,eyeY);ctx.quadraticCurveTo(x,eyeY+eye*.2,x+eye*.7,eyeY);ctx.stroke()}else if(variant===0){heart(x,eyeY,eye*.82)}else if(variant===3&&side===1){ctx.strokeStyle='#382a25';ctx.lineWidth=Math.max(2,r*.06);ctx.beginPath();ctx.moveTo(x-eye*.75,eyeY);ctx.quadraticCurveTo(x,eyeY+eye*.22,x+eye*.75,eyeY);ctx.stroke()}else if(variant===4){star(x,eyeY,eye*.88)}else{ctx.beginPath();ctx.ellipse(x,eyeY,eye*.78,eye*(variant===2?.72:variant===6?1.12:1),0,0,Math.PI*2);ctx.fill();ctx.fillStyle='#fff';ctx.beginPath();ctx.arc(x-eye*.23,eyeY-eye*.35,eye*.28,0,Math.PI*2);ctx.fill();ctx.beginPath();ctx.arc(x+eye*.2,eyeY+eye*.13,eye*.11,0,Math.PI*2);ctx.fill()}});
 ctx.fillStyle='rgba(242,103,117,.82)';[-1,1].forEach(side=>{ctx.beginPath();ctx.ellipse(cx+side*r*.62,cy+r*.05,r*.13,r*.075,-side*.18,0,Math.PI*2);ctx.fill()});
 if(variant===7){ctx.strokeStyle='#68bfe9';ctx.lineWidth=Math.max(2,r*.045);[-1,1].forEach(side=>{ctx.beginPath();ctx.moveTo(cx+side*r*.55,cy+r*.24);ctx.quadraticCurveTo(cx+side*r*.72,cy+r*.5,cx+side*r*.58,cy+r*.66);ctx.stroke()})}
 ctx.strokeStyle='#382a25';ctx.lineWidth=Math.max(2,r*.045);ctx.lineCap='round';ctx.beginPath();if(variant===1||variant===4){ctx.moveTo(cx-r*.14,cy+r*.18);ctx.quadraticCurveTo(cx,cy+r*.48,cx+r*.14,cy+r*.18)}else if(variant===2||variant===6){ctx.moveTo(cx-r*.16,cy+r*.22);ctx.quadraticCurveTo(cx,cy+r*.12,cx+r*.16,cy+r*.22)}else{ctx.moveTo(cx-r*.13,cy+r*.13);ctx.quadraticCurveTo(cx,cy+r*(variant===7?.34:.25),cx+r*.13,cy+r*.13)}ctx.stroke();
 if(variant===1||variant===4){ctx.fillStyle='#6a3340';ctx.beginPath();ctx.ellipse(cx,cy+r*.31,r*.12,r*.09,0,0,Math.PI*2);ctx.fill()}
 ctx.restore();ctx.restore();
}

function drawCloud(ctx,p){ctx.save();ctx.translate(p.left,p.top);ctx.scale(p.w/210,p.h/120);ctx.globalAlpha=.2;ctx.fillStyle=p.color;ctx.beginPath();ctx.moveTo(38,108);[[15,108,3,96,8,78],[10,64,21,56,36,56],[32,34,49,17,70,20],[80,1,112,0,126,20],[151,9,176,26,173,51],[207,48,215,98,184,106],[165,115,58,117,38,108]].forEach(a=>ctx.bezierCurveTo(...a));ctx.closePath();ctx.fill();ctx.restore();}
function drawStyleBackdrop(ctx,W,H,style,theme,time=0){
 const colors=palette[theme]||palette.night,accent=colors[2]||'#46d6dc',line=theme==='paper'?'rgba(35,91,115,.28)':'rgba(104,224,238,.38)';ctx.save();ctx.lineWidth=1.5;ctx.strokeStyle=line;ctx.fillStyle=accent;
 if(style==='moles'){
  const sky=ctx.createLinearGradient(0,0,0,H);sky.addColorStop(0,'#a9e6ff');sky.addColorStop(.42,'#d9f5b0');sky.addColorStop(1,'#7fc34d');ctx.fillStyle=sky;ctx.fillRect(0,0,W,H);
  ctx.fillStyle='#63a83f';ctx.beginPath();ctx.ellipse(W*.5,H*1.03,W*.72,H*.42,0,0,Math.PI*2);ctx.fill();
  for(let i=0;i<28;i++){const x=(i*83%997)/997*W,y=(i*47%613)/613*H*.86,r=3+(i%4)*2;ctx.fillStyle=i%3===0?'#fff2b5':i%3===1?'#ffb9c9':'#e6f8d2';ctx.beginPath();ctx.arc(x,y,r,0,Math.PI*2);ctx.fill();ctx.fillStyle='#f2bd4a';ctx.beginPath();ctx.arc(x,y,r*.35,0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='#6d9b51';for(let i=0;i<18;i++){const x=i*W/17;ctx.fillRect(x,H*.05,Math.max(2,W*.003),H*.1);ctx.beginPath();ctx.arc(x,H*.08,Math.max(5,W*.012),0,Math.PI*2);ctx.fill();}
  ctx.fillStyle='rgba(255,255,255,.2)';ctx.beginPath();ctx.ellipse(W*.5,H*.16,W*.42,H*.1,0,0,Math.PI*2);ctx.fill();
 }else if(style==='fishing'){const water=ctx.createLinearGradient(0,0,W,H);water.addColorStop(0,'#62c9e8');water.addColorStop(.48,'#197ca9');water.addColorStop(1,'#103c62');ctx.fillStyle=water;ctx.fillRect(0,0,W,H);ctx.save();ctx.globalAlpha=.26;for(let i=0;i<12;i++){const y=H*(.08+i*.075)+Math.sin(time*.8+i)*5;ctx.strokeStyle=i%2?'#d9f8ff':'#83e4f3';ctx.lineWidth=1.4;ctx.beginPath();ctx.moveTo(-20,y);for(let x=0;x<=W+20;x+=24)ctx.lineTo(x,y+Math.sin(x*.018+time+i)*5);ctx.stroke()}ctx.restore();ctx.save();ctx.translate(W*.5,H*.5);ctx.rotate(time*.025);ctx.strokeStyle='rgba(230,251,255,.34)';ctx.lineWidth=1.2;for(let i=0;i<9;i++){ctx.beginPath();ctx.ellipse(0,0,W*(.08+i*.055),H*(.08+i*.055),0,0,Math.PI*2);ctx.stroke()}ctx.restore();}else if(style==='network'){
  const pts=[[.50,.48,.105],[.22,.22,.035],[.34,.72,.045],[.70,.25,.05],[.80,.65,.045],[.15,.70,.025],[.87,.18,.025],[.57,.88,.03],[.38,.12,.025],[.90,.83,.018],[.08,.43,.018],[.68,.52,.025],[.30,.42,.018],[.48,.90,.015],[.75,.08,.015]];
  const edges=[[0,1],[0,2],[0,3],[0,4],[0,7],[0,8],[1,8],[1,10],[2,5],[2,11],[3,6],[3,11],[4,9],[4,11],[7,9],[8,12],[7,13],[3,14],[12,2],[11,7]];
  edges.forEach(([a,b],i)=>{const ax=pts[a][0]*W,ay=pts[a][1]*H,bx=pts[b][0]*W,by=pts[b][1]*H;ctx.beginPath();ctx.moveTo(ax,ay);ctx.lineTo(bx,by);ctx.strokeStyle='rgba(70,225,255,.24)';ctx.lineWidth=1.2;ctx.stroke();const phase=(time*.42+i*.173)%1,px=ax+(bx-ax)*phase,py=ay+(by-ay)*phase;ctx.save();ctx.shadowColor='#43eaff';ctx.shadowBlur=16;ctx.fillStyle='#d9fbff';ctx.beginPath();ctx.arc(px,py,2.1+Math.sin(time*3+i)*.7,0,Math.PI*2);ctx.fill();ctx.restore()});
  pts.forEach(([x,y,r],i)=>{const x0=x*W,y0=y*H,rr=Math.max(5,Math.min(W,H)*r);ctx.beginPath();ctx.arc(x0,y0,rr,0,Math.PI*2);ctx.fillStyle=i===0?'rgba(22,190,207,.22)':'rgba(35,190,205,.10)';ctx.fill();ctx.stroke();if(i===0){ctx.save();ctx.shadowColor='#35eaff';ctx.shadowBlur=30;ctx.strokeStyle='#b5f8ff';ctx.lineWidth=2.4;ctx.beginPath();ctx.arc(x0,y0,rr+8+Math.sin(time*2)*2,0,Math.PI*2);ctx.stroke();ctx.restore()}});
 }else if(style==='atom'){
  const cx=W/2,cy=H/2,rx=Math.min(W,H)*.34,ry=Math.min(W,H)*.13;[0,Math.PI/3,-Math.PI/3].forEach(a=>{ctx.save();ctx.translate(cx,cy);ctx.rotate(a);ctx.beginPath();ctx.ellipse(0,0,rx,ry,0,0,Math.PI*2);ctx.stroke();ctx.restore()});ctx.beginPath();ctx.arc(cx,cy,Math.max(5,Math.min(W,H)*.035),0,Math.PI*2);ctx.fillStyle='rgba(22,190,207,.35)';ctx.fill();
 }else if(style==='dna'){
  const x0=W*.18,x1=W*.82,steps=80,amp=Math.min(W,H)*.14,cy=H/2;for(let strand=0;strand<2;strand++){ctx.beginPath();for(let i=0;i<=steps;i++){const t=i/steps,x=x0+(x1-x0)*t,y=cy+Math.sin(t*Math.PI*5+strand*Math.PI)*amp;if(i===0)ctx.moveTo(x,y);else ctx.lineTo(x,y)}ctx.stroke()}for(let i=0;i<=20;i++){const t=i/20,x=x0+(x1-x0)*t,y1=cy+Math.sin(t*Math.PI*5)*amp,y2=cy+Math.sin(t*Math.PI*5+Math.PI)*amp;ctx.globalAlpha=.55;ctx.beginPath();ctx.moveTo(x,y1);ctx.lineTo(x,y2);ctx.stroke()}ctx.globalAlpha=1;
 }else if(style==='heart'||style==='star'){
  ctx.beginPath();if(style==='heart'){const x=W/2,y=H/2,s=Math.min(W,H)*.34;ctx.moveTo(x,y+s*.75);ctx.bezierCurveTo(x-s*1.5,y-s*.15,x-s*.85,y-s*1.25,x,y-s*.55);ctx.bezierCurveTo(x+s*.85,y-s*1.25,x+s*1.5,y-s*.15,x,y+s*.75)}else{const x=W/2,y=H/2,r=Math.min(W,H)*.34;for(let i=0;i<10;i++){const a=-Math.PI/2+i*Math.PI/5,rr=i%2?r*.43:r;if(i===0)ctx.moveTo(x+Math.cos(a)*rr,y+Math.sin(a)*rr);else ctx.lineTo(x+Math.cos(a)*rr,y+Math.sin(a)*rr)}ctx.closePath()}ctx.stroke();
 }
 if(style==='network'){const cx=W*.5,cy=H*.48,r=Math.min(W,H)*.27;ctx.save();ctx.translate(cx,cy);ctx.strokeStyle='rgba(65,222,255,.32)';ctx.lineWidth=1;for(let k=0;k<3;k++){ctx.save();ctx.rotate(time*.16+k*Math.PI/3);ctx.beginPath();ctx.ellipse(0,0,r,r*(.24+k*.12),0,0,Math.PI*2);ctx.stroke();ctx.restore()}for(let i=0;i<42;i++){const a=i*2.399+time*.22,rr=r*(.35+.65*((i%7)/7)),x=Math.cos(a)*rr,y=Math.sin(a)*rr*.55;ctx.fillStyle='rgba(114,239,255,.72)';ctx.shadowColor='#3ee7ff';ctx.shadowBlur=9;ctx.beginPath();ctx.arc(x,y,1.1+(i%3)*.55,0,Math.PI*2);ctx.fill()}ctx.restore()}ctx.restore();
}
const moleHitTimes=new Map();let moleLastLikes=new Map(),moleFrame=0;
function paint(){
 if(!state||mode==='history'||mode==='my-history')return;const canvas=mode==='host'?$('#hostCanvas'):mode==='screen'?$('#screenCanvas'):$('#joinCanvas');const box=canvas.getBoundingClientRect();if(box.width<10||box.height<10)return;
 const W=box.width,H=box.height,dpr=Math.min(2,window.devicePixelRatio||1),style=state.style||'clouds',clouds=style==='clouds',motion=state.motion||'gentle';canvas.classList.remove('visual-motion-wave','visual-motion-pulse','visual-motion-lively');if(['wave','pulse','lively'].includes(motion))canvas.classList.add('visual-motion-'+motion);const speed=state.motionSpeed||'normal',amp=state.motionAmplitude||'medium',base=motion==='wave'?5:motion==='pulse'?3.8:motion==='lively'?1.8:0,duration=base*(speed==='slow'?1.7:speed==='fast'?.58:1);canvas.style.animationDuration=base?duration+'s':'';canvas.parentElement.dataset.depth=amp;canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,W,H);drawStyleBackdrop(ctx,W,H,style,state.theme,Date.now()/1000);
 const words=state.words.slice(0,motion==='eco'?60:200);let positions=layoutWords(ctx,words,W,H);if(positions.length<words.length*.9){const small=layoutWords(ctx,words,W,H,.75);if(small.length>positions.length)positions=small;}if((style==='moles'||style==='fishing')&&positions.length>1){const slots=positions.map(p=>({...p})),bucket=Math.floor(Date.now()/1800),ordered=words.slice(0,positions.length).map(w=>({w,k:hash(w.text+'|'+bucket)})).sort((a,b)=>a.k-b.k);positions=slots.map((slot,i)=>{const w=ordered[i].w;return {...slot,text:w.text,count:w.count,likes:w.likes||0,participants:w.participants||[],score:heat(w),color:palette[state.theme][hash(w.text)%7],font:fontFamily(w.text),lines:[w.text]}})}if(style==='fishing'&&words.length){const count=Math.min(words.length,18),unit=Math.min(W,H),tile=Math.max(68,Math.min(132,unit*(count<=8?.19:.155))),items=words.slice(0,count).map(w=>w).sort((a,b)=>hash(a.text)-hash(b.text));positions=items.map((w,i)=>{const angle=i*2.399963+((hash(w.text)%31)-15)*.012,spread=Math.sqrt((i+.5)/Math.max(1,count)),x=W*.5+Math.cos(angle)*W*.405*spread,y=H*.5+Math.sin(angle)*H*.365*spread,ww=Math.min(tile,W*.19),hh=Math.min(tile,H*.27),size=Math.max(12,Math.min(24,Math.min(ww,hh)*.17)),sizeScale=.82+Math.min(.62,Math.sqrt(heat(w))*.16);return {text:w.text,count:w.count,likes:w.likes||0,participants:w.participants||[],score:heat(w),sizeScale,color:palette[state.theme][hash(w.text)%7],font:fontFamily(w.text),size,lines:[w.text],left:x-ww/2,top:y-hh/2,w:ww,h:hh,x,y:y+size*.2}})}else if(style==='moles'&&positions.length>1){const slots=positions.map(p=>({...p})),bucket=Math.floor(Date.now()/1800),ordered=words.slice(0,positions.length).map(w=>({w,k:hash(w.text+'|'+bucket)})).sort((a,b)=>a.k-b.k);positions=slots.map((slot,i)=>{const w=ordered[i].w;return {...slot,text:w.text,count:w.count,likes:w.likes||0,participants:w.participants||[],score:heat(w),color:palette[state.theme][hash(w.text)%7],font:fontFamily(w.text),size:Math.max(10,Math.min(19,Math.min(slot.w,slot.h)*.19*(.72+.28*Math.sqrt(heat(w)/Math.max(1,heat(words[0])))))),lines:[w.text]}})}
 ctx.textAlign='center';ctx.textBaseline='alphabetic';positions.forEach((p,index)=>{if(!['moles','fishing'].includes(style)&&p.text===challengeTarget()){ctx.save();ctx.strokeStyle='rgba(255,215,91,.98)';ctx.lineWidth=Math.max(3,Math.min(7,W*.008));ctx.setLineDash([8,5]);ctx.shadowColor='#ffe45d';ctx.shadowBlur=16;ctx.strokeRect(p.left-5,p.top-5,p.w+10,p.h+10);ctx.setLineDash([]);ctx.restore();}if(style==='moles'||style==='fishing'){const now=Date.now(),t=now/1000,phase=(t+(hash(p.text)%4200)/1000)%4.2,prior=moleLastLikes.get(p.text)||0;const hit=(gameHitUntil.get(p.text)||0)>performance.now(),up=(phase<1.55)||hit;p.gameUp=up;gameTargetStates.set(p.text,up);if(style==='moles')drawMole(ctx,p,t,hit,up);else drawFishingFish(ctx,p,t,up,hit)}else{gameTargetStates.set(p.text,p.text===challengeTarget());if(style==='stickers')drawSticker(ctx,p,Date.now()/1000);if(clouds)drawCloud(ctx,p)}let textSize=p.size;if(style==='stickers'){const r=Math.min(p.w,p.h)*.48;ctx.save();ctx.beginPath();ctx.arc(p.x,p.top+p.h*.5,r*.91,0,Math.PI*2);ctx.clip();ctx.font='700 '+textSize+'px '+p.font;const maxLine=Math.max(1,...p.lines.map(line=>ctx.measureText(line).width));textSize=Math.min(Math.max(textSize,r*.36),textSize*(r*1.48)/maxLine);ctx.font='700 '+textSize+'px '+p.font;}else{ctx.font='700 '+textSize+'px '+p.font;}const hue=(index*37+(Date.now()/90)%360)%360;if(!clouds&&motion!=='eco'){ctx.shadowColor=p.color;ctx.shadowBlur=style==='network'?18:style==='dna'||style==='atom'?15:12;const glow=ctx.createLinearGradient(p.x-p.size*2,p.y-p.size,p.x+p.size*2,p.y+p.size);glow.addColorStop(0,p.color);glow.addColorStop(.5,'hsl('+hue+' 95% 82%)');glow.addColorStop(1,p.color);ctx.fillStyle=glow}else{ctx.shadowBlur=0;ctx.fillStyle=p.color}p.lines.forEach((line,i)=>{ctx.lineWidth=Math.max(2,textSize*.075);ctx.strokeStyle=style==='stickers'?'#563c45':state.theme==='night'?'#18243a':'#fffdf5';ctx.strokeText(line,p.x,p.y+i*textSize*1.14);ctx.fillText(line,p.x,p.y+i*textSize*1.14)});if(style==='stickers')ctx.restore();ctx.shadowBlur=0;if(!clouds){const names=(p.participants||[]).map(x=>x.label).filter(Boolean).slice(0,3).join('、'),metaSize=Math.max(9,Math.min(12,p.size*.22)),bottom=p.top+p.h-5;ctx.save();ctx.font='700 '+metaSize+'px sans-serif';ctx.textBaseline='bottom';const pill=(text,x,align,color)=>{ctx.textAlign=align;const tw=ctx.measureText(text).width+12;ctx.fillStyle='rgba(35,42,50,.78)';ctx.beginPath();ctx.roundRect(x,bottom-metaSize-7,tw,metaSize+9,7);ctx.fill();ctx.fillStyle=color;ctx.fillText(text,align==='left'?x+6:x+tw-6,bottom)};if((p.likes||0)>0)pill('♥ '+p.likes,p.left+4,'left','#ff9bc7');if(names&&style!=='stickers'){const text=names+(p.participants?.length>3?'…':'');const maxW=Math.max(28,p.w*.48),clipped=ctx.measureText(text).width>maxW?text.slice(0,8)+'…':text,tw=ctx.measureText(clipped).width+12;pill(clipped,p.left+p.w-tw-4,'left','#e7f7ff')}ctx.restore()}});
 if(gameHitBannerUntil>performance.now()){ctx.save();const label=gameHitStyle==='moles'?'打中了！':gameHitStyle==='fishing'?'釣到了！':'挑戰成功！',sub=gameHitWord?'「'+gameHitWord+'」':'';ctx.textAlign='center';ctx.textBaseline='middle';const fs=Math.max(24,Math.min(54,W*.075));ctx.font='900 '+fs+'px sans-serif';ctx.lineWidth=7;ctx.strokeStyle='rgba(16,48,64,.88)';ctx.fillStyle=gameHitStyle==='moles'?'#fff06a':gameHitStyle==='fishing'?'#fff5a5':'#c9f7ff';ctx.shadowColor='#fff';ctx.shadowBlur=18;ctx.strokeText(label+' '+sub,W/2,H*.16);ctx.fillText(label+' '+sub,W/2,H*.16);ctx.restore()};let layer=canvas.parentElement.querySelector('.bubble-layer');if(!layer){layer=document.createElement('div');layer.setAttribute('aria-hidden','true');canvas.parentElement.append(layer)}layer.className='bubble-layer motion-'+motion;layer.hidden=!clouds||motion==='eco';canvas.style.opacity=layer.hidden?'1':'0';
 if(!layer.hidden){const old=new Map([...layer.children].map(n=>[n.dataset.word,n]));positions.forEach(p=>{let shell=old.get(p.text);const fresh=!shell;if(!shell){shell=document.createElement('div');shell.className='bubble-shell bubble-enter';shell.dataset.word=p.text;const entry=document.createElement('div');entry.className='bubble-entry';const sway=document.createElement('div');sway.className='bubble-sway';const label=document.createElement('span');label.className='bubble-label';const likes=document.createElement('small');likes.className='bubble-like-count';const names=document.createElement('small');names.className='bubble-participant-names';sway.append(label,likes,names);entry.append(sway);shell.append(entry);layer.append(shell)}old.delete(p.text);const entry=shell.children[0],sway=entry.children[0],label=sway.children[0],likes=sway.children[1],names=sway.children[2];Object.assign(shell.style,{left:p.left+'px',top:p.top+'px',width:p.w+'px',height:p.h+'px'});Object.assign(label.style,{fontFamily:p.font,fontSize:p.size+'px',fontWeight:'700',color:p.color});label.textContent=p.lines.join('\n');likes.textContent=p.likes?'👍 '+p.likes:'';names.textContent=(p.participants||[]).map(x=>x.label).join('、');names.hidden=!names.textContent;sway.style.backgroundImage='url("data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 120" preserveAspectRatio="none"><path d="'+CLOUD_PATH+'" fill="'+p.color+'" fill-opacity=".2"/></svg>')+'")';sway.style.setProperty('--sway-time',(4+hash(p.text)%40/10)+'s');sway.style.setProperty('--sway-delay',-(hash(p.text)%50/10)+'s');if(!fresh&&Number(shell.dataset.score)!==p.score){shell.classList.remove('bubble-enter','bubble-pulse');void shell.offsetWidth;shell.classList.add('bubble-pulse')}shell.dataset.score=p.score;});old.forEach(n=>n.remove());}else{layer.replaceChildren()}
 gamePositions=positions.filter(p=>style==='moles'||style==='fishing').map(p=>({text:p.text,x:p.x,y:p.y,left:p.left,top:p.top,w:p.w,h:p.h,up:!!p.gameUp}));canvas.setAttribute('aria-label','文字雲：'+words.map(w=>w.text+'，投稿 '+w.count+' 次，讚同 '+(w.likes||0)+' 次').join('、'));canvas.dataset.shown=positions.length;canvas.dataset.total=state.words.length;if(style==='moles'||style==='fishing'){moleLastLikes=new Map(positions.map(p=>[p.text,p.likes||0]));if(!moleFrame)moleFrame=requestAnimationFrame(function tick(){moleFrame=0;if(['moles','fishing'].includes(state?.style)&&mode!=='history'&&mode!=='my-history')paint()})}else if(moleFrame){cancelAnimationFrame(moleFrame);moleFrame=0}
 if(mode==='host'&&state.words.length>positions.length)$('#statusLabel').textContent=(state.open?'● 開放投稿中':'Ⅱ 已暫停收件')+' · 顯示 '+positions.length+' 個熱門詞';
}
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(paint,120)});

const historyState={cursor:'0',stack:[],page:1,next:null,busy:false};let historyTrashMode=false;
function historyEl(id){return document.getElementById(id)}
function historyMessage(id,message){const el=historyEl(id);if(el)el.textContent=String(message||'')}
function historyError(label,error,statusId){console.error('[History] '+label,error);historyMessage(statusId,error instanceof Error?error.message:'歷史功能暫時無法使用，請稍後再試。')}
function renderHistoryCards(items,cardsId,statusId,detailId,prevId,nextId,pageId){
 const cards=historyEl(cardsId),prev=historyEl(prevId),next=historyEl(nextId),pageLabel=historyEl(pageId);
 if(!cards||!prev||!next||!pageLabel){historyMessage(statusId,'歷史介面尚未完整載入；主持台其他功能仍可使用。');return false}
 if(!Array.isArray(items))throw new Error('歷史列表格式不正確。');
 cards.replaceChildren();
 if(!items.length){const empty=document.createElement('p');empty.className='empty-list';empty.textContent=historyTrashMode?'目前沒有隱藏的歷史紀錄。':'目前還沒有歷史快照。可手動保存，或在換題／清空前由系統自動保存。';cards.append(empty);}
 items.forEach(item=>{
  if(!item||typeof item.id!=='string')return;
  const card=document.createElement('section');card.className='history-card';
  const h=document.createElement('h3');const stamp=Date.parse(item.createdAt||'');h.textContent=Number.isFinite(stamp)?new Date(stamp).toLocaleString('zh-TW',{hour12:false}):String(item.title||'歷史主題');
  const p=document.createElement('p');p.textContent=String(item.question||'');
  const meta=document.createElement('p');meta.textContent=(item.responses||0)+' 次投稿 · '+(item.likesTotal||0)+' 個讚同 · '+(item.wordCount||0)+' 個詞語';
  card.append(h,p,meta);
  if(item.deletedAt){
   const state=document.createElement('p');state.textContent='已隱藏：'+new Date(item.deletedAt).toLocaleString('zh-TW');card.append(state);
   const restore=document.createElement('button');restore.type='button';restore.className='primary';restore.textContent='恢復雲端備存（可查看）';
   restore.onclick=async()=>{restore.disabled=true;try{await api('/api/admin/history/'+encodeURIComponent(item.id)+'/restore',{method:'POST',body:{},admin:true});await loadHistoryPage(true,cardsId,statusId,detailId,prevId,nextId,pageId);historyMessage(statusId,'已恢復為雲端備存，參與者可以查看。')}catch(e){historyError('還原歷史紀錄失敗',e,statusId);restore.disabled=false}};
   card.append(restore);
  }else{
   const mode=item.accessMode|| (item.interactiveOpen?'open':'view');
   const state=document.createElement('p');state.className='history-access-state';state.textContent=mode==='open'?'狀態：開放互動':mode==='hidden'?'狀態：隱藏（參與者看不到）':'狀態：雲端備存（參與者可查看）';card.append(state);
   const b=document.createElement('button');b.type='button';b.className='secondary';b.textContent='預覽／重播投影';b.onclick=()=>loadHistoryDetail(item.id,detailId,statusId);
   const oneExport=document.createElement('button');oneExport.type='button';oneExport.className='secondary';oneExport.textContent='下載這筆 JSON';oneExport.onclick=()=>exportOneHistory(item.id,'json');
   const access=document.createElement('button');access.type='button';access.className=mode==='open'?'secondary':'primary';access.textContent=mode==='open'?'雲端備存（停止互動、保留查看）':mode==='hidden'?'恢復參與者查看':'開放互動（允許投稿與讚同）';
   access.onclick=async()=>{const next=mode==='open'?'view':mode==='hidden'?'view':'open';const prompt=next==='view'?'備存後參與者仍可查看這筆歷史成果，但不能再投稿或按讚。確定備存？':'開放後，參與者可以在「我的歷史互動」中再次投稿與按讚。確定開放？';if(!await confirmUI(prompt))return;access.disabled=true;try{await api('/api/admin/history/'+encodeURIComponent(item.id)+'/access',{method:'POST',body:{mode:next},admin:true});await loadHistoryPage(true,cardsId,statusId,detailId,prevId,nextId,pageId);historyMessage(statusId,next==='view'?'已雲端備存；參與者仍可查看。':'已開放歷史互動。')}catch(e){historyError('更新歷史主題權限失敗',e,statusId);access.disabled=false}};
   card.append(b,oneExport,access);
  }
  cards.append(card);
 });
 prev.disabled=historyState.stack.length===0;next.disabled=!historyState.next;pageLabel.textContent='第 '+historyState.page+' 頁';return true;
}
async function loadHistoryDetail(id,detailId,statusId){
 try{
  if(typeof id!=='string'||!id)throw new Error('歷史快照識別碼無效。');
  historyMessage(statusId,'正在讀取歷史快照……');
  const response=await api('/api/admin/history/'+encodeURIComponent(id),{admin:true});
  const item=await response.json();
  if(!item||typeof item.id!=='string'||typeof item.question!=='string'||!Array.isArray(item.words))throw new Error('歷史快照內容格式不正確。');
  for(const w of item.words)if(!w||typeof w.text!=='string'||!Number.isFinite(w.count)||!Number.isFinite(w.likes))throw new Error('歷史快照含有無效詞語資料。');
  const root=historyEl(detailId);if(!root){historyMessage(statusId,'歷史檢視區尚未載入；主持台其他功能仍可使用。');return}
  root.replaceChildren();root.hidden=false;const h=document.createElement('h3');h.textContent=item.title||item.question;const q=document.createElement('p');q.textContent='題目：'+item.question;const meta=document.createElement('p');meta.textContent=new Date(item.createdAt).toLocaleString('zh-TW')+' · '+item.responses+' 次投稿 · '+item.likesTotal+' 個讚同';const list=document.createElement('div');list.className='word-list';item.words.forEach(w=>{const chip=document.createElement('div');chip.className='word-chip';const word=document.createElement('span');word.textContent=w.text;const count=document.createElement('strong');count.textContent='投稿 '+w.count+' · 讚同 '+w.likes+' · 熱度 '+(w.count+w.likes);chip.append(word,count);list.append(chip)});const use=document.createElement('button');use.type='button';use.className='primary';use.textContent='載入主持台並繼續互動（保留原成果）';use.onclick=async()=>{if(!await confirmUI('將目前活動自動保存，再載入這個歷史主題及原有投稿／讚同數，並繼續使用目前 QR Code。確定繼續？'))return;use.disabled=true;try{await api('/api/admin/action',{method:'POST',body:{action:'historyUse',id:item.id},admin:true});toast('已載入歷史主題，原成果保留，現在可繼續投稿。');location.href=API_ROOT+'/host#key='+encodeURIComponent(key)}catch(e){toast(e.message);use.disabled=false}};const exportJSON=document.createElement('button');exportJSON.type='button';exportJSON.className='secondary';exportJSON.textContent='下載這筆 JSON';exportJSON.onclick=()=>exportOneHistory(item.id,'json');const exportCSV=document.createElement('button');exportCSV.type='button';exportCSV.className='secondary';exportCSV.textContent='下載這筆 CSV';exportCSV.onclick=()=>exportOneHistory(item.id,'csv');const actions=document.createElement('div');actions.className='inline-actions';actions.append(exportJSON,exportCSV);root.append(h,q,meta,list,actions,use);historyMessage(statusId,'已載入快照；可下載單筆資料、檢視原成果，或載入主持台繼續互動。');
 }catch(e){historyError('無法載入快照',e,statusId)}
}
async function loadHistoryPage(reset=false,cardsId='hostHistoryCards',statusId='hostHistoryStatus',detailId='hostHistoryDetail',prevId='hostHistoryPrev',nextId='hostHistoryNext',pageId='hostHistoryPageLabel'){
 if(historyState.busy)return;
 if(reset){historyState.cursor='0';historyState.stack=[];historyState.page=1;historyState.next=null}
 historyState.busy=true;historyMessage(statusId,'正在載入歷史主題……');
 try{
  const from=historyEl('historyFrom')?.value||'',to=historyEl('historyTo')?.value||'';const filter=(from?'&from='+encodeURIComponent(from):'')+(to?'&to='+encodeURIComponent(to):'')+(historyTrashMode?'&trash=1':'');const response=await api('/api/admin/history?limit=20&cursor='+encodeURIComponent(historyState.cursor)+filter,{admin:true});
  const page=await response.json();
  if(!page||!Array.isArray(page.items)||!Number.isFinite(page.total)||!Number.isFinite(page.limit)||(page.nextCursor!==null&&typeof page.nextCursor!=='string'))throw new Error('歷史列表回應格式不正確。');
  historyState.next=page.nextCursor;
  if(renderHistoryCards(page.items,cardsId,statusId,detailId,prevId,nextId,pageId))historyMessage(statusId,'共 '+page.total+' 筆歷史主題；每頁 '+page.limit+' 筆。');
 }catch(e){historyError('無法載入歷史列表',e,statusId)}finally{historyState.busy=false}
}
function reloadHistoryPage(){return mode==='history'?loadHistoryPage(false,'historyCards','historyStatus','historyDetail','historyPrev','historyNext','historyPageLabel'):loadHistoryPage(false)}
function historyNext(){if(!historyState.next||historyState.busy)return;historyState.stack.push(historyState.cursor);historyState.cursor=historyState.next;historyState.page++;reloadHistoryPage()}

async function collectHistoryForExport(){
 const from=historyEl('historyFrom')?.value||'',to=historyEl('historyTo')?.value||'';
 const filter=(from?'&from='+encodeURIComponent(from):'')+(to?'&to='+encodeURIComponent(to):'');
 const records=[];let cursor='0',pageCount=0;
 do{
  const response=await api('/api/admin/history?limit=50&cursor='+encodeURIComponent(cursor)+filter,{admin:true});
  if(!response.ok)throw new Error('讀取歷史清單失敗（HTTP '+response.status+'）');
  const page=await response.json();
  if(!Array.isArray(page.items))throw new Error('歷史清單格式不正確');
  for(const item of page.items){
   const detailResponse=await api('/api/admin/history/'+encodeURIComponent(item.id),{admin:true});
   if(!detailResponse.ok)throw new Error('讀取「'+(item.title||item.question||item.id)+'」失敗');
   records.push(await detailResponse.json());
  }
  cursor=page.nextCursor;pageCount++;
  if(pageCount>200)throw new Error('歷史筆數過多，請縮小日期範圍後再匯出');
  historyMessage('hostHistoryStatus','正在整理歷史資料：已讀取 '+records.length+' 筆……');
 }while(cursor);
 return records;
}
async function exportOneHistory(id,format){
 try{
  const response=await api('/api/admin/history/'+encodeURIComponent(id),{admin:true});
  if(!response.ok)throw new Error('讀取歷史快照失敗（HTTP '+response.status+'）');
  const item=await response.json();
  if(!item||typeof item.id!=='string'||!Array.isArray(item.words))throw new Error('歷史快照內容格式不正確');
  const stamp=String(item.createdAt||new Date().toISOString()).slice(0,10);
  const safe=String(item.title||item.question||'歷史主題').replace(/[\\\\/:*?"<>|]/g,'_').slice(0,40);
  if(format==='csv')downloadBlob(new Blob([historyCSV([item])],{type:'text/csv;charset=utf-8'}),'Junba_'+safe+'_'+stamp+'.csv');
  else downloadBlob(new Blob([JSON.stringify({schema:'junba-wordcloud-history-item-v1',item},null,2)],{type:'application/json;charset=utf-8'}),'Junba_'+safe+'_'+stamp+'.json');
  historyMessage('hostHistoryStatus','已下載單筆歷史：'+(item.title||item.question));
 }catch(e){historyError('下載單筆歷史失敗',e,'hostHistoryStatus')}
}
function historyCSV(records){
 const q=v=>'"'+String(v??'').replace(/"/g,'""')+'"';
 const rows=[['快照名稱','活動題目','建立時間','投稿次數','讚同數','詞語','詞語投稿數','詞語讚同數']];
 for(const item of records)for(const word of (Array.isArray(item.words)?item.words:[]))
  rows.push([item.title,item.question,item.createdAt,item.responses,item.likesTotal,word.text,word.count,word.likes]);
 return '\\uFEFF'+rows.map(row=>row.map(q).join(',')).join('\\r\\n');
}
async function exportHistory(format){
 const buttons=['exportHistoryJSON','exportHistoryCSV'].map(id=>historyEl(id)).filter(Boolean);
 buttons.forEach(b=>b.disabled=true);
 try{
  const records=await collectHistoryForExport();
  if(!records.length){historyMessage('hostHistoryStatus','目前篩選條件沒有可匯出的歷史紀錄。');return}
  const stamp=new Date().toISOString().slice(0,10);
  if(format==='json'){
   downloadBlob(new Blob([JSON.stringify({schema:'junba-wordcloud-history-v1',exportedAt:new Date().toISOString(),count:records.length,items:records},null,2)],{type:'application/json;charset=utf-8'}),'Junba_歷史主題_'+stamp+'.json');
  }else{
   downloadBlob(new Blob([historyCSV(records)],{type:'text/csv;charset=utf-8'}),'Junba_歷史主題_'+stamp+'.csv');
  }
  historyMessage('hostHistoryStatus','已匯出 '+records.length+' 筆歷史主題。');
 }catch(e){historyError('匯出歷史資料失敗',e,'hostHistoryStatus')}
 finally{buttons.forEach(b=>b.disabled=false)}
}
function historyPrev(){if(!historyState.stack.length||historyState.busy)return;historyState.cursor=historyState.stack.pop();historyState.page=Math.max(1,historyState.page-1);reloadHistoryPage()}
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.style.display='none';document.body.append(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1500)}
async function downloadAdmin(path,name){try{const r=await api(path,{admin:true});downloadBlob(await r.blob(),name)}catch(e){toast(e.message)}}
function savePNG(){
 if(!state)return;const src=mode==='host'?$('#hostCanvas'):$('#screenCanvas');
 const c=document.createElement('canvas');c.width=1920;c.height=1080;const ctx=c.getContext('2d');ctx.fillStyle={night:'#151f33',paper:'#fcf9f0',orange:'#fff0e5'}[state.theme];ctx.fillRect(0,0,c.width,c.height);
 ctx.fillStyle={night:'#f7f4ed',paper:'#44463f',orange:'#733f2c'}[state.theme];ctx.textAlign='center';ctx.font='700 44px "Microsoft JhengHei", sans-serif';
 const chars=[...state.question];let lines=[],line='';for(const char of chars){if(ctx.measureText(line+char).width>1720&&line){lines.push(line);line=''}line+=char}if(line)lines.push(line);lines.forEach((l,i)=>ctx.fillText(l,960,75+i*60));
 const y=90+lines.length*60;const areaH=1000-y,ratio=src.width/src.height;let drawW=1760,drawH=drawW/ratio;if(drawH>areaH){drawH=areaH;drawW=drawH*ratio}ctx.drawImage(src,(1920-drawW)/2,y,drawW,drawH);
 ctx.font='24px "Microsoft JhengHei", sans-serif';ctx.fillText(state.responses+' 次投稿 · '+(state.likesTotal||0)+' 個讚同 · '+state.words.length+' 個詞語 · 作者：峻爸',960,1040);c.toBlob(b=>{if(b)downloadBlob(b,'Junba_WordCloud.png')},'image/png');
}
async function loadJoin(){
 try{const v=await(await api('/api/join')).json();const nextLink=v.shortJoin||v.join;if(link===nextLink)return;link=nextLink;
  if(mode==='screen'){$('#screenQR').src=API_ROOT+'/qr.png?v='+Date.now();$('#screenJoinURL').textContent=link;}
 }catch{}
}
if(mode==='host'){
 const historyDialog=historyEl('hostHistoryDialog');historyEl('openHistory')?.addEventListener('click',()=>{historyDialog?.showModal();loadHistoryPage(true)});historyEl('launchHistory')?.addEventListener('click',()=>{historyDialog?.showModal();loadHistoryPage(true)});historyEl('launchHistory')?.removeAttribute('hidden');historyEl('closeHostHistory')?.addEventListener('click',()=>historyDialog?.close());historyEl('historySearch')?.addEventListener('click',()=>loadHistoryPage(true));historyEl('historyReset')?.addEventListener('click',()=>{historyEl('historyFrom').value='';historyEl('historyTo').value='';historyTrashMode=false;historyEl('toggleHistoryTrash').textContent='查看回收區';loadHistoryPage(true)});historyEl('toggleHistoryTrash')?.addEventListener('click',()=>{historyTrashMode=!historyTrashMode;historyEl('toggleHistoryTrash').textContent=historyTrashMode?'返回歷史主題':'查看隱藏紀錄';loadHistoryPage(true)});historyEl('hostHistoryPrev')?.addEventListener('click',historyPrev);historyEl('hostHistoryNext')?.addEventListener('click',historyNext);historyEl('exportHistoryJSON')?.addEventListener('click',()=>exportHistory('json'));historyEl('exportHistoryCSV')?.addEventListener('click',()=>exportHistory('csv'));historyEl('launchHistoryFromDialog')?.addEventListener('click',()=>window.open(API_ROOT+'/history#key='+encodeURIComponent(key),'junba-history'));
 historyEl('importHistoryButton')?.addEventListener('click',()=>historyEl('importHistoryFile')?.click());historyEl('importHistoryFile')?.addEventListener('change',async e=>{const file=e.target.files?.[0];if(!file)return;const button=historyEl('importHistoryButton');button.disabled=true;try{const data=JSON.parse(await file.text());if(!data||!Array.isArray(data.items))throw new Error('請選擇峻爸文字雲匯出的歷史 JSON 檔。');const result=await(await api('/api/admin/history/import',{method:'POST',body:data,admin:true})).json();await loadHistoryPage(true);historyMessage('hostHistoryStatus','匯入完成：新增 '+result.inserted+' 筆，略過重複 '+result.skipped+' 筆。')}catch(err){historyError('匯入歷史主題失敗',err,'hostHistoryStatus')}finally{button.disabled=false;e.target.value=''}});
 if(!key){toast(IS_CLOUD?'請使用先前保存的完整主持連結開啟，或掃描主持人專用 QR Code。':'主持台憑證已失效。請重新開啟 EXE，再使用自動開啟的主持台。');document.querySelectorAll('#host button,#host select,#host textarea').forEach(e=>e.disabled=true)}
 function showHostShortLink(){if(!IS_CLOUD||!key||!config)return;$('#visibleHostShortLink').value=(config.shortHost||location.origin+API_ROOT+'/host')+'#key='+key;$('#privateHostLinkCard').hidden=false;}
 async function loadConfig(){
  try{config=await(await api('/api/admin/config',{admin:true})).json();renderQuestionBank();await loadMasterBank();showHostShortLink();['theme','font','cloudStyle','motion','motionAmplitude','motionSpeed'].forEach(id=>{const k=id==='cloudStyle'?'style':id;if(config[k]&&$('#'+id))$('#'+id).value=config[k]});link=config.shortJoin||config.join;$('#network').replaceChildren();config.links.forEach(l=>{const o=document.createElement('option');o.value=l.split('/join?')[0];o.textContent=l.split('/join?')[0];o.selected=l===config.join;$('#network').append(o)});$('#hostQR').src=API_ROOT+'/qr.png?v='+Date.now();$('#participantShortLink').value=config.shortJoin||link;$('#testJoin').href=config.shortJoin||link;$('#dataNote').textContent=IS_CLOUD?'結果自動儲存在活動帳號。':'自動儲存：'+config.dataPath;$('#networkWarning').textContent=IS_CLOUD?'線上活動：可使用各自的 Wi-Fi 或 4G／5G。':link.includes('127.0.0.1')?'目前只有本機網址，手機無法使用。請先將筆電連上學校 Wi-Fi 或手機熱點，再按「重新偵測網路」。':'請確認這是實際使用的 Wi-Fi 網址。';}
  catch(e){toast(e.message)}
 }

 let masterBankItems=[];
 async function loadMasterBank(){const q=$('#masterBankSearch')?.value||'';try{const response=await api('/api/admin/master-bank?q='+encodeURIComponent(q),{admin:true}),data=await response.json();masterBankItems=data.items||[];renderQuestionBank()}catch(e){toast('雲端題庫載入失敗：'+e.message)}}
 function renderQuestionBank(){const select=$('#questionBank'),previous=select.value;select.replaceChildren();masterBankItems.forEach(item=>{const o=document.createElement('option');o.value=item.id;o.textContent=item.question;o.dataset.question=item.question;select.append(o)});if(masterBankItems.some(x=>x.id===previous))select.value=previous;else if(state){const current=masterBankItems.find(x=>x.question===state.question);if(current)select.value=current.id}$('#bankCount').textContent=masterBankItems.length+' 題（雲端共用）';['bankUse','bankDelete'].forEach(id=>$('#'+id).disabled=!masterBankItems.length);$('#bankExport').disabled=!masterBankItems.length}
 $('#masterBankSearch').oninput=()=>loadMasterBank();
 $('#questionBank').onchange=()=>{const o=$('#questionBank').selectedOptions[0];if(o)$('#question').value=o.dataset.question};
 $('#bankSave').onclick=async()=>{const o=$('#questionBank').selectedOptions[0],question=$('#question').value.trim();try{if(!question)throw Error('請先輸入題目。');const payload={question};if(o)payload.id=o.value;await api('/api/admin/master-bank',{method:'POST',admin:true,body:payload});await loadMasterBank();const saved=masterBankItems.find(x=>x.question===question);if(saved)$('#questionBank').value=saved.id;toast('題目已儲存至雲端題庫。')}catch(e){toast(e.message)}};
 $('#bankUse').onclick=async()=>{const o=$('#questionBank').selectedOptions[0],question=o?.dataset.question;if(!question)return;if(state&&(state.responses||state.likesTotal||state.words.length)&&!await confirmUI('換成「'+question+'」並清空目前投稿及讚同？系統會先保存目前成果。'))return;try{await act({action:'questionUse',question});$('#question').value=question;toast('已換題並重新開放收件。')}catch(e){toast(e.message)}};
 $('#bankDelete').onclick=async()=>{const o=$('#questionBank').selectedOptions[0];if(!o||!await confirmUI('確定刪除「'+o.dataset.question+'」？'))return;try{await api('/api/admin/master-bank?id='+encodeURIComponent(o.value),{method:'DELETE',admin:true});$('#question').value='';await loadMasterBank();toast('題目已刪除。')}catch(e){toast(e.message)}};
 $('#bankExport').onclick=async()=>{const b=$('#bankExport');b.disabled=true;b.textContent='匯出準備中…';try{const data=await(await api('/api/admin/master-bank?all=1',{admin:true})).json();if(!Array.isArray(data.items))throw Error('雲端題庫回傳格式不正確');const payload={schema:'junba-question-bank-v2',items:data.items.map(x=>({question:x.question}))};downloadBlob(new Blob([JSON.stringify(payload,null,2)],{type:'application/json;charset=utf-8'}),'Junba_Cloud_Question_Bank.json');toast('已匯出 '+data.items.length+' 題雲端題庫。')}catch(e){toast('匯出失敗：'+e.message)}finally{b.disabled=false;b.textContent='↓ 匯出雲端題庫'}};
 $('#bankImport').onclick=()=>{const input=$('#bankImportFile');input.value='';input.click()};
 $('#bankImportFile').onchange=async e=>{const input=e.target,file=input.files?.[0],button=$('#bankImport');if(!file)return;button.disabled=true;button.textContent='匯入中…';try{if(file.size>1048576)throw Error('題庫檔案超過 1 MB，請先縮小檔案');const value=JSON.parse(await file.text()),questions=Array.isArray(value)?value:Array.isArray(value.items)?value.items:value.questions;if(!Array.isArray(questions)||!questions.length)throw Error('JSON 必須包含 items 或 questions 題目陣列');const items=questions.map(q=>typeof q==='string'?{question:q}:q&&typeof q.question==='string'?{question:q.question}:null);if(items.some(x=>!x))throw Error('題庫格式錯誤：每題需為文字或 question 物件');const result=await(await api('/api/admin/master-bank/import',{method:'POST',admin:true,body:{items}})).json();await loadMasterBank();toast('匯入完成：新增 '+result.inserted+' 題，整合重複 '+result.skipped+' 題。')}catch(e){toast('匯入失敗：'+e.message)}finally{input.value='';button.disabled=false;button.textContent='↑ 匯入雲端題庫'}};
 $('#settingsForm').onsubmit=async e=>{e.preventDefault();try{await act({action:'settings',question:$('#question').value,theme:$('#theme').value,font:$('#font').value,style:$('#cloudStyle').value,motion:$('#motion').value,motionAmplitude:$('#motionAmplitude').value,motionSpeed:$('#motionSpeed').value});toast('已套用。')}catch(e){toast(e.message)}};
 $('#refreshNetwork').onclick=async()=>{const b=$('#refreshNetwork');b.disabled=true;try{await act({action:'refreshNetwork'});await loadConfig();toast('網路已重新偵測，請使用畫面上的 QR Code。')}catch(e){toast(e.message)}finally{b.disabled=false}};
 $('#network').onchange=async()=>{try{await act({action:'network',base:$('#network').value});await loadConfig();toast('QR Code 已更新，請使用新的網址。')}catch(e){toast(e.message)}};
 $('#pause').onclick=async()=>{try{await act({action:'toggle'})}catch(e){toast(e.message)}};
 $('#clear').onclick=async()=>{if(!await confirmUI('清空所有詞語、投稿次數及讚同數，並重新開放收件？題目、配色與 QR Code 都會保留。需要保留成果時，請先匯出或備份。'))return;try{await act({action:'clear'});toast('已清空重來，重新開放收件。原 QR Code 可繼續使用。')}catch(e){toast(e.message)}};
 $('#launchLite').onclick=()=>window.open(API_ROOT+'/join?room='+encodeURIComponent(participantRoom||cloudRoom),'junba-participant');
 $('#launchScreen').onclick=()=>window.open(API_ROOT+'/screen','junba-screen');
 $('#copyParticipantShortLink').onclick=async()=>{const url=config?.shortJoin||link;try{await navigator.clipboard.writeText(url);toast('已複製參與者短網址。')}catch{await promptUI('請複製參與者短網址：',url)}};
 $('#downloadParticipantQR').onclick=()=>{const image=$('#hostQR');if(!image.complete||!image.naturalWidth){toast('QR Code 還在載入，請稍後再按。');return}try{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1024,1024);ctx.drawImage(image,0,0,1024,1024);canvas.toBlob(blob=>{if(blob)downloadBlob(blob,'JunbaWordCloud_Participant_QR.png');else toast('無法下載 QR Code，請重新整理頁面。')},'image/png')}catch{toast('QR Code 下載失敗，請重新整理頁面。')}};
 $('#copyLink').onclick=async()=>{try{await navigator.clipboard.writeText(link);toast('已複製投稿網址。')}catch{await promptUI('請複製以下網址：',link)}};
 $('#savePNG').onclick=savePNG;$('#exportCSV').onclick=()=>downloadAdmin('/api/admin/export','Junba_WordCloud.csv');$('#backup').onclick=()=>downloadAdmin('/api/admin/backup','Junba_WordCloud_backup.json');
 $('#shutdown').onclick=async()=>{if(!await confirmUI('結束文字雲程式？現有資料已自動儲存，所有手機將停止投稿。'))return;try{await api('/api/admin/shutdown',{method:'POST',admin:true});toast('程式已結束，可以關閉此頁。');document.querySelectorAll('#host button,#host select,#host textarea').forEach(e=>e.disabled=true)}catch(e){toast(e.message)}};
 if(IS_CLOUD){document.querySelectorAll('.join-card p').forEach(p=>p.innerHTML='① 使用自己的網路<br>② 掃碼輸入詞語');$('#copyHostLink').hidden=false;$('#copyHostLink').onclick=async()=>{const url=(config?.shortHost||location.origin+API_ROOT+'/host')+'#key='+key;try{await navigator.clipboard.writeText(url);toast('已複製主持連結，請自行保存。')}catch{await promptUI('請保存這個具有管理權限的主持連結：',url)}};
  $('#showHostQR').hidden=false;let privateQRObjectURL='';$('#showHostQR').onclick=async()=>{const button=$('#showHostQR');button.disabled=true;try{const response=await api('/api/admin/host-qr',{admin:true});if(privateQRObjectURL)URL.revokeObjectURL(privateQRObjectURL);privateQRObjectURL=URL.createObjectURL(await response.blob());$('#privateHostQR').src=privateQRObjectURL;$('#hostQRDialog').showModal()}catch(e){toast(e.message)}finally{button.disabled=false}};$('#closeHostQR').onclick=()=>$('#hostQRDialog').close();$('#hostQRDialog').onclose=()=>{if(privateQRObjectURL){URL.revokeObjectURL(privateQRObjectURL);privateQRObjectURL='';$('#privateHostQR').removeAttribute('src')}};
  $('#copyVisibleHostLink').onclick=()=>$('#copyHostLink').onclick();$('#copyShortHostLink').onclick=()=>$('#copyHostLink').onclick();$('#copyLongHostLink').onclick=async()=>{const url=location.origin+API_ROOT+'/host#key='+key;try{await navigator.clipboard.writeText(url);toast('已複製主持長連結，請自行保存。')}catch{await promptUI('請保存這個具有管理權限的主持長連結：',url)}};
  $('#downloadHostQR').onclick=()=>{const image=$('#privateHostQR');if(!image.complete||!image.naturalWidth){toast('QR Code 還在載入，請稍後再按。');return}try{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1024,1024);ctx.drawImage(image,0,0,1024,1024);canvas.toBlob(blob=>{if(blob)downloadBlob(blob,'JunbaWordCloud_Host_QR_PRIVATE.png');else toast('無法下載，請重新開啟主持人 QR Code。')},'image/png')}catch{toast('無法下載，請重新開啟主持人 QR Code。')}};
  $('#refreshNetwork').hidden=true;$('#network').hidden=true;$('.local-badge').textContent='線上活動';$('#networkWarning').textContent='大家可以各用自己的網路，掃碼參與。';$('#shutdown').hidden=true;}if(key)loadConfig();
}else if(mode==='history'){
 try{
  const back=historyEl('historyBack'),prev=historyEl('historyPrev'),next=historyEl('historyNext');
  if(back)back.onclick=()=>location.href=API_ROOT+'/host#key='+encodeURIComponent(key);
  if(prev)prev.onclick=historyPrev;
  if(next)next.onclick=historyNext;
  loadHistoryPage(true,'historyCards','historyStatus','historyDetail','historyPrev','historyNext','historyPageLabel');
 }catch(e){historyError('歷史頁初始化失敗',e,'historyStatus')}

}else if(mode==='my-history'){
 const status=$('#myHistoryStatus'),cards=$('#myHistoryCards'),detail=$('#myHistoryDetail');$('#myHistoryHome').href=API_ROOT+'/join?room='+encodeURIComponent(participantRoom);$('#myHistoryLink')?.setAttribute('href',API_ROOT+'/my-history');
 const esc=s=>String(s??'').replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
 let activeArchiveId='',archiveMonitorTimer=null;
 const drawArchiveCloud=(canvas,words)=>{if(!canvas)return;const ctx=canvas.getContext('2d'),W=canvas.width=canvas.clientWidth*2||720,H=canvas.height=canvas.clientHeight*2||360;ctx.clearRect(0,0,W,H);const max=Math.max(1,...words.map(w=>(w.count||0)+(w.likes||0)));words.slice(0,100).forEach((w,i)=>{const angle=i*2.399,rad=18+Math.sqrt(i+1)*Math.min(W,H)*.055,x=W/2+Math.cos(angle)*rad,y=H/2+Math.sin(angle)*rad*.72,size=18+Math.sqrt(((w.count||0)+(w.likes||0))/max)*40;ctx.save();ctx.shadowColor=['#27d9ef','#8d7bff','#ff8bcb','#ffd166','#69e6ad'][i%5];ctx.shadowBlur=18;ctx.fillStyle=['#6ee7f9','#c4b5fd','#f9a8d4','#fde68a','#86efac'][i%5];ctx.font='700 '+size+'px system-ui';ctx.textAlign='center';ctx.textBaseline='middle';ctx.fillText(w.text,x,y);ctx.restore()})};
 const renderArchiveDetail=topic=>{detail.hidden=false;const live=topic.interactionState?.words||[];detail.innerHTML='<div class="archive-live-heading"><span class="live-dot"></span><strong>歷史主題互動畫面</strong><small>'+esc(topic.title||topic.question)+'</small></div><p>'+esc(topic.question)+'</p><div class="archive-cloud-grid"><section><h3>原始封存成果</h3><canvas id="archiveOriginalCanvas" class="archive-live-canvas"></canvas><p>'+topic.words.length+' 個詞語 · '+(topic.responses||0)+' 次投稿</p></section><section><h3>再次互動即時畫面</h3><canvas id="archiveRoundCanvas" class="archive-live-canvas"></canvas><p>新回合 '+(topic.interactionState?.responses||0)+' 次投稿 · '+(topic.interactionState?.likesTotal||0)+' 個讚同</p></section></div><div class="archive-word-actions"><h3>原始封存詞語明細（完整）</h3><div class="archive-word-list">'+(topic.words.length?topic.words.map(w=>'<div class="archive-word-row"><strong>'+esc(w.text)+'</strong><span>投稿 '+Number(w.count||0)+' · 讚同 '+Number(w.likes||0)+'</span><small>'+(Array.isArray(w.participants)?w.participants.map(p=>esc(p.label)+(Number(p.submissions)>1?' ×'+p.submissions:'')).join('、'):'')+'</small></div>').join(''):'<p>沒有詞語資料</p>')+'</div></div><div class="archive-word-actions"><h3>新回合詞語明細：按讚參與</h3><div class="archive-word-list">'+(live.length?live.map(w=>{const liked=(topic.interactionState?.liked||[]).includes(w.text);return '<div class="archive-word-row"><strong>'+esc(w.text)+'</strong><span>投稿 '+Number(w.count||0)+' · 讚同 '+Number(w.likes||0)+'</span><button type="button" class="archive-like-chip" data-word="'+esc(w.text)+'" '+(liked?'disabled':'')+'>'+(liked?'✓ 已讚同':'👍 按讚')+'</button></div>'}).join(''):'<p>還沒有新的投稿，成為第一位參與者吧！</p>')+'</div></div>'+(topic.canInteract?'<form id="archiveSubmitForm" class="archive-submit-form"><label for="archiveWords">加入這次歷史互動（1～3 個詞語）</label><textarea id="archiveWords" maxlength="80" required placeholder="輸入詞語，以逗號或換行分隔"></textarea><button class="primary">送出並加入即時文字雲</button></form>':topic.isCurrentTopic?'<div class="archive-current-notice"><strong>這是目前活動主題</strong><p>主持人尚未開放此歷史互動頁。可前往目前活動頁投稿；若要在本頁加入，請主持人開放此歷史主題。</p><a class="primary" href="'+API_ROOT+'/join">前往目前活動投稿</a></div>':'<p class="field-hint">此主題目前僅供查看，不能新增投稿或讚同。</p>');drawArchiveCloud($('#archiveOriginalCanvas'),topic.words);drawArchiveCloud($('#archiveRoundCanvas'),live);detail.querySelectorAll('.archive-like-chip').forEach(btn=>btn.onclick=async()=>{try{await api('/api/history/'+activeArchiveId+'/like',{method:'POST',body:{text:btn.dataset.word}});await refreshArchiveDetail()}catch(e){toast(e.message)}});const form=$('#archiveSubmitForm');if(form)form.onsubmit=async e=>{e.preventDefault();const button=form.querySelector('button');button.disabled=true;try{await api('/api/history/'+activeArchiveId+'/submit',{method:'POST',body:{text:$('#archiveWords').value}});$('#archiveWords').value='';toast('已加入歷史主題的新互動回合！');await refreshArchiveDetail()}catch(err){toast(err.message)}finally{button.disabled=false}}};
 const refreshArchiveDetail=async()=>{if(!activeArchiveId)return;const input=$('#archiveWords');if(input&&document.activeElement===input)return;try{const response=await api('/api/history/'+activeArchiveId);const topic=await response.json();renderArchiveDetail(topic)}catch(e){status.textContent=e.message}};
 const openArchive=async id=>{activeArchiveId=id;await refreshArchiveDetail();if(archiveMonitorTimer)clearInterval(archiveMonitorTimer);archiveMonitorTimer=setInterval(refreshArchiveDetail,3000)};
 (async()=>{try{const response=await api('/api/my/history?limit=50'),page=await response.json();if(page.disabled){status.textContent='主持人目前已關閉個人歷史功能。';return}if(!page.items.length){status.textContent='目前沒有可顯示的歷史互動紀錄。';return}status.textContent='找到 '+page.items.length+' 筆歷史互動。選擇主題即可觀看封存成果及即時互動畫面。';cards.replaceChildren();page.items.forEach(item=>{const card=document.createElement('button');card.className='history-card';card.type='button';card.innerHTML='<strong>'+esc(item.title)+'</strong><span class="archive-card-question">'+esc(item.question)+'</span><span>'+esc(new Date(item.createdAt).toLocaleString())+'</span><small>我的投稿 '+item.submissions+' · 我的讚同 '+item.likes+' · '+(item.accessMode==='open'?'開放互動':item.accessMode==='view'?'僅供查看':'不開放')+'</small>';card.onclick=()=>openArchive(item.id);cards.append(card)})}catch(e){status.textContent=e.message}})();
}else if(mode==='join'){
 const room=participantRoom;$('#joinCanvas').addEventListener('click',async event=>{if(!state||!['moles','fishing'].includes(state.style))return;const rect=event.currentTarget.getBoundingClientRect(),x=event.clientX-rect.left,y=event.clientY-rect.top;const target=[...gamePositions].reverse().find(p=>x>=p.left&&x<=p.left+p.w&&y>=p.top&&y<=p.top+p.h);if(!target)return;if(!target.up){toast(state.style==='moles'?'地鼠還沒露頭，請點下方按讚按鈕。':'魚還沒浮上水面，請點下方按讚按鈕。');return}if((state.liked||[]).includes(target.text)||pendingLikes.has(target.text))return;pendingLikes.add(target.text);try{await api('/api/like',{method:'POST',body:{text:target.text,room,round:state.round,hit:true,gameStyle:state.style}});gameHitUntil.set(target.text,performance.now()+3200);gameHitWord=target.text;gameHitStyle=state.style;gameHitBannerUntil=performance.now()+3200;toast(state.style==='moles'?'敲中「'+target.text+'」！':'釣到「'+target.text+'」！');await refresh()}catch(e){toast(e.message)}finally{pendingLikes.delete(target.text)}});const myHistoryLink=$('#myHistoryLink');if(myHistoryLink)myHistoryLink.href=API_ROOT+'/my-history';
 api('/api/join').then(r=>r.json()).then(v=>{ready=new URL(v.join).searchParams.get('room')===room;updateSubmit();if(state)renderEndorsements();if(!ready){$('#submitStatus').textContent='活動連結已失效，請重新掃描現場 QR Code。';$('#submitStatus').className='submit-status error'}}).catch(()=>setConnection(false));
 syncParticipantName();askParticipantName();$('#changeParticipantName').onclick=()=>askParticipantName(true);$('#feedbackNotificationsButton').onclick=openFeedbackNotifications;$('#feedbackNotificationsClose').onclick=()=>$('#feedbackNotificationsDialog').close();$('#feedbackThreadClose').onclick=()=>$('#feedbackThreadDialog').close();$('#feedbackComposeCancel').onclick=()=>$('#feedbackComposeDialog').close();$('#feedbackComposeForm').onsubmit=async e=>{e.preventDefault();const body=$('#feedbackComposeBody').value.trim(),word=feedbackTargetWord,question=feedbackTargetQuestion;if(!body){$('#feedbackComposeStatus').textContent='請先寫下回饋內容。';return}if(!word){$('#feedbackComposeStatus').textContent='找不到回饋對象，請關閉視窗後重新點選「回饋」。';return}if([...body].length>300){$('#feedbackComposeStatus').textContent='回饋內容最多 300 字。';return}const submit=$('#feedbackComposeSubmit');if(submit.disabled)return;submit.disabled=true;submit.textContent='公開中…';$('#feedbackComposeStatus').textContent='正在安全送出，請稍候…';try{await api('/api/feedback',{method:'POST',body:{word,body,question,label:participantName||'匿名'}});$('#feedbackComposeDialog').close();$('#feedbackComposeBody').value='';toast('回饋已公開，原始投稿者會收到通知。')}catch(err){$('#feedbackComposeStatus').textContent='尚未成功公開：'+err.message+'。文字已保留，請確認連線後再試一次。'}finally{submit.disabled=false;submit.textContent='公開回饋'}};$('#participantNameForm').onsubmit=e=>{const value=$('#participantNameInput').value.trim();if(e.submitter&&e.submitter.id==='skipParticipantName'){participantName='';localStorage.removeItem(participantStorageKey);}else if(value&&!validParticipantName(value)){e.preventDefault();toast('小名請輸入 1～5 個中英文或數字');return;}else if(value){participantName=value;localStorage.setItem(participantStorageKey,value);}else{participantName='';localStorage.removeItem(participantStorageKey);}sessionStorage.setItem('junba-name-prompted-v2:'+participantRoom,'1');syncParticipantName();};$('#submitForm').onsubmit=async e=>{
  e.preventDefault();if(!state||!ready||submitting)return;submitting=true;const currentRound=state.round;const b=$('#submitWords');b.disabled=true;b.textContent='送出中…';$('#submitStatus').textContent='';
  try{await api('/api/submit',{method:'POST',body:{text:$('#words').value,label:participantName,room,round:currentRound}});$('#words').value='';$('#submitStatus').className='submit-status';$('#submitStatus').textContent='✓ 已收到！你的想法已加入文字雲。';}
  catch(e){$('#submitStatus').className='submit-status error';$('#submitStatus').textContent=e.message;await refresh()}
  finally{submitting=false;updateSubmit()}
 };
}else{
 if(IS_CLOUD){$('#screenJoin p').innerHTML='使用自己的 Wi-Fi 或 4G／5G<br>掃碼，輸入 1～3 個詞語';$('.screen-cloud .empty-cloud p').textContent='使用自己的網路，掃碼加入我們。';}loadJoin();$('#screenPNG').onclick=savePNG;
 $('#fullScreen').onclick=async()=>{try{if(!document.fullscreenElement){await document.documentElement.requestFullscreen()}else{await document.exitFullscreen()}}catch{toast('此瀏覽器不支援全螢幕，可直接觀看目前畫面。筆電也可嘗試 F11。')}};
 $('#toggleQR').onclick=()=>{$('#screen').classList.toggle('no-qr');$('#toggleQR').textContent=$('#screen').classList.contains('no-qr')?'顯示 QR':'隱藏 QR';setTimeout(paint,0)};
}
refresh();
let events,retryTimer;function reconnect(){clearTimeout(retryTimer);if(events)events.close();if(IS_CLOUD){const url=new URL(API_ROOT+'/ws',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';events=new WebSocket(url);events.onmessage=e=>{try{const message=JSON.parse(e.data);if(message?.type==='gameHit'){gameHitUntil.set(message.text,performance.now()+3200);gameHitWord=message.text;gameHitStyle=message.style;gameHitBannerUntil=performance.now()+3200;paint();}else if(message?.type==='feedback'){refreshFeedbackNotificationBadge();const thread=$('#feedbackThreadDialog');if(mode==='join'&&thread?.open&&activeFeedbackWord===message.word)openFeedbackThread(activeFeedbackWord);if(mode==='join'&&$('#feedbackNotificationsDialog')?.open)loadFeedbackNotifications();}else consume(message)}catch{refresh()}};events.onclose=()=>{refresh();retryTimer=setTimeout(reconnect,2200)};events.onerror=()=>{refresh()};}else{events=new EventSource('/api/events');events.onmessage=()=>refresh();events.onerror=()=>setConnection(false);}refresh()}reconnect();
window.addEventListener('online',reconnect);window.addEventListener('pageshow',()=>{refresh();if(mode==='join')refreshFeedbackNotificationBadge()});document.addEventListener('visibilitychange',()=>{if(!document.hidden){reconnect();if(mode==='join')refreshFeedbackNotificationBadge()}});
setInterval(()=>{if(!IS_CLOUD||!events||events.readyState!==1)refresh()},IS_CLOUD?(mode==='screen'?2500:5000):5000);setInterval(()=>{if(state){paint();if(mode==='join')renderEndorsements(true)}},1000);if(mode==='join'&&IS_CLOUD){refreshFeedbackNotificationBadge();setInterval(refreshFeedbackNotificationBadge,4000)}
if(document.fonts)document.fonts.ready.then(paint);

if(typeof ResizeObserver!=="undefined"){const obs=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(paint,80)});obs.observe(mode==="host"?$(".cloud-stage"):mode==="screen"?$(".screen-cloud"):$(".participant-cloud"));}

if(mode==="join")$("#phoneCloud").ontoggle=()=>setTimeout(paint,0);

let loadedAppearanceFont='';function ensureCloudFont(){if(!state||!document.fonts||!document.fonts.load)return;const font=state.font||'round';if(loadedAppearanceFont===font)return;loadedAppearanceFont=font;const names=font==='mixed'?['JunbaRound','JunbaSerif']:font==='round'?['JunbaRound']:font==='serif'?['JunbaSerif']:[];Promise.all(names.map(n=>document.fonts.load('700 24px '+n))).then(()=>paint()).catch(()=>{});}if(document.fonts)ensureCloudFont();
