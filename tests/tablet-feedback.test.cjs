const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),vm=require('node:vm');
const C=require('../dist/core.js'),P=require('../dist/progress.js'),db=require('../dist/data/catalog.json');
const state=(changes={})=>({history:[],completed:[],favorites:[],answers:{},inkNotes:{},...changes});
test('on a stale tab, drawing and erasing affect only the observed stroke IDs',()=>{
 const a=state({inkNotes:{p:[{id:'a'}]}}),b=state({inkNotes:{p:[{id:'a'},{id:'b'}]}}),peer=state({inkNotes:{p:[{id:'a'},{id:'c'}]}});
 const result=P.apply(peer,P.delta(a,b));assert.deepEqual(result.inkNotes.p.map(x=>x.id),['a','c','b']);
 const undo=P.apply(result,P.delta(b,a));assert.deepEqual(undo.inkNotes.p.map(x=>x.id),['a','c']);
 const emptyUndo=P.apply(result,P.delta(a,state()));assert.deepEqual(emptyUndo.inkNotes.p.map(x=>x.id),['c','b']);
});
test('legacy whole-passage writes cannot erase protected strokes or revive a deleted one',()=>{
 const ledger=P.rememberInk({}, {p:{add:[{id:'added'}],del:['removed']}});
 assert.deepEqual(P.inkApply({p:[{id:'removed'},{id:'legacy'}]},ledger).p.map(x=>x.id),['legacy','added']);
 const tomb=P.rememberInk(ledger,{p:{add:[],del:['added']}});assert.deepEqual(P.inkApply({p:[{id:'added'}]},tomb).p,[]);
});
test('backup import retains both histories and ink, does not resurrect an answer after retry, and is idempotent',()=>{
 const a=state({history:[{id:'1',passageId:'p',answers:{q:'B'}}],answers:{live:'C'},inkNotes:{p:[{id:'p1'}]},studySeconds:30});
 const b=state({history:[{id:'2',passageId:'other',answers:{old:'C'}}],answers:{q:'A',live:'A',old:'C'},inkNotes:{p:[{id:'p2'}]},studySeconds:20});
 const orig=JSON.stringify([a,b]),v=P.mergeBackup(a,b,{preferIncomingUntimed:false});
 assert.deepEqual(v.answers,{live:'C',old:'C'});assert.equal(v.history.length,2);assert.equal(v.inkNotes.p.length,2);assert.equal(v.studySeconds,30);
 assert.deepEqual(P.mergeBackup(v,b,{preferIncomingUntimed:false}),v);assert.equal(JSON.stringify([a,b]),orig);
});
test('pending feedback never changes scored totals; conflicts are not advertised as a key',()=>{
 const q={questionId:'q',referenceAnswer:'C',answerVerification:'single-source-pending',answerSource:['source'],options:{A:'a',B:'b',C:'c',D:'d'}};
 assert.deepEqual(C.answerVerdict(q,'B'),{kind:'reference',key:'C',isCorrect:null,agrees:false});
 assert.equal(C.grade([q],{q:'B'}).rows[0].isCorrect,null);assert.equal(C.grade([q],{q:'B'}).total,0);
 assert.equal(C.answerVerdict({...q,answerVerification:'source-conflict'},'B').key,undefined);assert.equal(C.answerVerdict({...q,answerSource:[]},'C').kind,'missing');
});
test('the screenshot passage can be regraded from old answer rows without modifying the saved attempt',()=>{
 const p=db.passages.find(p=>p.passageId==='2017-06-2-p1');const h={result:{total:0,rows:p.questions.map((q,i)=>({questionId:q.questionId,chosen:'ABAD'[i],correct:null,isCorrect:null}))}};
 const raw=JSON.stringify(h);const r=C.grade(p.questions,C.attemptAnswers(h));assert.deepEqual(r.rows.map(x=>x.isCorrect),[true,false,true,true]);assert.equal(r.correct,3);assert.equal(JSON.stringify(h),raw);
});
test('a single touch-only stylus writes, a real pen wins over a palm, and switching modes saves the active stroke',()=>{
 const registered={},written=[],appBox={left:5,top:0,right:305,width:300};
 const clf={toggle(){}},canvas={classList:clf,style:{},addEventListener(k,v){registered[k]=v;},setPointerCapture(){},hasPointerCapture(){return false;},getContext(){return null;}};
 const win={innerHeight:500,devicePixelRatio:1,scrollY:100};const world={window:win,document:{documentElement:{classList:clf},addEventListener(){},elementsFromPoint(){return [];}},crypto:require('node:crypto').webcrypto,addEventListener(){},requestAnimationFrame(){return 1;}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../dist/ink-board.js'),'utf8'),world);
 const board=new win.CETInkBoard(canvas,{getBoundingClientRect:()=>appBox},{owner:()=>'p',layer:()=>'questions',blocked:()=>false,erase:()=>false,color:()=>'red',entries:()=>[],commit:(id,s)=>written.push(s)});
 function event(id,type,x=30,y=30,extra={}){return {pointerId:id,pointerType:type,isPrimary:true,clientX:x,clientY:y,width:2,height:2,preventDefault(){},...extra};}
 board.set(true,true);registered.pointerdown(event(1,'touch'));registered.pointermove(event(1,'touch',30,65));registered.pointerup(event(1,'touch',30,97));assert.ok(written[0].points.length>=3);
 registered.pointerdown(event(2,'touch'));registered.pointerdown(event(3,'pen'));registered.pointercancel(event(2,'touch'));assert.equal(board.active.pointer,3);
 registered.pointermove(event(3,'pen',30,90));board.set(true,false);assert.equal(written.length,2);assert.equal(canvas.hidden,false);assert.equal(board.enabled,false);assert.equal(written.at(-1).points.length,2);
 registered.pointerdown(event(4,'touch'));assert.equal(board.active,null);
});
test('verified / reference / conflicted question counts match release and both shipped catalogs',()=>{
 const r=require('../dist/data/release.json'),quality=require('../dist/data/quality-report.json');
 const script=fs.readFileSync(require.resolve('../dist/data/catalog.js'),'utf8'),world={window:{}};vm.runInNewContext(script,world);
 assert.equal(JSON.stringify(world.window.CET_DATA),JSON.stringify(db));const q=db.passages.flatMap(p=>p.questions),types=q.map(x=>C.answerVerdict(x,null).kind);
 assert.equal(q.length,825);assert.equal(db.passages.length,231);assert.equal(db.exams.length,33);assert.equal(types.filter(x=>x==='verified').length,r.scoring.verified);
 assert.equal(types.filter(x=>x==='reference').length,r.scoring.reference);assert.equal(types.filter(x=>x==='conflict').length,r.scoring.conflict);assert.equal(quality.verifiedAnswers,r.scoring.verified);
 assert.equal(C.answerVerdict(q.find(x=>x.questionId==='2019-12-2-q14'),'C').isCorrect,true);
});
test('pen mode routes only pen to ink; a finger tap stays a tap and a drag scrolls without a stroke',()=>{
 const root=[],surface={},seen=[],written=[],pageEvents={},rect={left:0,top:0,width:320,right:320};
 const cls=fn=>({toggle:fn||(()=>{})}),element=(events,fn)=>({classList:cls(fn),style:{},addEventListener(k,v){events[k]=v;},setPointerCapture(){},hasPointerCapture(){return false;},getContext(){return null;}});
 const main=element(surface),canvas=element({}),w={window:{innerHeight:500,scrollY:0,scrollBy(o){seen.push(o.top);}},document:{documentElement:{classList:cls((k,v)=>root.push([k,v]))},addEventListener(k,v){pageEvents[k]=v;},elementsFromPoint(){return [];}},crypto:require('node:crypto').webcrypto,addEventListener(){},requestAnimationFrame(){return 1;}};
 vm.runInNewContext(fs.readFileSync(require.resolve('../dist/ink-board.js'),'utf8'),w);
 const b=new w.window.CETInkBoard(canvas,{getBoundingClientRect:()=>rect},{main,owner:()=>'p',layer:()=>'questions',blocked:()=>false,erase:()=>false,color:()=>'red',entries:()=>[],commit:(_id,s)=>written.push(s)});
 const label={closest(){return null;}};
 const event=(pointerId,pointerType,type,y=60,target=label)=>({pointerId,pointerType,type,isPrimary:true,clientX:10,clientY:y,target,preventDefault(){}});
 b.set(true,true,'pen');assert.deepEqual(root.at(-1),['paper-locked',false]);
 surface.pointerdown(event(1,'touch','pointerdown'));pageEvents.pointerup(event(1,'touch','pointerup'));assert.equal(b.swallowClick,false);assert.equal(written.length,0);
 surface.pointerdown(event(1,'touch','pointerdown'));pageEvents.pointermove(event(1,'touch','pointermove',40));
 pageEvents.lostpointercapture(event(1,'touch','lostpointercapture',40));pageEvents.pointermove(event(1,'touch','pointermove',25));pageEvents.pointerup(event(1,'touch','pointerup',25,main));assert.deepEqual(seen,[20,15]);assert.equal(written.length,0);assert.equal(b.swallowClick,true);
 surface.pointerdown(event(3,'pen','pointerdown'));pageEvents.lostpointercapture(event(3,'pen','lostpointercapture'));
 pageEvents.pointermove(event(3,'pen','pointermove',90));pageEvents.pointerup(event(3,'pen','pointerup',120,main));assert.equal(written.length,1);assert.equal(written[0].points.length,3);assert.deepEqual(seen,[20,15]);
 b.set(true,false,'pen');assert.equal(canvas.hidden,false);
});
test('evidence playback uses one bounded original-audio candidate and reports uncertain boundaries',()=>{
 const p=db.passages.find(p=>p.passageId==='2017-06-2-p1'),q=p.questions[0];
 const r=C.evidencePlan(p,q);assert.ok(r&&q.evidenceSentenceIds.includes(r.sentenceId));assert.equal(r.audioFile,p.continuous.audioFile);assert.ok(r.endTime<=p.continuous.bodyEnd);assert.ok(r.startTime>0);assert.equal(r.approximate,true);
 assert.equal(C.evidencePlan(p,{evidenceSentenceIds:['other-passage']}),null);
 const noClocks={...p,sentences:[{sentenceId:'s',startTime:null,endTime:null}]};assert.equal(C.evidencePlan(noClocks,{evidenceSentenceIds:['s']}),null);
});
test('review reasons merge per question and survive a backup without overriding a current reason',()=>{
 const a=state({reviewReasons:{q1:'unheard'}}),b=state({reviewReasons:{q1:'unheard',q2:'unknown'}}),peer=state({reviewReasons:{q1:'unknown',q3:'unknown'}});
 assert.deepEqual(P.apply(peer,P.delta(a,b)).reviewReasons,{q1:'unknown',q3:'unknown',q2:'unknown'});
 assert.deepEqual(P.mergeBackup(b,peer).reviewReasons,{q1:'unheard',q3:'unknown',q2:'unknown'});
});

test('merging old and new attempts counts first submitted answers once and preserves new-only work',()=>{
 const current=state({answers:{q1:'C',q3:'A',draft:'B'},history:[{id:'new',at:'2026-11-19T10:00:00Z',passageId:'p',answers:{q1:'C',q3:'A'}}]});
 const incoming=state({answers:{q1:'D',q2:'C',draft:'A'},history:[
  {id:'old-first',at:'2026-10-18T10:00:00Z',passageId:'p',answers:{q1:'B',q2:'C'}},
  {id:'old-redo',at:'2026-10-20T10:00:00Z',passageId:'p',answers:{q1:'D',q2:'C'}}
 ]});
 const merged=P.mergeBackup(current,incoming);
 assert.deepEqual(merged.answers,{q1:'B',q3:'A',draft:'A',q2:'C'});assert.equal(merged.history.length,3);
 assert.deepEqual(P.mergeBackup(merged,incoming),merged);
 const r=P.firstStats(merged.history,[['q1','D'],['q2','C'],['q3','A'],['draft','B'],['unanswered','A']]);assert.equal(r.graded,3);assert.equal(r.correct,2);assert.deepEqual([...r.wrong],['q1']);
});
test('an old backup without dates takes precedence over the new site only when identified as older',()=>{
 const now=state({answers:{q:'C'},history:[{id:'new',at:'2026-11-19T00:00:00Z',passageId:'p',answers:{q:'C'}}]});
 const old=state({history:[{id:'old',passageId:'p',result:{rows:[{questionId:'q',chosen:'A'}]}}]});
 assert.equal(P.mergeBackup(now,old).answers.q,'A');assert.equal(P.mergeBackup(now,old,{preferIncomingUntimed:false}).answers.q,'C');
});
test('each newly graded question retains the passage-local evidence and the prior disagreement in the audit',{skip:!fs.existsSync(__dirname+'/../audit/2026-11-19-transcript-review.json')},()=>{
 const {createHash}=require('node:crypto'),a=require('../audit/2026-11-19-transcript-review.json');assert.equal(a.rows.length,50);
 for(const row of a.rows){const p=db.passages.find(p=>p.questions.some(q=>q.questionId===row.questionId)),q=p.questions.find(q=>q.questionId===row.questionId),s=p.sentences.find(s=>s.sentenceId===row.evidence);
 assert.equal(q.correctAnswer,row.answer);assert.ok(q.evidenceSentenceIds.includes(row.evidence));assert.equal(row.evidenceSha256,createHash('sha256').update(s.englishText).digest('hex'));}
 assert.equal(a.rows.find(q=>q.questionId==='2017-06-2-q14').previous.conflict.other,'B');
});
