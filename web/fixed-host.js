'use strict';
const ROOM='8082f8ffa91e4f2c89ec6346';
const form=document.querySelector('#fixedHostForm');
const field=document.querySelector('#hostKey');
const button=document.querySelector('#fixedHostButton');
const status=document.querySelector('#fixedHostStatus');
form.addEventListener('submit',async event=>{
 event.preventDefault();
 const key=field.value.trim().toLowerCase();
 if(!/^[a-f0-9]{32}$/.test(key)){
  status.textContent='憑證格式不正確：這裡需要原主持人專屬的 32 位英數 Key，不是建立活動時輸入的 4 位數活動管理碼。請從原主持人連結 #key= 後方取得。';
  field.focus();return;
 }
 button.disabled=true;status.textContent='正在驗證原始活動權限…';
 try{
  const response=await fetch('/r/'+ROOM+'/api/admin/config',{headers:{Authorization:'Bearer '+key},cache:'no-store'});
  const data=await response.json();
  if(!response.ok){
   if(response.status===403)throw new Error('這組 32 位 Key 與指定的原活動不符。請確認使用的是活動 ID '+ROOM+' 當時產生的主持人 Key。');
   throw new Error(data.error||'目前無法驗證原始活動，請稍後再試。');
  }
  sessionStorage.setItem('junba-host-key',key);
  field.value='';
  status.textContent='驗證成功，正在開啟固定活動…';
  location.assign('/r/'+ROOM+'/host');
 }catch(error){status.textContent=error.message;button.disabled=false;field.focus();}
});
