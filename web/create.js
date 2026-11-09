'use strict';
const form=document.querySelector('#createForm'),button=document.querySelector('#createButton'),status=document.querySelector('#createStatus'),keyField=document.querySelector('#setupKey');
let setupUnavailable=false;
async function checkSetup(){
 try{
  const r=await fetch('/api/setup-status',{cache:'no-store'});if(!r.ok)return;
  const v=await r.json();
  if(v.ready===false){setupUnavailable=true;button.disabled=true;status.textContent=v.error||'請先完成網站的活動管理碼設定。';}
 }catch{}
}
keyField.addEventListener('input',()=>{
 if(setupUnavailable)return;
 keyField.value=keyField.value.replace(/\D/g,'').slice(0,4);
 const valid=/^\d{4}$/.test(keyField.value);
 status.textContent=keyField.value.length>0&&!valid?'活動管理碼必須是 4 位數字。':'';
});
form.onsubmit=async e=>{
 e.preventDefault();if(setupUnavailable)return;
 if(!/^\d{4}$/.test(keyField.value)){status.textContent='請輸入完整的 4 位數字活動管理碼。';return;}
 button.disabled=true;status.textContent='建立中…';
 try{
  const r=await fetch('/api/new',{method:'POST',headers:{Authorization:'Bearer '+keyField.value}}),v=await r.json();
  if(!r.ok)throw Error(v.error||'無法建立活動');
  keyField.value='';location.assign(v.host);
 }catch(e){status.textContent=e.message;button.disabled=setupUnavailable;}
};
checkSetup();