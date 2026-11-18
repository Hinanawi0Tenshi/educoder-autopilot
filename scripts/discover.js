#!/usr/bin/env node
/**
 * discover.js — 不知道作业链接时，从头找出「哪些作业还没做完」。
 *
 *   node discover.js                       # 我加入的所有进行中课程 + 作业/关卡完成度
 *   node discover.js --course 122599       # 单门课：每份作业的状态、完成度、首关入口 URL
 *   node discover.js --course HSKX7LDL     # 也可以用课程 identifier
 *   node discover.js --url <任务URL>        # 从任意一关的 URL 反推课程/作业并给出全课清单
 *   node discover.js --only-todo           # 只列还没做完的作业
 *   node discover.js --json                # 机器可读输出
 *
 * 依赖同目录 edunet.js（cookie + 签名）。cookie 用 get-cookies.js 取。
 *
 * 链路（全部 GET，都是 data.educoder.net）：
 *   1. /api/users/get_user_info.json?school=1                     -> login（账号名）
 *   2. /api/users/{login}/courses.json?status=processing&...       -> 课程 id 列表
 *   3. /api/courses/{id}.json                                      -> identifier（= /tasks/ 里的课程码）
 *   4. /api/courses/{id}/homework_commons.json                     -> homeworks[]（含完成度、状态、shixun_identifier）
 *   5. /api/shixuns/{shixun_identifier}/shixun_exec.json           -> game_identifier（首关 slug）
 *   => 任务 URL = https://www.educoder.net/tasks/{identifier}/{homework_id}/{game_identifier}
 */
const { api, sleep, WWW } = require('./edunet');

const argv = process.argv.slice(2);
const argOf = (n) => {
  const i = argv.indexOf('--' + n);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (n) => argv.includes('--' + n);

const JSON_OUT = flag('json');
const ONLY_TODO = flag('only-todo');
const COURSE_ARG = argOf('course');
const URL_ARG = argOf('url');

const widthOf = (s) => [...String(s)].reduce((a, c) => a + (c.charCodeAt(0) > 255 ? 2 : 1), 0);
const pad = (s, n) => String(s) + ' '.repeat(Math.max(0, n - widthOf(s)));
const cut = (s, w) => {
  let out = '';
  let acc = 0;
  for (const ch of String(s)) {
    const cw = ch.charCodeAt(0) > 255 ? 2 : 1;
    if (acc + cw > w) break;
    out += ch;
    acc += cw;
  }
  return out;
};

async function whoami() {
  const u = await api('/api/users/get_user_info.json?school=1');
  return { login: u.login, name: u.real_name || u.username, id: u.user_id };
}

async function listCourses(login) {
  const q = new URLSearchParams({
    category: '',
    status: 'processing',
    page: '1',
    per_page: '50',
    sort_by: 'updated_at',
    sort_direction: 'desc',
    username: login,
  });
  const r = await api(`/api/users/${login}/courses.json?${q}`);
  return r.courses || [];
}

async function courseDetail(idOrIdentifier) {
  let id = idOrIdentifier;
  if (!/^\d+$/.test(String(id))) {
    // 给的是 identifier，先反查 id
    const me = await whoami();
    const cs = await listCourses(me.login);
    const hit = cs.find((c) => c.first_category_url && c.first_category_url.includes(`/classrooms/${idOrIdentifier}/`));
    if (!hit) throw new Error(`在「进行中课程」里没找到 identifier=${idOrIdentifier}`);
    id = hit.id;
  }
  const c = await api(`/api/courses/${id}.json`);
  const hw = await api(`/api/courses/${id}/homework_commons.json?page=1&per_page=100`);
  const homeworks = [];
  for (const h of hw.homeworks || []) {
    const todo = (h.challenge_count || 0) - (h.finished_challenge_count || 0);
    homeworks.push({
      homework_id: h.homework_id,
      name: h.name,
      status: (h.status || []).join('/'),
      challenges: `${h.finished_challenge_count}/${h.challenge_count}`,
      todo,
      end_time: h.end_time || null,
      late_time: h.late_time || null,
      status_time: h.status_time || '',
      shixun_identifier: h.shixun_identifier,
      // 首关 slug 只为没做完的作业取（要额外一次请求）
      first_game: todo > 0 && h.challenge_count > 0 ? await firstGame(h.shixun_identifier) : null,
    });
  }
  return {
    id,
    identifier: c.identifier,
    name: c.name,
    school: c.school,
    over: {
      challenge: `${hw.finished_challenge_count}/${hw.challenge_count}`,
      task: `${hw.finished_task_count}/${hw.task_count}`,
    },
    homeworks,
  };
}

const gameCache = new Map();
async function firstGame(shixun) {
  if (!shixun) return null;
  if (gameCache.has(shixun)) return gameCache.get(shixun);
  try {
    const r = await api(`/api/shixuns/${shixun}/shixun_exec.json`);
    gameCache.set(shixun, r.game_identifier || null);
    await sleep(150);
    return r.game_identifier || null;
  } catch {
    gameCache.set(shixun, null);
    return null;
  }
}

function taskUrl(course, hw) {
  if (!hw.first_game) return '';
  return `${WWW}/tasks/${course.identifier}/${hw.homework_id}/${hw.first_game}`;
}

async function main() {
  if (URL_ARG) {
    // 从任务 URL 反推：/tasks/{identifier}/{hwid}/{slug}
    const m = String(URL_ARG).match(/\/tasks\/([^/?#]+)\/(\d+)\//);
    if (!m) throw new Error('URL 里没有 /tasks/<课程码>/<作业ID>/，解析不到');
    const d = await courseDetail(m[1]);
    const hw = d.homeworks.find((h) => String(h.homework_id) === m[2]);
    return printCourses([d], hw ? [hw.homework_id] : []);
  }

  const me = await whoami();
  if (COURSE_ARG) {
    const d = await courseDetail(COURSE_ARG);
    return printCourses([d], null, true);
  }

  const cs = await listCourses(me.login);
  const details = [];
  for (const c of cs) {
    const d = await courseDetail(c.id);
    details.push(d);
    await sleep(200);
  }
  if (!JSON_OUT) console.log(`账号：${me.name}（${me.login}），进行中课程 ${details.length} 门\n`);
  printCourses(details);
}

function printCourses(list, focusHwIds, verbose) {
  if (JSON_OUT) {
    const out = list.map((d) => ({
      ...d,
      homeworks: ONLY_TODO ? d.homeworks.filter((h) => h.todo > 0) : d.homeworks,
    }));
    console.log(JSON.stringify(out, null, 1));
    return;
  }

  for (const d of list) {
    const todoHw = d.homeworks.filter((h) => h.todo > 0);
    console.log(`■ ${d.name}  [${d.identifier}]  id=${d.id}  ${d.school || ''}`);
    console.log(`  关卡 ${d.over.challenge}   作业 ${d.over.task}   未完成作业 ${todoHw.length} 份`);
    console.log(
      '  ' + pad('作业', 34) + pad('状态', 12) + pad('关卡', 8) + pad('未做', 6) + '最晚提交'
    );
    for (const h of d.homeworks) {
      if (ONLY_TODO && h.todo === 0) continue;
      const mark = h.todo > 0 ? ' *' : '  ';
      console.log(
        mark +
          pad(cut(h.name, 32), 34) +
          pad(h.status, 12) +
          pad(h.challenges, 8) +
          pad(h.todo || '-', 6) +
          (h.late_time || h.end_time || '-')
      );
      const focus = (focusHwIds && focusHwIds.includes(h.homework_id)) || verbose;
      if (focus && h.todo > 0) {
        console.log('    首关: ' + (taskUrl(d, h) || '(取不到，可能未开放)'));
        console.log(`    walk: node eduapi.js walk "${taskUrl(d, h)}"`);
      }
    }
    console.log('');
  }
  console.log('（* = 有未完成关卡；已截止但接口仍可提交的情况见 references/discover.md）');
}

main().catch((e) => {
  console.error('ERROR: ' + e.message);
  process.exit(1);
});
