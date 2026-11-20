'use strict';
const express=require('express');
const helmet=require('helmet');
const {rateLimit}=require('express-rate-limit');
const {Pool}=require('pg');
const {readFileSync}=require('node:fs');
const path=require('node:path');
const {randomUUID,randomBytes,createHash,scrypt,timingSafeEqual}=require('node:crypto');
const {promisify}=require('node:util');
const {Readable}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const cloud=require('../dist/cloud-core.js');
const rules=require('./validate.cjs');
const schema=readFileSync(path.join(__dirname,'schema.sql'),'utf8');
const web=path.join(__dirname,'../dist');
const upstream='https://cet6-listening-lab.poeticfern128.chatgpt.site';
const hash=s=>createHash('sha256').update(s).digest('hex');
const stretch=promisify(scrypt);
const days=30*24*60*60;
const denied=(res,status,message)=>res.status(status).json({error:message});
const emptyDoc=()=>({state:cloud.state(),deleted:{}});
const missingDatabase='云端数据库尚未连接，本机练习和备份仍可使用。';
const invalid='请求内容无效，未改动云端记录。';

function createApp(pool,options={}){
 const app=express();
 const secure=options.secure??false;
 const registerCode=options.registrationCode;
 app.disable('x-powered-by');
 if(secure)app.set('trust proxy',1);
 app.use(helmet({strictTransportSecurity:secure?undefined:false,contentSecurityPolicy:{directives:{
  "default-src":["'self'"],"script-src":["'self'"],"script-src-attr":["'none'"],"style-src":["'self'","'unsafe-inline'"],"img-src":["'self'","data:"],"media-src":["'self'","blob:"],"object-src":["'none'"],"form-action":["'self'"],"frame-ancestors":["'none'"],"upgrade-insecure-requests":secure?[]:null
 }}}));
 let ready;
 function prepare(){
  if(!pool)return Promise.reject(new Error('database missing'));
  if(!ready)ready=pool.query(schema).catch(e=>{ready=null;throw e;});
  return ready;
 }
 app.get('/healthz',(_req,res)=>res.json({status:'ok'}));
 app.use('/api',(req,res,next)=>{
  res.set('Cache-Control','no-store');
  if(req.method!=='GET'&&req.method!=='HEAD'){
   const expect=options.origin||(secure?null:'http://'+req.get('host'));
   if(!expect||req.get('origin')!==expect||!req.is('application/json'))return denied(res,403,'请从本站页面发起操作。');
  }
  next();
 });
 app.get('/api/status',async(_req,res)=>{
  try{await prepare();await pool.query('SELECT 1');res.json({database:'ready',registration:!!registerCode});}
  catch{res.status(503).json({database:'unavailable',error:missingDatabase});}
 });
 app.use('/api',express.json({limit:'2mb'}));
 app.use('/api',async(_req,res,next)=>{try{await prepare();next();}catch(e){if(pool)console.error('database setup:',e.code||e.name);denied(res,503,missingDatabase);}});
 const sessionName=secure?'__Host-cet6_session':'cet6_session';
 const cookieOptions={httpOnly:true,sameSite:'lax',secure,path:'/'};
 function sessionHash(req){
  const cookies=(req.get('cookie')||'').split(';').map(s=>s.trim());
  const raw=cookies.find(s=>s.startsWith(sessionName+'='))?.slice(sessionName.length+1);
  return /^[A-Za-z0-9_-]{43}$/.test(raw||'')?hash(raw):null;
 }
 async function current(req){
  const token=sessionHash(req);if(!token)return null;
  return (await pool.query('SELECT u.id,u.username FROM cet_sessions s JOIN cet_users u ON s.user_id=u.id WHERE s.token_hash=$1 AND s.expires_at>now()',[token])).rows[0]||null;
 }
 async function session(req,res,user){
  const token=randomBytes(32).toString('base64url');
  const prev=sessionHash(req);
  if(prev)await pool.query('DELETE FROM cet_sessions WHERE token_hash=$1',[prev]);
  await pool.query('DELETE FROM cet_sessions WHERE expires_at<=now()');
  await pool.query("INSERT INTO cet_sessions(token_hash,user_id,expires_at) VALUES($1,$2,now()+interval '30 days')",[hash(token),user.id]);
  res.cookie(sessionName,token,{...cookieOptions,maxAge:days*1000});
  return res.json({user});
 }
 const limiter=(windowMs,limit)=>rateLimit({windowMs,limit,standardHeaders:'draft-8',legacyHeaders:false,message:{error:'请求过于频繁，请稍后再试。'}});
 const authLimit=limiter(10*60_000,20),globalAuth=rateLimit({windowMs:60_000,limit:90,keyGenerator:()=> 'auth-global',legacyHeaders:false,message:{error:'登录繁忙，请稍后再试。'}});
 app.get('/api/me',async(req,res)=>res.json({user:await current(req),registration:!!registerCode}));
 app.post('/api/register',authLimit,globalAuth,async(req,res)=>{
  const {invite,...credentials}=req.body||{};
  if(!registerCode||typeof invite!=='string'||invite.length>256||!timingSafeEqual(Buffer.from(hash(invite)),Buffer.from(hash(registerCode))))return denied(res,403,'注册未开放或邀请码不正确。');
  const parsed=rules.auth.safeParse(credentials);
  if(!parsed.success)return denied(res,400,'用户名须为 3–32 位英文、数字、下划线或连字符；密码须为 12–128 个字符。');
  const {username,password}=parsed.data,salt=randomBytes(16).toString('hex');
  const derived=await stretch(password,salt,64);
  const id=randomUUID();
  const result=await pool.query('INSERT INTO cet_users(id,username,password_hash) VALUES($1,$2,$3) ON CONFLICT(username) DO NOTHING RETURNING id,username',[id,username,salt+':'+derived.toString('hex')]);
  if(!result.rowCount)return denied(res,409,'该用户名不可用。');
  return session(req,res,result.rows[0]);
 });
 app.post('/api/login',authLimit,globalAuth,async(req,res)=>{
  const parsed=rules.auth.safeParse(req.body);
  if(!parsed.success)return denied(res,400,'用户名或密码格式不正确。');
  const {username,password}=parsed.data;
  const record=(await pool.query('SELECT id,username,password_hash FROM cet_users WHERE username=$1',[username])).rows[0];
  const [salt,expected]=(record?.password_hash||'00000000000000000000000000000000:'+('00'.repeat(64))).split(':');
  const actual=await stretch(password,salt,64);
  if(!record||!timingSafeEqual(Buffer.from(expected,'hex'),actual))return denied(res,401,'用户名或密码不正确。');
  return session(req,res,{id:record.id,username:record.username});
 });
 app.post('/api/logout',async(req,res)=>{
  const token=sessionHash(req);if(token)await pool.query('DELETE FROM cet_sessions WHERE token_hash=$1',[token]);
  res.clearCookie(sessionName,cookieOptions).json({ok:true});
 });
 app.post('/api/sync',limiter(60_000,180),async(req,res)=>{
  const user=await current(req);if(!user)return denied(res,401,'请登录后同步。');
  const parsed=rules.sync.safeParse(req.body);
  if(!parsed.success)return denied(res,400,invalid);
  const {owner,revision,ops}=parsed.data;
  if(owner!==user.id)return denied(res,409,'浏览器本地记录属于另一个账号。');
  if(!ops.length){
   const row=(await pool.query('SELECT revision,document FROM cet_progress WHERE user_id=$1',[owner])).rows[0];
   const ver=row?.revision||0;
   if(revision>ver)return denied(res,409,'云端版本低于本机。请先导出本机备份并联系管理员。');
   return res.json({owner,revision:ver,ack:[],...(revision!==ver?{document:row?.document||emptyDoc()}:{})});
  }
  const conn=await pool.connect();
  let response;
  try{
   await conn.query('BEGIN');
   await conn.query('INSERT INTO cet_progress(user_id) VALUES($1) ON CONFLICT DO NOTHING',[owner]);
   const row=(await conn.query('SELECT revision,document FROM cet_progress WHERE user_id=$1 FOR UPDATE',[owner])).rows[0];
   if(revision>row.revision){await conn.query('ROLLBACK');return denied(res,409,'云端版本低于本机。请先导出本机备份并联系管理员。');}
   const doc=row.document.state?row.document:emptyDoc();
   let count=0;
   for(const op of ops){
    const receipt=await conn.query('INSERT INTO cet_receipts(user_id,op_id) VALUES($1,$2) ON CONFLICT DO NOTHING RETURNING op_id',[owner,op.id]);
    if(receipt.rowCount){cloud.apply(doc,op);count++;}
   }
   const encoded=JSON.stringify(doc);
   if(Buffer.byteLength(encoded)>1_500_000){await conn.query('ROLLBACK');return denied(res,413,'云端记录已达到当前账号容量；改动仍保留在本机。请先导出备份。');}
   const next=row.revision+count;
   if(count)await conn.query('UPDATE cet_progress SET revision=$2,document=$3 WHERE user_id=$1',[owner,next,encoded]);
   await conn.query('COMMIT');
   response={owner,revision:next,document:doc,ack:ops.map(o=>o.id)};
  }catch(e){await conn.query('ROLLBACK').catch(()=>{});throw e;}
  finally{conn.release();}
  return res.json(response);
 });
 app.use('/api',(_req,res)=>denied(res,404,'接口不存在。'));
 app.use('/data',express.static(path.join(web,'data'),{fallthrough:false,cacheControl:true,maxAge:'15m'}));
 app.use('/audio',express.static(path.join(web,'audio'),{maxAge:'1d'}));
 app.get(/^\/audio\/(?:opus|continuous)\/[\w.-]+\.(?:opus|mp3|ogg|m4a|wav)$/i,async(req,res)=>{
  if(req.path.includes('..'))return res.sendStatus(404);
  const abort=new AbortController();
  res.on('close',()=>abort.abort());
  let remote;
  try{
   remote=await fetch(upstream+req.path,{redirect:'error',method:req.method,headers:req.get('range')?{range:req.get('range')}:{},signal:AbortSignal.any([abort.signal,AbortSignal.timeout(25_000)])});
  }catch{return res.sendStatus(502);}
  if(![200,206,416].includes(remote.status)){await remote.body?.cancel();return res.sendStatus(remote.status===404?404:502);}
  res.status(remote.status).set('Content-Type',req.path.toLowerCase().endsWith('.opus')?'audio/ogg':remote.headers.get('content-type')||'application/octet-stream').set('Cache-Control','public, max-age=86400');
  for(const name of ['content-range','accept-ranges','last-modified','etag'])if(remote.headers.has(name))res.set(name,remote.headers.get(name));
  if(!remote.headers.has('content-encoding')&&remote.headers.has('content-length'))res.set('content-length',remote.headers.get('content-length'));
  if(!remote.body)return res.end();
  await pipeline(Readable.fromWeb(remote.body),res).catch(()=>{res.destroy();});
 });
 app.use(express.static(web,{setHeaders(res){res.setHeader('Cache-Control','no-cache');}}));
 app.use((e,req,res,_next)=>{
  if(res.headersSent)return res.end();
  const status=e.status===413?413:e.status===400?400:e.status===404?404:503;
  if(status===503)console.error('request failed:',e.code||e.name);
  if(req.originalUrl.startsWith('/api/'))return denied(res,status,status===503?'暂时无法访问云端。请稍后重试。':status===413?'单次同步内容过大；本机数据未删除。':invalid);
  res.sendStatus(status);
 });
 return app;
}

function poolFromEnv(){
 const raw=process.env.DATABASE_URL;
 if(!raw)return null;
 const url=new URL(raw);
 const local=['localhost','127.0.0.1','[::1]'].includes(url.hostname);
 const plain=local&&url.searchParams.get('sslmode')==='disable'&&!process.env.ALTARE&&process.env.NODE_ENV!=='production';
 for(const k of ['ssl','sslmode','sslrootcert','sslcert','sslkey','uselibpqcompat'])url.searchParams.delete(k);
 const ca=process.env.DATABASE_CA_PEM?.replace(/\\n/g,'\n');
 const ssl=plain?false:{rejectUnauthorized:true,servername:url.hostname,...(ca?{ca}:{})};
 return new Pool({connectionString:url.toString(),ssl,max:5,idleTimeoutMillis:20_000,connectionTimeoutMillis:8_000,statement_timeout:10_000});
}
if(require.main===module){
 const secure=process.env.NODE_ENV==='production'||!!process.env.ALTARE;
 const rawOrigin=process.env.APP_ORIGIN||process.env.ALTARE_URL||undefined; const origin=rawOrigin?.replace(/\/$/,'');
 if(secure&&origin&&(new URL(origin).origin!==origin||!origin.startsWith('https://')))throw Error('Set APP_ORIGIN to the exact HTTPS origin (no trailing slash).');
 const pool=poolFromEnv();
 pool?.on('error',e=>console.error('database connection:',e.code||e.name));
 const server=createApp(pool,{secure,origin,registrationCode:process.env.REGISTRATION_CODE}).listen(Number(process.env.PORT||3000),'0.0.0.0',()=>console.log('CET-6 web listening on '+server.address().port));
 for(const signal of ['SIGINT','SIGTERM'])process.on(signal,()=>server.close(()=>Promise.resolve(pool?.end()).finally(()=>process.exit(0))));
}
module.exports={createApp};
