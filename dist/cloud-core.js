/* Shared cloud protocol. Keep settings, local audio and handwriting on this device. */
(function(g){
'use strict';
const p=typeof module==='undefined'?g.CETProgress:require('./progress.js');
const maps=['answers','notes','reviewReasons','optionMarks'];
const sets=['favorites','completed'];
const own=(o,k)=>Object.hasOwn(o,k);
const safe=k=>typeof k==='string'&&k.length>0&&k.length<=180&&!/[\u0000-\u001f]/.test(k)&&!['__proto__','constructor','prototype'].includes(k);
function history(items=[]){
 return items.filter(h=>safe(h?.passageId)).map(h=>{
  const answers=Object.fromEntries([...Object.entries(Object.fromEntries((h.result?.rows||[]).filter(r=>safe(r?.questionId)).map(r=>[r.questionId,r.chosen]))),...Object.entries(h.answers||{})].filter(([k,v])=>safe(k)&&/^[ABCD]$/.test(v)));
  const at=typeof h.at==='string'&&Number.isFinite(Date.parse(h.at))?new Date(h.at).toISOString():null;
  return {id:safe(h.id)?h.id:null,passageId:h.passageId,at,answers,...(h.importedUntimedFirst&&!at?{importedUntimedFirst:true}:{})};
 });
}
function capture(d){
 return {maps:Object.fromEntries(maps.map(f=>[f,Object.fromEntries(Object.entries(d.maps[f]||{}).filter(([k])=>safe(k)))])),sets:Object.fromEntries(sets.map(f=>[f,{add:(d.sets[f]?.add||[]).filter(safe),remove:(d.sets[f]?.remove||[]).filter(safe)}])),history:history(d.history),seconds:Math.floor(d.seconds||0)};
}
function state(s={}){
 return {...Object.fromEntries(maps.map(f=>[f,Object.fromEntries(Object.entries(s[f]||{}).filter(([k])=>safe(k)))])),...Object.fromEntries(sets.map(f=>[f,(s[f]||[]).filter(safe)])),history:history(s.history),studySeconds:Math.floor(s.studySeconds||0)};
}
function empty(d){return !d.seconds&&!d.history.length&&!Object.values(d.maps).some(x=>Object.keys(x).length)&&!Object.values(d.sets).some(x=>x.add.length||x.remove.length);}
function unionHistory(a,b){
 const seen=new Set(),ids=new Set();
 return [...a,...b].filter(h=>{
  const k=JSON.stringify([h.passageId,h.at,Object.entries(h.answers).sort()]);
  if((h.id&&ids.has(h.id))||seen.has(k))return false;
  if(h.id)ids.add(h.id);
  seen.add(k);return true;
 });
}
function apply(doc,op){
 const s=doc.state;
 if(op.seed){
  const seed=op.seed;
  for(const f of maps)for(const[k,v] of Object.entries(seed[f]))if(!own(s[f],k)&&!own(doc.deleted[f]||{},k))s[f][k]=v;
  for(const f of sets)s[f]=[...new Set([...s[f],...seed[f].filter(k=>!own(doc.deleted[f]||{},k))])];
  s.history=unionHistory(s.history,seed.history);s.studySeconds=Math.max(s.studySeconds,seed.studySeconds);
 }else{
  const d=op.delta;
  for(const f of maps)for(const[k,v] of Object.entries(d.maps[f])){
   const tombstones=doc.deleted[f]||={};
   if(v.deleted){delete s[f][k];tombstones[k]=true;}else{s[f][k]=v.value;delete tombstones[k];}
  }
  for(const f of sets){
   const vals=new Set(s[f]),tombstones=doc.deleted[f]||={};
   if(f!=='completed')for(const k of d.sets[f].remove){vals.delete(k);tombstones[k]=true;}
   for(const k of d.sets[f].add){vals.add(k);delete tombstones[k];}s[f]=[...vals];
  }
  s.history=unionHistory(s.history,d.history);s.studySeconds+=d.seconds;
 }
 s.completed=[...new Set([...s.completed,...s.history.map(h=>h.passageId)])];return doc;
}
function projectedDelta(before,after){return capture(p.delta(before,after));}
const api={maps,sets,safe,state,empty,apply,projectedDelta};
if(typeof module!=='undefined')module.exports=api;else g.CETCloudCore=api;
})(typeof window==='undefined'?globalThis:window);
