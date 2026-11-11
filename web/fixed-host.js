'use strict';
const ROOM='8082f8ffa91e4f2c89ec6346';
const form=document.querySelector('#fixedHostForm');
const field=document.querySelector('#hostKey');
const button=document.querySelector('#fixedHostButton');
const status=document.querySelector('#fixedHostStatus');
form.addEventListener('submit',async event=>{
 event.preventDefault();
 const key=field.value.trim();
 if(!key){status.textContent='請輸入主持人 Key。';return;}
 button.disabled=true;status.textContent='正在驗證原始活動權限…';
 try{
  const response=await fetch('/r/'+ROOM+'/api/admin/config',{headers:{Authorization:'Bearer '+key},cache:'no-store'});
  const data=await response.json();
  if(!response.ok)throw new Error(data.error||'Key 驗證失敗，請確認是否為原始主持人 Key。');
  sessionStorage.setItem('junba-host-key',key);
  field.value='';
  status.textContent='驗證成功，正在開啟固定活動…';
  location.assign('/r/'+ROOM+'/host');
 }catch(error){status.textContent=error.message;button.disabled=false;field.focus();}
});
