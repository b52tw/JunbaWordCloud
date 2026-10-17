'use strict';
const $=s=>document.querySelector(s);
const route=location.pathname.replace(/\/$/,'');const match=route.match(/^\/r\/([a-z0-9]{12,40})(?:\/|$)/);const cloudRoom=match?match[1]:$('meta[name="junba-room"]')?.content||'';const API_ROOT=cloudRoom?'/r/'+cloudRoom:'';const IS_CLOUD=!!cloudRoom;
const participantRoom=new URLSearchParams(location.search).get('room')||cloudRoom;
const mode=route.endsWith('/join')?'join':route.endsWith('/screen')?'screen':'host';
$('#'+mode).hidden=false;
const auth=new URLSearchParams(location.hash.slice(1)).get('key');
if(auth){sessionStorage.setItem('junba-host-key',auth);history.replaceState(null,'',location.pathname+location.search)}
const key=sessionStorage.getItem('junba-host-key')||'';
let state=null,config=null,link='',ready=false,connected=false,loading=false,submitting=false,lastPaint='',displayedRound='',endorseSignature='',toastTimer,networkLoaded=false;
const palette={night:['#f9d590','#92c6b7','#b1c5f5','#f49e86','#d2b8ec','#ebede9','#88bcd2'],paper:['#ad694b','#627f68','#aa8c47','#566b95','#a57486','#7a898c','#826d55'],orange:['#be5a31','#737d40','#957242','#a87967','#7c6554','#d28b37','#744c36']};
function toast(msg){$('#toast').textContent=msg;$('#toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('#toast').hidden=true,4000)}
async function api(path,{method='GET',body,admin=false}={}){
 const headers={};if(body!==undefined)headers['Content-Type']='application/json';if(admin)headers.Authorization='Bearer '+key;
 const r=await fetch(API_ROOT+path,{method,headers,body:body===undefined?undefined:JSON.stringify(body),cache:'no-store'});
 if(!r.ok){let m;try{m=(await r.json()).error}catch{};throw Error(m||'連線失敗，請確認程式仍在執行。')}
 return r;
}
async function act(body){await api('/api/admin/action',{method:'POST',body,admin:true});await refresh();}
function setConnection(ok){connected=ok;const label=mode==='host'?$('#connection'):mode==='screen'?$('#screenConnection'):$('#joinConnection');label.textContent=ok?(mode==='screen'?'':'即時連線中'):'連線中斷，重新連線中…';if(mode==='join'){updateSubmit();if(state)renderEndorsements();}}
async function refresh(){
 if(loading)return;loading=true;
 try{const next=await(await api('/api/state')).json();consume(next);}catch(e){setConnection(false)}finally{loading=false}
}
function consume(next){if(!Array.isArray(next.liked))next.liked=state&&state.voteEpoch===next.voteEpoch?(state.liked||[]):[];state=next;setConnection(true);render();ensureCloudFont();}
function updateSubmit(){if(!state)return;const b=$('#submitWords');b.disabled=submitting||!state.open||!ready||!connected;b.textContent=submitting?'送出中…':!ready?'活動連結無效':!connected?'等待重新連線…':state.open?'送出我的想法 ↗':'主持人已暫停收件';}
function render(){
 if(!state)return;
 if(mode==='join'){
  const old=$('#joinQuestion').textContent;$('#joinQuestion').textContent=state.question;
  if(displayedRound&&displayedRound!==state.round){$('#submitStatus').textContent=old===state.question?'主持人已清空重來，現在可以重新投稿。':'題目已更新，請確認後再送出。';$('#submitStatus').className='submit-status';}
  displayedRound=state.round;
  $('#joinResponses').textContent=state.responses;$('#joinLikes').textContent=state.likesTotal||0;$('.participant-cloud').dataset.theme=state.theme;$('#joinCloudEmpty').hidden=state.words.length>0;const sig=JSON.stringify([state.words,state.theme,state.font,state.style,state.motion]);if(sig!==lastPaint){lastPaint=sig;paint()}renderEndorsements();
  updateSubmit();return;
 }
 const panel=mode==='host'?$('.cloud-panel'):$('#screen');panel.dataset.theme=state.theme;
 if(mode==='host'){
  $('#previewQuestion').textContent=state.question;$('#responseCount').textContent=state.responses;$('#likeCount').textContent=state.likesTotal||0;$('#wordCount').textContent=state.words.length;$('#listCount').textContent=state.words.length;
  $('#statusLabel').textContent=state.open?'● 開放投稿中':'Ⅱ 已暫停收件';$('#pause').textContent=state.open?'暫停收件':'繼續收件';
  if(!networkLoaded){$('#question').value=state.question;$('#theme').value=state.theme;$('#font').value=state.font||'round';$('#cloudStyle').value=state.style||'clouds';$('#motion').value=state.motion||'gentle';networkLoaded=true}
  const container=$('#wordList');container.replaceChildren();
  state.words.forEach(w=>{const chip=document.createElement('div');chip.className='word-chip';const word=document.createElement('span');word.textContent=w.text;const count=document.createElement('strong');count.textContent='投稿 '+w.count+' · 讚同 '+(w.likes||0)+' · 熱度 '+heat(w);const del=document.createElement('button');del.type='button';del.textContent='×';del.title='刪除「'+w.text+'」';del.setAttribute('aria-label',del.title);del.onclick=async()=>{if(!confirm('刪除「'+w.text+'」及其投稿與讚同計數？'))return;try{await act({action:'delete',text:w.text})}catch(e){toast(e.message)}};chip.append(word,count,del);container.append(chip)});
  $('#listEmpty').hidden=state.words.length>0;
 }else{
  $('#screenQuestion').textContent=state.question;$('#screenResponses').textContent=state.responses;$('#screenLikes').textContent=state.likesTotal||0;$('#screenStatus').textContent=state.open?'● 開放投稿中':'Ⅱ 暫停收件';
 }
 const signature=JSON.stringify([state.words,state.theme,state.font,state.style,state.motion]);if(signature!==lastPaint){lastPaint=signature;paint()}
 document.querySelectorAll('.empty-cloud').forEach(el=>el.hidden=state.words.length>0);
 if(mode==='screen')loadJoin();
}
const pendingLikes=new Set();
function renderEndorsements(force=false){
 if(!state)return;const sig=JSON.stringify([state.words,state.liked,state.open,ready,connected,[...pendingLikes]]);if(!force&&sig===endorseSignature)return;endorseSignature=sig;
 const list=$('#endorseList');const scrollTop=list.scrollTop;list.replaceChildren();const liked=new Set(state.liked||[]);
 state.words.forEach(word=>{const row=document.createElement('div');row.className='endorse-row';const info=document.createElement('div');info.className='endorse-info';const name=document.createElement('strong');name.textContent=word.text;const meta=document.createElement('small');meta.textContent='投稿 '+word.count+' · 讚同 '+(word.likes||0)+' · 熱度 '+heat(word);info.append(name,meta);
 const b=document.createElement('button');b.type='button';b.className=liked.has(word.text)?'like-button liked':'like-button';b.textContent=liked.has(word.text)?'✓ 已讚同':'👍 讚同';b.disabled=liked.has(word.text)||pendingLikes.has(word.text)||!state.open||!ready||!connected;b.setAttribute('aria-label',b.textContent+'「'+word.text+'」');
 b.onclick=async()=>{if(pendingLikes.has(word.text))return;pendingLikes.add(word.text);b.disabled=true;try{await api('/api/like',{method:'POST',body:{text:word.text,room:participantRoom,round:state.round}});toast('已讚同「'+word.text+'」！')}catch(e){toast(e.message)}finally{pendingLikes.delete(word.text);await refresh();renderEndorsements(true)}};
 row.append(info,b);list.append(row)});list.scrollTop=scrollTop;$('#endorseEmpty').hidden=state.words.length>0;
}
function hash(s){let h=2166136261;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),16777619);return h>>>0}
function heat(w){return w.count+(w.likes||0)}
function fontFamily(text){const choice=state.font==='mixed'?['round','serif','sans'][hash(text)%3]:(state.font||'round');return choice==='round'?'JunbaRound, "Microsoft JhengHei", sans-serif':choice==='serif'?'JunbaSerif, "Noto Serif CJK TC", serif':'"Microsoft JhengHei", "PingFang TC", sans-serif'}
function cloudLines(text){const chars=[...text],lines=[];for(let i=0;i<chars.length;i+=12)lines.push(chars.slice(i,i+12).join(''));return lines;}
function layoutWords(ctx,words,W,H,scale=1){
 if(!words.length)return [];const clouds=(state.style||'clouds')==='clouds',largest=heat(words[0]);
 const weightedArea=words.reduce((sum,w)=>sum+Math.max(2,[...w.text].length)*Math.pow(.4+.6*Math.sqrt(heat(w)/largest),2),0);
 const ideal=Math.min(W*.14,H*.23,112,Math.sqrt(W*H*(clouds?.26:.42)/Math.max(6,weightedArea*1.4)))*scale;
 const grid=5,gw=Math.ceil(W/grid),gh=Math.ceil(H/grid),occ=new Uint8Array(gw*gh),positions=[];
 function free(x,y,w,h){if(x<8||y<8||x+w>W-8||y+h>H-8)return false;const x1=Math.floor(x/grid),y1=Math.floor(y/grid),x2=Math.ceil((x+w)/grid),y2=Math.ceil((y+h)/grid);for(let yy=y1;yy<y2;yy++)for(let xx=x1;xx<x2;xx++)if(occ[yy*gw+xx])return false;return true;}
 function mark(x,y,w,h){const x1=Math.floor(x/grid),y1=Math.floor(y/grid),x2=Math.ceil((x+w)/grid),y2=Math.ceil((y+h)/grid);for(let yy=y1;yy<y2;yy++)for(let xx=x1;xx<x2;xx++)occ[yy*gw+xx]=1;}
 words.forEach(word=>{
  let size=Math.max(11*scale,ideal*(.4+.6*Math.sqrt(heat(word)/largest)));const lines=clouds?cloudLines(word.text):[word.text];size=Math.min(size,(W-45)/Math.max(1,...lines.map(l=>[...l].length)));if(size<8)return;
  const font=fontFamily(word.text);ctx.font='700 '+size+'px '+font;const pad=clouds?Math.max(12,size*.4):7,w=Math.ceil(Math.max(...lines.map(l=>ctx.measureText(l).width)))+pad*2,h=Math.ceil(size*1.14*lines.length+pad*2+(clouds?size*.35:0));const phase=(hash(word.text)%628)/100;
  for(let t=0;t<2400;t++){const angle=t*.37+phase,rad=Math.sqrt(t/2400)*1.1,x=W/2+Math.cos(angle)*rad*W/2-w/2,y=H/2+Math.sin(angle)*rad*H/2-h/2;if(free(x,y,w,h)){mark(x,y,w,h);positions.push({text:word.text,count:word.count,score:heat(word),size,font,lines,left:x,top:y,w,h,x:x+w/2,y:y+h/2+size*.36-(lines.length-1)*size*.57,color:palette[state.theme][hash(word.text)%7]});break;}}
 });return positions;
}
const CLOUD_PATH='M38 108C15 108 3 96 8 78C10 64 21 56 36 56C32 34 49 17 70 20C80 1 112 0 126 20C151 9 176 26 173 51C207 48 215 98 184 106C165 115 58 117 38 108Z';
function drawCloud(ctx,p){ctx.save();ctx.translate(p.left,p.top);ctx.scale(p.w/210,p.h/120);ctx.globalAlpha=.2;ctx.fillStyle=p.color;ctx.beginPath();ctx.moveTo(38,108);[[15,108,3,96,8,78],[10,64,21,56,36,56],[32,34,49,17,70,20],[80,1,112,0,126,20],[151,9,176,26,173,51],[207,48,215,98,184,106],[165,115,58,117,38,108]].forEach(a=>ctx.bezierCurveTo(...a));ctx.closePath();ctx.fill();ctx.restore();}
function paint(){
 if(!state)return;const canvas=mode==='host'?$('#hostCanvas'):mode==='screen'?$('#screenCanvas'):$('#joinCanvas');const box=canvas.getBoundingClientRect();if(box.width<10||box.height<10)return;
 const W=box.width,H=box.height,dpr=Math.min(2,window.devicePixelRatio||1),clouds=(state.style||'clouds')==='clouds',motion=state.motion||'gentle';canvas.width=Math.round(W*dpr);canvas.height=Math.round(H*dpr);const ctx=canvas.getContext('2d');ctx.scale(dpr,dpr);ctx.clearRect(0,0,W,H);
 const words=state.words.slice(0,motion==='eco'?60:mode==='join'?100:200);let positions=layoutWords(ctx,words,W,H);if(positions.length<words.length*.9){const small=layoutWords(ctx,words,W,H,.75);if(small.length>positions.length)positions=small;}
 ctx.textAlign='center';ctx.textBaseline='alphabetic';positions.forEach(p=>{if(clouds)drawCloud(ctx,p);ctx.font='700 '+p.size+'px '+p.font;ctx.fillStyle=p.color;p.lines.forEach((line,i)=>ctx.fillText(line,p.x,p.y+i*p.size*1.14));});
 let layer=canvas.parentElement.querySelector('.bubble-layer');if(!layer){layer=document.createElement('div');layer.setAttribute('aria-hidden','true');canvas.parentElement.append(layer)}layer.className='bubble-layer motion-'+motion;layer.hidden=!clouds||motion==='eco';canvas.style.opacity=layer.hidden?'1':'0';
 if(!layer.hidden){const old=new Map([...layer.children].map(n=>[n.dataset.word,n]));positions.forEach(p=>{let shell=old.get(p.text);const fresh=!shell;if(!shell){shell=document.createElement('div');shell.className='bubble-shell bubble-enter';shell.dataset.word=p.text;const entry=document.createElement('div');entry.className='bubble-entry';const sway=document.createElement('div');sway.className='bubble-sway';const label=document.createElement('span');label.className='bubble-label';sway.append(label);entry.append(sway);shell.append(entry);layer.append(shell)}old.delete(p.text);const entry=shell.children[0],sway=entry.children[0],label=sway.children[0];Object.assign(shell.style,{left:p.left+'px',top:p.top+'px',width:p.w+'px',height:p.h+'px'});Object.assign(label.style,{fontFamily:p.font,fontSize:p.size+'px',fontWeight:'700',color:p.color});label.textContent=p.lines.join('\n');sway.style.backgroundImage='url("data:image/svg+xml,'+encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 210 120" preserveAspectRatio="none"><path d="'+CLOUD_PATH+'" fill="'+p.color+'" fill-opacity=".2"/></svg>')+'")';sway.style.setProperty('--sway-time',(4+hash(p.text)%40/10)+'s');sway.style.setProperty('--sway-delay',-(hash(p.text)%50/10)+'s');if(!fresh&&Number(shell.dataset.score)!==p.score){shell.classList.remove('bubble-enter','bubble-pulse');void shell.offsetWidth;shell.classList.add('bubble-pulse')}shell.dataset.score=p.score;});old.forEach(n=>n.remove());}else{layer.replaceChildren()}
 canvas.setAttribute('aria-label','文字雲：'+words.map(w=>w.text+'，投稿 '+w.count+' 次，讚同 '+(w.likes||0)+' 次').join('、'));canvas.dataset.shown=positions.length;canvas.dataset.total=state.words.length;
 if(mode==='host'&&state.words.length>positions.length)$('#statusLabel').textContent=(state.open?'● 開放投稿中':'Ⅱ 已暫停收件')+' · 顯示 '+positions.length+' 個熱門詞';
}
let resizeTimer;window.addEventListener('resize',()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(paint,120)});
function downloadBlob(blob,name){const url=URL.createObjectURL(blob),a=document.createElement('a');a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),10000)}
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
 if(!key){toast(IS_CLOUD?'請使用先前保存的完整主持連結開啟，或掃描主持人專用 QR Code。':'主持台憑證已失效。請重新開啟 EXE，再使用自動開啟的主持台。');document.querySelectorAll('#host button,#host select,#host textarea').forEach(e=>e.disabled=true)}
 async function loadConfig(){
  try{config=await(await api('/api/admin/config',{admin:true})).json();renderQuestionBank();link=config.shortJoin||config.join;$('#network').replaceChildren();config.links.forEach(l=>{const o=document.createElement('option');o.value=l.split('/join?')[0];o.textContent=l.split('/join?')[0];o.selected=l===config.join;$('#network').append(o)});$('#hostQR').src=API_ROOT+'/qr.png?v='+Date.now();$('#testJoin').href=link;$('#dataNote').textContent=IS_CLOUD?'結果自動儲存在活動帳號。':'自動儲存：'+config.dataPath;$('#networkWarning').textContent=IS_CLOUD?'線上活動：可使用各自的 Wi-Fi 或 4G／5G。':link.includes('127.0.0.1')?'目前只有本機網址，手機無法使用。請先將筆電連上學校 Wi-Fi 或手機熱點，再按「重新偵測網路」。':'請確認這是實際使用的 Wi-Fi 網址。';}
  catch(e){toast(e.message)}
 }

 function renderQuestionBank(){const select=$('#questionBank'),previous=select.value;select.replaceChildren();const questions=config.questions||[];questions.forEach(q=>{const o=document.createElement('option');o.value=q;o.textContent=q;select.append(o)});if(questions.includes(previous))select.value=previous;else if(state&&questions.includes(state.question))select.value=state.question;$('#bankCount').textContent=questions.length+' / 100';['bankLoad','bankUse','bankDelete','bankExport'].forEach(id=>$('#'+id).disabled=!questions.length);}
 $('#bankSave').onclick=async()=>{try{await act({action:'questionSave',question:$('#question').value});await loadConfig();$('#questionBank').value=$('#question').value.trim();toast('已存入題庫。')}catch(e){toast(e.message)}};
 $('#bankLoad').onclick=()=>{if($('#questionBank').value){$('#question').value=$('#questionBank').value;toast('已帶入，可編輯後套用。')}};
 $('#bankUse').onclick=async()=>{const question=$('#questionBank').value;if(!question)return;if(state&&(state.responses||state.likesTotal||state.words.length)&&!confirm('換成「'+question+'」並清空目前投稿及讚同？可先取消並匯出本題結果。題庫與 QR Code 保留。'))return;try{await act({action:'questionUse',question});$('#question').value=question;toast('已換題並重新開放收件。')}catch(e){toast(e.message)}};
 $('#bankDelete').onclick=async()=>{const question=$('#questionBank').value;if(!question||!confirm('從題庫刪除「'+question+'」？不會改動目前進行中的題目。'))return;try{await act({action:'questionDelete',question});await loadConfig();toast('已從題庫移除。')}catch(e){toast(e.message)}};
 $('#bankExport').onclick=()=>downloadBlob(new Blob([JSON.stringify({schema:'junba-question-bank-v1',questions:config.questions||[]},null,2)],{type:'application/json;charset=utf-8'}),'Junba_Question_Bank.json');
 $('#bankImport').onclick=()=>$('#bankImportFile').click();
 $('#bankImportFile').onchange=async e=>{try{const file=e.target.files[0];if(!file)return;if(file.size>65536)throw Error('題庫檔案過大，最多 64 KB');const value=JSON.parse(await file.text()),questions=Array.isArray(value)?value:value.questions;if(!Array.isArray(questions)||!questions.every(q=>typeof q==='string'))throw Error('題庫格式不正確');await act({action:'questionsImport',questions});await loadConfig();toast('已合併題庫，重複題目會自動略過。')}catch(e){toast(e.message)}finally{e.target.value=''}};
 $('#settingsForm').onsubmit=async e=>{e.preventDefault();try{await act({action:'settings',question:$('#question').value,theme:$('#theme').value,font:$('#font').value,style:$('#cloudStyle').value,motion:$('#motion').value});toast('已套用。')}catch(e){toast(e.message)}};
 $('#refreshNetwork').onclick=async()=>{const b=$('#refreshNetwork');b.disabled=true;try{await act({action:'refreshNetwork'});await loadConfig();toast('網路已重新偵測，請使用畫面上的 QR Code。')}catch(e){toast(e.message)}finally{b.disabled=false}};
 $('#network').onchange=async()=>{try{await act({action:'network',base:$('#network').value});await loadConfig();toast('QR Code 已更新，請使用新的網址。')}catch(e){toast(e.message)}};
 $('#pause').onclick=async()=>{try{await act({action:'toggle'})}catch(e){toast(e.message)}};
 $('#clear').onclick=async()=>{if(!confirm('清空所有詞語、投稿次數及讚同數，並重新開放收件？題目、配色與 QR Code 都會保留。需要保留成果時，請先匯出或備份。'))return;try{await act({action:'clear'});toast('已清空重來，重新開放收件。原 QR Code 可繼續使用。')}catch(e){toast(e.message)}};
 $('#launchLite').onclick=()=>window.open(API_ROOT+'/lite','junba-lite');
 $('#launchScreen').onclick=()=>window.open(API_ROOT+'/screen','junba-screen');
 $('#copyLink').onclick=async()=>{try{await navigator.clipboard.writeText(link);toast('已複製投稿網址。')}catch{prompt('請複製以下網址：',link)}};
 $('#savePNG').onclick=savePNG;$('#exportCSV').onclick=()=>downloadAdmin('/api/admin/export','Junba_WordCloud.csv');$('#backup').onclick=()=>downloadAdmin('/api/admin/backup','Junba_WordCloud_backup.json');
 $('#shutdown').onclick=async()=>{if(!confirm('結束文字雲程式？現有資料已自動儲存，所有手機將停止投稿。'))return;try{await api('/api/admin/shutdown',{method:'POST',admin:true});toast('程式已結束，可以關閉此頁。');document.querySelectorAll('#host button,#host select,#host textarea').forEach(e=>e.disabled=true)}catch(e){toast(e.message)}};
 if(IS_CLOUD){document.querySelectorAll('.join-card p').forEach(p=>p.innerHTML='① 使用自己的網路<br>② 掃碼輸入詞語');$('#copyHostLink').hidden=false;$('#copyHostLink').onclick=async()=>{const url=(config?.shortHost||location.origin+API_ROOT+'/host')+'#key='+key;try{await navigator.clipboard.writeText(url);toast('已複製主持連結，請自行保存。')}catch{prompt('請保存這個具有管理權限的主持連結：',url)}};
  $('#showHostQR').hidden=false;let privateQRObjectURL='';$('#showHostQR').onclick=async()=>{const button=$('#showHostQR');button.disabled=true;try{const response=await api('/api/admin/host-qr',{admin:true});if(privateQRObjectURL)URL.revokeObjectURL(privateQRObjectURL);privateQRObjectURL=URL.createObjectURL(await response.blob());$('#privateHostQR').src=privateQRObjectURL;$('#hostQRDialog').showModal()}catch(e){toast(e.message)}finally{button.disabled=false}};$('#closeHostQR').onclick=()=>$('#hostQRDialog').close();$('#hostQRDialog').onclose=()=>{if(privateQRObjectURL){URL.revokeObjectURL(privateQRObjectURL);privateQRObjectURL='';$('#privateHostQR').removeAttribute('src')}};
  $('#copyShortHostLink').onclick=()=>$('#copyHostLink').onclick();$('#copyLongHostLink').onclick=async()=>{const url=location.origin+API_ROOT+'/host#key='+key;try{await navigator.clipboard.writeText(url);toast('已複製主持長連結，請自行保存。')}catch{prompt('請保存這個具有管理權限的主持長連結：',url)}};
  $('#downloadHostQR').onclick=()=>{const image=$('#privateHostQR');if(!image.complete||!image.naturalWidth){toast('QR Code 還在載入，請稍後再按。');return}try{const canvas=document.createElement('canvas');canvas.width=1024;canvas.height=1024;const ctx=canvas.getContext('2d');ctx.fillStyle='#fff';ctx.fillRect(0,0,1024,1024);ctx.drawImage(image,0,0,1024,1024);canvas.toBlob(blob=>{if(blob)downloadBlob(blob,'JunbaWordCloud_Host_QR_PRIVATE.png');else toast('無法下載，請重新開啟主持人 QR Code。')},'image/png')}catch{toast('無法下載，請重新開啟主持人 QR Code。')}};
  $('#refreshNetwork').hidden=true;$('#network').hidden=true;$('.local-badge').textContent='線上活動';$('#networkWarning').textContent='大家可以各用自己的網路，掃碼參與。';$('#shutdown').hidden=true;}if(key)loadConfig();
}else if(mode==='join'){
 const room=participantRoom;
 api('/api/join').then(r=>r.json()).then(v=>{ready=new URL(v.join).searchParams.get('room')===room;updateSubmit();if(state)renderEndorsements();if(!ready){$('#submitStatus').textContent='活動連結已失效，請重新掃描現場 QR Code。';$('#submitStatus').className='submit-status error'}}).catch(()=>setConnection(false));
 $('#submitForm').onsubmit=async e=>{
  e.preventDefault();if(!state||!ready||submitting)return;submitting=true;const currentRound=state.round;const b=$('#submitWords');b.disabled=true;b.textContent='送出中…';$('#submitStatus').textContent='';
  try{await api('/api/submit',{method:'POST',body:{text:$('#words').value,room,round:currentRound}});$('#words').value='';$('#submitStatus').className='submit-status';$('#submitStatus').textContent='✓ 已收到！你的想法已加入文字雲。';}
  catch(e){$('#submitStatus').className='submit-status error';$('#submitStatus').textContent=e.message;await refresh()}
  finally{submitting=false;updateSubmit()}
 };
}else{
 if(IS_CLOUD){$('#screenJoin p').innerHTML='使用自己的 Wi-Fi 或 4G／5G<br>掃碼，輸入 1～3 個詞語';$('.screen-cloud .empty-cloud p').textContent='使用自己的網路，掃碼加入我們。';}loadJoin();$('#screenPNG').onclick=savePNG;
 $('#fullScreen').onclick=async()=>{try{if(!document.fullscreenElement){await document.documentElement.requestFullscreen()}else{await document.exitFullscreen()}}catch{toast('此瀏覽器不支援全螢幕，可直接觀看目前畫面。筆電也可嘗試 F11。')}};
 $('#toggleQR').onclick=()=>{$('#screen').classList.toggle('no-qr');$('#toggleQR').textContent=$('#screen').classList.contains('no-qr')?'顯示 QR':'隱藏 QR';setTimeout(paint,0)};
}
refresh();
let events,retryTimer;function reconnect(){clearTimeout(retryTimer);if(events)events.close();if(IS_CLOUD){const url=new URL(API_ROOT+'/ws',location.href);url.protocol=url.protocol==='https:'?'wss:':'ws:';events=new WebSocket(url);events.onmessage=e=>{try{consume(JSON.parse(e.data))}catch{refresh()}};events.onclose=()=>{setConnection(false);retryTimer=setTimeout(reconnect,4000)};events.onerror=()=>setConnection(false);}else{events=new EventSource('/api/events');events.onmessage=()=>refresh();events.onerror=()=>setConnection(false);}refresh()}reconnect();
window.addEventListener('online',reconnect);window.addEventListener('pageshow',()=>refresh());document.addEventListener('visibilitychange',()=>{if(!document.hidden)reconnect()});
setInterval(()=>{if(!IS_CLOUD||!events||events.readyState!==1)refresh()},IS_CLOUD?(mode==='screen'?2500:15000):5000);
if(document.fonts)document.fonts.ready.then(paint);

if(typeof ResizeObserver!=="undefined"){const obs=new ResizeObserver(()=>{clearTimeout(resizeTimer);resizeTimer=setTimeout(paint,80)});obs.observe(mode==="host"?$(".cloud-stage"):mode==="screen"?$(".screen-cloud"):$(".participant-cloud"));}

if(mode==="join")$("#phoneCloud").ontoggle=()=>setTimeout(paint,0);

let loadedAppearanceFont='';function ensureCloudFont(){if(!state||!document.fonts||!document.fonts.load)return;const font=state.font||'round';if(loadedAppearanceFont===font)return;loadedAppearanceFont=font;const names=font==='mixed'?['JunbaRound','JunbaSerif']:font==='round'?['JunbaRound']:font==='serif'?['JunbaSerif']:[];Promise.all(names.map(n=>document.fonts.load('700 24px '+n))).then(()=>paint()).catch(()=>{});}if(document.fonts)ensureCloudFont();
