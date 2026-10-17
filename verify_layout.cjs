const fs=require('fs'),vm=require('vm'),assert=require('assert');
const code=fs.readFileSync('web/app.js','utf8');
const start=code.indexOf('function hash('),end=code.indexOf('function paint(');
const palette={night:['a','b','c','d','e','f','g']};const context={state:{theme:'night'},palette};vm.createContext(context);vm.runInContext(code.slice(start,end),context);
const canvasContext={font:'',measureText(text){const size=parseFloat(this.font.slice(4));return {width:[...text].length*size,actualBoundingBoxAscent:size*.85,actualBoundingBoxDescent:size*.12}}};
for(const [W,H,n] of [[250,220,10],[350,300,20],[850,380,30],[1250,650,100],[350,260,15],[1600,800,200]]){
 const words=Array.from({length:n},(_,i)=>({text:['期待','勇氣','試錯','我的未來','職涯規劃'][i%5]+i,count:Math.max(1,100-i*3)}));
 const out=context.layoutWords(canvasContext,words,W,H);assert(out.length>n*.5,`too few ${out.length}/${n}`);const bounds=[];
 for(const p of out){const box={x:p.left,y:p.top,w:p.w,h:p.h};assert(box.x>=0&&box.y>=0&&box.x+box.w<=W&&box.y+box.h<=H,'outside canvas');for(const b of bounds){assert(box.x+box.w<=b.x||b.x+b.w<=box.x||box.y+box.h<=b.y||b.y+b.h<=box.y,'words overlap')}bounds.push(box)}
 console.log(`${W}x${H}: ${out.length}/${n} words; bounds and overlap checks passed`);
}
