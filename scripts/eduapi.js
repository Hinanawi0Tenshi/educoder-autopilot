#!/usr/bin/env node
/**
 * 头歌（educoder）纯接口客户端 —— 不打开浏览器，只用 cookie + 签名头。
 *
 *   node get-cookies.js                      # 从带调试端口的 Chrome 里取 cookie -> cookies.json
 *   node eduapi.js list   <任务URL>           # 全部关卡 + 通过状态（顺着 next_game 走一遍）
 *   node eduapi.js walk   <任务URL>           # 下一道未通过的题：正文 + 图片 + 现有代码框架
 *   node eduapi.js task   <任务URL>           # 指定关卡的完整信息
 *   node eduapi.js img    <任务URL> [目录]     # 把题面配图下载到本地（读图用）
 *   node eduapi.js submit <任务URL> <代码文件|->   # 保存 -> 评测 -> 轮询 -> 打印预期/实际差异
 *   node eduapi.js choose <任务URL> <答案1> [答案2 ...] # 提交选择题/判断题直接判分
 *
 * 环境变量：
 *   EDU_COOKIES   cookie 文件路径，默认 ./cookies.json
 *   EDU_COOKIE    直接给 cookie 串 "k=v; k=v"（优先于文件）
 *   EDU_TIMEOUT   评测轮询上限秒数，默认 120
 *
 * 需要 Node 18+（只用内置 fetch / crypto / fs）。
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const BASE = 'https://data.educoder.net';
const WWW = 'https://www.educoder.net';
const COOKIE_FILE = process.env.EDU_COOKIES || path.join(__dirname, 'cookies.json');
const TIMEOUT = Number(process.env.EDU_TIMEOUT || 120);

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
 * 复刻前端的 X-EDU-Signature：
 *   n   = "method=M&ak=<AK>&sk=<SK>&time=<ms>"
 *   sig = md5( base64(n) )
 * 签名只跟 method 和时间戳有关，跟 URL 无关。
 */
function signHeaders(method) {
  const t = Date.now();
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
  if (json.status === -102) {
    throw new Error('签名被拒（-102）：AK/SK 已过期，按 references/api.md 重新提取');
  }
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${text.slice(0, 200)}`);
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

const OPTION_LETTERS = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', 'K', 'L', 'M', 'N'];

async function fetchTask(url) {
  const { course, hwid, slug } = parseTaskUrl(url);
  const t = await api(`/api/tasks/${slug}.json?homework_common_id=${hwid}`);
  if (!t.challenge) throw new Error('任务响应异常: ' + JSON.stringify(t).slice(0, 300));
  const filePath = cleanPath(t.challenge.path);
  let code = '';
  if (filePath && filePath !== 'null') {
    try {
      const rep = await api(
        `/api/tasks/${slug}/rep_content.json?path=${encodeURIComponent(filePath)}&homework_common_id=${hwid}&exercise_id=`
      );
      code = Buffer.from(rep.content.content, 'base64').toString('utf8');
    } catch (e) {
      code = `__读代码失败__ ${e.message}`;
    }
  }
  const md = String(t.challenge.task_pass || '');
  const images = [...md.matchAll(/!\[[^\]]*\]\(([^)]+)\)/g)]
    .map((m) => m[1])
    .filter((u) => u && !u.startsWith('data:'))
    .map((u) => (u.startsWith('http') ? u : WWW + u));
  return { course, hwid, slug, t, filePath, code, images };
}

function view(x) {
  const { t, slug, filePath, code, images } = x;
  const chooses =
    Array.isArray(t.chooses) && t.chooses.length > 0
      ? t.chooses.map((c) => ({
          position: c.position,
          category: c.category === 1 ? '单选题' : c.category === 2 ? '多选题' : c.question_name || String(c.category),
          subject: c.subject,
          options: (c.challenge_question || []).map((o, idx) => ({
            label: OPTION_LETTERS[idx] || String(idx),
            option_name: o.option_name,
          })),
        }))
      : undefined;

  return {
    slug,
    subject: t.challenge.subject,
    position: t.challenge.position,
    total_levels: t.game_count,
    score: t.game && t.game.final_score,
    status: t.game && t.game.status,
    path: filePath,
    time_limit: t.challenge.exec_time,
    next_game: t.next_game,
    is_last: t.is_last_game,
    task_markdown: t.challenge.task_pass,
    images,
    ...(chooses ? { chooses } : {}),
    code,
  };
}

/** 顺着 next_game 把整条关卡链走一遍 */
async function listLevels(startUrl) {
  const { course, hwid } = parseTaskUrl(startUrl);
  let slug = parseTaskUrl(startUrl).slug;
  const rows = [];
  for (let i = 0; i < 300; i++) {
    const t = await api(`/api/tasks/${slug}.json?homework_common_id=${hwid}`);
    if (!t.challenge) break;
    const need = t.challenge.score || 100;
    rows.push({
      position: t.challenge.position,
      slug,
      subject: t.challenge.subject,
      score: t.game && t.game.final_score,
      passed: !!(t.game && t.game.final_score >= need),
      url: `${WWW}/tasks/${course}/${hwid}/${slug}`,
    });
    if (!t.next_game || t.is_last_game) break;
    slug = t.next_game;
    await sleep(250);
  }
  return rows;
}

/** 保存代码 -> 触发评测 -> 轮询结果 */
async function submit(taskUrl, codeText) {
  const { hwid, slug } = parseTaskUrl(taskUrl);
  const t = await api(`/api/tasks/${slug}.json?homework_common_id=${hwid}`);
  if (!t.challenge) throw new Error('任务响应异常: ' + JSON.stringify(t).slice(0, 300));
  const filePath = cleanPath(t.challenge.path);
  const envId =
    t.shixun.evaluate_scirpt_env_id ||
    (t.shixun_environments && t.shixun_environments[0] && t.shixun_environments[0].shixun_environment_id);
  const extrasBase = {
    exercise_id: '',
    question_id: '',
    challenge_id: t.challenge.id,
    subject_id: '',
    smart_plan_page_item_bank_id: '',
    homework_common_id: hwid,
    competition_entry_id: '',
    currentUserId: t.game.user_id,
  };

  // 1) 保存文件
  const up = await api(`/api/myshixuns/${t.game.myshixun_id}/update_file.json`, {
    body: {
      path: filePath,
      evaluate: 1,
      content: codeText,
      game_id: t.game.id,
      tab_type: 1,
      exercise_id: null,
      homework_common_id: hwid,
      extras: extrasBase,
    },
  });
  if (!up || !up.sec_key) throw new Error('保存失败: ' + JSON.stringify(up).slice(0, 300));

  // 2) 触发评测
  const build = await api(`/api/tasks/${slug}/game_build.json`, {
    body: {
      sec_key: up.sec_key,
      resubmit: up.resubmit,
      first: 1,
      content_modified: 0,
      shixun_environment_id: envId,
      tab_type: 1,
      extras: { ...extrasBase, commitID: up.content.commitID },
    },
  });
  if (build.status !== 1) throw new Error('评测被拒: ' + JSON.stringify(build).slice(0, 400));

  // 3) 轮询
  const qs = new URLSearchParams({
    resubmit: up.resubmit,
    time_out: 'false',
    port: '0',
    sec_key: up.sec_key,
    challenge_id: String(t.challenge.id),
    subject_id: '',
    homework_common_id: hwid,
  });
  const deadline = Date.now() + TIMEOUT * 1000;
  let last = null;
  while (Date.now() < deadline) {
    const st = await api(`/api/tasks/${slug}/game_status.json?${qs}`);
    last = st;
    if (st.status === 2 || Array.isArray(st.test_sets)) break;
    await sleep(1200);
  }
  if (!last || !Array.isArray(last.test_sets)) return { ok: false, phase: 'timeout', last };

  const sets = last.test_sets.map((s) => ({
    result: s.result,
    expected: s.output,
    actual: s.actual_output,
    compile_success: s.compile_success,
    matchRule: s.matchRule,
    time: s.ts_time,
    mem: s.ts_mem,
  }));
  return {
    ok: sets.every((s) => s.result === true) && last.sets_error_count === 0,
    status: last.status,
    grade: last.grade,
    test_sets_count: last.test_sets_count,
    sets_error_count: last.sets_error_count,
    compile_output: last.last_compile_output,
    next_game: last.next_game,
    sets,
  };
}

/** 提交选择题答案并直接评测（POST /api/tasks/{slug}/choose_build.json） */
async function submitChooses(taskUrl, answers) {
  const { hwid, slug } = parseTaskUrl(taskUrl);
  const t = await api(`/api/tasks/${slug}.json?homework_common_id=${hwid}`);
  if (!t.challenge) throw new Error('任务响应异常: ' + JSON.stringify(t).slice(0, 300));

  let formattedAnswers = [];
  if (answers.length === 1 && (answers[0].startsWith('[') || answers[0].startsWith('{'))) {
    try {
      const parsed = JSON.parse(answers[0]);
      formattedAnswers = Array.isArray(parsed) ? parsed : Object.values(parsed);
    } catch {
      formattedAnswers = answers;
    }
  } else {
    formattedAnswers = answers;
  }

  const res = await api(`/api/tasks/${slug}/choose_build.json`, {
    body: {
      answer: formattedAnswers,
      challenge_id: t.challenge.id,
      subject_id: '',
      homework_common_id: hwid,
    },
  });

  const passed = res.game_original_status === 2 || res.gold > 0 || res.experience > 0;
  return {
    ok: passed,
    status: res.game_original_status,
    score: t.challenge.score,
    grade: res.grade,
    gold: res.gold,
    experience: res.experience,
    challenge_chooses_count: res.challenge_chooses_count,
    test_sets: res.test_sets,
    next_game: res.next_game,
  };
}

/** 下载题面配图（带 cookie，附件需要登录态） */
async function downloadImages(taskUrl, outDir) {
  const x = await fetchTask(taskUrl);
  const dir = outDir || path.join(process.cwd(), 'task-images', x.slug);
  fs.mkdirSync(dir, { recursive: true });
  const saved = [];
  for (let i = 0; i < x.images.length; i++) {
    const u = x.images[i];
    const r = await fetch(u, { headers: { Cookie: cookieHeader(), Referer: WWW + '/' } });
    if (!r.ok) {
      saved.push({ url: u, error: 'HTTP ' + r.status });
      continue;
    }
    const buf = Buffer.from(await r.arrayBuffer());
    const ct = r.headers.get('content-type') || '';
    const ext = ct.includes('png') ? 'png' : ct.includes('jpeg') || ct.includes('jpg') ? 'jpg' : ct.includes('gif') ? 'gif' : 'bin';
    const file = path.join(dir, `${String(i + 1).padStart(2, '0')}-${u.split('/').pop().slice(0, 16)}.${ext}`);
    fs.writeFileSync(file, buf);
    saved.push({ url: u, file, bytes: buf.length, type: ct });
  }
  return { dir, images: saved };
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const usage = `usage: node eduapi.js <list|walk|task|code|img|next|submit|choose> <任务URL> [参数]`;

  if (cmd === 'list') {
    const rows = await listLevels(rest[0]);
    console.log(JSON.stringify({ total: rows.length, passed: rows.filter((r) => r.passed).length, rows }, null, 1));
  } else if (cmd === 'walk') {
    const rows = await listLevels(rest[0]);
    const todo = rows.find((r) => !r.passed);
    if (!todo) return console.log(JSON.stringify({ done: true, total: rows.length }, null, 1));
    const x = await fetchTask(todo.url);
    console.log(
      JSON.stringify({ done: false, remaining: rows.filter((r) => !r.passed).length, ...view(x) }, null, 1)
    );
  } else if (cmd === 'task') {
    console.log(JSON.stringify(view(await fetchTask(rest[0])), null, 1));
  } else if (cmd === 'code') {
    console.log((await fetchTask(rest[0])).code);
  } else if (cmd === 'next') {
    console.log((await fetchTask(rest[0])).t.next_game || '');
  } else if (cmd === 'img') {
    console.log(JSON.stringify(await downloadImages(rest[0], rest[1]), null, 1));
  } else if (cmd === 'submit') {
    const src = rest[1];
    if (!src) return console.error(usage);
    const codeText = src === '-' ? fs.readFileSync(0, 'utf8') : fs.readFileSync(src, 'utf8');
    const r = await submit(rest[0], codeText);
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 3);
  } else if (cmd === 'choose') {
    const answers = rest.slice(1);
    if (answers.length === 0) {
      console.error(`usage: node eduapi.js choose <任务URL> <答案1> [答案2 ...]`);
      process.exit(2);
    }
    const r = await submitChooses(rest[0], answers);
    console.log(JSON.stringify(r, null, 1));
    process.exit(r.ok ? 0 : 3);
  } else {
    console.error(usage);
    process.exit(2);
  }
}

main().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
