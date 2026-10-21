#!/usr/bin/env node
/**
 * 从带调试端口的 Chrome 里取出头歌的 cookie，写成 eduapi.js 能用的 cookies.json。
 *
 *   node get-cookies.js                       # 默认 http://127.0.0.1:9222
 *   node get-cookies.js --port 9333
 *   node get-cookies.js --match educoder.net --out cookies.json
 *
 * 前置：用独立 profile 起一个可见的 Chrome，用户自己登录完，再跑这个。
 *   chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<独立目录>
 *
 * 需要 Node 22+（用到内置 WebSocket）；老版本可 npm i ws 后自动回退。
 */
const fs = require('fs');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const PORT = argOf('port', '9222');
const ENDPOINT = argOf('endpoint', `http://127.0.0.1:${PORT}`);
const MATCH = argOf('match', 'educoder.net');
const OUT = argOf('out', 'cookies.json');

async function getWebSocket() {
  if (typeof WebSocket !== 'undefined') return WebSocket;
  try {
    return require('ws');
  } catch {
    throw new Error('需要 Node 22+ 的内置 WebSocket，或先 npm i ws');
  }
}

async function main() {
  const listRes = await fetch(ENDPOINT + '/json/list').catch(() => {
    throw new Error(`连不上 ${ENDPOINT}，Chrome 起来了吗？端口对吗？`);
  });
  const list = await listRes.json();
  const pages = list.filter((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!pages.length) throw new Error('没有可用的页面 target');

  const page = pages.find((p) => (p.url || '').includes(MATCH)) || pages[0];
  console.log(`使用页面: ${page.title || ''} ${page.url}`);

  const WS = await getWebSocket();
  const ws = new WS(page.webSocketDebuggerUrl);

  const result = await new Promise((resolve, reject) => {
    let seq = 0;
    const pending = new Map();
    ws.onmessage = (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }
      if (msg.id && pending.has(msg.id)) {
        const { res, rej } = pending.get(msg.id);
        pending.delete(msg.id);
        msg.error ? rej(new Error(msg.error.message)) : res(msg.result);
      }
    };
    ws.onerror = () => reject(new Error('WebSocket 连接失败'));
    ws.onopen = async () => {
      const send = (method, params = {}) =>
        new Promise((res, rej) => {
          const id = ++seq;
          pending.set(id, { res, rej });
          ws.send(JSON.stringify({ id, method, params }));
        });
      try {
        await send('Network.enable');
        const ck = await send('Network.getCookies', {
          urls: ['https://www.educoder.net/', 'https://data.educoder.net/'],
        });
        resolve(ck.cookies);
      } catch (e) {
        reject(e);
      }
    };
  });

  ws.close();

  const jar = {};
  for (const c of result) jar[c.name] = c.value;

  if (!jar['_educoder_session']) {
    throw new Error('没取到 _educoder_session —— 用户可能还没登录，或者当前页面不是头歌');
  }
  fs.writeFileSync(OUT, JSON.stringify(jar, null, 1));
  console.log(`已写入 ${OUT}：${Object.keys(jar).join(', ')}`);
  console.log('提醒：cookies.json 等于账号登录态，已在 .gitignore 里，别提交。');
}

main().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
