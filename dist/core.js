(function(g){
'use strict';
const clone=x=>JSON.parse(JSON.stringify(x));
const isRange=r=>r&&typeof r.audioFile==='string'&&Number.isFinite(r.startTime)&&Number.isFinite(r.endTime)&&r.startTime>=0&&r.endTime>r.startTime;
function trainingExams(db){return db.exams.filter(e=>e.year>=2017&&e.year<=2024);}
function trainingPassages(db){const ids=new Set(trainingExams(db).map(e=>e.examId));return db.passages.filter(p=>ids.has(p.examId));}
function bodyRange(p){const c=p.continuous;if(!c)return {...p.body};return {...c,startTime:c.practiceStart??0,endTime:c.bodyEnd,label:'正文 · 原声前导'};}
function sourceRange(p,r){const c=p.continuous;if(!c||r.audioFile!==p.body.audioFile||!isRange(r))return {...r};return {...r,audioFile:c.audioFile,startTime:r.startTime+c.bodyOffset,endTime:r.endTime+c.bodyOffset};}
function leadInSeconds(value){return Number.isFinite(value)?Math.max(0,Math.min(1,value)):.5;}
function contextRange(p,r,leadIn=.5,tail=.06){
 const mapped=sourceRange(p,r);if(!isRange(mapped))return mapped;
 const lead=leadInSeconds(leadIn);
 const limit=p.continuous&&mapped.audioFile===p.continuous.audioFile?p.continuous.bodyEnd:mapped.audioFile===p.body?.audioFile?p.body.endTime:mapped.endTime;
 return {...mapped,nominalStart:mapped.startTime,nominalEnd:mapped.endTime,startTime:Math.max(p.continuous&&mapped.audioFile===p.continuous.audioFile?p.continuous.practiceStart??0:0,mapped.startTime-lead),endTime:Math.min(limit,mapped.endTime+tail),leadIn:Math.min(lead,mapped.startTime)};
}
function wordPlan(p,sentenceId,wordId,options={}){
 const s=p.sentences.find(s=>s.sentenceId===sentenceId),w=s&&wordSpans(s).find(w=>w.wordId===wordId);
 if(!w||!Number.isFinite(w.startTime)||w.endTime<=w.startTime)throw Error('此词缺少可靠的发音范围。');
 return [contextRange(p,{audioFile:s.audioFile,startTime:w.startTime,endTime:w.endTime,label:w.text+' · 含起播前导',wordId},options.leadIn??.5,.06)];
}
function timelinePosition(p,r,position){return p?.continuous&&r?.audioFile===p.continuous.audioFile?{audioFile:p.body.audioFile,time:position-p.continuous.bodyOffset}:{audioFile:r?.audioFile,time:position};}
function audioPaths(p){return p.continuous?[p.continuous.audioFile,...p.sentences.filter(s=>s.audioFile!==p.body.audioFile).map(s=>s.audioFile)]:[p.body?.audioFile,...p.questions.map(q=>q.segment?.audioFile),...p.sentences.map(s=>s.audioFile)];}
function plan(p,mode='full',id=null,options={}){
 let ranges=[],c=p.continuous;
 if(mode==='full'&&c)ranges=[{...c,startTime:c.practiceStart??0,label:'正文与题目 · 连续原声'}];
 else if(mode==='questions'&&c)ranges=[{...c,startTime:c.questionsStart,label:'全部题目 · 原始停顿'}];
 else {
  if(mode==='body'||mode==='full')ranges.push({...bodyRange(p),label:'正文'});
  if(mode==='questions'||mode==='full')ranges.push(...p.questions.map(q=>({...q.playback||q.segment,label:'Q'+q.originalQuestionNumber,questionId:q.questionId})));
 }
 if(mode==='question'){const q=p.questions.find(q=>q.questionId===id);if(q)ranges=[{...(q.playback||q.segment),label:'Q'+q.originalQuestionNumber,questionId:id}];}
 if(mode==='sentence'){const s=p.sentences.find(s=>s.sentenceId===id);if(s)ranges=[contextRange(p,{audioFile:s.audioFile,startTime:s.startTime,endTime:s.endTime,label:'单句 · 含起播前导',sentenceId:id},options.leadIn??.5)];}
 if(ranges.some(r=>!isRange(r)))throw Error('此播放范围尚未校准，请先导入或校准音频标注。');
 if(!ranges.length)throw Error('没有可播放的原声片段。');return ranges;
}
function answerVerdict(q,chosen){
 const key=x=>typeof x==='string'&&/^[ABCD]$/.test(x)&&(!q.options||Object.hasOwn(q.options,x));
 if(key(q.correctAnswer))return {kind:'verified',key:q.correctAnswer,isCorrect:chosen===q.correctAnswer};
 if(q.answerVerification==='source-conflict'||q.answerConflict)return {kind:'conflict',isCorrect:null};
 if(key(q.referenceAnswer)&&q.answerVerification==='single-source-pending'&&q.answerSource?.length)return {kind:'reference',key:q.referenceAnswer,isCorrect:null,agrees:chosen?chosen===q.referenceAnswer:null};
 return {kind:'missing',isCorrect:null};
}
function attemptAnswers(h){if(h?.answers&&typeof h.answers==='object'&&!Array.isArray(h.answers)&&Object.keys(h.answers).length)return {...h.answers};if(Array.isArray(h?.result?.rows)&&h.result.rows.some(r=>r.questionId&&r.chosen))return Object.fromEntries(h.result.rows.filter(r=>r.questionId&&r.chosen).map(r=>[r.questionId,r.chosen]));return null;}
function grade(questions,answers){const rows=questions.map(q=>({questionId:q.questionId,chosen:answers[q.questionId]||null,correct:q.correctAnswer||null,isCorrect:q.correctAnswer?answers[q.questionId]===q.correctAnswer:null}));const graded=rows.filter(r=>r.correct);return {rows,correct:graded.filter(r=>r.isCorrect).length,total:graded.length,pending:rows.length-graded.length,answered:rows.filter(r=>r.chosen).length,accuracy:graded.length?graded.filter(r=>r.isCorrect).length/graded.length:null};}
function shuffle(items,random=Math.random){const out=items.slice();for(let i=out.length-1;i>0;i--){const j=Math.floor(random()*(i+1));[out[i],out[j]]=[out[j],out[i]];}return out;}
function safePath(s){return typeof s==='string'&&s.length<500&&!s.includes('..')&&!/^(?:[a-z]+:|[/\\])/i.test(s)&&!/[?#]/.test(s);}
function validate(db){const errors=[];if(db?.schemaVersion!==1||!Array.isArray(db.exams)||!Array.isArray(db.passages))return ['不支持的数据格式'];const examIds=new Set(),pIds=new Set(),qIds=new Set(),sIds=new Set();for(const e of db.exams){if(examIds.has(e.examId))errors.push('重复试卷ID');examIds.add(e.examId);if(!Number.isInteger(e.year)||e.year<2017||e.year>2026)errors.push('试卷年份无效');if(e.audioFile&&!safePath(e.audioFile))errors.push('音频路径无效');}
for(const p of db.passages){if(pIds.has(p.passageId))errors.push('重复文章ID');pIds.add(p.passageId);if(!examIds.has(p.examId))errors.push('文章所属试卷不存在');if(!Array.isArray(p.questions)||!Array.isArray(p.sentences)){errors.push('文章字段缺失');continue;}if(p.body&&(!isRange(p.body)||!safePath(p.body.audioFile)))errors.push('正文范围无效');if(p.continuous&&(!isRange(p.continuous)||!safePath(p.continuous.audioFile)||!Number.isFinite(p.continuous.bodyOffset)||p.continuous.bodyOffset<0||p.continuous.bodyEnd>p.continuous.endTime||p.continuous.questionsStart<p.continuous.bodyEnd||p.continuous.questionsStart>=p.continuous.endTime||(p.continuous.practiceStart!==undefined&&(!Number.isFinite(p.continuous.practiceStart)||p.continuous.practiceStart<0||p.continuous.practiceStart>=p.continuous.bodyEnd))))errors.push('连续原声范围无效');for(const q of p.questions){if(q.playback&&(!isRange(q.playback)||!safePath(q.playback.audioFile)||q.playback.audioFile!==p.continuous?.audioFile||q.playback.endTime>p.continuous.endTime))errors.push('恢复后的题目范围无效');if(qIds.has(q.questionId))errors.push('重复问题ID');qIds.add(q.questionId);if(!q.options||'ABCD'.split('').some(k=>typeof q.options[k]!=='string'))errors.push('选项不完整');if(q.correctAnswer&&!['A','B','C','D'].includes(q.correctAnswer))errors.push('答案无效');if(q.segment&&(!isRange(q.segment)||!safePath(q.segment.audioFile)))errors.push('问题范围无效');}
let prev=-1;for(const s of p.sentences){if(sIds.has(s.sentenceId))errors.push('重复句子ID');sIds.add(s.sentenceId);if(s.startTime!==null){if(!isRange(s)||!safePath(s.audioFile))errors.push('句子范围无效');if(s.startTime<prev-.2)errors.push('句子时序错误');prev=s.startTime;}for(const w of s.words||[])if(w.startTime!==null&&(!Number.isFinite(w.endTime)||w.endTime<w.startTime||w.startTime<0))errors.push('单词范围无效');}}
return [...new Set(errors)];}

function audioIdentity(file){return String(file||'').replace(/^audio\/(?:clips|opus)\//,'').replace(/\.(?:mp3|opus)$/,'');}
function mergeCatalog(bundled,saved){
 if(!saved||validate(saved).length)return clone(bundled);
 const result=clone(bundled),examIds=new Set(result.exams.map(e=>e.examId)),passageIds=new Set(result.passages.map(p=>p.passageId));
 for(const e of saved.exams)if(!examIds.has(e.examId)){result.exams.push(clone(e));examIds.add(e.examId);}
 const prior=new Map(saved.passages.map(p=>[p.passageId,p]));
 for(const p of result.passages){const old=prior.get(p.passageId);if(!old||old.body?.originalStart!==p.body?.originalStart||old.body?.endTime!==p.body?.endTime||((old.body?.audioSha256||p.body?.audioSha256)&&old.body?.audioSha256!==p.body?.audioSha256)||audioIdentity(old.body?.audioFile)!==audioIdentity(p.body?.audioFile))continue;const sentences=new Map(old.sentences.map(s=>[s.sentenceId,s]));for(const s of p.sentences){const before=sentences.get(s.sentenceId);if(before?.verificationStatus==='reviewed'&&before.englishText===s.englishText){s.startTime=before.startTime;s.endTime=before.endTime;s.verificationStatus='reviewed';}if(before?.englishText===s.englishText){if(before.translationVerification==='reviewed'){s.chineseTranslation=before.chineseTranslation;s.translationScope=before.translationScope;s.translationVerification='reviewed';}if(before.words?.some(w=>w.verificationStatus==='reviewed')){const indexed=new Map(before.words.filter(w=>w.verificationStatus==='reviewed').map(w=>[w.wordId||w.text,w]));s.words=s.words.map(w=>indexed.has(w.wordId||w.text)?clone(indexed.get(w.wordId||w.text)):w);}}}}
 for(const p of saved.passages)if(!passageIds.has(p.passageId)&&examIds.has(p.examId))result.passages.push(clone(p));
 return validate(result).length?clone(bundled):result;
}


// Display offsets remain independent of ASR token boundaries.
function wordSpans(s){
 const source=s.englishText||'',data=s.words||[];let cursor=0;
 const located=data.map((w,index)=>{const at=Number.isInteger(w.charStart)&&w.charStart>=cursor&&source.slice(w.charStart,w.charEnd)===w.text?w.charStart:source.indexOf(w.text,cursor);if(at<0)return null;cursor=at+w.text.length;return {w,index,a:at,b:cursor};}).filter(Boolean);
 return Array.from(source.matchAll(/[0-9]+(?:,[0-9]{3})*(?:\.[0-9]+)?|[A-Za-z]+(?:['’\-‐‑][A-Za-z]+)*/g),m=>{const start=m.index,end=start+m[0].length;const parts=located.filter(x=>x.a>=start&&x.b<=end);let owner=located.find(x=>x.a<=start&&x.b>=end);if(!owner&&parts.length&&parts.map(x=>x.w.text).join('')===m[0].replace(/[,.]/g,'')){const valid=parts.every(x=>Number.isFinite(x.w.startTime)&&x.w.endTime>x.w.startTime)&&parts.every((x,i)=>!i||x.w.startTime>=parts[i-1].w.startTime);owner={index:parts[0].index,w:{startTime:valid?parts[0].w.startTime:null,endTime:valid?parts.at(-1).w.endTime:null},indices:parts.map(x=>x.index)};}const w=owner?.w;const timed=Number.isFinite(w?.startTime)&&Number.isFinite(w?.endTime)&&w.endTime>w.startTime;return {text:m[0],charStart:start,charEnd:end,wordId:s.sentenceId+'@'+start+'-'+end,dataIndex:owner?.index??null,dataIndices:owner?.indices||(owner?[owner.index]:[]),startTime:timed?w.startTime:null,endTime:timed?w.endTime:null,groupId:timed?(w.timeGroup||s.sentenceId+':'+w.startTime+'-'+w.endTime):null};});
}
function approximateSentenceRange(p,index,options={}){
 const s=p.sentences[index],words=s.words||[];let a,b;
 const valid=words.length&&words.every(w=>Number.isFinite(w.startTime)&&w.endTime>w.startTime)&&words.every((w,i)=>!i||w.startTime>=words[i-1].startTime);
 if(valid){a=Math.max(0,words[0].startTime-.12);b=Math.min(p.body.endTime,words.at(-1).endTime+.15);}
 else{const prev=p.sentences.slice(0,index).reverse().find(s=>Number.isFinite(s.endTime)),next=p.sentences.slice(index+1).find(s=>Number.isFinite(s.startTime));a=Math.max(0,(prev?.endTime||0)-.1);b=Math.min(p.body.endTime,(next?.startTime??p.body.endTime)+.1);}
 if(!(b>a)){a=p.body.startTime||0;b=p.body.endTime;}
 return contextRange(p,{audioFile:p.body.audioFile,startTime:a,endTime:b,label:'附近原声 · 此句边界待校准',sentenceId:s.sentenceId,approximate:true},options.leadIn??.5);
}
function sentencePlan(p,id,continuous=false,options={}){
 const index=p.sentences.findIndex(s=>s.sentenceId===id);if(index<0)throw Error('找不到句子');const s=p.sentences[index];
 if(!continuous)return Number.isFinite(s.startTime)&&Number.isFinite(s.endTime)?plan(p,'sentence',id,options):[approximateSentenceRange(p,index,options)];
 const previous=p.sentences.slice(0,index).reverse().find(x=>Number.isFinite(x.endTime));
 const previousWords=previous?wordSpans(previous).filter(w=>Number.isFinite(w.endTime)&&w.endTime>w.startTime):[];
 const currentWords=wordSpans(s).filter(w=>Number.isFinite(w.startTime)&&Number.isFinite(w.endTime)&&w.endTime>w.startTime);
 const priorEnd=Number.isFinite(previous?.endTime)?previous.endTime:previousWords.length?Math.max(...previousWords.map(w=>w.endTime)):null;
 const currentFirst=currentWords.length?Math.min(...currentWords.map(w=>w.startTime)):null;
 const oldAnchor=p.sentences.slice(0,index).reverse().find(x=>Number.isFinite(x.startTime));
 const target=Number.isFinite(s.startTime)?{time:s.startTime,approximate:false}:Number.isFinite(priorEnd)?{time:priorEnd,approximate:true}:Number.isFinite(currentFirst)?{time:currentFirst,approximate:true}:oldAnchor?{time:oldAnchor.startTime,approximate:true}:null;
 const r=bodyRange(p);return [{...r,sentenceId:id,approximate:!!target?.approximate,playFrom:target?Math.max(r.startTime,target.time+(p.continuous?.bodyOffset||0)-leadInSeconds(options.leadIn)):r.startTime,label:target?.approximate?'正文连续播放 · 从最近可用边界附近开始':'正文连续播放'}];
}
function evidencePlan(p,q,options={}){
 const byId=new Map(p.sentences.map((s,i)=>[s.sentenceId,[s,i]]));
 for(const id of q?.evidenceSentenceIds||[]){
  const hit=byId.get(id);if(!hit)continue;
  const [s,i]=hit,hasBounds=isRange(s);
  if(!hasBounds&&!isRange(p.body))continue;
  const r=hasBounds?contextRange(p,{audioFile:s.audioFile,startTime:s.startTime,endTime:s.endTime,sentenceId:id},options.leadIn??.5):approximateSentenceRange(p,i,options);
  // Without a short, located candidate, do not substitute the whole recording for evidence.
  if(!isRange(r)||!safePath(r.audioFile)||(!hasBounds&&r.endTime-r.startTime>24))continue;
  return {...r,label:'Q'+q.originalQuestionNumber+(hasBounds?' · 答案依据':' · 附近原声'),approximate:!hasBounds||s.verificationStatus!=='reviewed'};
 }
 return null;
}
function mergeLearningStates(local={},saved={}){
 const a=local&&typeof local==='object'?local:{},b=saved&&typeof saved==='object'?saved:{};
 const newer=(Number(b.updatedAt)||0)>(Number(a.updatedAt)||0)?b:a,older=newer===a?b:a;
 const array=(v)=>Array.isArray(v)?v:[];const history=new Map();
 for(const h of [...array(older.history),...array(newer.history)])if(h&&h.passageId)history.set(h.id||h.at+':'+h.passageId,h);
 const merged={...older,...newer,history:[...history.values()],answers:{...(older.answers||{}),...(newer.answers||{})},notes:{...(older.notes||{}),...(newer.notes||{})},optionMarks:{...(older.optionMarks||{}),...(newer.optionMarks||{})}};
 merged.completed=[...new Set([...array(a.completed),...array(b.completed),...merged.history.map(h=>h.passageId)])];
 merged.favorites=(a.updatedAt||b.updatedAt)?array(newer.favorites):[...new Set([...array(a.favorites),...array(b.favorites)])];
 merged.studySeconds=Math.max(Number(a.studySeconds)||0,Number(b.studySeconds)||0);return merged;
}
function translationFor(p,s){
 if(s.translationScope==='sentence'&&s.chineseTranslation)return {text:s.chineseTranslation,scope:'sentence',sentenceIds:[s.sentenceId]};
 const group=p.sentences.filter(x=>x.paragraph===s.paragraph);if(p.paragraphTranslations?.[s.paragraph])return {text:p.paragraphTranslations[s.paragraph],scope:'paragraph',sentenceIds:group.map(x=>x.sentenceId)};const translated=group.filter(x=>x.translationScope==='paragraph'&&x.chineseTranslation);
 if(translated.length)return {text:[...new Set(translated.map(x=>x.chineseTranslation))].join('\n'),scope:'paragraph',sentenceIds:group.map(x=>x.sentenceId)};
 return {text:'此句暂无可靠的独立译文。',scope:'missing',sentenceIds:[s.sentenceId]};
}

class AudioEngine extends EventTarget {
 constructor(resolve,Context){super();this.resolve=resolve;this.Context=Context||g.AudioContext||g.webkitAudioContext;this.cache=new Map();this.queue=[];this.index=0;this.offset=0;this.rate=1;this.volume=.85;this.token=0;this.loop=false;this.playing=false;this.ab=null;}
 emit(type,detail={}){const e=new Event(type);e.detail=detail;this.dispatchEvent(e);}
 async init(){if(!this.Context)throw Error('此浏览器不支持精确音频播放，请换用新版 Chrome、Edge 或 Firefox。');if(!this.ctx){this.ctx=new this.Context();this.gain=this.ctx.createGain();this.gain.connect(this.ctx.destination);this.gain.gain.value=this.volume;}await this.ctx.resume();}
 async buffer(path){if(this.cache.has(path))return this.cache.get(path);const result=await this.resolve(path);const b=await this.ctx.decodeAudioData(result.slice(0));this.cache.set(path,b);if(this.cache.size>8)this.cache.delete(this.cache.keys().next().value);return b;}
 stopNode(){if(this.source){this.source.onended=null;try{this.source.stop();}catch{}this.source.disconnect();this.source=null;}}
 cancel(){this.token++;this.stopNode();this.playing=false;this.emit('state');}
 reset(){this.cancel();this.queue=[];this.index=0;this.offset=0;this.ab=null;this.loop=false;this.task=null;this.emit('state');}
 async play(ranges,task={}){if(!ranges.length||ranges.some(r=>!isRange(r)))throw Error('无效播放范围');this.cancel();this.task=task;this.queue=ranges.map(r=>({...r}));this.index=0;this.offset=this.queue[0].playFrom??this.queue[0].startTime;this.ab=null;await this.resume();}
 async resume(){if(!this.queue.length)return;const token=++this.token;this.stopNode();await this.init();if(token!==this.token)return;const r=this.queue[this.index];if(!r)return;const b=await this.buffer(r.audioFile);if(token!==this.token)return;
 const end=this.ab?.b??r.endTime;const start=Math.max(this.ab?.a??r.startTime,Math.min(this.offset,end));if(end>b.duration+.08)throw Error('音频标注超出文件时长，请重新校准。');const length=Math.min(end,b.duration)-start;if(length<=.001){this.offset=r.startTime;return this.advance();}this.source=this.ctx.createBufferSource();this.source.buffer=b;this.source.playbackRate.value=this.rate;this.source.connect(this.gain);this.offset=start;this.clock=this.ctx.currentTime;this.playing=true;this.source.onended=()=>token===this.token?this.advance().catch(e=>this.fail(e)):Promise.resolve();this.source.start(0,start,length);this.emit('state');}
 fail(e){this.cancel();this.emit('error',{message:e.message});}
 async advance(){const r=this.queue[this.index];if(this.ab){this.offset=this.ab.a;return this.resume();}if(this.index<this.queue.length-1){this.index++;this.offset=this.queue[this.index].startTime;return this.resume();}if(this.loop){this.index=0;this.offset=this.queue[0].startTime;return this.resume();}this.playing=false;this.offset=r.endTime;this.emit('state');this.emit('complete',this.task||{});}
 position(){const r=this.queue[this.index];if(!r)return 0;return Math.min(this.ab?.b??r.endTime,this.offset+(this.playing?(this.ctx.currentTime-this.clock)*this.rate:0));}
 pause(){this.offset=this.position();this.cancel();}
 async toggle(){if(this.playing)this.pause();else if(this.queue.length){if(this.offset>=this.queue[this.index].endTime-.01){this.index=0;this.offset=this.queue[0].startTime;}await this.resume();}}
 async seek(pos){if(!this.queue.length)return;const running=this.playing;this.cancel();const r=this.queue[this.index];this.offset=Math.max(this.ab?.a??r.startTime,Math.min(pos,this.ab?.b??r.endTime));if(running)await this.resume();else this.emit('state');}
 async setRate(rate){const running=this.playing;this.offset=this.position();this.cancel();this.rate=rate;if(running)await this.resume();}
 setVolume(v){this.volume=v;if(this.gain)this.gain.gain.value=v;}
 setAB(a,b){const r=this.queue[this.index];if(!r||a<r.startTime||b>r.endTime||b<=a+.03)throw Error('A、B 必须位于当前片段内，且 B 晚于 A。');this.ab={a,b};this.offset=a;if(this.playing)return this.resume();}
}
const api={evidencePlan,answerVerdict,attemptAnswers,contextRange,wordPlan,bodyRange,sourceRange,timelinePosition,audioPaths,wordSpans,sentencePlan,mergeLearningStates,translationFor,mergeCatalog,clone,isRange,trainingExams,trainingPassages,plan,grade,shuffle,safePath,validate,AudioEngine};if(typeof module!=='undefined')module.exports=api;g.CETCore=api;
})(typeof window!=='undefined'?window:globalThis);
