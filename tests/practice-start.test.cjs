const test=require('node:test'),assert=require('node:assert/strict'),C=require('../dist/core.js'),db=require('../dist/data/catalog.json');
const p=db.passages.find(p=>p.passageId==='2017-12-2-p1');
test('daily practice skips long exam directions but whole-exam file is untouched',()=>{
 assert.equal(C.plan(p,'full')[0].startTime,30.4);assert.equal(C.plan(p,'body')[0].startTime,30.4);
 assert.equal(C.plan(p,'questions')[0].startTime,p.continuous.questionsStart);
 assert.equal(C.plan(p,'question',p.questions[0].questionId)[0].startTime,p.questions[0].playback.startTime);
 assert.equal(p.sentences[0].startTime,29.5);assert.equal(p.sentences[0].words[0].startTime,null);
 assert.ok(C.sentencePlan(p,p.sentences[0].sentenceId)[0].startTime>=30.4);
 assert.ok(C.sentencePlan(p,p.sentences[0].sentenceId,true)[0].playFrom>=30.4);
 assert.equal(C.plan(db.passages.find(x=>x.passageId==='2017-06-1-p1'),'full')[0].startTime,0);
});
test('invalid practice start cannot publish',()=>{for(const v of [-1,p.continuous.bodyEnd,NaN]){const x=structuredClone(db);x.passages.find(y=>y.passageId===p.passageId).continuous.practiceStart=v;assert.ok(C.validate(x).includes('连续原声范围无效'));}});

test('short section labels are skipped without clipping the first body word',()=>{
 const starts={'2018-06-1-p3':.85,'2020-12-1-p2':1.3,'2020-12-2-p2':2.3,'2024-06-1-p2':2.55};
 for(const [id,start] of Object.entries(starts)){const x=db.passages.find(p=>p.passageId===id);assert.equal(C.plan(x,'full')[0].startTime,start);assert.equal(C.plan(x,'body')[0].startTime,start);assert.ok(C.plan(x,'questions')[0].startTime>start);}
 const next=db.passages.find(p=>p.passageId==='2024-06-1-p2').sentences[0].words[0];assert.equal(next.startTime,null);
});
