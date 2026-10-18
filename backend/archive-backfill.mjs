// 一次性救存 Supabase 仍存在的歷史。只讀雲端，不刪除或修改資料表。
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {HistoryArchive,validDate,taiwanDate} from './history-archive.mjs';
import {SupabasePublisher} from './publisher.mjs';

const root=path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const [start=taiwanDate(Date.now()-7*86400000),end=taiwanDate(Date.now())]=process.argv.slice(2);
if(!validDate(start)||!validDate(end)||start>end||Date.parse(end)-Date.parse(start)>31*86400000)throw Error('請提供有效的起訖日期，每次最多 31 天');
const publisher=new SupabasePublisher({url:process.env.SUPABASE_URL,key:process.env.SUPABASE_WRITE_KEY,getSnapshot:()=>({})});
if(!publisher.status.enabled)throw Error('尚未設定主機端 Supabase 讀取設定');
const archive=new HistoryArchive({directory:process.env.RF_ARCHIVE_DIR||path.join(root,'.data','history-archives')});
try{
  for(let t=Date.parse(start+'T00:00:00Z');t<=Date.parse(end+'T00:00:00Z');t+=86400000){
    const date=new Date(t).toISOString().slice(0,10);let count=0;
    for(let offset=0;offset<1500;offset+=500){
      const frames=await publisher.readHistory(date,offset);await archive.importFrames(frames);count+=frames.length;
      if(frames.length<500)break;
    }
    console.log(`${date}: saved ${count} existing frames`);
  }
  await archive.buildAll();
}catch{
  console.error('歷史救存未完成；已存檔案保留，請檢查雲端連線、權限與主機磁碟後重試。');process.exitCode=1;
}
