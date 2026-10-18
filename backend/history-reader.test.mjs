import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFile} from 'node:fs/promises';
import {gzipSync} from 'node:zlib';
const code=await readFile(new URL('../history-reader.js',import.meta.url),'utf8');
function reader(Fetch,loadRecent){
  const context=vm.createContext({Date,AbortSignal,DecompressionStream,TextDecoder,Uint8Array});vm.runInContext(code,context);
  return new context.RFHistoryReader({Fetch,loadRecent,Now:()=>Date.parse('2026-10-18T00:00:00Z')});
}
const frames=[{captured_at:'2026-10-16T00:00:00Z',cities:[{city_id:1,name:'城市'}]}];
const index=()=>Response.json({version:1,days:[{date:'2026-10-16',count:1}]});
test('舊日期優先讀壓縮封存，不下載Supabase近期清單',async()=>{
  let cloud=0;const r=reader(async url=>url.endsWith('index.json')?index():new Response(gzipSync(JSON.stringify({kind:'rf-battle-report',version:1,frames}))),async()=>{cloud++;return [];});
  assert.equal((await r.load('2026-10-16'))[0].cities[0].name,'城市');assert.equal(cloud,0);assert.equal(r.source,'archive');
});
test('尚未公開封存時回到近期資料；今日優先近期且不暗中混入本機',async()=>{
  let requests=0;const r=reader(async()=>{requests++;return new Response(null,{status:404});},async()=>frames);
  assert.equal((await r.load('2026-10-16')).length,1);assert.equal(requests,1);
  await r.load('2026-10-18');assert.equal(requests,1);assert.equal(r.source,'cloud');
});
test('封存損壞／連線失敗不誤報沒有紀錄；無效日期不發請求',async()=>{
  let requests=0;const r=reader(async url=>{requests++;return url.endsWith('index.json')?index():new Response('bad gzip');},async()=>[]);
  await assert.rejects(r.load('2026-10-16'),/讀取失敗/);
  const before=requests;await assert.rejects(r.load('../.env'));await assert.rejects(r.load('2026-02-30'));assert.equal(requests,before);
});
