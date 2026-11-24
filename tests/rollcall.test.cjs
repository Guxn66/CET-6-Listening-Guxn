'use strict';
const test=require('node:test');
const assert=require('node:assert/strict');
const {createApp}=require('../server/index.cjs');
const {validate}=require('../server/rollcall.cjs');
test('cloud status is read-only and admin actions require a secret',async()=>{
 const server=createApp(null).listen(0,'127.0.0.1');await new Promise(r=>server.once('listening',r));
 try{const origin='http://127.0.0.1:'+server.address().port;
  const h=await fetch(origin+'/rollcall/health');assert.equal(h.status,200);assert.equal((await h.json()).configured,false);
  const r=await fetch(origin+'/rollcall/admin/config',{method:'POST',headers:{'content-type':'application/json'},body:'{}'});assert.equal(r.status,401);
  assert.equal((await fetch(origin+'/healthz')).status,200);
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
});
test('configuration rejects non-private relay targets',()=>{
 const value={username:'fixture',password:'fixture',pair:{origin:'https://example.chatgpt.site',token:'x'.repeat(32)}};
 assert.equal(validate(value).enabled,false);
 for(const origin of ['http://example.chatgpt.site','https://evil.test','https://example.chatgpt.site/?token=x'])assert.throws(()=>validate({...value,pair:{...value.pair,origin}}));
});
