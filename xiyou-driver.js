#!/usr/bin/env node
/*
 * xiyou-driver.js  --  drive the 西柚英语 (XiYou English) desktop client over CDP with zero dependencies.
 *
 * The client is an Electron shell that loads https://student.xiyouyingyu.com in an iframe.
 * Launch it with --remote-debugging-port (e.g. 9222); the real web app then appears as a
 * separate CDP "iframe"/"page" target. We attach to the target whose url starts with
 * https://student. so we can read the homework DOM and drive the answers.
 *
 * Usage:
 *   node xiyou-driver.js launch            -> (if not running) start the exe + debug port
 *   node xiyou-driver.js list              -> print CDP targets
 *   node xiyou-driver.js dump              -> print the app's body text / key structure
 *   node xiyou-driver.js eval "<js>"       -> run JS in the app, print JSON result
 *   node xiyou-driver.js shot out.png      -> PNG screenshot
 *   node xiyou-driver.js click "<text>"    -> find & click an element whose text equals <text>
 */

const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const http = require('http');

const EXE = 'D:\\Program Files\\Xiyou\\西柚英语个人版.exe';
const PORT = 9222;
const DEBUG = 'http://127.0.0.1:' + PORT;
const APP_PREFIX = 'https://student.xiyouyingyu.com';

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function httpGet(url) {
  return new Promise((resolve, reject) => {
    http.get(url, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

async function listTargets() {
  const body = await httpGet(DEBUG + '/json');
  return JSON.parse(body);
}

let nextId = 1;
function connect(wsUrl) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(wsUrl);
    const pending = new Map();
    ws.addEventListener('message', ev => {
      const msg = JSON.parse(ev.data);
      if (msg.id && pending.has(msg.id)) {
        const { resolve, reject } = pending.get(msg.id);
        pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
    ws.addEventListener('open', () => resolve({
      ws,
      call(method, params) {
        const id = nextId++;
        return new Promise((res, rej) => {
          pending.set(id, { resolve: res, reject: rej });
          ws.send(JSON.stringify({ id, method, params: params || {} }));
        });
      }
    }));
    ws.addEventListener('error', reject);
  });
}

// Pick the real app target: prefer https://student.*, else the first iframe/page.
async function pickTarget() {
  const ts = await listTargets();
  const app = ts.find(t => (t.url || '').startsWith(APP_PREFIX));
  return app || ts.find(t => t.type === 'iframe') || ts[0] || null;
}

async function main() {
  const cmd = process.argv[2] || 'list';
  const rest = process.argv.slice(3);

  if (cmd === 'list') {
    const ts = await listTargets();
    ts.forEach((t, i) => {
      console.log(`[${i}] ${t.type}  ${t.title}`);
      console.log('    ' + t.url);
      console.log('    ws:  ' + t.webSocketDebuggerUrl);
    });
    return;
  }

  if (cmd === 'launch') {
    try {
      await listTargets();
      console.log('already running (port ' + PORT + ')');
    } catch (e) {
      const child = spawn(EXE, ['--remote-debugging-port=' + PORT], { detached: true, stdio: 'ignore' });
      child.unref();
      console.log('launched pid ' + child.pid + ' with --remote-debugging-port=' + PORT);
      // wait for the debug endpoint to come up
      for (let i = 0; i < 20; i++) {
        await wait(500);
        try { await listTargets(); console.log('CDP up.'); break; } catch (_) {}
      }
    }
    return;
  }

  const target = await pickTarget();
  if (!target) { console.error('No app target found. Is the client running with --remote-debugging-port=' + PORT + '?'); process.exit(1); }

  const cdp = await connect(target.webSocketDebuggerUrl);
  await cdp.call('Runtime.enable');
  await cdp.call('Page.enable');

  if (cmd === 'dump') {
    const r = await cdp.call('Runtime.evaluate', {
      expression: `JSON.stringify({url:location.href, title:document.title, text:document.body.innerText.slice(0,4000), h1:[...document.querySelectorAll('h1,h2,h3')].map(e=>e.innerText)})`,
      returnByValue: true
    });
    const v = r.result && r.result.value;
    console.log(v ? JSON.parse(v) : r);
    return;
  }

  if (cmd === 'eval') {
    const code = rest.join(' ') || 'document.body.innerText';
    const r = await cdp.call('Runtime.evaluate', {
      expression: code, returnByValue: true, awaitPromise: true
    });
    console.log(JSON.stringify(r.result && r.result.value !== undefined ? r.result.value : r, null, 2));
    return;
  }

  if (cmd === 'click') {
    const text = rest.join(' ');
    const r = await cdp.call('Runtime.evaluate', {
      expression: `(() => { const els=[...document.querySelectorAll('*')].filter(e=>e.innerText && e.innerText.trim()===${JSON.stringify(text)} && e.children.length===0); if(els.length){ els[0].click(); return 'clicked: '+els[0].tagName; } return 'NOT FOUND'; })()`,
      returnByValue: true
    });
    console.log(r.result && r.result.value);
    return;
  }

  if (cmd === 'clickxy') {
    const x = Number(rest[0]), y = Number(rest[1]);
    if (!Number.isFinite(x) || !Number.isFinite(y)) { console.error('usage: clickxy <x> <y>'); return; }
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
    await cdp.call('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
    console.log('clicked ' + x + ',' + y);
    return;
  }

  if (cmd === 'shot') {
    const file = rest[0] || 'xiyou.png';
    const r = await cdp.call('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
    console.log('saved ' + file);
    return;
  }

  console.error('unknown command: ' + cmd);
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error('ERROR:', e.message); process.exit(1); });
