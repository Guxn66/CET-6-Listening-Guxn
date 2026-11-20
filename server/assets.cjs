'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const {createHash}=require('node:crypto');
const origin='https://cet6-listening-lab.poeticfern128.chatgpt.site';
const checks={
 'quality-report.json':'502f25ad88523b69748eaa818c14f47be84dbfdb6b1bb5ac77d34bbd8290ce01',
 'catalog.js':'4ca07bae370baac587ddec4b57616ac170054d449e6a550f309a2d2bca35ff94',
 'catalog.json':'6494fce6e83592789031c2afe5c04eb32bbf5431e8d6062ff0f204c1f0f92b7e',
 'answer-review.json':'c20945643e4b18d80637fc72cd613354db4243c639407f9c758e7966b242209a',
 'audio-audit.json':'82fa76fa80a724fb3a21095bcffdf7561260bc2b8ff472b8afa905acd25e4090',
 'release.json':'944304138adf349fdeb51bbfb339d747e3ed3a25f0eb645817d23d4468fdddb7'
};
const sha=b=>createHash('sha256').update(b).digest('hex');
async function main(){
 const dir=path.join(__dirname,'../dist/data');await fs.mkdir(dir,{recursive:true});
 for(const [file,sum] of Object.entries(checks)){
  const out=path.join(dir,file);
  const existing=await fs.readFile(out).catch(()=>null);
  if(existing&&sha(existing)===sum){console.log('Verified '+file);continue;}
  const r=await fetch(origin+'/data/'+file,{redirect:'error',signal:AbortSignal.timeout(60_000)});
  if(!r.ok)throw Error(file+': HTTP '+r.status);
  const bytes=Buffer.from(await r.arrayBuffer());
  if(sha(bytes)!==sum)throw Error(file+': published content changed; review and update its pin before rebuilding.');
  await fs.writeFile(out+'.tmp',bytes);await fs.rename(out+'.tmp',out);
  console.log('Downloaded and verified '+file);
 }
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
