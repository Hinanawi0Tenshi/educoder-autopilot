# 不知道作业链接时，怎么找出未完成的作业

用户常常只给一句"把数据库作业做完"，不给 URL。**不要问他要链接**——头歌的课程 / 作业 / 关卡
是一条可以纯接口走通的链，五个 GET 就能从账号名走到具体某一关。

```bash
node scripts/discover.js                       # 我加入的所有进行中课程 + 每份作业的完成度
node scripts/discover.js --course 122599       # 单门课：未完成作业的首关 URL 直接给出来
node scripts/discover.js --course HSKX7LDL     # 课程 identifier 也行
node scripts/discover.js --url <任意一关URL>    # 反推课程，给出全课清单
node scripts/discover.js --only-todo           # 只列没做完的
```

输出里 `*` 标记的就是有未完成关卡的作业，后面直接跟 `eduapi.js walk` 的命令，复制即用。

---

## 五步链路

全部 `GET`，都在 `data.educoder.net`（不是 `www`），带同一套 cookie + 签名头。

| # | 接口 | 拿到什么 |
|---|---|---|
| 1 | `/api/users/get_user_info.json?school=1` | `login`（账号名，如 `sztu202400203020`）、`user_id`、`real_name` |
| 2 | `/api/users/{login}/courses.json?category=&status=processing&page=1&per_page=50&sort_by=updated_at&sort_direction=desc&username={login}` | `courses[]`：`id`（数字）、`name`、`homework_commons_count` |
| 3 | `/api/courses/{id}.json` | `identifier` ← **这个才是 `/tasks/` URL 里的课程码**（如 `HSKX7LDL`） |
| 4 | `/api/courses/{id}/homework_commons.json` | `homeworks[]` + 全课汇总计数（见下） |
| 5 | `/api/shixuns/{shixun_identifier}/shixun_exec.json` | `game_identifier` ← 首关 slug |

拼出任务 URL：

```
https://www.educoder.net/tasks/{identifier}/{homework_id}/{game_identifier}
```

拿到这个 URL 之后，`eduapi.js list / walk / submit` 全部接管，`next_game` 会自己串到最后一关。
**每份作业只需要求一次首关 slug，后面的关卡靠 `next_game` 走。**

### 第 4 步的字段（判"做没做完"就看这几个）

`homework_commons.json` 顶层：

| 字段 | 含义 |
|---|---|
| `challenge_count` / `finished_challenge_count` | 全课关卡总数 / 已通过数 —— **最可靠的总进度** |
| `task_count` / `finished_task_count` | 作业份数 / 已全部通过的份数 |
| `all_count` / `published_count` | 含未发布的作业数；`homeworks[]` 只含已发布的 |

`homeworks[]` 每项：

| 字段 | 含义 |
|---|---|
| `homework_id` | `/tasks/` URL 第二段 |
| `name` | 作业名 |
| `status` | 数组，取值如 `已截止` / `补交中` / `未开始` |
| `status_time` | 补交剩余时间文案，如 `补交剩余时间：0 天 6 小时 14 分 ` |
| `challenge_count` / `finished_challenge_count` | 这份作业的关卡数 / 已过数 → **差值就是还要做几关** |
| `shixun_identifier` | 第 5 步的入参 |
| `late_time` | 最晚补交时间，`null` 表示不给补交 |
| `end_time` | 正常截止时间 |

**别用 `status` 判断做完没有**——`已截止` 里既有 20/20 的也有 0/5 的。只看
`finished_challenge_count` 与 `challenge_count` 的差。

---

## 三个坑

### 1. 同一份作业，每个人的 slug 不一样

作业是**按学生 fork 的副本**：同课程同 `homework_id` 的两个账号，题面一致但关卡 slug 完全不同
（实测同一份「实验12」两个号分别是 `lncwz3gfbpka…` 和 `nvahipk6ctfb…`）。

所以**不能照抄别人的任务链接**，也不能把某次的 slug 写死进脚本。只能从自己的账号按上面的链走。

### 2. `can_submit: false` 不代表接口提交不了

`/api/homework_commons/{hwid}.json` 里 `can_submit=false`、`time_status=5`（已截止），
但 `game_build.json` 实测**仍然照常评测并记分**（`can_submit` 大概只管界面按钮）。

遇到「已截止」的作业：先拿一关试提交一次（`l10-probe.sql` 那种原样框架即可），看返回是
`compile_output` 判题结果还是"已截止"错误。判题结果 = 能做，别提前放弃。**只有平台明确拒绝才停。**

### 3. 同一个课程里，不同作业的 MySQL 版本可能不一样

`HSKX7LDL` 的「实验12」是 MySQL 8.0（能用 `WITH`），「实验10」却是 MySQL 5.7。
5.7 上 `WITH` 的报错长这样：

```
ERROR 1064 (42000) at line 3: ... near 'd AS (
```

看到 `WITH` 名字被吃掉（报错停在 CTE 名而不是 `WITH` 本身）就是 5.7，改写成派生表：

```sql
-- 5.7：把每个 CTE 挪成 FROM 后面的子查询
SELECT ...
FROM (SELECT ...) d
LEFT JOIN (SELECT ...) a ON a.dt = d.dt
```

**判断依据不要靠猜**：先看题面有没有"本次实验切换到了 mysql8.0"这句话，没有就按 5.7 写。

---

## 登录态的两个坑（会直接影响 discover）

- `_educoder_session` 是**会话 cookie**，浏览器一关就没了。于是"上一个命令登录成功、
  下一个命令浏览器已经是退出状态"是正常的——`get-cookies.js` 取到的值仍然有效，
  只是要靠 `Network.setCookie` 注回去（`domain=.educoder.net`），别指望 `autologin_trustie` 自动恢复。
- 沙箱环境会在每条命令结束时回收子进程，**Chrome 活不过一次命令调用**。
  凡是需要浏览器的步骤（取 cookie、看渲染图），必须写成"一个脚本里自己拉起 Chrome、
  自己干完、自己收工"，不能 `chrome &` 之后等下一次调用再用。

---

## 实测样例（2026-11，数据库系统2026秋季）

```
■ 数据库系统2026秋季  [HSKX7LDL]  id=122599
  关卡 119/127   作业 8/10   未完成作业 2 份
  实验12 SQL互联网业务查询-2   补交中   0/3   3   2026-11-18 23:30
  实验10 SQL互联网业务查询-1   已截止   0/5   5   2026-11-11 23:59
```

`--course HSKX7LDL` 会直接给出两份作业的首关 URL；按 `walk` 一路做完 8 关后复跑，
变成 `127/127`、`未完成作业 0 份`——**验收就用这一行**。
