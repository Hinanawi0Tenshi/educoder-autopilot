#!/usr/bin/env node
/**
 * edunet.js — 头歌接口共用的底层客户端（cookie + 签名 + 请求）
 * eduapi.js / discover.js 都从这里取，AK/SK 只在这一处维护。
 *
 * 环境变量：
 *   EDU_COOKIES  cookie 文件路径，默认 scripts/cookies.json
 *   EDU_COOKIE   直接给 "k=v; k=v"（优先于文件）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://data.educoder.net';
const WWW = 'https://www.educoder.net';
const COOKIE_FILE = process.env.EDU_COOKIES || path.join(__dirname, 'cookies.json');

// 前端 umi bundle 里的签名密钥（getKey = atob(atob(x))）。
// 换版本失效时按 references/api.md「密钥重新提取」一节重取。
const AK = 'e9dd5b4322f9f7d83d009de9bfa100c3';
const SK = '2e3da06ae26ba9f76a5d8d355746f2fe';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (s) => crypto.createHash('md5').update(s).digest('hex');

function cookieMap() {
  if (process.env.EDU_COOKIE) {
    const o = {};
    for (const part of process.env.EDU_COOKIE.split(';')) {
      const i = part.indexOf('=');
      if (i > 0) o[part.slice(0, i).trim()] = part.slice(i + 1).trim();
    }
    return o;
  }
  if (!fs.existsSync(COOKIE_FILE)) {
    throw new Error(`缺少 ${COOKIE_FILE}：先跑 node get-cookies.js，或设 EDU_COOKIE="k=v; k=v"`);
  }
  return JSON.parse(fs.readFileSync(COOKIE_FILE, 'utf8'));
}

function cookieHeader() {
  return Object.entries(cookieMap()).map(([k, v]) => `${k}=${v}`).join('; ');
}

/**
 * 本机时钟与服务器的时间差（毫秒）。沙箱/虚拟机时钟会飘，
 * 飘超过阈值服务端就返 -102「服务器时间与您的设备时间不匹配」。
 * 优先用 EDU_TIME_OFFSET_MS，其次用探测到的值。
 */
let clockOffset = Number(process.env.EDU_TIME_OFFSET_MS || 0);

function setClockOffset(ms) {
  clockOffset = Number(ms) || 0;
}

/** 用响应头 date 估算服务器当前时间，返回 offset = serverNow - localNow */
async function probeClockOffset() {
  const res = await fetch(BASE + '/api/setting.json', {
    headers: { Accept: 'application/json', 'User-Agent': 'Mozilla/5.0' },
  }).catch(() => null);
  const dh = res && res.headers.get('date');
  if (!dh) return 0;
  const server = Date.parse(dh);
  if (Number.isNaN(server)) return 0;
  return server - Date.now();
}

/**
 * 复刻前端的 X-EDU-Signature：
 *   n   = "method=M&ak=<AK>&sk=<SK>&time=<ms>"
 *   sig = md5( base64(n) )
 * 签名只跟 method 和时间戳有关，跟 URL 无关。
 */
function signHeaders(method) {
  const t = Date.now() + clockOffset;
  const n = `method=${String(method).toUpperCase()}&ak=${AK}&sk=${SK}&time=${t}`;
  const sig = md5(Buffer.from(n, 'utf8').toString('base64'));
  const jar = cookieMap();
  return {
    'X-EDU-Type': 'pc',
    'X-EDU-Timestamp': String(t),
    'X-EDU-Signature': sig,
    'Pc-Authorization': jar['_educoder_session'] || '',
    'X-Original-Protocol': 'https:',
    'X-Original-Origin': WWW,
    'X-Original-Host': 'www.educoder.net',
    'X-Request-Id': crypto.randomUUID(),
  };
}

async function api(p, opts = {}) {
  const url = p.startsWith('http') ? p : BASE + p;
  const method = opts.method || (opts.body !== undefined ? 'POST' : 'GET');

  const doFetch = async () => {
    const headers = {
      Cookie: cookieHeader(),
      Accept: 'application/json, text/plain, */*',
      Referer: WWW + '/',
      'User-Agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
      'X-Requested-With': 'XMLHttpRequest',
      ...signHeaders(method),
    };
    if (opts.body !== undefined) headers['Content-Type'] = 'application/json; charset=utf-8';
    const res = await fetch(url, {
      method,
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = JSON.parse(text);
    } catch {
      throw new Error(`非 JSON 响应 ${res.status}: ${text.slice(0, 200)}`);
    }
    return { res, json };
  };

  let { res, json } = await doFetch();

  // -102 = 时间戳与服务器差太多：探一次服务器时间，纠正后重试一次
  if (json && json.status === -102 && !opts._clockRetried) {
    const off = await probeClockOffset();
    if (off) {
      setClockOffset(off);
      ({ res, json } = await doFetch());
    }
  }
  if (json.status === -102) {
    throw new Error('签名被拒（-102）：本机时钟与服务器偏差过大，已尝试自动校正仍失败，请检查系统时间');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text}`);
  return json;
}

/** /tasks/{course}/{homework_common_id}/{task_slug} */
function parseTaskUrl(u) {
  const m = String(u).match(/\/tasks\/([^/?#]+)\/([^/?#]+)\/([^/?#]+)/);
  if (!m) throw new Error('无法解析任务 URL（形如 https://www.educoder.net/tasks/<course>/<hwid>/<slug>）: ' + u);
  return { course: m[1], hwid: m[2], slug: m[3] };
}

/** 题面里的路径偶尔带全角标点，清掉 */
const cleanPath = (p) => String(p).replace(/[，,；;\s]+$/, '').trim();

module.exports = {
  BASE, WWW, COOKIE_FILE, AK, SK,
  sleep, md5, cookieMap, cookieHeader, signHeaders, api, parseTaskUrl, cleanPath,
  setClockOffset, probeClockOffset,
};
