import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
const out = path.resolve('C:/DSH/icl/.state/lab/mc-body-soak/place-real-smoke'); fs.mkdirSync(out,{recursive:true})
const child = spawn(process.execPath, ['packages/mc-body/src/cli.mjs','--host','127.0.0.1','--port','54839','--listen','54902','--name','ICL-mcbody-1','--allow-task','--paused-disconnect-ms','0','--state',path.join(out,'tasks.json'),'--log',path.join(out,'events.jsonl')], {stdio:['ignore','pipe','pipe'],cwd:process.cwd()})
let log=''; child.stdout.on('data',d=>log+=d); child.stderr.on('data',d=>log+=d)
const sleep=(ms)=>new Promise(r=>setTimeout(r,ms)); const base='http://127.0.0.1:54902'
const get=async(p)=>(await fetch(base+p,{signal:AbortSignal.timeout(3000)})).json()
const post=async(p,b,t=120000)=>(await fetch(base+p,{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b??{}),signal:AbortSignal.timeout(t)})).json()
let up=false; for(let i=0;i<90;i++){try{const s=await get('/v1/status'); if(s.adapter?.spawnSafety){up=true;break}}catch{} if(child.exitCode!=null) break; await sleep(500)}
console.log('up',up)
const steps=[]
if (up) {
  const inv = async(name)=>{ const r=await post('/v1/inspect',{kind:'inventory'}); const items=r.result?.data?.items??[]; return items.filter(x=>x.name===name).reduce((s,x)=>s+x.count,0) }
  const mineRes = await post('/v1/do',{steps:[{op:'mine',params:{block:'dirt',count:3,radius:8}}]},120000)
  steps.push({label:'mine dirt x3', r: mineRes.results?.[0]?.result ?? mineRes.error, dirt: await inv('dirt')})
  console.log('mine dirt:', JSON.stringify(steps.at(-1)))
  const st = await get('/v1/status'); const p = st.adapter.position
  const supported = { x: Math.floor(p.x)+2, y: Math.floor(p.y), z: Math.floor(p.z) }
  const floating = { x: supported.x, y: supported.y+3, z: supported.z }
  const place = await post('/v1/do',{steps:[{op:'place',item:'dirt',positions:[floating,supported]}]},60000)
  const pr = place.results?.[0]?.result ?? { error: place.error }
  steps.push({label:'place supported+floating', r: pr})
  console.log('place:', JSON.stringify(pr))
  await post('/v1/shutdown',{reason:'place-real-smoke-done'}).catch(()=>null)
}
for(let i=0;i<40 && child.exitCode==null;i++) await sleep(250)
const exitPath = path.join(out,'body-exit.json')
const rec = fs.existsSync(exitPath) ? JSON.parse(fs.readFileSync(exitPath,'utf8')) : null
console.log('exit', child.exitCode, 'reason', rec?.reason)
const pass = steps.length===2 && !steps[0].r?.error && steps[0].dirt>=3 && steps[1].r?.placedCount>=1 && steps[1].r?.skippedCount>=1 && steps[1].r?.skipped?.[0]?.reason
fs.writeFileSync(path.join(out,'report.md'), ['# place 真服 smoke（54839 flat）','', ...steps.map(s=>`- ${s.label}: ${JSON.stringify(s.r).slice(0,500)}`), '', `- body-exit: ${rec?.reason} code=${rec?.exitCode}`, `- result: ${pass?'PASS':'FAIL'}`].join('\n')+'\n','utf8')
fs.writeFileSync(path.join(out,'metrics.json'), JSON.stringify({steps, exit: rec, pass}, null, 2),'utf8')
console.log('RESULT', pass ? 'PASS':'FAIL')
