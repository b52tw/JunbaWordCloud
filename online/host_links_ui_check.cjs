const fs=require('node:fs'),vm=require('node:vm'),assert=require('node:assert/strict');
const room='1234567890abcdef12345678',key='k'.repeat(32),origin='https://wordcloud.test',copied=[],downloads=[];
class Element{
 constructor(){this.children=[];this.dataset={};this.style={setProperty(){}};this.classList={add(){},remove(){},toggle(){},contains(){return false}};this.hidden=true;this.complete=true;this.naturalWidth=280;this.value='';this.textContent=''}
 append(...nodes){for(const n of nodes){n.parentElement=this;this.children.push(n)}}
 replaceChildren(){this.children=[]}
 querySelector(){return null}
 setAttribute(name,value){this[name]=value}
 removeAttribute(name){delete this[name]}
 getBoundingClientRect(){return {width:900,height:400}}
 getContext(){return {scale(){},clearRect(){},fillRect(){},drawImage(){}}}
 toBlob(callback){callback(new Blob(['test png'],{type:'image/png'}))}
 showModal(){this.open=true}
 close(){this.open=false;this.onclose?.()}
 click(){downloads.push(this.download)}
}
const elements=new Map(),element=s=>{if(!elements.has(s))elements.set(s,new Element());const e=elements.get(s);if(!e.parentElement)e.parentElement=new Element();return e};
element('meta[name="junba-room"]').content=room;
const state={question:'主控台測試',theme:'night',font:'round',style:'clouds',motion:'eco',open:true,round:'round-one',words:[],responses:0,likesTotal:0};
const sandbox={console,URL,URLSearchParams,Blob,ResizeObserver:class{observe(){}},WebSocket:class{close(){}},setTimeout:()=>0,clearTimeout(){},setInterval(){},location:{pathname:'/host',origin,href:origin+'/host',hash:'',search:''},sessionStorage:{getItem(){return key}},window:{devicePixelRatio:1,addEventListener(){}},document:{addEventListener(){},querySelector:element,querySelectorAll(){return []},createElement(){return new Element()}},navigator:{clipboard:{async writeText(text){copied.push(text)}}},fetch:async(path,options={})=>{
 assert(path.startsWith('/r/'+room+'/'));let value={};
 if(path.endsWith('/api/state'))value=state;
 else if(path.endsWith('/api/admin/config')){assert.equal(options.headers.Authorization,'Bearer '+key);value={join:origin+'/r/'+room+'/join?room='+room,shortJoin:origin+'/join',shortHost:origin+'/host',links:[],questions:[]}}
 else if(path.endsWith('/api/admin/host-qr')){assert.equal(options.headers.Authorization,'Bearer '+key);return {ok:true,blob:async()=>new Blob(['<svg/>'],{type:'image/svg+xml'})}}
 return {ok:true,json:async()=>value};
}};
vm.createContext(sandbox);vm.runInContext(fs.readFileSync('web/app.js','utf8'),sandbox);
(async()=>{
 await new Promise(setImmediate);await new Promise(setImmediate);
 assert.equal(element('#privateHostLinkCard').hidden,false);assert.equal(element('#visibleHostShortLink').value,origin+'/host#key='+key);
 await element('#copyVisibleHostLink').onclick();assert.equal(copied.pop(),origin+'/host#key='+key);
 await element('#copyHostLink').onclick();assert.equal(copied.pop(),origin+'/host#key='+key);
 await element('#copyShortHostLink').onclick();assert.equal(copied.pop(),origin+'/host#key='+key);
 await element('#copyLongHostLink').onclick();assert.equal(copied.pop(),origin+'/r/'+room+'/host#key='+key);
 await element('#showHostQR').onclick();assert.equal(element('#hostQRDialog').open,true);assert.match(element('#privateHostQR').src,/^blob:/);
 element('#downloadHostQR').onclick();assert.equal(downloads.pop(),'JunbaWordCloud_Host_QR_PRIVATE.png');
 element('#closeHostQR').onclick();assert.equal(element('#hostQRDialog').open,false);assert.equal(element('#privateHostQR').src,undefined);
 console.log('PASS: short and long host links preserve the credential; authenticated QR opens, downloads PNG and closes');
})().catch(error=>{console.error(error);process.exit(1)});
