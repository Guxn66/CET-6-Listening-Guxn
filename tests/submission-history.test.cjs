const test=require('node:test'),assert=require('node:assert/strict');
const P=require('../dist/progress.js');

test('first submission times ignore drafts and preserve different first times within one passage',()=>{
 const history=[
  {passageId:'p',at:'2026-11-19T01:20:07Z',answers:{a:'C',b:'D'}},
  {passageId:'p',at:'2026-11-18T12:00:00+08:00',result:{rows:[{questionId:'a',chosen:'B'},{questionId:'b',chosen:null}]}},
  {passageId:'q',answers:{c:'A'}}
 ];
 const result=P.submissionSummary({history,completed:['orphan'],answers:{draft:'B'}});
 assert.deepEqual(result,{completedPassages:3,submittedQuestions:3,passagesWithTime:1,passagesWithoutTime:2,
  firstPassageSubmissions:{p:'2026-11-18T04:00:00.000Z',q:null,orphan:null},
  firstQuestionSubmissions:{a:'2026-11-18T04:00:00.000Z',b:'2026-11-19T01:20:07.000Z',c:null},recordedAttempts:3});
});

test('backup round trip preserves original timestamps and hides the retake date when the first attempt has no date',()=>{
 const backup={history:[{id:'a1',passageId:'p',at:'2025-06-19T22:30:35.456Z',answers:{a:'B'}},{id:'u1',passageId:'q',answers:{b:'C'}}],completed:['p','q','legacy-flag'],answers:{a:'B',b:'C'}};
 const local={history:[{id:'a2',passageId:'p',at:'2026-11-19T02:00:00Z',answers:{a:'C'}},{id:'u2',passageId:'q',at:'2026-11-19T02:15:00Z',answers:{b:'A',c:'C'}}],completed:['p','q'],answers:{a:'C',b:'A'}};
 const merged=P.mergeBackup(local,JSON.parse(JSON.stringify(backup)));
 const s=P.submissionSummary(merged);
 assert.deepEqual(s.firstPassageSubmissions,{p:'2025-06-19T22:30:35.456Z',q:null,'legacy-flag':null});
 assert.deepEqual(s.firstQuestionSubmissions,{a:'2025-06-19T22:30:35.456Z',b:null,c:'2026-11-19T02:15:00.000Z'});
 assert.deepEqual(P.submissionSummary(P.mergeBackup(merged,backup)),s);
});
