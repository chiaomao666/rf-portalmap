import {mkdir, readFile, writeFile, rename, readdir, stat, statfs} from 'node:fs/promises';
import {randomUUID} from 'node:crypto';
import path from 'node:path';
import {gzip, gunzip} from 'node:zlib';
import {promisify} from 'node:util';

const zip=promisify(gzip),unzip=promisify(gunzip);
export const taiwanDate=value=>new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,10);
export function validDate(date) {
  return typeof date==='string' && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    Number.isFinite(Date.parse(date+'T00:00:00Z')) && new Date(date+'T00:00:00Z').toISOString().slice(0,10)===date;
}
// 和雲端控制權歷史相同的白名單。原始封包、戰力、帳號、權杖不進封存。
export function publicHistoryCities(rows) {
  if(!Array.isArray(rows)||!rows.length||rows.length>700)throw Error('城市清單無效');
  const ids=new Set(),text=value=>typeof value==='string'?value.slice(0,160):null;
  return rows.map(city=>{
    const id=Number(city?.city_id);
    if(!Number.isSafeInteger(id)||id<=0||ids.has(id))throw Error('城市 ID 無效');
    ids.add(id);
    return {city_id:id,name:text(city.name),control_nation_name:text(city.control_nation_name),
      control_union_id:Number.isSafeInteger(Number(city.control_union_id))&&Number(city.control_union_id)>0?Number(city.control_union_id):null,
      control_union_name:text(city.control_union_name)};
  }).sort((a,b)=>a.city_id-b.city_id);
}

export class HistoryArchive {
  constructor({directory,getSnapshot,Now=Date.now}) {
    Object.assign(this,{directory:path.resolve(directory),getSnapshot,Now});
    this.status={enabled:true,lastSaved:null,error:null};this.queue=Promise.resolve();
    this.signature=null;this.lastDay=null;this.lastMinute=null;this.stopped=false;
  }
  async atomic(file,data) {
    await mkdir(path.dirname(file),{recursive:true,mode:0o700});
    const disk=await statfs(this.directory);
    if(disk.bavail*disk.bsize<256*1024*1024+Buffer.byteLength(data))throw Error('磁碟空間不足');
    const temporary=file+'.tmp-'+randomUUID();await writeFile(temporary,data,{mode:0o600});await rename(temporary,file);
  }
  enqueue(work) {
    const result=this.queue.then(work);
    this.queue=result.catch(()=>{this.status.error='歷史封存失敗；請檢查磁碟空間與檔案權限，既有檔案不會清除';});
    return result;
  }
  async dates() {
    let entries;try{entries=await readdir(path.join(this.directory,'.minutes'),{withFileTypes:true});}catch(error){if(error.code==='ENOENT')return [];throw error;}
    return entries.filter(e=>e.isDirectory()&&validDate(e.name)).map(e=>e.name).sort();
  }
  async readDay(date) {
    if(!validDate(date))throw Error('日期無效');
    let names;try{names=await readdir(path.join(this.directory,'.minutes',date));}catch(error){if(error.code==='ENOENT')return [];throw error;}
    names=names.filter(name=>/^\d{12}\.json\.gz$/.test(name)).sort();
    if(names.length>1440)throw Error('快照數量無效');
    const frames=[];
    for(const name of names){
      const file=path.join(this.directory,'.minutes',date,name);
      if((await stat(file)).size>1024*1024)throw Error('快照檔案過大');
      const frame=JSON.parse((await unzip(await readFile(file),{maxOutputLength:1024*1024})).toString());
      if(!Number.isFinite(Date.parse(frame.captured_at))||taiwanDate(frame.captured_at)!==date)throw Error('快照日期不符');
      frames.push({captured_at:new Date(frame.captured_at).toISOString(),cities:publicHistoryCities(frame.cities)});
    }
    return frames;
  }
  async saveFrame(frame) {
    const time=Date.parse(frame?.captured_at);
    if(!Number.isFinite(time))throw Error('快照時間無效');
    const date=taiwanDate(time),minute=String(Math.floor(time/60000)).padStart(12,'0');
    const clean={captured_at:new Date(time).toISOString(),cities:publicHistoryCities(frame.cities)};
    const file=path.join(this.directory,'.minutes',date,minute+'.json.gz');
    try{
      const existing=JSON.parse((await unzip(await readFile(file),{maxOutputLength:1024*1024})).toString());
      if(Date.parse(existing.captured_at)>=time)return;
    }catch(error){if(error.code!=='ENOENT')throw error;}
    await this.atomic(file,await zip(JSON.stringify(clean)));
    this.status.lastSaved=clean.captured_at;this.status.error=null;
  }
  async capture() {
    if(this.stopped||this.captureBusy)return;
    this.captureBusy=true;
    try{await this.enqueue(async()=>{
      const snapshot=this.getSnapshot(),now=this.Now(),date=taiwanDate(now),minute=Math.floor(now/60000);
      if(snapshot.status?.connected!==true || !snapshot.cities?.length)return;
      const last=Math.max(Date.parse(snapshot.status.lastSnapshot)||0,Date.parse(snapshot.status.lastMessage)||0);
      if(now-last>90000||last>now+60000)return;
      if(this.lastMinute===minute)return;
      const cities=publicHistoryCities(snapshot.cities),signature=JSON.stringify(cities);
      if(signature===this.signature&&date===this.lastDay){this.lastMinute=minute;return;}
      // 重啟後比較磁碟上的當日最後一筆，不把每次重啟當成控制權變化。
      if(this.lastDay===null){const frames=await this.readDay(date),lastFrame=frames.at(-1);
        if(lastFrame&&JSON.stringify(lastFrame.cities)===signature){this.lastDay=date;this.signature=signature;this.lastMinute=Math.floor(Date.parse(lastFrame.captured_at)/60000);return;}}
      const previousDay=this.lastDay;
      await this.saveFrame({captured_at:new Date(now).toISOString(),cities});
      this.lastDay=date;this.lastMinute=minute;this.signature=signature;
      if(previousDay&&previousDay!==date)await this.buildDay(previousDay);
    });}catch{}finally{this.captureBusy=false;}
  }
  async buildDay(date) {
    const frames=await this.readDay(date);if(!frames.length)return;
    const report={kind:'rf-battle-report',version:1,timeZone:'Asia/Taipei',frames};
    const body=JSON.stringify(report);
    if(Buffer.byteLength(body)>60000000)throw Error('每日封存超過網頁回放大小上限；分鐘原檔仍保留');
    await this.atomic(path.join(this.directory,date+'.json.gz'),await zip(body));
    await this.atomic(path.join(this.directory,'.summaries',date+'.json'),JSON.stringify({date,count:frames.length,first:frames[0].captured_at,last:frames.at(-1).captured_at}));
  }
  async buildAll() {
    return this.enqueue(async()=>{
      const index={version:1,timeZone:'Asia/Taipei',updated_at:new Date(this.Now()).toISOString(),days:[]};
      for(const date of await this.dates()){
        const file=path.join(this.directory,date+'.json.gz');
        let exists=true;try{await stat(file);}catch(error){if(error.code==='ENOENT')exists=false;else throw error;}
        const summary=path.join(this.directory,'.summaries',date+'.json');
        let hasSummary=true;try{await stat(summary);}catch(error){if(error.code==='ENOENT')hasSummary=false;else throw error;}
        if(!exists||!hasSummary||date===taiwanDate(this.Now()))await this.buildDay(date);
        index.days.push(JSON.parse(await readFile(summary,'utf8')));
      }
      await this.atomic(path.join(this.directory,'index.json'),JSON.stringify(index));this.status.error=null;
      return index;
    });
  }
  async importFrames(frames) {
    if(!Array.isArray(frames))throw Error('歷史格式無效');
    return this.enqueue(async()=>{
      const dates=new Set();for(const frame of frames){await this.saveFrame(frame);dates.add(taiwanDate(frame.captured_at));}
      for(const date of dates)await this.buildDay(date);
    });
  }
  start() {
    void this.capture();void this.buildAll().catch(()=>{});
    this.timer=setInterval(()=>void this.capture(),60000);
    this.bundleTimer=setInterval(()=>void this.buildAll().catch(()=>{}),300000);
  }
  async stop() {this.stopped=true;clearInterval(this.timer);clearInterval(this.bundleTimer);await this.queue;await this.buildAll().catch(()=>{});}
}
