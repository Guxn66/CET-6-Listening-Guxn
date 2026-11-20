(function(g){
'use strict';
const $=id=>document.getElementById(id);
async function api(route,body){
 const r=await fetch('/api/'+route,{...(body===undefined?{}:{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)}),cache:'no-store',credentials:'same-origin',signal:AbortSignal.timeout(20_000)});
 const value=await r.json();
 if(!r.ok){const e=Error(value.error||'云端请求失败');e.status=r.status;throw e;}
 return value;
}
function attach(store,changed){
 const dialog=$('cloud-dialog'),form=$('cloud-auth'),status=$('cloud-status'),button=$('cloud-button'),invite=$('cloud-invite');
 let user=null,running=null,authenticating=false,registration=false,last=null,inBackoff=0;
 function show(message){status.textContent=message;button.title=message;}
 function controls(meta){
  form.hidden=!!user;$('cloud-register').hidden=!registration;invite.hidden=!registration;
  $('cloud-user').textContent=user?'当前账号：'+user.username:'';
  $('cloud-enable').hidden=!user||!!meta;
  $('cloud-sync-now').hidden=!user||meta?.owner!==user.id;
  $('cloud-logout').hidden=!user;
  button.textContent=user&&meta?.owner===user.id?'云同步':'账号 / 同步';
 }
 async function align(){
  const meta=await store.cloudMeta();controls(meta);
  if(!user)show(meta?'已保存到本机；登录原账号后继续同步。退出登录不会清除本机记录。':'未启用云同步。可照常使用本机练习和 JSON 备份。');
  else if(meta?.owner&&meta.owner!==user.id)show('此浏览器已绑定另一个账号。为防串档，请退出并使用原账号，或用独立浏览器配置。');
  else if(!meta)show('未上传任何本机学习记录。确认启用后才会合并到此账号。');
  else show(meta.outbox.length?'有 '+meta.outbox.length+' 项等待同步。':(last?'最近一次同步：'+last.toLocaleTimeString():'等待连接云端'));
  return meta;
 }
 async function discover(){
  try{const r=await api('me');user=r.user;registration=r.registration;await align();}
  catch(e){await align();show(!navigator.onLine?'当前离线，学习继续保存在此设备。':e.message);}
 }
 async function run(force=false){
  if(running||(!force&&Date.now()<inBackoff))return running;
  const task=async()=>{
   const who=user?.id;if(!who)return;
   try{
    await store.save();
    for(let n=0;n<6&&user?.id===who;n++){
     const meta=await store.cloudMeta();if(!meta||meta.owner!==who)break;
     const ops=meta.outbox.slice(0,30);
     while(ops.length>1&&JSON.stringify(ops).length>420_000)ops.pop();
     const reply=await api('sync',{owner:who,revision:meta.revision,ops});
     if(await store.acceptCloud(reply))changed();
     last=new Date();inBackoff=0;
     if(!ops.length||ops.length===meta.outbox.length)break;
    }
    await align();
   }catch(e){
    inBackoff=Date.now()+30_000;
    if(e.status===401){user=null;await align();}
    show(!navigator.onLine?'已保存到本机。联网后会自动重试。':e.message+' 待同步改动仍保留在本机。');
   }
  };
  running=(navigator.locks?navigator.locks.request('cet6-cloud-sync',task):task()).finally(()=>{running=null;});return running;
 }
 button.addEventListener('click',async()=>{
  if(!dialog.open)dialog.showModal();
  await discover();if(user)await run(true);
 });
 $('cloud-close').addEventListener('click',()=>dialog.close());
 form.addEventListener('submit',async e=>{
  e.preventDefault();if(authenticating)return;authenticating=true;
  const isNew=e.submitter?.id==='cloud-register';
  const data={username:$('cloud-name').value,password:$('cloud-password').value};
  if(isNew)data.invite=$('cloud-code').value;
  try{const r=await api(isNew?'register':'login',data);user=r.user;form.reset();await align();await run(true);}
  catch(err){show(err.message);}finally{authenticating=false;}
 });
 $('cloud-enable').addEventListener('click',async()=>{
  if(!user||!confirm('将当前浏览器的作答、提交记录、收藏、笔记和练习时长同步到当前账号。音频、手写及设置不会上传。确定启用？'))return;
  try{await store.enableCloud(user.id);await run(true);}catch(e){show(e.message);}
 });
 $('cloud-sync-now').addEventListener('click',async()=>{await discover();await run(true);});
 $('cloud-logout').addEventListener('click',async()=>{
  try{await running;await api('logout',{});user=null;last=null;await align();}
  catch(e){show(e.message);}
 });
 addEventListener('online',async()=>{await discover();await run(true);});
 document.addEventListener('visibilitychange',()=>{if(!document.hidden)run();});
 setInterval(()=>{if(!document.hidden&&navigator.onLine)run();},12_000);
 discover().then(()=>run()).catch(e=>show(e.message));
}
g.CETCloud={attach};
})(window);
