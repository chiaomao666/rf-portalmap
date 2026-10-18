import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,readFile,writeFile,readdir} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';
import {gunzipSync} from 'node:zlib';
import {HistoryArchive,validDate} from './history-archive.mjs';
const cities=[{city_id:1,name:'城市',control_nation_name:'臺灣',control_union_id:7,control_union_name:'聯盟',token:'PRIVATE',nation_battle:'PRIVATE'}];
async function fixture(){
  const directory=await mkdtemp(path.join(tmpdir(),'rf-history-archive-'));
  let now=Date.parse('2026-10-18T00:01:00Z');
  const snapshot={cities:structuredClone(cities),status:{connected:true,lastSnapshot:new Date(now).toISOString()}};
  const archive=new HistoryArchive({directory,getSnapshot:()=>snapshot,Now:()=>now});
  return {directory,snapshot,archive,advance(ms){now+=ms;snapshot.status.lastSnapshot=new Date(now).toISOString();}};
}
test('磁碟封存只保留白名單、分鐘去重、無變化不重存及壓縮索引',async()=>{
  const {archive,directory,snapshot,advance}=await fixture();
  await archive.capture();await archive.capture();advance(60000);await archive.capture();
  assert.equal((await archive.readDay('2026-10-18')).length,1);
  snapshot.cities[0].control_union_name='新聯盟';advance(60000);await archive.capture();
  const index=await archive.buildAll();assert.equal(index.days[0].count,2);
  const report=JSON.parse(gunzipSync(await readFile(path.join(directory,'2026-10-18.json.gz'))));
  assert.equal(report.frames.length,2);assert(!JSON.stringify(report).includes('PRIVATE'));
  assert.deepEqual(report.frames[0].cities[0],{city_id:1,name:'城市',control_nation_name:'臺灣',control_union_id:7,control_union_name:'聯盟'});
});
test('斷線／超過90秒不記錄，跨臺灣午夜建立當日基準',async()=>{
  const {archive,snapshot,advance}=await fixture();snapshot.status.connected=false;await archive.capture();assert.deepEqual(await archive.dates(),[]);
  snapshot.status.connected=true;snapshot.status.lastSnapshot='2026-10-17T00:00:00Z';await archive.capture();assert.deepEqual(await archive.dates(),[]);
  advance(0);await archive.capture();advance(86400000);await archive.capture();
  assert.deepEqual(await archive.dates(),['2026-10-18','2026-10-19']);
});
test('重啟沿用磁碟紀錄不重複；救存舊日期不受7天／2000筆清理',async()=>{
  const f=await fixture();await f.archive.capture();
  const restored=new HistoryArchive({directory:f.directory,getSnapshot:()=>f.snapshot,Now:()=>Date.parse('2026-10-18T00:02:00Z')});
  f.snapshot.status.lastSnapshot='2026-10-18T00:02:00Z';await restored.capture();assert.equal((await restored.readDay('2026-10-18')).length,1);
  await restored.importFrames([{captured_at:'2026-10-10T00:00:00Z',cities}]);await restored.buildAll();
  assert.equal((await restored.readDay('2026-10-10')).length,1);
});
test('同分鐘只保留較新快照，救存可重跑且不覆蓋較新的控制權',async()=>{
  const {archive}=await fixture();
  await archive.importFrames([{captured_at:'2026-10-18T00:01:59Z',cities:[{...cities[0],name:'較新'}]}]);
  await archive.importFrames([{captured_at:'2026-10-18T00:01:01Z',cities}]);
  const frames=await archive.readDay('2026-10-18');assert.equal(frames.length,1);assert.equal(frames[0].cities[0].name,'較新');
});
test('拒絕路徑穿越、無效日曆與損壞原檔；不蓋掉既有資料',async()=>{
  const {archive,directory}=await fixture();await archive.capture();
  assert.equal(validDate('2026-02-30'),false);await assert.rejects(archive.readDay('../.env'));
  const folder=path.join(directory,'.minutes','2026-10-18'),file=path.join(folder,(await readdir(folder))[0]);
  await writeFile(file,'corrupted');await assert.rejects(archive.importFrames([{captured_at:'2026-10-18T00:01:59Z',cities}]));
  assert.equal(await readFile(file,'utf8'),'corrupted');assert(archive.status.error);
});
