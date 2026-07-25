// mock/test-stream-incremental.mjs — 验证代理对 SSE 流式响应的「增量转发」
//
// mock 用 success-slow 模式每 300ms 发一个 SSE chunk。代理若是缓冲式（旧实现），
// 会把全部 chunk 攒到上游 end 后一次性吐，客户端只看到一次到达；流式改造后应看到
// 多次到达、间隔 ~300ms。
//
// 运行： node mock/test-stream-incremental.mjs
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import { writeFileSync, unlinkSync } from 'node:fs';
const PROXY_PORT = 11502, MOCK_PORT = 8790;
const PROXY = `http://127.0.0.1:${PROXY_PORT}`, MOCK = `http://127.0.0.1:${MOCK_PORT}`;
const TEST_CONFIG = 'mock/config.incr.json';
const cfg = JSON.stringify({ env:{ANTHROPIC_AUTH_TOKEN:'t',ANTHROPIC_BASE_URL:MOCK,API_TIMEOUT_MS:'10000',ANTHROPIC_MODEL:'m'}, effortLevel:'', proxy:{listenHost:'127.0.0.1',listenPort:PROXY_PORT,maxAttempts:1,backoffSec:0.2,backoffMaxSec:2,passthrough:false,retryOnStatus:[],retryOnBodyErrorCode:[]} }, null, 2);
let mockProc, proxyProc;
const kill=(p)=>{try{p?.kill('SIGTERM')}catch{}};
async function waitHealth(u,l){for(let i=0;i<100;i++){try{const r=await fetch(u+'/healthz');if(r.ok)return true}catch{}await sleep(100)}throw new Error(l+' unhealthy')}
async function setSeq(seq){await fetch(MOCK+'/__mock/control',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sequence:seq})})}
async function main(){
  mockProc=spawn('node',['mock/mock-server.js'],{env:{...process.env,MOCK_PORT:String(MOCK_PORT)},stdio:['ignore','ignore','inherit']});
  writeFileSync(TEST_CONFIG,cfg+'\n','utf8');
  proxyProc=spawn('node',['proxy/server.js'],{env:{...process.env,CONFIG_PATH:TEST_CONFIG},stdio:['ignore','ignore','inherit']});
  try{
    await waitHealth(MOCK,'mock');await waitHealth(PROXY,'proxy');await sleep(300);
    await setSeq(['success-slow']);
    console.log('=== streaming incremental arrival test (mock emits 1 chunk / 300ms) ===');
    const t0 = Date.now();
    const r = await fetch(PROXY+'/v1/messages?beta=true',{method:'POST',headers:{'content-type':'application/json','anthropic-version':'2023-06-01','anthropic-beta':'oauth-2025-04-20'},body:JSON.stringify({model:'m',max_tokens:16,stream:true,messages:[{role:'user',content:'hi'}]})});
    console.log(`[${Date.now()-t0}ms] headers status=${r.status} ct=${r.headers.get('content-type')}`);
    // read body as a stream, timestamp each chunk arrival
    let arrivals = [];
    for await (const chunk of r.body) {
      arrivals.push({ t: Date.now()-t0, len: chunk.length });
    }
    console.log(`[${Date.now()-t0}ms] stream ended. ${arrivals.length} chunk arrival(s):`);
    for (const a of arrivals) console.log(`  +${a.t}ms  ${a.len} bytes`);
    // verdict
    const first = arrivals[0]?.t ?? -1;
    const last = arrivals[arrivals.length-1]?.t ?? -1;
    const spread = last - first;
    const multi = arrivals.length > 1;
    console.log(`\nfirst arrival: +${first}ms, last: +${last}ms, spread: ${spread}ms, multi-arrival: ${multi}`);
    if (multi && spread > 1000) {
      console.log('PASS: chunks arrived incrementally over time (streaming works)');
    } else if (arrivals.length === 1) {
      console.log('FAIL: only ONE arrival at +'+first+'ms — proxy buffered entire response then sent at once');
    } else {
      console.log('AMBIGUOUS: multiple arrivals but spread only '+spread+'ms');
    }
  } finally { kill(mockProc);kill(proxyProc);try{unlinkSync(TEST_CONFIG)}catch{} process.exit(0); }
}
main();
