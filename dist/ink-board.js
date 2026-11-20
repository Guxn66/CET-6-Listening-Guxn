/* Store the geometry with the ink. Drawing and seeing an annotation are independent. */
(function(g){'use strict';
class InkBoard {
 constructor(canvas, app, options) {
  Object.assign(this,{canvas,app,options,active:null,frame:0,enabled:false,visible:false,penSeen:false,mode:null,touch:null,swallowClick:false});
  canvas.addEventListener('pointerdown',e=>this.start(e));canvas.addEventListener('pointermove',e=>this.move(e));
  canvas.addEventListener('pointerup',e=>{if(this.active?.pointer===e.pointerId){this.move(e);this.finish();}});
  for(const event of ['pointercancel','lostpointercapture'])canvas.addEventListener(event,e=>{if(this.active?.pointer===e.pointerId)this.finish();});
  const main=options.main;this.main=main;
  if(main){
   main.addEventListener('contextmenu',e=>{if(this.mode==='pen'&&(this.active?.type==='pen'||e.pointerType==='pen'))e.preventDefault();},true);
   main.addEventListener('wheel',e=>{if(this.mode==='pen'&&this.active)e.preventDefault();},{passive:false});
   main.addEventListener('pointerdown',e=>this.onMainDown(e),true);
   document.addEventListener('pointermove',e=>this.onMainMove(e),{capture:true,passive:false});
   for(const event of ['pointerup','pointercancel','lostpointercapture'])document.addEventListener(event,e=>this.onMainEnd(e),true);
   main.addEventListener('click',e=>{if(this.mode==='pen'&&this.swallowClick&&e.detail!==0){this.swallowClick=false;e.preventDefault();e.stopImmediatePropagation();}},true);
  }
  canvas.addEventListener('wheel',e=>{if(this.enabled)e.preventDefault();},{passive:false});
  canvas.addEventListener('contextmenu',e=>{if(this.enabled)e.preventDefault();});
  addEventListener('scroll',()=>this.schedule(),{passive:true,capture:true});
  addEventListener('resize',()=>this.schedule());addEventListener('blur',()=>{this.touch=null;this.finish();});
  document.addEventListener('visibilitychange',()=>{if(document.hidden)this.finish();});
  if(typeof ResizeObserver==='function')new ResizeObserver(()=>this.schedule()).observe(app);
 }
 set(visible,enabled,mode='locked'){
  const next=visible&&enabled?mode:null;
  if(next!==this.mode){this.finish();this.touch=null;this.swallowClick=false;this.penSeen=false;}
  this.visible=visible;this.enabled=!!next;this.mode=next;this.canvas.hidden=!visible;
  this.canvas.classList.toggle('writing',next==='locked');
  this.main?.classList.toggle('pen-surface',next==='pen');
  document.documentElement.classList.toggle('paper-locked',next==='locked');
  if(visible)this.draw();
 }
 onMainDown(e){
  if(this.mode!=='pen'||this.options.blocked())return;
  this.swallowClick=false;
  if(e.pointerType==='pen'){
   if(e.target.closest('button,a,select,textarea,summary,input:not([type="radio"])'))return;
   this.touch=null;this.start(e,this.main);return;
  }
  if(e.pointerType!=='touch'||this.active)return;
  if(!e.isPrimary){this.touch=null;return;}
  if(e.target.closest('input[type="range"],select,textarea'))return;
  this.touch={pointer:e.pointerId,originX:e.clientX,originY:e.clientY,lastY:e.clientY,drag:false};
 }
 onMainMove(e){
  if(this.mode!=='pen')return;
  if(this.active?.pointer===e.pointerId){this.move(e);return;}
  const t=this.touch;
  if(!t||t.pointer!==e.pointerId||this.active)return;
  if(!t.drag){
   if(Math.abs(e.clientY-t.originY)<7)return;
   if(Math.abs(e.clientX-t.originX)>Math.abs(e.clientY-t.originY)){this.touch=null;return;}
   t.drag=true;this.swallowClick=true;
   try{this.main.setPointerCapture(e.pointerId);}catch{}
  }
  e.preventDefault();window.scrollBy({top:t.lastY-e.clientY,behavior:'instant'});t.lastY=e.clientY;
 }
 onMainEnd(e){
  if(this.mode!=='pen'||e.type==='lostpointercapture'&&e.target!==this.main)return;
  if(this.touch?.pointer===e.pointerId)this.touch=null;
  if(this.active?.pointer===e.pointerId){
   if(e.type==='pointerup')this.move(e);
   this.swallowClick=true;this.finish();
  }
 }
 schedule(){if(this.visible&&!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.draw();});}
 surface(x,y){
  for(const el of document.elementsFromPoint(x,y)){
   if(el===this.canvas||!this.app.contains(el))continue;
   const opt=el.closest('label.option');if(opt){const key=opt.querySelector('[data-mark-key]')?.dataset.markKey;if(key)return {kind:'option',key,el:opt};}
   const q=el.closest('[data-question]');if(q)return {kind:'question',key:q.dataset.question,el:q};
   const s=el.closest('.sentence[id]');if(s)return {kind:'sentence',key:s.id,el:s};
  }return null;
 }
 anchorBox(a){
  if(!a)return null;
  const key=CSS.escape(a.key);
  const el=a.kind==='option'?this.app.querySelector('[data-mark-key="'+key+'"]')?.closest('label.option'):a.kind==='question'?this.app.querySelector('[data-question="'+key+'"]'):document.getElementById(a.key);
  return el?.getBoundingClientRect()||null;
 }
 start(e,capture=this.canvas){
  if(this.mode==='pen'&&e.pointerType!=='pen')return;
  if(!this.enabled||this.options.blocked()||e.pointerType==='mouse'&&e.button!==0||e.pointerType==='touch'&&(!e.isPrimary||this.penSeen||Math.max(e.width||0,e.height||0)>42))return;
  if(e.pointerType==='pen'){this.penSeen=true;if(this.active?.type==='touch'){const owner=this.active.pointer;this.active=null;try{this.canvas.releasePointerCapture(owner);}catch{}}}
  if(this.active)return;
  const appBox=this.app.getBoundingClientRect();if(e.clientX<appBox.left||e.clientX>appBox.right)return;
  e.preventDefault();const a=this.surface(e.clientX,e.clientY),box=a?.el.getBoundingClientRect()||appBox;
  const o=this.options,stroke={id:crypto.randomUUID(),madeAt:Date.now(),color:o.color(),erase:o.erase()||e.button===5||(e.buttons&32)!==0,width:3.2,baseWidth:box.width,layer:o.layer(),points:[]};
  if(a)stroke.anchor={kind:a.kind,key:a.key};
  this.active={stroke,owner:o.owner(),pointer:e.pointerId,type:e.pointerType,box,capture};
  this.point(e);try{capture.setPointerCapture(e.pointerId);}catch{}this.schedule();
 }
 point(e){
  const {stroke,box}=this.active;const x=e.clientX-box.left,y=stroke.anchor?e.clientY-box.top:e.clientY+window.scrollY;
  const p=stroke.points.at(-1);if(!p||Math.hypot(x-p[0],y-p[1])>=.6)stroke.points.push([x,y,Math.max(.1,e.pressure||.5)]);
 }
 move(e){if(!this.active||e.pointerId!==this.active.pointer)return;e.preventDefault();for(const p of e.getCoalescedEvents?.()||[])this.point(p);this.point(e);this.schedule();}
 finish(){if(!this.active)return;const {owner,pointer,stroke,capture}=this.active;this.active=null;
  try{if(capture.hasPointerCapture(pointer))capture.releasePointerCapture(pointer);}catch{}
  if(stroke.points.length)this.options.commit(owner,stroke);
  this.schedule();
 }
 draw(){
  if(!this.visible)return;const c=this.canvas,b=this.app.getBoundingClientRect(),h=window.innerHeight;
  if(!b.width||!h)return;const dpr=Math.min(window.devicePixelRatio||1,2);
  c.style.left=b.left+'px';c.style.width=b.width+'px';c.style.height=h+'px';
  if(c.width!==Math.round(b.width*dpr)||c.height!==Math.round(h*dpr)){c.width=Math.round(b.width*dpr);c.height=Math.round(h*dpr);}
  const ctx=c.getContext('2d');if(!ctx)return;
  ctx.setTransform(dpr,0,0,dpr,0,0);ctx.clearRect(0,0,b.width,h);ctx.lineCap='round';ctx.lineJoin='round';
  const list=this.options.entries()||[],active=this.active;
  const rects=new Map(),layer=this.options.layer();
  for(const stroke of (active?list.concat(active.stroke):list)){
   if(!stroke.points?.length||stroke.layer&&stroke.layer!==layer)continue;
   const a=stroke.anchor,k=a&&a.kind+':'+a.key;if(k&&!rects.has(k))rects.set(k,this.anchorBox(a));
   const anchor=k?rects.get(k):null;if(k&&!anchor)continue;
   const left=anchor?anchor.left-b.left:0,top=anchor?anchor.top:-window.scrollY;
   const scale=stroke.baseWidth>0?(anchor?.width||b.width)/stroke.baseWidth:1;
   const pts=stroke.points;ctx.globalCompositeOperation=stroke.erase?'destination-out':'source-over';
   ctx.strokeStyle=stroke.color||'#d34836';ctx.lineWidth=stroke.width||3.2;
   ctx.beginPath();ctx.moveTo(left+pts[0][0]*scale,top+pts[0][1]);
   for(let i=1;i<pts.length;i++)ctx.lineTo(left+pts[i][0]*scale,top+pts[i][1]);
   if(pts.length===1)ctx.lineTo(left+pts[0][0]*scale+.1,top+pts[0][1]+.1);ctx.stroke();
  }
  ctx.globalCompositeOperation='source-over';
 }
}
g.CETInkBoard=InkBoard;
})(window);
