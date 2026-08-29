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
// Tracks progress through the paperDetail (作业四) sub-exercises so watch re-enters the NEXT menu
// (模仿朗读/角色扮演/故事复述) instead of redoing the first one every time.
let detailMenuIdx = 0;
const DETAIL_MENU_NAMES = ['模仿朗读', '角色扮演', '故事复述'];
const DEBUG = (CFG.cdpUrl || 'http://127.0.0.1') + ':' + PORT;
const APP_PREFIX = CFG.appUrlPrefix || 'https://student.xiyouyingyu.com';
const MIC_DEVICE = CFG.micDevice || 'CABLE Output';
const PLAY_DEVICE = CFG.playDevice || 'CABLE Input';
const AUDIO = path.resolve(__dirname, CFG.audioToolExe || 'audio-tool/bin/Release/net6.0/xiaoyou-audio.exe');
const CACHE = path.resolve(__dirname, CFG.cacheDir || 'audio-cache');
const MAX_WINDOW_MS = (CFG.replayMaxMs || 25) * 1000;   // generous for 10-25s windows

if (!fs.existsSync(AUDIO)) { console.error('audio tool not found: ' + AUDIO); process.exit(1); }
if (!fs.existsSync(CACHE)) fs.mkdirSync(CACHE, { recursive: true });

// ---- Local log file ----
// Every message printed by the script (console.log/warn/error/info) is ALSO appended to a dated log
// in ./logs/ (e.g. logs/xiyou-auto-2026-08-29.log), so a run can be inspected after the fact even if
// the console/terminal was closed. Set "logDir" in config.json to change the folder, or "logFile":false
// to disable.
const LOG_DIR = path.resolve(__dirname, CFG.logDir || 'logs');
const LOG_FILE = CFG.logFile === false ? null : path.join(LOG_DIR, 'xiyou-auto-' + new Date().toISOString().slice(0, 10) + '.log');
if (LOG_FILE) {
  try { fs.mkdirSync(LOG_DIR, { recursive: true }); } catch (e) {}
  const stamp = () => new Date().toISOString();
  function teed(kind, args) {
    try {
      const line = '[' + stamp() + '] [' + kind.toUpperCase() + '] ' + args.map(a => (typeof a === 'string') ? a : (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') + '\n';
      fs.appendFileSync(LOG_FILE, line);
    } catch (e) {}
  }
  const orig = { log: console.log, warn: console.warn, error: console.error, info: console.info };
  console.log  = (...a) => { teed('log', a);   orig.log(...a); };
  console.warn = (...a) => { teed('warn', a);  orig.warn(...a); };
  console.error= (...a) => { teed('error', a); orig.error(...a); };
  console.info = (...a) => { teed('info', a);  orig.info(...a); };
}

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
    // Homework-4 (听说同步 / 必修第一册阶段训练) is driven by paperDetail: a multi-step state machine
    // where each step has a processTypeId (0=录音提示,1/2=播放,3=等待,4=录音作答,5=播放视频,...).
    // Only the record step (4) actually captures audio; the rest just need to be advanced through.
    var d=find('paperDetail');
    if(d){var dproc=d.process||{},dod=dproc.infoData||{},dotm=dproc.oralTypeModel||{};var dstep=dproc.processTypeId;
      var dtotal=0; try{dtotal=(d.list&&d.list[d.menuIndex]&&d.list[d.menuIndex].smallList[d.smallIndex].processList||[]).length;}catch(e){}
      return {type:'details',found:true,sub:dproc.processTypeId,menu:d.menuIndex,index:d.seq,total:dtotal,
        text:String(dod.showTxt||dotm.refText||'').slice(0,80),audioUrl:dod.audioURL||'',recording:rec(d),windowSec:d.totalTime||dod.timeCount||0};}
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
    // Homework detail list (bagList) for the paperDetail homework: re-enter the exercise to continue.
    var bg=find('bagList');
    if(bg){return {type:'enter',found:true,enter:'bagList',recording:false};}
    // Score report (paperScore): after clicking 再做一次 we land here; click a 重做 to re-enter.
    var ps=find('paperScore');
    if(ps){return {type:'enter',found:true,enter:'paperScore',recording:false};}
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
        // paperDetail (homework-4): the record step (processTypeId 4) — the app's readList() may have
        // already started egStartRecord(); start it again only if not already recording.
        var d=find('paperDetail'); if(d){ if(!d.egRecordState && d.process && d.process.processTypeId===4 && typeof d.egStartRecord==='function'){ d.egStartRecord(d.process, d.process.infoData.timeCount||10); } return 'details'; }
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
    var d=find('paperDetail'); if(d)return !!d.egRecordState;
    var r=find('read'); if(r)return !!r.egRecordState;
    return false;
  })()`);
}
async function advance() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var w=find('readingLoudlyV2'); if(w){if(typeof w.nextList==='function'){w.nextList();return 'word';}}
    var s=find('accentDetail');
    if(s){
      // accentDetail's goNext() is gated by egRecordState/spinning: it is a no-op unless the engine
      // has finished uploading + scoring the previous sentence (its async callback clears those flags).
      // An immediate goNext after stopRecord() therefore often does nothing -> "句子朗读无法自动结束".
      // Loop a bounded few times, waiting for the flags to clear, then goNext() until the sentence
      // index (seq+smallIndex) actually advances. Also handle the last sentence: nextFlow() returns
      // early there, so we must trigger the submit via paperAnswer() (all recorded -> out()/paperAnswer()).
      var snapIdx = s.smallIndex + ':' + s.seq;
      var tries = 0;
      while (tries++ < 4) {
        if (typeof s.goNext === 'function') { s.goNext(); }
        if ((s.smallIndex + ':' + s.seq) !== snapIdx) { return 'sentence-advanced'; }
        // Check flags that block goNext: if still spinning/recording, wait a bit (outside this fn can't
        // await, so we return a special marker telling the loop to wait before re-trying).
        return 'sentence-pending';
      }
      return 'sentence-advanced';
    }
    var d=find('paperDetail');
    if(d){
      // Homework-4 paperDetail multi-step machine. Non-record steps (processTypeId != 4) advance via
      // goNext(). The record step (4) is special: after processItem() replayed the model audio and
      // stopped the record, the app's goNext() sets saveRecordAnswer and awaitRecordSave() waits for the
      // async upload to clear it, then calls nextFlow(). Repeated goNext() while loading/saveRecordAnswer
      // is still set can leave 'loading' stuck true (which then gates goNext and stalls the exercise).
      // So for a record step we do NOT nudge goNext(); we unstick 'loading' when it's clearly finished
      // (saveRecordAnswer cleared + a score already recorded) and let nextFlow() advance.
      var dpt = d.process ? d.process.processTypeId : null;
      if (dpt === 4) {
        if (d.loading && !d.saveRecordAnswer && (d.answerData||[]).length > 0) { d.loading = false; }
        return 'details-record';
      }
      if (typeof d.goNext === 'function') { d.goNext(); }
      return 'details';
    }
    var r=find('read'); if(r){if(typeof r.handleNext==='function'){r.handleNext();return 'text';}}
    var ch=find('chooseTranslateV2'); if(ch){if(typeof ch.nextList==='function'){ch.nextList();return 'choice';}}
    return null;
  })()`);
}
// After the LAST recorded sentence, accentDetail's goNext/nextFlow() returns early and does not submit.
// Trigger the submit directly: if every sentence has been recorded (answerList length == total) the
// component is in the "submit" state and paperAnswer() posts the result. Returns true if submit fired.
async function submitSentence() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var s=find('accentDetail'); if(!s) return false;
    var total=(s.answerLength||0);
    var done=(s.answerList||[]).length;
    var isLastSmall=(s.questions && s.questions.smallList)
      ? (s.smallIndex+1 === s.questions.smallList.length && s.seq+1 === s.questions.smallList[s.smallIndex].processList.length)
      : false;
    if (!isLastSmall) return false;                       // not the last sentence yet -> nothing to submit
    if (typeof s.paperAnswer === 'function' && s.answerList && s.answerList.length > 0) {
      s.spinning = true;
      s.paperAnswer();
      return true;
    }
    return false;
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
    if(kind==='bagList'){
      // 作业四(听说同步) 的详情列表: click 再做一次 -> paperScore, then 重做 -> re-enter paperDetail.
      // This lets watch continue through every sub-exercise after each one submits and returns here.
      function leaf(t){return [...document.querySelectorAll('*')].filter(function(e){return e.children.length===0 && (e.innerText||'').trim()===t;});}
      var redoBtn=leaf('再做一次'); if(redoBtn.length) redoBtn[0].click();
      return 'bagList->redo-again';
    }
    return null;
  })()`);
}
// When on the paperScore report after clicking 再做一次, click the 重做 button of the target
// sub-exercise to re-enter paperDetail at that menu. targetName is one of 模仿朗读/角色扮演/故事复述.
// Returns true if a 重做 was clicked.
async function enterPaperScore(targetName) {
  return evaluate(`(function(){
    function leaf(t){return [...document.querySelectorAll('*')].filter(function(e){return e.children.length===0 && (e.innerText||'').trim()===t;});}
    var redo=leaf('重做');
    if(!redo.length) return false;
    var target=${JSON.stringify(targetName||'')};
    // find the 重做 whose ancestor row mentions targetName
    for(var i=0;i<redo.length;i++){ var el=redo[i], row=el; for(var k=0;k<8&&row;k++){ row=row.parentElement; if(row && target && (row.innerText||'').indexOf(target)>=0){ el.click(); return true; } } }
    // fallback: if no target matched, take the FIRST 重做 (avoids getting stuck)
    redo[0].click();
    return true;
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
function hashUrl(u) {   // short stable hash of the audio url so each word's file is distinct
  let h = 0; const s = String(u || '');
  for (let i = 0; i < s.length; i++) { h = (h * 31 + s.charCodeAt(i)) >>> 0; }
  return h.toString(36);
}
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
      var d=find('paperDetail'); if(d&&d.egRecordState){if(typeof d.stop==='function'){d.stop();}else if(d.EngineEvaluat&&typeof d.EngineEvaluat.stopRecord==='function'){d.EngineEvaluat.stopRecord();}return true;}
      var r=find('read'); if(r&&r.egRecordState){if(typeof r.stopRecord==='function'){r.stopRecord();}else{try{r.EngineEvaluat&&r.EngineEvaluat.stopRecord();}catch(e){}}return true;}
    }catch(e){}
    return false;
  })()`);
}

// paperDetail record step helper: ensure the record window is open (call egStartRecord if needed).
async function ensureRecordStarted() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var d=find('paperDetail'); if(!d) return false;
    if(!d.egRecordState && d.process && d.process.processTypeId===4 && typeof d.egStartRecord==='function'){
      d.egStartRecord(d.process, d.process.infoData.timeCount||10);
      return true;
    }
    return !!d.egRecordState;
  })()`);
}

// paperDetail record step: the reference audio for what to say. For the record step (type 4) the
// model audio isn't on the record process itself; it lives on the preceding 播放原文/播放题干 step
// (processTypeId 1/2) in the same smallList. We fetch that step's audioURL. Returns a cached mp3 path
// or null.
async function detailsAudio() {
  const url = await evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var d=find('paperDetail'); if(!d) return null;
    var menu=d.list[d.menuIndex], sl=menu.smallList[d.smallIndex];
    // prefer the nearest preceding step with an audioURL (播放题干/播放原文/播放视频)
    for(var i=d.seq-1; i>=0; i--){ var x=sl.processList[i]; var u=x.infoData&&x.infoData.audioURL; if(u) return u; }
    // fall back to the record step's own info
    var cur=sl.processList[d.seq]; return (cur.infoData&&cur.infoData.audioURL)||null;
  })()`);
  if (!url) return null;
  const key = slug('details_' + url);
  return ensureAudio('details_' + key, url);
}

// 角色扮演 record steps (om.name 翻译 / 问答题) are scored by KEY-PHRASE matching (om.key), not by
// pronunciation. There is no model audio URL; the answer is the model text. The engine scores the SPOKEN
// answer against the key phrases, so we synthesize those phrases (short, fast) and replay them. Trigger
// only when the record step exposes key phrases (hasKey). Else return null (caller replays model audio).
async function detailsAnswerText() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var d=find('paperDetail'); if(!d) return null;
    var om=d.process&&d.process.oralTypeModel||{};
    if(om.key){   // 翻译/问答题: keyword-scored -> synthesize the scored key phrases
      return om.key.split(/[\\n;\\/，,]+/).map(function(s){return s.trim();}).filter(Boolean).join('. ');
    }
    return null;
  })()`);
}

// Synthesize the given text into a WAV via the Windows System.Speech engine (PS) at a moderate rate and
// 16 kHz mono to keep the file small, cache it, and return the file path. Falls back to null on failure.
async function synthAnswer(text) {
  if (!text) return null;
  const key = 'ano_' + slug(text).slice(0, 40) + '_' + hashUrl(text) + '.wav';
  const f = path.join(CACHE, key);
  if (fs.existsSync(f) && fs.statSync(f).size > 0) return f;
  const safe = f.replace(/\\/g, '\\\\');
  const ps = "Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.Rate = 0; $s.SetOutputToWaveFile('" + safe + "'); $s.Speak(" + JSON.stringify(text) + "); $s.Dispose();";
  return new Promise((res) => {
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], (err) => {
      if (!err && fs.existsSync(f) && fs.statSync(f).size > 0) res(f); else res(null);
    });
  });
}



// When paperDetail's save-upload flow stalls (loading stuck true after a record), force the step
// forward with nextFlow(). Returns true if it advanced. Safe no-op if component gone.
async function forceDetailsNext() {
  return evaluate(`(function(){
    function find(n){var c=null;document.querySelectorAll('*').forEach(function(el){if(!c&&el.__vue__&&el.__vue__.$options.name===n)c=el.__vue__;});return c;}
    var d=find('paperDetail'); if(!d) return true;   // gone -> treat as advanced
    var before = d.menuIndex + ':' + d.smallIndex + ':' + d.seq;
    d.loading = false;                                // unstick the save-wait spinner
    if (typeof d.nextFlow === 'function') d.nextFlow();
    var after = d.menuIndex + ':' + d.smallIndex + ':' + d.seq;
    return (before !== after);
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

  // Homework-4 (paperDetail) multi-step flow. Only the record step (processTypeId 4) captures audio;
  // other steps (0/1/2/3/5/9 = 录音提示/播放/等待/视频) just need to be advanced through via goNext().
  if (snap.type === 'details') {
    if (snap.sub !== 4) {
      console.log('   [details] step type ' + snap.sub + ' (play/wait/prompt) — skipping record.');
      return { ok: true, skipRecord: true };
    }
    // Record step: the app's readList() already calls egStartRecord() when the step loads, so we may
    // already be recording. Ensure the record window is open, replay the correct audio into the mic,
    // then force-stop so the engine scores it and msgHandle clears saveRecordAnswer.
    const p = await ensureRecordStarted();
    if (!p) return { ok: false, reason: 'record not started' };
    await wait(700);
    // 角色扮演(问答题): scored by key-phrase matching — synthesize the model answer & replay it.
    // 模仿朗读/故事复述: scored by pronunciation — replay the reference/model audio.
    const ansTxt = await detailsAnswerText();
    let replayed = false;
    if (ansTxt) {
      const awav = await synthAnswer(ansTxt);
      if (awav) { await playAudio(awav); await playAudio(awav); console.log('   [details] replayed synthesized answer (问答题).'); replayed = true; }
    }
    if (!replayed) {
      const daudio = await detailsAudio();
      if (daudio) { await playAudio(daudio); await playAudio(daudio); console.log('   [details] replayed model audio.'); }
    }
    await wait(600);
    await stopRecord();
    const end = Date.now() + 2500;
    while ((await recording()) && Date.now() < end) { await wait(1000); }
    console.log('   [details] record ended (recording=' + (await recording()) + ')');
    return { ok: true, record: true };
  }

  // Cache key must be per-WORD (text + url hash), NOT per index: the same index in a different
  // exercise is a different word, and a stale "word_0.mp3" from a previous unit would replay the
  // wrong pronunciation -> the engine hears a different word -> score ~0. Keying by text+url hash
  // guarantees each word's correct audio is replayed (fixes word-reading scores of 0).
  const audioKey = slug(snap.text).slice(0, 40) + '_' + hashUrl(snap.audioUrl);
  const audio = await ensureAudio(snap.type + '_' + audioKey, snap.audioUrl);
  if (!audio) { console.log('   !! no audio'); return { ok: false, reason: 'no audio' }; }

  const winSec = (snap.windowSec || 10);
  const first = snap.type !== 'choice' && !didFirstRecord;   // capture BEFORE flipping the flag
  // "每个朗读的最开始(1/xx)多停1秒": the first item of a read-aloud series. Sentence reports index
  // as seq+1 (1-based), others are 0-based. So the series start is index===1 (sentence) or index===0.
  const atStart = (snap.type === 'sentence') ? (snap.index === 1) : (snap.index === 0);
  if (atStart) await wait(1000);                        // +1s at the very start to avoid a missed recording
  if (snap.type !== 'text') await wait(500);                 // 0.5s lead-in before word/sentence record
  await startRecord();
  await wait(first ? 700 : 300);
  didFirstRecord = true;
  // Feed the correct pronunciation into the mic by replaying the audio a bounded number of
  // passes, then FORCE-STOP the recording so we don't wait for the app's (long) countdown and
  // so egRecordState clears (which lets goNext/handleNext advance -> fixes sentence repeating).
  let plays = 0;
  if (snap.type === 'text') {
    // Article: play the full audio once (it IS the whole paragraph reading), then stop.
    await playAudio(audio); plays = 1;
  } else {
    // Word/sentence — deterministic fast rhythm: play the correct audio ONCE (efficiency), then
    // a short pause, then FORCE-STOP. No waiting for the app's long countdown.
    if (first) await wait(800);                    // small warm-up only on the very first word
    await playAudio(audio); plays = 1;
    await wait(500);                                // 0.5s tail after the audio, then switch
  }
  // Force-stop so the engine finalizes and egRecordState clears, then a short grace wait.
  await stopRecord();
  const end = Date.now() + 2500;
  while ((await recording()) && Date.now() < end) { await wait(1000); }
  if (snap.type !== 'text') await wait(500);        // 0.5s lead-out after the record
  console.log('   record window ended (replays=3, recording=' + (await recording()) + ')');
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
    let done = 0, worstSame = 0, lastKey = null, supKind = null, supUntil = 0;
    while (done < n) {
      const snap = await detect();
      if (!snap.found) { console.log('reading screen not detected; is the exercise open? (use watch to auto-wait)'); break; }
      if (snap.type === 'enter') {
        if (snap.enter === supKind && Date.now() < supUntil) { await wait(1500); continue; }
        console.log('[enter] auto-opening: ' + snap.enter);
        const r = snap.enter === 'paperScore' ? ((await enterPaperScore()) ? 'paperScore->redo' : 'paperScore->none') : await enterFromList(snap.enter);
        if (r && /done-or-none|fallback/.test(r)) { supKind = snap.enter; supUntil = Date.now() + 30000; console.log('   "' + snap.enter + '" nothing to do; not re-opening for 30s.'); }
        else if (r && /->redo|->detail|->read|->choice|->redo/.test(r)) { supKind = null; supUntil = 0; }
        await wait(1200);
        continue;
      }
      // Let paperDetail record steps (sub===4) through even though they auto-start recording:
      // processItem() forces them (replay + stop). Other recording states just wait.
      if (snap.recording && !(snap.type === 'details' && snap.sub === 4)) { console.log('currently recording; waiting...'); await wait(1500); continue; }
      const key = snap.type + ':' + snap.index;
      if (lastKey === key) { worstSame++; } else { worstSame = 0; lastKey = key; }
      if (worstSame >= 3) { console.log('no progress for 3 rounds (idx=' + snap.index + '); stopping to avoid a loop.'); break; }
      const r = await processItem();
      done++;
      if (snap.type === 'word' || snap.type === 'text') readDone = true;   // reading part done -> next time on unitWordListV2 open choice
      if (!r.ok) { console.log('   !! ' + r.reason); break; }
      // Advance to the next item (for text this also submits the last paragraph).
      // If the component is already gone (submitted/navigated), advance() is a safe no-op.
      const adv = await advance();
      // accentDetail: goNext may be a no-op while the engine's async callback hasn't cleared
      // egRecordState/spinning yet. Wait and retry until the sentence index actually moves.
      if (snap.type === 'sentence' && adv === 'sentence-pending') {
        for (let w = 0; w < 12; w++) {
          await wait(1000);
          const s2 = await detect();
          if (!s2.found || s2.recording) continue;               // still busy
          if ((s2.index) !== snap.index) break;                  // advanced
          // reached the last recorded index and can't advance further -> submit the exercise
          if (w >= 5) {
            const sub = await submitSentence();
            if (sub) console.log('   last sentence recorded; triggered submit.');
            break;
          }
          const a2 = await advance();
          if (a2 === 'sentence-advanced') break;
        }
      }
      // paperDetail record step (sub 4): the app's save-upload flow advances on its own once the score
      // is uploaded. If 'loading' stayed stuck (a race from rapid goNext), unstick it and nudge nextFlow.
      if (snap.type === 'details' && snap.sub === 4) {
        for (let w = 0; w < 10; w++) {
          await wait(1000);
          const s2 = await detect();
          if (!s2.found) break;
          if ((s2.menu !== snap.menu) || (s2.index !== snap.index)) break;   // advanced (or moved menu)
          // stuck: force the step forward (recording already saved)
          const st = await forceDetailsNext();
          if (st) { console.log('   [details] record step stuck; forced nextFlow.'); break; }
        }
      }
      await wait(700);
      if (done >= n) break;
    }
    console.log('RUN ENDED (' + done + ' processed).');
    return;
  }
  if (cmd === 'watch') {
    console.log('watch mode: auto-reads any read-aloud exercise that opens. Waiting...');
    let idle = 0, errCount = 0, stuckRec = 0, suppressKind = null, suppressUntil = 0, cooldownUntil = 0;
    for (;;) {
      try {
        const snap = await detect();
        if (snap.found) {
          idle = 0; errCount = 0;
          if (snap.type === 'enter') {
            // If this exact list was recently found "nothing to do", don't keep re-entering it
            // (avoids the endless auto-open/pause loop on a completed exercise).
            const now = Date.now();
            if (suppressKind === snap.enter && now < suppressUntil) {
              await wait(1500);
              continue;
            }
            // Cooldown after finishing an exercise: don't instantly re-open the list.
            if (now < cooldownUntil) {
              await wait(1500);
              continue;
            }
            console.log('[enter] auto-opening: ' + snap.enter);
            let res;
            if (snap.enter === 'paperScore') {
              // We clicked 再做一次 on the homework detail and landed on the score report.
              // Click the 重做 for the next target sub-exercise to re-enter paperDetail.
              const tgt = DETAIL_MENU_NAMES[detailMenuIdx] || DETAIL_MENU_NAMES[0];
              res = (await enterPaperScore(tgt)) ? 'paperScore->redo' : 'paperScore->none';
            } else {
              res = await enterFromList(snap.enter);
            }
            if (res && /done-or-none|fallback/.test(res)) {
              // Nothing runnable on this list -> suppress re-entering it for a while.
              suppressKind = snap.enter;
              suppressUntil = Date.now() + 30000;
              console.log('   [watch] "' + snap.enter + '" has nothing to do; not re-opening for 30s.');
            } else if (res && /->redo|->detail|->read|->choice/.test(res)) {
              suppressKind = null; suppressUntil = 0;   // something opened -> reset suppression
            }
            await wait(1200);
            continue;
          }
          if (snap.recording && !(snap.type === 'details' && snap.sub === 4)) {
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
          const adv = await advance();
          // accentDetail: goNext may no-op until the engine's async callback clears egRecordState/spinning.
          if (snap.type === 'sentence' && adv === 'sentence-pending') {
            for (let w = 0; w < 12; w++) {
              await wait(1000);
              const s2 = await detect();
              if (!s2.found || s2.recording) continue;
              if (s2.index !== snap.index) break;                 // advanced
              if (w >= 5) {                                       // last recorded index -> submit exercise
                const sub = await submitSentence();
                if (sub) console.log('   [watch] last sentence recorded; triggered submit.');
                break;
              }
              const a2 = await advance();
              if (a2 === 'sentence-advanced') break;
            }
          }
          // paperDetail record step (sub 4): the app's save-upload flow advances on its own once the
          // score is uploaded. If 'loading' stayed stuck, unstick it and nudge nextFlow (mirrors run loop).
          if (snap.type === 'details' && snap.sub === 4) {
            for (let w = 0; w < 10; w++) {
              await wait(1000);
              const s2 = await detect();
              if (!s2.found) break;
              if ((s2.menu !== snap.menu) || (s2.index !== snap.index)) break;   // advanced (or moved menu)
              const st = await forceDetailsNext();
              if (st) { console.log('   [watch] record step stuck; forced nextFlow.'); break; }
            }
          }
          // Once a paperDetail menu's record fully finished, advance the target menu so the next
          // re-entry (bagList->再做一次->重做) starts at the next sub-exercise instead of menu 0.
          if (snap.type === 'details' && snap.sub === 4 && (typeof snap.menu === 'number')) {
            detailMenuIdx = Math.max(detailMenuIdx, snap.menu + 1);
          }
          // If we just re-entered paperDetail but want a later menu (reFormIndex always starts at 0),
          // jump to the target menu directly.
          if (snap.type === 'details' && detailMenuIdx > 0 && snap.menu === 0) {
            const g = await gotoDetailsMenu(detailMenuIdx);
            if (g) console.log('   [watch] jumped to details menu ' + detailMenuIdx + ' (' + (DETAIL_MENU_NAMES[detailMenuIdx]||'') + ')');
          }
          // After completing a runnable exercise it often returns to a list screen. Cooldown all
          // auto-entering so it doesn't instantly re-open the just-finished exercise (review loop).
          cooldownUntil = Date.now() + 12000;
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
