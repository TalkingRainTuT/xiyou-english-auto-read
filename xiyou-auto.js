#!/usr/bin/env node
/*
 * xiyou-auto.js  —  auto-complete 西柚英语 read-aloud homework, unified for 3 exercise types.
 *
 * It auto-DETECTS which reading screen is open and drives its Vue component directly via CDP.
 * The core trick is the same for all types: start the ~N-second mic record window via the
 * component's record method, then replay the item's correct pronunciation MP3 into the virtual
 * mic (CABLE Input -> CABLE Output) until the record window ends, then advance to the next item.
 *
 * The three exercise types and how we drive them:
 *   -----------------------------------------------------------------------
 *   类型          component      record()            audio source                              advance
 *   -----------------------------------------------------------------------
 *   word  单词    readingLoudlyV2  egStartRecord()  list[listIndex].enPronunciation           nextList()
 *   sentence  句   accentDetail     startRecord()     process.infoData.audioURL               goNext()
 *   text  课文    read             egStartRecord()   textParagraphList[curIndex].audioUrl      handleNext()
 *   -----------------------------------------------------------------------
 *
 * Because it re-detects the component on every iteration (rather than assuming one type),
 * it also FREELY RESUMES: if you pause / exit and re-enter an exercise, running it again
 * continues from the current position instead of restarting.
 *
 * PREREQS:
 *   1. VB-Cable installed; default mic = "CABLE Output"; default render = "CABLE Input".
 *   2. Client running with --remote-debugging-port, logged in.
 *   3. xiaoyou-audio.exe built; config.json present.
 *
 * Usage:
 *   node xiyou-auto.js status     -> detect type + show current item / recording state
 *   node xiyou-auto.js run [n]    -> read the next n items (default 1) then stop
 *   node xiyou-auto.js runall     -> read all items until the exercise submits
 *   node xiyou-auto.js watch      -> keep looping; auto-read any exercise that opens (resume-safe)
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

// ---- Configuration ----
const CONFIG_PATH = path.join(__dirname, 'config.json');
let CFG = {};
try { CFG = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8')); } catch (e) { console.error('could not read config.json: ' + e.message); process.exit(1); }

const PORT = CFG.port || 9222;
const DEBUG = (CFG.cdpUrl || 'http://127.0.0.1') + ':' + PORT;
const APP_PREFIX = CFG.appUrlPrefix || 'https://student.xiyouyingyu.com';
const MIC_DEVICE = CFG.micDevice || 'CABLE Output';
const PLAY_DEVICE = CFG.playDevice || 'CABLE Input';
const AUDIO = path.resolve(__dirname, CFG.audioToolExe || 'audio-tool/bin/Release/net6.0/xiaoyou-audio.exe');
const CACHE = path.resolve(__dirname, CFG.cacheDir || 'audio-cache');
const MAX_WINDOW_MS = (CFG.replayMaxMs || 25) * 1000;   // generous for 10-25s windows

if (!fs.existsSync(AUDIO)) { console.error('audio tool not found: ' + AUDIO); process.exit(1); }
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

const wait = ms => new Promise(r => setTimeout(r, ms));
function httpGet(url) { return new Promise((res, rej) => http.get(url, r => { let b = ''; r.on('data', d => b += d); r.on('end', () => res(b)); }).on('error', rej)); }
async function listTargets() { return JSON.parse(await httpGet(DEBUG + '/json')); }
let nextId = 1;
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    ws.addEventListener('message', ev => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { const p = pending.get(m.id); pending.delete(m.id); m.error ? p.reject(new Error(JSON.stringify(m.error))) : p.resolve(m.result); } });
    ws.addEventListener('open', () => resolve({ ws, call(method, params) { const id = nextId++; return new Promise((res, rej) => { pending.set(id, { resolve: res, reject: rej }); ws.send(JSON.stringify({ id, method, params: params || {} })); }); } }));
    ws.addEventListener('error', reject);
  });
}
async function pickTarget() {
  const ts = await listTargets();
  return ts.find(t => (t.url || '').startsWith(APP_PREFIX)) || ts.find(t => t.type === 'iframe') || ts[0];
}
let cdp;
async function client() {
  if (cdp) return cdp;
  let t = null;
  for (let i = 0; i < 20 && !t; i++) {           // wait for the client/app iframe to come up fresh
    try { t = await pickTarget(); } catch (_) { t = null; }
    if (!t) await wait(1000);
  }
  if (!t) throw new Error('no app target — is the client running with --remote-debugging-port?');
  cdp = await connect(t.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  // Grant microphone permission so the app can record without a prompt (first-run fix).
  try { await cdp.call('Browser.grantPermissions', { permissions: ['audioCapture'], origin: APP_PREFIX }); } catch (e) {
    try { await cdp.call('Browser.grantPermissions', { permissions: ['audioCapture', 'microphone'], origin: APP_PREFIX }); } catch (e2) {}
  }
  return cdp;
}
async function evaluate(code) {
  const r = await cdp.call('Runtime.evaluate', { expression: code, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(JSON.stringify(r.exceptionDetails));
  return r.result && r.result.value;
}

// Non-invasive audio routing: we do NOT change the OS default mic / speaker (other apps are
// unaffected). Instead we inject a getUserMedia override into the Xiyou page so that the app's
// microphone records from the virtual cable (CABLE Output) only. We play the downloaded correct
// pronunciation to CABLE Input all along, which surfaces on CABLE Output = the app's mic.
// This way no system audio is captured and other apps keep their real devices.
async function ensureCableMic() {
  if (!CFG.useCableMicOverride) return;   // disabled -> caller handles defaults manually
  const cableName = CFG.cableMicDevice || 'CABLE Output';
  // 1) resolve the cable device id from the page's enumerateDevices
  let cableId = null;
  try {
    cableId = await evaluate(`(async function(){var ds=await navigator.mediaDevices.enumerateDevices();var m=ds.filter(function(d){return d.kind==='audioinput' && ${JSON.stringify(cableName)}.toLowerCase()===(d.label||'').toLowerCase()|| (d.label||'').toLowerCase().indexOf(${JSON.stringify(cableName).toLowerCase()})>=0;});return m.length?m[0].deviceId:null;})()`);
  } catch (e) { cableId = null; }
  if (!cableId) { console.log('   [audio] cable mic override: ' + cableName + ' not found; skipping.'); return; }
  // 2) wrap getUserMedia to force the audio input to the cable device
  const script = `
    (function(){
      var cableId = ${JSON.stringify(cableId)};
      var md = navigator.mediaDevices;
      if (!md || md.__cableWrap) return;
      var orig = md.getUserMedia.bind(md);
      md.getUserMedia = function(constraints){
        var c = constraints || {};
        if (c.audio === undefined || c.audio === true) { c = { audio: { deviceId: { exact: cableId } } }; }
        else if (c.audio && typeof c.audio === 'object') { c.audio.deviceId = { exact: cableId }; }
        return orig(c);
      };
      md.__cableWrap = true;
    })()
  `;
  await evaluate(script);
  // 3) persist across reloads
  try { await cdp.call('Page.addScriptToEvaluateOnNewDocument', { source: script }); } catch (e) {}
  console.log('   [audio] cable mic override active -> ' + cableName);
}

async function detect() {
  // Try all three reading components in order, return a snapshot of the active exercise.
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    function rec(c){return !!c.egRecordState;}
    var w=find('readingLoudlyV2');
    if(w){var cur=w.list[w.listIndex]||{};return {type:'word',found:true,index:w.listIndex,total:w.list.length,text:cur.name||'',audioUrl:cur.enPronunciation||'',recording:rec(w),windowSec:10};}
    var s=find('accentDetail');
    if(s){var p=s.process||{},i=p.infoData||{},om=p.oralTypeModel||{};return {type:'sentence',found:true,index:s.seq+1,total:s.num||0,text:om.refText||i.showTxt||'',audioUrl:i.audioURL||'',recording:rec(s),windowSec:i.timeCount||15};}
    var r=find('read');
    if(r){var cp=r.currentParagraph||{},pl=r.textParagraphList||[];var url=cp.audioUrl||(pl[0]&&pl[0].audioUrl)||'';var win=Math.ceil((cp.sectionEndTime||0)-(cp.sectionBeginTime||0));if(!win||win<10)win=(r.duration||30);return {type:'text',found:true,index:r.curIndex,total:pl.length,text:(cp.originalText||'').slice(0,60),audioUrl:url,recording:rec(r),windowSec:win};}
    return {type:null,found:false};
  })()`);
}
// Start the record window for whichever reading component is open. The app's audio engine
// (engine.js) connects a WebSocket lazily; on a cold start the first egStartRecord can throw
// "Failed to construct 'WebSocket': The URL 'en.word.score?...' is invalid." (base URL not ready).
// We retry a few times with a short wait so the engine's websocket initializes.
async function startRecord() {
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await evaluate(`(function(){
        function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
        var w=find('readingLoudlyV2'); if(w){w.egStartRecord();return 'word';}
        var s=find('accentDetail'); if(s){s.startRecord();return 'sentence';}
        var r=find('read'); if(r){r.egStartRecord();return 'text';}
        return null;
      })()`);
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      if (/WebSocket|en\.word\.score/i.test(msg)) {
        console.log('   engine WebSocket not ready yet; retrying startRecord (' + (attempt + 1) + '/5)...');
        await wait(1200);
        continue;
      }
      throw e;
    }
  }
  throw new Error('could not start record after retries (engine websocket did not initialize)');
}
async function recording() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var w=find('readingLoudlyV2'); if(w)return !!w.egRecordState;
    var s=find('accentDetail'); if(s)return !!s.egRecordState;
    var r=find('read'); if(r)return !!r.egRecordState;
    return false;
  })()`);
}
async function advance() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var w=find('readingLoudlyV2'); if(w){if(typeof w.nextList==='function'){w.nextList();return 'word';}}
    var s=find('accentDetail'); if(s){if(typeof s.goNext==='function'){s.goNext();return 'sentence';}}
    var r=find('read'); if(r){if(typeof r.handleNext==='function'){r.handleNext();return 'text';}}
    return null;
  })()`);
}

function slug(w) { return (w || '').trim().replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 60); }
function cachePath(key) { return path.join(CACHE, slug(key) + '.mp3'); }
async function ensureAudio(key, url) {
  if (!url) return null;
  const f = cachePath(key);
  if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  const r = await fetch(url);
  if (!r.ok) return null;
  const buf = Buffer.from(await r.arrayBuffer());
  if (buf.length === 0) return null;
  fs.writeFileSync(f, buf);
  return f;
}
function playAudio(mp3) { return new Promise(res => execFile(AUDIO, ['play', PLAY_DEVICE, mp3], () => res())); }

async function stopRecord() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    try{
      var w=find('readingLoudlyV2'); if(w&&w.egRecordState){if(typeof w.stopRecord==='function')w.stopRecord();return true;}
      var s=find('accentDetail'); if(s&&s.egRecordState){if(typeof s.stop==='function'){s.stop();}else if(typeof s.stopRecord==='function'){s.stopRecord();}return true;}
      var r=find('read'); if(r&&r.egRecordState){if(typeof r.stopRecord==='function'){r.stopRecord();}else{try{r.EngineEvaluat&&r.EngineEvaluat.stopRecord();}catch(e){}}return true;}
    }catch(e){}
    return false;
  })()`);
}

async function processItem() {
  const snap = await detect();
  if (!snap.found || !snap.audioUrl) return { ok: false, reason: 'no item' };
  console.log(`[${snap.type}] (${snap.index}${snap.total ? '/' + snap.total : ''}) "${(snap.text || '').slice(0, 40)}"`);
  const audio = await ensureAudio(snap.type + '_' + snap.index, snap.audioUrl);
  if (!audio) { console.log('   !! no audio'); return { ok: false, reason: 'no audio' }; }

  const winSec = (snap.windowSec || 10);
  await startRecord();
  await wait(600);
  // Feed the correct pronunciation into the mic by replaying the audio a bounded number of
  // passes, then FORCE-STOP the recording so we don't wait for the app's (long) countdown and
  // so egRecordState clears (which lets goNext/handleNext advance -> fixes sentence repeating).
  const start = Date.now();
  let plays = 0;
  if (snap.type === 'text') {
    // Article: play the full audio once (it IS the whole paragraph reading), then stop.
    while (Date.now() - start < Math.min(winSec, 240) * 1000 && plays < 1) {
      await playAudio(audio); plays++;
    }
  } else {
    // Word/sentence: replay a few passes (they're short), then stop. Keeps score high w/o waiting.
    const replayForMs = Math.min(winSec, 25) * 1000;
    while (Date.now() - start < replayForMs && plays < 12) {
      await playAudio(audio); plays++;
    }
  }
  // Force-stop so the engine finalizes and egRecordState clears, then a short grace wait.
  await stopRecord();
  const end = Date.now() + 8000;
  while ((await recording()) && Date.now() < end) { await wait(1000); }
  console.log('   record window ended (replays=' + plays + ', recording=' + (await recording()) + ')');
  return { ok: true };
}

async function main() {
  await client();
  await ensureCableMic();
  const cmd = process.argv[2] || 'run';
  if (cmd === 'status') { console.log(JSON.stringify(await detect(), null, 2)); return; }
  if (cmd === 'run' || cmd === 'runall') {
    const n = cmd === 'runall' ? Infinity : (Number(process.argv[3]) || 1);
    console.log('target=' + (n === Infinity ? 'ALL' : n));
    let done = 0, worstSame = 0, lastKey = null;
    while (done < n) {
      const snap = await detect();
      if (!snap.found) { console.log('reading screen not detected; is the exercise open? (use watch to auto-wait)'); break; }
      if (snap.recording) { console.log('currently recording; waiting...'); await wait(1500); continue; }
      const key = snap.type + ':' + snap.index;
      if (lastKey === key) { worstSame++; } else { worstSame = 0; lastKey = key; }
      if (worstSame >= 3) { console.log('no progress for 3 rounds (idx=' + snap.index + '); stopping to avoid a loop.'); break; }
      const r = await processItem();
      done++;
      if (!r.ok) { console.log('   !! ' + r.reason); break; }
      // Advance to the next item (for text this also submits the last paragraph).
      // If the component is already gone (submitted/navigated), advance() is a safe no-op.
      await advance();
      await wait(700);
      if (done >= n) break;
    }
    console.log('RUN ENDED (' + done + ' processed).');
    return;
  }
  if (cmd === 'watch') {
    console.log('watch mode: auto-reads any read-aloud exercise that opens. Waiting...');
    let idle = 0;
    for (;;) {
      const snap = await detect();
      if (snap.found) {
        idle = 0;
        if (snap.recording) { await wait(1500); continue; }
        await processItem();
        await advance();
        await wait(700);
      } else {
        idle++;
        if (idle === 1) console.log('waiting for a reading exercise...');
        await wait(1500);
      }
    }
  }
  console.error('unknown command: ' + cmd);
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
