/* Operation deltas are committed against the latest state in one IDB transaction.
   state-v2 is authoritative; old v5 tabs can only overwrite the legacy mirror. */
(function(g){'use strict';
const copy=x=>JSON.parse(JSON.stringify(x)),eq=(a,b)=>JSON.stringify(a)===JSON.stringify(b);
const maps=['answers','notes','optionMarks','reviewReasons'],sets=['favorites','completed','reservedPlayed'];
const strokeId=s=>s?.id||JSON.stringify(s);
function inkChanges(a={},b={}){
 const out={};for(const id of new Set([...Object.keys(a),...Object.keys(b)])){
  if(a[id]===b[id])continue;
  const prev=new Map((a[id]||[]).map(s=>[strokeId(s),s])),next=new Map((b[id]||[]).map(s=>[strokeId(s),s]));
  const add=[...next].filter(([k,v])=>!prev.has(k)||!eq(prev.get(k),v)).map(x=>x[1]),del=[...prev.keys()].filter(k=>!next.has(k));
  if(add.length||del.length)out[id]={add,del};
 }return out;
}
function inkApply(ink={},changes={}){const out={...ink};for(const[id,d]of Object.entries(changes)){
 const strokes=new Map((out[id]||[]).map(s=>[strokeId(s),s]));for(const x of d.del||[])strokes.delete(x);for(const s of d.add||[])strokes.set(strokeId(s),s);out[id]=[...strokes.values()];
}return out;}
// Old tabs know only the state-v2 mirror. Keep accepted new strokes and explicit erasures independently.
function rememberInk(ledger={},changes={}){
 const out={...ledger};for(const [pid,d] of Object.entries(changes)){const row=ledger[pid]||{},adds=new Map((row.add||[]).map(s=>[strokeId(s),s])),del=new Set(row.del||[]);
  (d.del||[]).forEach(id=>{adds.delete(id);del.add(id);});(d.add||[]).forEach(s=>{const id=strokeId(s);if(!del.has(id))adds.set(id,s);});
  out[pid]={add:[...adds.values()],del:[...del]};
 }return out;
}
const validAnswer=x=>typeof x==='string'&&/^[ABCD]$/.test(x);
const stamp=value=>{const n=typeof value==='string'&&value?Date.parse(value):NaN;return Number.isFinite(n)?n:Infinity;};
function attemptChoices(h){
 const out={};
 for(const r of Array.isArray(h?.result?.rows)?h.result.rows:[])if(typeof r?.questionId==='string'&&validAnswer(r.chosen))out[r.questionId]=r.chosen;
 for(const [id,v] of Object.entries(h?.answers||{}))if(validAnswer(v))out[id]=v;
 return out;
}
function orderedHistory(history){return (history||[]).filter(h=>typeof h?.passageId==='string').slice().sort((a,b)=>{
 const x=stamp(a.at)===Infinity&&a.importedUntimedFirst?-Infinity:stamp(a.at),y=stamp(b.at)===Infinity&&b.importedUntimedFirst?-Infinity:stamp(b.at);return x===y?0:x-y;
});}
function firstChoices(history,passageId){
 const result=Object.create(null);
 for(const h of orderedHistory(history)){
  if(passageId&&h.passageId!==passageId)continue;
  for(const [id,answer] of Object.entries(attemptChoices(h)))if(!Object.hasOwn(result,id))result[id]=answer;
 }
 return result;
}
// Dates belong to actual submissions. A legacy completion flag is not a date.
function firstSubmissions(history,completed=[]){
 const passages=new Map(),questions=new Map();
 for(const h of orderedHistory(history)){
  const at=stamp(h.at)===Infinity?null:new Date(stamp(h.at)).toISOString();
  if(!passages.has(h.passageId))passages.set(h.passageId,at);
  for(const id of Object.keys(attemptChoices(h)))if(!questions.has(id))questions.set(id,at);
 }
 for(const id of Array.isArray(completed)?completed:[])if(typeof id==='string'&&!passages.has(id))passages.set(id,null);
 return {passages,questions};
}
function submissionSummary(state){
 const {passages,questions}=firstSubmissions(state.history,state.completed);
 const withoutTime=[...passages.values()].filter(v=>v===null).length;
 return {completedPassages:passages.size,submittedQuestions:questions.size,
  passagesWithTime:passages.size-withoutTime,passagesWithoutTime:withoutTime,
  firstPassageSubmissions:Object.fromEntries(passages),firstQuestionSubmissions:Object.fromEntries(questions),
  recordedAttempts:Array.isArray(state.history)?state.history.length:0};
}
function firstStats(history,questions){
 const choices=firstChoices(history),wrong=new Set();let graded=0,correct=0;
 for(const [id,key] of questions){
  if(!validAnswer(key)||!validAnswer(choices[id]))continue;
  graded++;if(key===choices[id])correct++;else wrong.add(id);
 }
 return {graded,correct,wrong,attempted:Object.keys(choices).length};
}
function mergeBackup(current,incoming,options={}){
 const s=copy(current),old=copy(incoming),prefer=options.preferIncomingUntimed!==false;
 if(!(s.history?.length||s.completed?.length||s.lastPassage||Object.keys(s.answers||{}).length)){for(const k of ['theme','rate','volume','intensiveLead','lastPassage'])if(old[k]!==undefined)s[k]=old[k];}
 const h=new Map(),seen=new Set();
 // For equal/unknown timestamps, place the older-site source first; chronological order otherwise wins.
 const incomingHistory=(old.history||[]).map(h=>h&&prefer&&stamp(h.at)===Infinity?{...h,importedUntimedFirst:true}:h);
 for(const item of orderedHistory(prefer?[...incomingHistory,...(s.history||[])]:[...(s.history||[]),...incomingHistory])){
  const content=JSON.stringify(Object.entries(attemptChoices(item)).sort());
  const signature=item.passageId+'|'+(item.at||'')+'|'+content;
  if(item.id&&h.has(item.id)||seen.has(signature))continue;
  seen.add(signature);h.set(item.id||signature,item);
 }
 s.history=[...h.values()];
 const first=firstChoices(s.history),incomingFirst=firstChoices(old.history),currentFirst=firstChoices(current.history),out={...current.answers};
 for(const [id,answer] of Object.entries(old.answers||{}))if(validAnswer(answer)){
  if(!Object.hasOwn(out,id)&&!Object.hasOwn(currentFirst,id))out[id]=answer;
  else if(Object.hasOwn(out,id)&&!Object.hasOwn(first,id)&&prefer)out[id]=answer;
 }
 for(const [id,answer] of Object.entries(first)){
  // Keep an intentional reset on this device. A genuinely new submitted answer fills a missing question.
  if(Object.hasOwn(out,id)||(!Object.hasOwn(currentFirst,id)&&Object.hasOwn(incomingFirst,id)))out[id]=answer;
 }
 s.answers=out;
 for(const f of ['notes','optionMarks','reviewReasons'])s[f]={...(old[f]||{}),...(s[f]||{})};
 for(const f of ['completed','favorites','reservedPlayed'])s[f]=[...new Set([...(s[f]||[]),...(old[f]||[])])];
 s.completed=[...new Set([...s.completed,...s.history.map(x=>x.passageId)])];s.studySeconds=Math.max(s.studySeconds||0,old.studySeconds||0);
 s.inkNotes=inkApply(old.inkNotes||{},inkChanges({},current.inkNotes||{}));return s;
}
function delta(a,b){const d={maps:{},sets:{},values:{},history:[],ink:inkChanges(a.inkNotes,b.inkNotes),seconds:Math.max(0,(b.studySeconds||0)-(a.studySeconds||0))};
 for(const f of maps){d.maps[f]={};for(const k of new Set([...Object.keys(a[f]||{}),...Object.keys(b[f]||{})]))if(!eq(a[f]?.[k],b[f]?.[k]))d.maps[f][k]=Object.hasOwn(b[f]||{},k)?{value:b[f][k]}:{deleted:true};}
 for(const f of sets){const x=new Set(a[f]||[]),y=new Set(b[f]||[]);d.sets[f]={add:[...y].filter(k=>!x.has(k)),remove:f==='completed'?[]:[...x].filter(k=>!y.has(k))};}
 const ids=new Set((a.history||[]).map(h=>h.id||h.at+':'+h.passageId));d.history=(b.history||[]).filter(h=>!ids.has(h.id||h.at+':'+h.passageId));
 for(const f of ['lastPassage','theme','rate','volume','randomQueue','intensiveLead'])if(!eq(a[f],b[f])&&b[f]!==undefined)d.values[f]=b[f];return d;
}
function apply(s,d){s=copy(s);for(const [f,items]of Object.entries(d.maps)){s[f]={...(s[f]||{})};for(const[k,v]of Object.entries(items)){if(v.deleted)delete s[f][k];else s[f][k]=v.value;}}
 s.inkNotes=inkApply(s.inkNotes,d.ink);for(const[f,v]of Object.entries(d.sets)){const x=new Set(s[f]||[]);v.remove.forEach(k=>x.delete(k));v.add.forEach(k=>x.add(k));s[f]=[...x];}
 const h=new Map((s.history||[]).map(h=>[h.id||h.at+':'+h.passageId,h]));d.history.forEach(v=>h.set(v.id||v.at+':'+v.passageId,v));s.history=[...h.values()];s.completed=[...new Set([...(s.completed||[]),...s.history.map(h=>h.passageId)])];Object.assign(s,d.values);s.studySeconds=(s.studySeconds||0)+d.seconds;s.updatedAt=Date.now();return s;
}
function changed(d){return Object.keys(d.ink||{}).length||d.seconds||d.history.length||Object.keys(d.values).length||Object.values(d.maps).some(x=>Object.keys(x).length)||Object.values(d.sets).some(x=>x.add.length||x.remove.length);}
class Store{
 constructor(db,read,replace,error){this.db=db;this.read=read;this.replace=replace;this.error=error;this.chain=Promise.resolve();this.pending=0;this.prefix='cet6-operation-v2:';this.channel=typeof BroadcastChannel==='function'?new BroadcastChannel('cet6-progress-v2'):null;if(this.channel)this.channel.onmessage=()=>this.refresh();addEventListener('storage',e=>{if(e.key=== 'cet6-state-v1'||e.key?.startsWith(this.prefix))this.refresh();});}
 transaction(op,seed){return new Promise((resolve,reject)=>{
  const tx=this.db.transaction('kv','readwrite'),st=tx.objectStore('kv'),read=st.get('state-v2'),savedInk=st.get('ink-ledger-v10');let result;
  savedInk.onsuccess=()=>{let ledger=savedInk.result||{};result=read.result||copy(seed);result.inkNotes=inkApply(result.inkNotes,ledger);
   if(!op){const legacy=st.get('state');legacy.onsuccess=()=>{const h=new Map((result.history||[]).map(h=>[h.id||h.at+':'+h.passageId,h]));for(const item of legacy.result?.history||[])if(!h.has(item.id||item.at+':'+item.passageId))h.set(item.id||item.at+':'+item.passageId,item);result.history=[...h.values()];result.completed=[...new Set([...(result.completed||[]),...(legacy.result?.completed||[]),...result.history.map(h=>h.passageId)])];st.put(result,'state-v2');};return;}
   const meta=st.get('cloud-v1');const receipt=st.get('applied-v2:'+op.id);receipt.onsuccess=()=>{if(!receipt.result){
    const beforeCloud=meta.result&&g.CETCloudCore?g.CETCloudCore.state(result):null; let changes;if(op.backup){st.put(copy(result),'before-import:'+op.id);const before=result.inkNotes;result=mergeBackup(result,op.backup,op.backupOptions);changes=inkChanges(before,result.inkNotes);}
    else {changes=op.delta.ink;result=apply(result,op.delta);}
    if(Object.keys(changes||{}).length){ledger=rememberInk(ledger,changes);st.put(ledger,'ink-ledger-v10');}
    result.inkNotes=inkApply(result.inkNotes,ledger);st.put(result,'state-v2');st.put(true,'applied-v2:'+op.id);
    if(beforeCloud){const d=g.CETCloudCore.projectedDelta(beforeCloud,g.CETCloudCore.state(result));if(!g.CETCloudCore.empty(d)){meta.result.outbox.push({id:op.id,delta:d});st.put(meta.result,'cloud-v1');}}
   }st.put(result,'state');};};
  tx.oncomplete=()=>resolve(result);tx.onerror=()=>reject(tx.error);tx.onabort=()=>reject(tx.error||Error('学习记录事务未完成'));
 });}
 async init(seed){this.seed=copy(seed);const snapshot=await this.transaction(null,seed);this.replace(snapshot);this.baseline=copy(snapshot);const pending=[];for(let i=0;i<localStorage.length;i++){const k=localStorage.key(i);if(k.startsWith(this.prefix)){try{pending.push(JSON.parse(localStorage.getItem(k)));}catch{}}}pending.sort((a,b)=>a.at-b.at);for(const op of pending){const s=await this.transaction(op,this.seed);localStorage.removeItem(this.prefix+op.id);this.replace(s);this.baseline=copy(s);}this.mirror(this.read());}
 mirror(s){try{localStorage.setItem('cet6-state-v1',JSON.stringify(s));}catch(e){this.error(e);}}
 save(){const now=copy(this.read()),d=delta(this.baseline,now);if(!changed(d))return this.chain;const op={id:crypto.randomUUID(),at:Date.now(),delta:d};try{localStorage.setItem(this.prefix+op.id,JSON.stringify(op));}catch(e){this.error(e);}this.baseline=now;this.pending++;
 this.chain=this.chain.then(async()=>{const result=await this.transaction(op,this.seed);localStorage.removeItem(this.prefix+op.id);this.pending--;if(!this.pending){const unsaved=delta(this.baseline,this.read());this.baseline=copy(result);this.replace(apply(result,unsaved));}this.mirror(result);this.channel?.postMessage({id:op.id});}).catch(e=>{this.pending=Math.max(0,this.pending-1);this.error(e);});return this.chain;}
 async importBackup(backup,backupOptions){await this.save();const op={id:crypto.randomUUID(),backup:copy(backup),backupOptions};this.pending++;
  const work=this.chain.then(async()=>{const result=await this.transaction(op,this.seed);this.pending--;if(!this.pending){const d=delta(this.baseline,this.read());this.baseline=copy(result);this.replace(apply(result,d));}this.mirror(result);this.channel?.postMessage({id:op.id});});
  this.chain=work.catch(e=>{this.pending=Math.max(0,this.pending-1);this.error(e);});return work;}
 cloudTransaction(work){
  return new Promise((resolve,reject)=>{
   const tx=this.db.transaction('kv','readwrite'),st=tx.objectStore('kv'),local=st.get('state-v2'),account=st.get('cloud-v1');
   let output,failure;account.onsuccess=()=>{try{output=work(st,local.result,account.result);}catch(e){failure=e;tx.abort();}};
   tx.oncomplete=()=>resolve(output);tx.onabort=()=>reject(failure||tx.error||Error('本机同步事务未完成'));
  });
 }
 cloudMeta(){return this.cloudTransaction((_st,_s,meta)=>meta);}
 async enableCloud(owner){
  await this.save();
  const task=this.chain.then(()=>this.cloudTransaction((st,s,meta)=>{
   if(meta&&meta.owner!==owner)throw Error('此浏览器已绑定另一个账号。请用独立浏览器配置登录其他账号。');
   if(meta)return;
   st.put(s,'before-cloud-v1');
   st.put({owner,revision:-1,outbox:[{id:crypto.randomUUID(),seed:g.CETCloudCore.state(s)}]},'cloud-v1');
  }));
  this.chain=task.catch(()=>{});return task;
 }
 async acceptCloud(reply){
  await this.save();this.pending++;
  const task=this.chain.then(async()=>{
   let result;
   try{result=await this.cloudTransaction((st,s,meta)=>{
    if(!meta||meta.owner!==reply.owner)throw Error('同步账号与本机绑定不匹配。');
    const ack=new Set(reply.ack);
    meta.outbox=meta.outbox.filter(o=>!ack.has(o.id));
    if(reply.document&&reply.revision>=meta.revision){meta.revision=reply.revision;meta.remote=reply.document;}
    st.put(meta,'cloud-v1');
    if(!meta.remote)return null;
    const doc=copy(meta.remote);
    for(const op of meta.outbox)g.CETCloudCore.apply(doc,op);
    if(eq(g.CETCloudCore.state(s),doc.state))return null;
    const merged={...s,...doc.state};
    st.put(merged,'state-v2');st.put(merged,'state');return merged;
   });}finally{this.pending--;}
   if(result&&!this.pending){const d=delta(this.baseline,this.read());this.baseline=copy(result);this.replace(apply(result,d));}
   if(result){this.mirror(result);this.channel?.postMessage({remote:true});}
   return !!result;
  });
  this.chain=task.catch(()=>{});return task;
 }
 async refresh(){if(this.pending)return;try{const s=await this.transaction(null,this.seed);if(this.pending)return;const d=delta(this.baseline,this.read());this.baseline=copy(s);this.replace(apply(s,d));}catch(e){this.error(e);}}
}
const api={delta,apply,changed,Store,mergeBackup,firstChoices,firstStats,firstSubmissions,submissionSummary,rememberInk,inkApply};if(typeof module!=='undefined')module.exports=api;g.CETProgress=api;
})(typeof window!=='undefined'?window:globalThis);
