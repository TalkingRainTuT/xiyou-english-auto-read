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
// Tracks whether we've completed the reading part of a unitWordListV2 group, so the next
// time we land back on that screen we auto-open the word-choice (看义选词) part instead.
let readDone = false;
// The scoring engine (engine.js) connects a WebSocket lazily; on the FIRST record in a session
// it may not be ready yet, so the first word's recording can be silent (score 0). We give the
// first record a longer warm-up wait.
let didFirstRecord = false;
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
  const app = ts.find(t => (t.url || '').startsWith(APP_PREFIX));
  if (app) return app;
  const iframe = ts.find(t => t.type === 'iframe');
  if (iframe) return iframe;
  // No real app iframe yet — do NOT attach to the shell page (file://...index.html); wait for it.
  return ts.find(t => (t.url || '').includes('student.')) || null;
}
let cdp;
async function client() {
  if (cdp) return cdp;
  let t = null;
  for (let i = 0; i < 40 && !t; i++) {           // wait up to 40s for the real app iframe (not the shell page)
    try { t = await pickTarget(); } catch (_) { t = null; }
    if (!t) await wait(1000);
  }
  if (!t) throw new Error('app iframe not loaded — is the client logged in / did the web content load?');
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
    var ch=find('chooseTranslateV2');
    if(ch){var it=ch.list[ch.listIndex]||{};var ct=it.chooseTitleType||{};var ot=ct.optionsTypeList||[];var ci=-1;for(var oi=0;oi<ot.length;oi++){if(ot[oi].answer){ci=oi;break;}}return {type:'choice',found:true,index:ch.listIndex,total:(ch.list||[]).length,text:it.name||'',answerIndex:ci,optionCount:ot.length,recording:false};}
    // List screens: only auto-navigate WITHIN a homework the user already opened.
    // We do NOT auto-open whole homework items from bagList (the user picks which homework),
    // which prevents "forcibly opening a homework / looping".
    var al=find('accentList');
    if(al){return {type:'enter',found:true,enter:'accentList',recording:false};}
    var uw=find('unitWordListV2');
    if(uw){return {type:'enter',found:true,enter:'unitWordListV2',recording:false};}
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
    var ch=find('chooseTranslateV2'); if(ch){if(typeof ch.nextList==='function'){ch.nextList();return 'choice';}}
    return null;
  })()`);
}
// Auto-enter a runnable exercise from a list screen (the user lands on these when they open homework).
async function enterFromList(kind) {
  const rd = readDone;   // capture Node-side flag so it's available inside the page JS below
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var kind=${JSON.stringify(kind)};
    var readDone=${JSON.stringify(rd)};
    if(kind==='accentList'){ var a=find('accentList'); if(a&&a.list&&a.list.length&&typeof a.detail==='function'){a.detail(0);return 'accentList->detail';} }
    if(kind==='unitWordListV2'){
      // On this group screen there are two parts: 朗读单词 (reading) and 看义选词 (choice).
      // Only auto-open a part whose action is "去完成" (not yet done). If a part is already
      // done it shows "再做一次" — we skip it so we never redo / loop.
      function clickRow(label){
        var row=[...document.querySelectorAll('*')].find(function(e){var t=(e.innerText||'').trim();return t===label&&e.children.length===0;});
        if(!row) return false;
        var card=row;for(var i=0;i<4&&card;i++){card=card.parentElement;if(card){
          var b=card.querySelector('.btn')||[...card.querySelectorAll('div,span,button')].find(function(x){var t=(x.innerText||'').trim();return t==='去完成'||t==='再做一次';});
          if(b){
            var bt=(b.innerText||'').trim();
            if(bt!=='去完成') return false;   // already done -> skip to avoid redo/loop
            b.click(); return true;
          }
        }}
        return false;
      }
      if(readDone){ if(clickRow('看义选词')) return 'unitWordListV2->choice'; }
      else { if(clickRow('朗读单词')) return 'unitWordListV2->read'; }
      return 'unitWordListV2->done-or-none';   // no not-done part -> do nothing (no loop)
    }
    return null;
  })()`);
}
// For the word-choice exercise: pick the correct option (the one with answer=true).
async function chooseAnswer() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var ch=find('chooseTranslateV2');
    if(!ch) return null;
    var it=ch.list[ch.listIndex]||{};
    var ot=(it.chooseTitleType||{}).optionsTypeList||[];
    for(var i=0;i<ot.length;i++){ if(ot[i].answer){ if(typeof ch.chooseOptions==='function') ch.chooseOptions(ch.listIndex, i); return {picked:i, text:ot[i].text}; } }
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
// Replay the audio into the loopback mic. On Windows we use the bundled xiaoyou-audio.exe
// (plays to a virtual device, e.g. CABLE Input -> CABLE Output). For other platforms
// (e.g. macOS with BlackHole), set "replayCmd" in config.json to a template like
//   "afplay %f"        (play to the default output; route it into BlackHole loopback)
//   "ffplay -nodisp -loglevel quiet -f lavfi -i %f"
// where %f is the audio file path. The env var XIYOU_REPLAY_CMD overrides config too.
function playAudio(mp3) {
  const cmdTpl = process.env.XIYOU_REPLAY_CMD || CFG.replayCmd || null;
  if (cmdTpl) {
    return new Promise(res => execFile('sh', ['-c', cmdTpl.replace(/%f/g, mp3)], () => res()));
  }
  return new Promise(res => execFile(AUDIO, ['play', PLAY_DEVICE, mp3], () => res()));
}

async function stopRecord() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    try{
      var w=find('readingLoudlyV2'); if(w&&w.egRecordState){
        // The word component has no .stopRecord(); stop via the engine so egRecordState clears
        // and nextList() (guarded by egRecordState) is allowed to advance.
        if(typeof w.stopRecord==='function') w.stopRecord();
        else if(w.EngineEvaluat&&typeof w.EngineEvaluat.stopRecord==='function') w.EngineEvaluat.stopRecord();
        return true;
      }
      var s=find('accentDetail'); if(s&&s.egRecordState){if(typeof s.stop==='function'){s.stop();}else if(typeof s.stopRecord==='function'){s.stopRecord();}return true;}
      var r=find('read'); if(r&&r.egRecordState){if(typeof r.stopRecord==='function'){r.stopRecord();}else{try{r.EngineEvaluat&&r.EngineEvaluat.stopRecord();}catch(e){}}return true;}
    }catch(e){}
    return false;
  })()`);
}

async function processItem() {
  const snap = await detect();
  if (!snap.found) return { ok: false, reason: 'no item' };
  console.log(`[${snap.type}] (${snap.index}${snap.total ? '/' + snap.total : ''}) "${(snap.text || '').slice(0, 40)}"`);

  // Word-choice (选词/看义选词): no mic/audio needed, just click the correct option.
  if (snap.type === 'choice') {
    if (snap.answerIndex < 0) { console.log('   !! no correct answer option found'); return { ok: false, reason: 'no answer' }; }
    const picked = await chooseAnswer();
    console.log('   picked correct option: ' + (picked ? picked.text : '?'));
    await wait(800);
    return { ok: true };
  }

  const audio = await ensureAudio(snap.type + '_' + snap.index, snap.audioUrl);
  if (!audio) { console.log('   !! no audio'); return { ok: false, reason: 'no audio' }; }

  const winSec = (snap.windowSec || 10);
  const first = snap.type !== 'choice' && !didFirstRecord;   // capture BEFORE flipping the flag
  if (first) {
    await wait(1500);   // engine may not be ready on the very first record (WebSocket up) -> longer warm-up
  }
  await startRecord();
  await wait(first ? 1200 : 600);
  didFirstRecord = true;
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
    // On the FIRST record give more passes / a longer window so the engine captures the correct
    // pronunciation robustly (the engine is cold on the very first word).
    const replayForMs = Math.min(winSec, first ? 60 : 25) * 1000;
    const maxPlays = first ? 18 : 12;
    while (Date.now() - start < replayForMs && plays < maxPlays) {
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
      if (snap.type === 'enter') {
        console.log('[enter] auto-opening: ' + snap.enter);
        await enterFromList(snap.enter);
        await wait(1200);
        continue;
      }
      if (snap.recording) { console.log('currently recording; waiting...'); await wait(1500); continue; }
      const key = snap.type + ':' + snap.index;
      if (lastKey === key) { worstSame++; } else { worstSame = 0; lastKey = key; }
      if (worstSame >= 3) { console.log('no progress for 3 rounds (idx=' + snap.index + '); stopping to avoid a loop.'); break; }
      const r = await processItem();
      done++;
      if (snap.type === 'word' || snap.type === 'text') readDone = true;   // reading part done -> next time on unitWordListV2 open choice
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
    let idle = 0, errCount = 0, stuckRec = 0, enterCount = 0;
    for (;;) {
      try {
        const snap = await detect();
        if (snap.found) {
          idle = 0; errCount = 0;
          if (snap.type === 'enter') {
            console.log('[enter] auto-opening: ' + snap.enter);
            const res = await enterFromList(snap.enter);
            enterCount++;
            // If a list keeps offering nothing new ("done-or-none") too many times, stop auto-entering
            // to avoid an open/redo loop.
            if (res && /done-or-none|fallback/.test(res)) { enterCount++; } else { enterCount = 0; }
            if (enterCount >= 4) { console.log('   [watch] list keeps auto-opening nothing; pausing to avoid a loop.'); enterCount = 0; await wait(3000); }
            await wait(1200);
            continue;
          }
          if (snap.recording) {
            stuckRec++;
            if (stuckRec >= 30) {   // ~45s of "recording" with no progress -> force-stop once
              console.log('   [watch] recording stuck; force-stopping...');
              await stopRecord();
              stuckRec = 0;
            }
            await wait(1500);
            continue;
          }
          stuckRec = 0;
          if (snap.type === 'word' || snap.type === 'text') readDone = true;   // reading done -> next time on unitWordListV2 open choice
          await processItem();
          await advance();
          await wait(700);
        } else {
          idle++; stuckRec = 0;
          if (idle === 1) console.log('waiting for a reading exercise...');
          await wait(1500);
        }
      } catch (e) {
        // Transient errors (CDP flash, WebSocket race, etc.) must NOT kill watch — log and retry.
        errCount++;
        console.log('   [watch] transient error (' + errCount + '): ' + (e && e.message ? e.message : e));
        if (/ECONNREFUSED|no app target|disconnect|closed|WebSocket/i.test(e && e.message ? e.message : String(e))) {
          console.log('   [watch] connection lost; reconnecting...');
          try { cdp = null; await client(); await ensureCableMic(); } catch (e2) { console.log('   [watch] reconnect failed: ' + (e2 && e2.message)); }
        }
        await wait(1500);
      }
    }
  }
  console.error('unknown command: ' + cmd);
}
main().then(() => process.exit(0)).catch(e => { console.error('FATAL:', e.stack || e.message); process.exit(1); });
