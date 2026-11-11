'use strict';
const ROOM='8082f8ffa91e4f2c89ec6346';
const form=document.querySelector('#fixedHostForm');
const field=document.querySelector('#hostKey');
const button=document.querySelector('#fixedHostButton');
const status=document.querySelector('#fixedHostStatus');
const savedKey=sessionStorage.getItem('junba-host-key')||'';
if(savedKey){field.value=savedKey;status.textContent='已帶入此分頁先前保存的主持人憑證；請按下驗證，或改貼原主持人連結 #key= 後方的完整內容。';}
form.addEventListener('submit',async event=>{
 event.preventDefault();
 const key=field.value.trim();
 if(!key){status.textContent='請貼上原主持人連結 #key= 後方的完整憑證。';field.focus();return;}
 button.disabled=true;status.textContent='正在向原活動所在的 Staging 資料庫驗證…';
 try{
  const response=await fetch('/r/'+ROOM+'/api/admin/config',{headers:{Authorization:'Bearer '+key},cache:'no-store'});
  const data=await response.json();
  if(!response.ok){
   if(response.status===403)throw new Error('伺服器已收到憑證，但它與此活動 ID 不符。請勿再猜測其他密碼；我們需要先核對原主持人連結或原始活動資料來源。');
   if(response.status===404)throw new Error('此活動 ID 在目前環境找不到活動資料。請勿建立新活動，以免混淆原始資料。');
   throw new Error(data.error||'目前無法驗證原始活動，請稍後再試。');
  }
  sessionStorage.setItem('junba-host-key',key);
  field.value='';
  status.textContent='驗證成功，正在開啟固定活動…';
  location.assign('/r/'+ROOM+'/host');
 }catch(error){status.textContent=error.message;button.disabled=false;field.focus();}
});
