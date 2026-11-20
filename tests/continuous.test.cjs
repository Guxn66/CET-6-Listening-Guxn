const test=require('node:test'),assert=require('node:assert/strict'),C=require('../dist/core.js'),db=require('../dist/data/catalog.json');
const p=db.passages.find(p=>p.passageId==='2017-06-1-p1');
test('full playback retains one continuous source range and real inter-question gaps',()=>{
 const r=C.plan(p,'full');assert.equal(r.length,1);assert.equal(r[0].audioFile,p.continuous.audioFile);
 assert.ok(r[0].endTime>p.body.endTime+p.questions.reduce((n,q)=>n+q.segment.endTime,0)+30);
 assert.equal(C.plan(p,'questions').length,1);
});
test('body begins one second earlier without changing legacy subtitle coordinates',()=>{
 const r=C.plan(p,'body')[0];assert.equal(r.startTime,0);assert.equal(p.continuous.bodyOffset,1);
 const mapped=C.timelinePosition(p,r,11.6);assert.equal(mapped.audioFile,p.body.audioFile);assert.ok(Math.abs(mapped.time-10.6)<1e-10);
 assert.equal(C.wordSpans(p.sentences[0]).find(w=>w.startTime<=10.6&&w.endTime>10.6)?.text,'at');
});
test('question source contains full fallback prefix, label and unchanged stable ID',()=>{
 const q=p.questions[0],r=C.plan(p,'question',q.questionId)[0];assert.equal(r.questionId,'2017-06-1-q1');
 assert.ok(r.originalStart<=q.segment.originalStart-.5);assert.equal(r.audioFile,p.continuous.audioFile);
 assert.ok(r.originalStart<191.32);assert.ok(r.endTime-r.startTime>q.segment.endTime);
});
test('sentence continuous mode uses one body timeline and an explicit offset',()=>{
 const s=p.sentences.find(s=>s.startTime!==null);const r=C.sentencePlan(p,s.sentenceId,true)[0];
 assert.equal(r.startTime,0);assert.equal(r.playFrom,s.startTime+1-.5);assert.equal(r.endTime,p.body.endTime+1);
 assert.equal(C.plan(p,'sentence',s.sentenceId)[0].nominalStart,s.startTime+1);
});
test('catalog keeps all stable IDs and validates continuous boundaries',()=>{
 assert.equal(C.validate(db).length,0);assert.equal(db.exams.length,33);assert.equal(db.passages.length,231);assert.equal(db.passages.flatMap(p=>p.questions).length,825);
 for(const p of db.passages.filter(p=>p.continuous))for(const q of p.questions){assert.ok(q.playback.originalStart<=q.segment.originalStart-.45);assert.ok(q.playback.endTime<=p.continuous.endTime);}
});
test('manual sentence calibrations retain their original coordinates after continuous upgrade',()=>{
 const old=structuredClone(db);delete old.passages.find(x=>x.passageId===p.passageId).continuous;for(const q of old.passages.find(x=>x.passageId===p.passageId).questions)delete q.playback;
 const s=old.passages.find(x=>x.passageId===p.passageId).sentences[0];s.startTime=.123;s.verificationStatus='reviewed';
 const merged=C.mergeCatalog(db,old).passages.find(x=>x.passageId===p.passageId);
 assert.equal(merged.sentences[0].startTime,.123);assert.ok(merged.continuous);assert.equal(C.plan(merged,'sentence',s.sentenceId)[0].nominalStart,1.123);
});

test('catalog script exposes the app contract and equals JSON',()=>{const fs=require('node:fs'),vm=require('node:vm'),context={window:{}};vm.runInNewContext(fs.readFileSync(__dirname+'/../dist/data/catalog.js','utf8'),context);assert.deepEqual(JSON.parse(JSON.stringify(context.window.CET_DATA)),db);});
