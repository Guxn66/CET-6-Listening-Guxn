'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const {randomUUID}=require('node:crypto');
const {PGlite}=require('@electric-sql/pglite');
const {createApp}=require('../server/index.cjs');
const core=require('../dist/cloud-core.js');
const progress=require('../dist/progress.js');
const fixture=()=>core.state({answers:{q1:'A'},favorites:['p1'],studySeconds:120,history:[{id:'first',at:'2026-10-08T12:23:00.000Z',passageId:'p1',answers:{q1:'A'}}]});
const delta=(before,after)=>({id:randomUUID(),delta:core.projectedDelta(before,after)});
test('seed retains existing cloud answers, tombstones and earliest submission',()=>{
 const old=fixture(),doc={state:core.state(),deleted:{}};
 core.apply(doc,{seed:old});
 core.apply(doc,delta(old,{...old,answers:{q2:'C'},favorites:[]}));
 core.apply(doc,{seed:{...old,answers:{q1:'A',q2:'B',q3:'D'},history:[...old.history,{...old.history[0],id:'older',at:'2026-10-07T12:23:00.000Z',answers:{q1:'B'}}]}});
 assert.deepEqual(doc.state.answers,{q2:'C',q3:'D'});
 assert.deepEqual(doc.state.favorites,[]);
 assert.equal(doc.state.history.length,2);
 assert.equal(progress.firstChoices(doc.state.history).q1,'B');
 assert.equal(doc.state.studySeconds,120);
});
test('PostgreSQL HTTP integration: sign in, two devices, duplicate delivery, isolation, logout and restart',async()=>{
 const db=new PGlite();
 const pool={query:async(...a)=>{
   const r=a.length===1&&a[0].startsWith('CREATE TABLE')?await db.exec(a[0]):await db.query(...a);
   return {...r,rowCount:r.rows?.length||r.affectedRows||0};
 }};
 pool.connect=async()=>({...pool,release(){}});
 let server,origin;
 async function start(){
  server=createApp(pool,{registrationCode:'local-test-only'}).listen(0,'127.0.0.1');
  await new Promise(r=>server.once('listening',r));origin='http://127.0.0.1:'+server.address().port;
 }
 const close=()=>new Promise(r=>server.close(r));
 async function req(route,{body,cookie,from=origin}={}){
  const r=await fetch(origin+route,{headers:{...(cookie?{cookie}:{}),...(body?{'content-type':'application/json',origin:from}:{})},...(body?{method:'POST',body:JSON.stringify(body)}:{})});
  return {status:r.status,headers:r.headers,body:await r.json(),cookie:r.headers.get('set-cookie')?.split(';')[0]};
 }
 const auth={username:'learner_a',password:'disposable-testing-password'};
 try{
  await start();
  assert.deepEqual((await req('/api/status')).body,{database:'ready',registration:true});
  assert.equal((await req('/api/register',{body:{...auth,invite:'wrong'}})).status,403);
  const a=await req('/api/register',{body:{...auth,invite:'local-test-only'}});
  assert.equal(a.status,200);assert.match(a.headers.get('set-cookie'),/HttpOnly.*SameSite=Lax/);assert.equal(a.headers.get('cache-control'),'no-store');
  assert.equal((await req('/api/login',{body:auth,from:'https://another.example'})).status,403);
  const b=await req('/api/login',{body:auth});
  assert.equal(b.status,200);
  const owner=a.body.user.id;
  const sync=(cookie,revision,ops=[],id=owner)=>req('/api/sync',{cookie,body:{owner:id,revision,ops}});
  assert.equal((await sync(undefined,-1)).status,401);
  const seed={id:randomUUID(),seed:fixture()};
  assert.equal((await sync(a.cookie,-1,[seed])).body.revision,1);
  assert.equal((await sync(b.cookie,-1)).body.document.state.answers.q1,'A');
  const base=fixture(),op1=delta(base,{...base,answers:{q1:'A',q2:'B'},studySeconds:135});
  const op2=delta(base,{...base,answers:{q3:'C'},studySeconds:125});
  assert.equal((await sync(a.cookie,1,[op1])).status,200);
  const both=await sync(b.cookie,1,[op2]);
  assert.equal(both.status,200);
  assert.deepEqual(both.body.document.state.answers,{q2:'B',q3:'C'});
  assert.equal(both.body.document.state.studySeconds,140);
  assert.equal((await sync(a.cookie,1,[op1])).body.document.state.studySeconds,140);
  assert.equal((await sync(a.cookie,99)).status,409);
  const other=await req('/api/register',{body:{...auth,username:'learner_other',invite:'local-test-only'}});
  assert.equal((await sync(other.cookie,-1)).status,409);
  assert.deepEqual((await sync(other.cookie,-1,[],other.body.user.id)).body.document.state.answers,{});
  const bad=delta(base,{...base,answers:{q1:'K'}}); assert.equal((await sync(a.cookie,3,[bad])).status,400);
  assert.equal((await req('/api/logout',{cookie:a.cookie,body:{}})).status,200);
  assert.equal((await sync(a.cookie,3)).status,401);
  await close(); await start();
  const retrieved=await sync(b.cookie,-1);
  assert.equal(retrieved.body.revision,3);
  assert.deepEqual(retrieved.body.document.state.answers,{q2:'B',q3:'C'});
  console.log('HTTP verified: persistence across app restart, distinct accounts, replay safety, offline edits and answer removal');
 }finally{if(server?.listening)await close();await db.close();}
});
