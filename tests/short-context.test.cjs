const test=require('node:test'),assert=require('node:assert/strict'),C=require('../dist/core.js'),db=require('../dist/data/catalog.json');
test('every timed sentence gets source prefix without editing timestamps',()=>{
 let count=0;for(const p of db.passages)for(const s of p.sentences){if(!Number.isFinite(s.startTime)||!Number.isFinite(s.endTime))continue;
 const before=JSON.stringify(s),r=C.sentencePlan(p,s.sentenceId)[0],nominal=s.startTime+p.continuous.bodyOffset;
 assert.ok(Math.abs(r.startTime-Math.max(p.continuous.practiceStart??0,nominal-.5))<1e-8,s.sentenceId);assert.equal(r.nominalStart,nominal);
 assert.ok(r.endTime<=p.continuous.bodyEnd);assert.equal(JSON.stringify(s),before);count++;}
 assert.ok(count>1000);
});
test('word replay uses the same prefix and preserves shared time groups',()=>{
 const p=db.passages.find(p=>p.passageId==='2017-06-1-p1'),s=p.sentences[0],w=C.wordSpans(s).find(w=>w.text==='at'&&w.startTime!==null);
 const r=C.wordPlan(p,s.sentenceId,w.wordId)[0];assert.equal(r.startTime,w.startTime+1-.5);assert.equal(r.nominalStart,w.startTime+1);
});
test('first sentence can use source before legacy body zero',()=>{
 const p=db.passages.find(p=>p.passageId==='2017-06-1-p1'),s=p.sentences[0],r=C.sentencePlan(p,s.sentenceId)[0];
 assert.ok(r.startTime<p.continuous.bodyOffset);assert.ok(r.startTime>=0);
});
test('continuous sentence begins early on one full body timeline',()=>{
 const p=db.passages[0],s=p.sentences.find(s=>s.startTime>1),r=C.sentencePlan(p,s.sentenceId,true,{leadIn:.75})[0];
 assert.equal(r.startTime,0);assert.equal(r.playFrom,s.startTime+p.continuous.bodyOffset-.75);assert.equal(r.endTime,p.continuous.bodyEnd);
});
test('uncalibrated sentences remain approximate and zero words unplayable',()=>{
 const p=db.passages.find(p=>p.passageId==='2017-06-1-p1'),s=p.sentences.find(s=>s.sentenceId.endsWith('-s11'));
 assert.equal(C.sentencePlan(p,s.sentenceId)[0].approximate,true);assert.throws(()=>C.wordPlan(p,s.sentenceId,C.wordSpans(s)[0].wordId));
});
test('prefix duration clamps to source bounds and does not affect full/question plans',()=>{
 const p=db.passages[0],s=p.sentences[0];assert.ok(C.sentencePlan(p,s.sentenceId,false,{leadIn:99})[0].startTime>=0);
 assert.equal(C.plan(p,'full')[0].startTime,0);assert.equal(C.plan(p,'question',p.questions[0].questionId)[0].startTime,p.questions[0].playback.startTime);
});
test('lead preference merges independently of answers and completion',()=>{
 const P=require('../dist/progress.js'),a={answers:{q:'A'},completed:['p'],history:[],studySeconds:0,intensiveLead:.5},b={...a,intensiveLead:1};
 const result=P.apply({...a,completed:['p','other']},P.delta(a,b));assert.equal(result.intensiveLead,1);assert.deepEqual(result.completed,['p','other']);assert.equal(result.answers.q,'A');
});

test('untimed continuous sentence starts near the preceding end, not its beginning',()=>{
 const p=db.passages.find(p=>p.passageId==='2017-06-1-p1'),i=p.sentences.findIndex(s=>s.sentenceId.endsWith('-s11')),s=p.sentences[i],prev=p.sentences.slice(0,i).reverse().find(x=>Number.isFinite(x.endTime));
 const r=C.sentencePlan(p,s.sentenceId,true)[0];assert.equal(r.approximate,true);assert.equal(r.sentenceId,s.sentenceId);assert.equal(r.playFrom,Math.max(0,prev.endTime+p.continuous.bodyOffset-.5));assert.ok(r.playFrom>prev.startTime+p.continuous.bodyOffset);
});
test('handwritten notes merge as passage-scoped progress deltas',()=>{
 const P=require('../dist/progress.js'),a={answers:{q:'B'},completed:['p1'],history:[],studySeconds:0,inkNotes:{p1:[{id:'a'}]}},b={...a,inkNotes:{p1:[{id:'a'},{id:'b'}]}};
 const result=P.apply({...a,completed:['p1','p2'],inkNotes:{...a.inkNotes,p2:[{id:'c'}]}},P.delta(a,b));assert.equal(result.inkNotes.p1.length,2);assert.equal(result.inkNotes.p2[0].id,'c');assert.deepEqual(result.completed,['p1','p2']);assert.equal(result.answers.q,'B');
});
