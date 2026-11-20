'use strict';
const {z}=require('zod');
const cloud=require('../dist/cloud-core.js');
const key=z.string().refine(cloud.safe);
const choice=z.enum(['A','B','C','D']);
const map=t=>z.record(key,t);
const note=z.array(z.string().max(6000)).length(3);
const marks=z.array(z.strictObject({a:z.int().min(0).max(100000),b:z.int().min(1).max(100000)}).refine(m=>m.b>m.a)).max(200);
const types={answers:choice,notes:note,reviewReasons:z.enum(['unknown','unheard']),optionMarks:marks};
const strings=z.array(key).max(12000);
const attempt=z.strictObject({id:key.nullable(),passageId:key,at:z.iso.datetime().nullable(),answers:map(choice),importedUntimedFirst:z.literal(true).optional()});
const history=z.array(attempt).max(15000);
const seconds=z.int().min(0).max(31_536_000);
const seed=z.strictObject({...Object.fromEntries(cloud.maps.map(f=>[f,map(types[f])])),favorites:strings,completed:strings,history,studySeconds:seconds});
const change=t=>map(z.union([z.strictObject({value:t}),z.strictObject({deleted:z.literal(true)})]));
const listChange=z.strictObject({add:strings,remove:strings});
const delta=z.strictObject({
 maps:z.strictObject(Object.fromEntries(cloud.maps.map(f=>[f,change(types[f])]))),
 sets:z.strictObject(Object.fromEntries(cloud.sets.map(f=>[f,listChange]))),
 history,seconds
});
const op=z.union([z.strictObject({id:z.uuid(),seed}),z.strictObject({id:z.uuid(),delta})]);
module.exports={
 auth:z.strictObject({username:z.string().trim().toLowerCase().regex(/^[a-z0-9][a-z0-9_-]{2,31}$/),password:z.string().min(12).max(128)}),
 sync:z.strictObject({owner:z.uuid(),revision:z.int().min(-1),ops:z.array(op).max(30)})
};
