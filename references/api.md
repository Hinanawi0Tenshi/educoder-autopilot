# 头歌接口模式（无界面）

不开浏览器、不点按钮，只用 cookie + 一个签名头，直接把题读完、代码提交、结果拿回来。

**这是首选模式**：比界面快一到两个数量级，也不受"冷启动吞点击""类名改版"影响。
界面模式留给它做不了的事——需要看渲染图、文件上传、选择题、图形化关卡。

---

## 1. 先拿 cookie

登录必须由用户自己完成，这一步不可绕过。用独立 profile 起一个**可见**的 Chrome：

```bash
chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<独立目录>
```

用户登录后：

```bash
node scripts/get-cookies.js            # -> cookies.json
```

只需要两个 cookie，都在 `.educoder.net` 域下：

| cookie | 作用 |
|---|---|
| `_educoder_session` | 会话，同时要作为 `Pc-Authorization` 头发出去 |
| `autologin_trustie` | 免登录续期 |

之后浏览器可以关掉，`cookies.json` 失效前都能纯接口跑。

---

## 2. 签名头（唯一的门槛）

不带签名会返回 `{"status":-102,"message":"服务器时间与您的设备时间不匹配，请检查您的设备时间设置并重新加载页面。"}`
——**这不是时间问题**，是缺签名。前端在 umi bundle 里这样算：

```js
let n = "method=" + METHOD.toUpperCase()
      + "&ak=" + getKey(mi)
      + "&sk=" + getKey(hw)
      + "&time=" + Date.now();
headers["X-EDU-Type"]          = "pc";
headers["X-EDU-Timestamp"]     = t;
headers["X-EDU-Signature"]     = md5(btoa(n));
headers["Pc-Authorization"]    = getCookie("_educoder_session");
headers["X-Original-Protocol"] = location.protocol;
headers["X-Original-Origin"]   = "https://www.educoder.net";
headers["X-Original-Host"]     = "www.educoder.net";
```

其中 `getKey = s => atob(atob(s))`（双重 base64 解码），`mi` / `hw` 是 bundle 里的两个常量。
当前值：

```
mi = e9dd5b4322f9f7d83d009de9bfa100c3
hw = 2e3da06ae26ba9f76a5d8d355746f2fe
```

**签名只跟 method 和时间戳有关，跟 URL、body 都无关。** 所以 GET 和 POST 各一个签名，换接口不用重算逻辑。

实测校验（GET，`X-EDU-Timestamp=1700000000000`）：

```
n   = method=GET&ak=e9dd5b4322f9f7d83d009de9bfa100c3&sk=2e3da06ae26ba9f76a5d8d355746f2fe&time=1700000000000
b64 = bWV0aG9kPUdFVCZhaz1lOWRkNWI0MzIyZjlmN2Q4M2QwMDlkZTliZmExMDBjMyZzaz0yZTNkYTA2YWUyNmJhOWY3NmE1ZDhkMzU1NzQ2ZjJmZSZ0aW1lPTE3MDAwMDAwMDAwMDA=
md5 = e279c864e2752591aa53c3989b9fdbeb   ← 与浏览器实际发出的头一致
```

### 密钥重新提取（签名被拒时）

1. 打开任务页，`F12 → Network`，随便挑一个 `data.educoder.net/api/*` 请求，看 `X-EDU-Signature` / `X-EDU-Timestamp`。
2. 取前端主 bundle（页面里 `umi.*.js` 的地址，通常在 `www-cdn.educoder.net`）。
3. 搜 `X-EDU-Signature`，附近就是 `setHeader` 函数；再搜 `mi:function(){return` 或 `const t="` 找到那个导出 `{mi, hw, Bn}` 的模块。
4. 两个常量做双重 base64 解码即得 AK / SK：

```js
const d = (s) => Buffer.from(Buffer.from(s, 'base64').toString(), 'base64').toString();
```

5. 用抓到的真实 timestamp 验算一次 md5 是否对得上，再替换进 `scripts/eduapi.js`。

---

## 3. 五个接口

URL 形如 `https://www.educoder.net/tasks/<course>/<homework_common_id>/<task_slug>`，
下文 `{slug}` = 最后一段，`{hwid}` = 倒数第二段。

| # | 方法与路径 | 作用 |
|---|---|---|
| 1 | `GET /api/tasks/{slug}.json?homework_common_id={hwid}` | 题目正文、图片、代码路径、`next_game`、当前分数 |
| 2 | `GET /api/tasks/{slug}/rep_content.json?path={path}&homework_common_id={hwid}&exercise_id=` | 编辑器里现有代码（base64） |
| 3 | `POST /api/myshixuns/{myshixun_id}/update_file.json` | 保存代码，返回 `sec_key` / `resubmit` / `commitID` |
| 4 | `POST /api/tasks/{slug}/game_build.json` | 触发评测 |
| 5 | `GET /api/tasks/{slug}/game_status.json?resubmit=&sec_key=&challenge_id=&homework_common_id=` | 轮询结果 |

`zzud`（用户学号）这个 query 参数**不是必需的**，可以完全不带——少一处个人信息泄露面。

### 接口 1 的关键字段

```jsonc
{
  "game_count": 17,                 // 总关卡数
  "next_game": "a1b2c3d4e5f6",      // 下一关 slug，串起整条链
  "prev_game": null,
  "is_last_game": false,
  "challenge": {
    "subject": "求各颜色零件的平均重量",
    "task_pass": "### 任务描述\n…![,](/api/attachments/2131388)…",  // 题面 markdown，图在 attachments
    "path": "src/step1/step.sql；",  // 注意可能带全角标点，要清
    "score": 100,
    "exec_time": 20
  },
  "game": { "id": 200000001, "myshixun_id": 30000001, "user_id": 1234567, "final_score": 100, "status": 2 },
  "shixun": { "evaluate_scirpt_env_id": 5000001 },   // 注意是 scirpt，拼写如此
  "shixun_environments": [{ "shixun_environment_id": 5000001 }]
}
```

`final_score >= challenge.score` 即该关已通过。`status == 2` 也是通过态。

### 接口 3 的 body

```jsonc
{
  "path": "src/step1/step.sql",
  "evaluate": 1,
  "content": "<完整代码，含 USE 行与 Begin/End 标记>",
  "game_id": 242652840,
  "tab_type": 1,
  "exercise_id": null,
  "homework_common_id": "123456",
  "extras": { "challenge_id": 4000001, "currentUserId": 1234567, "homework_common_id": "123456", "...": "" }
}
```

响应：`{"content":{"commitID":"…","content":"<base64>","size":148},"resubmit":"1792570226","sec_key":"lz3tkf9brxvy"}`

### 接口 4 的 body

```jsonc
{
  "sec_key": "abc123def456",
  "resubmit": "1700000000",
  "first": 1,
  "content_modified": 0,
  "shixun_environment_id": 5000001,
  "tab_type": 1,
  "extras": { "...": "", "commitID": "0f1e2d3c…", "currentUserId": 1234567 }
}
```

`commitID` 必须用接口 3 返回的那个，否则评的还是旧代码。

### 接口 5 的结果

轮询到 `status === 2` 或出现 `test_sets` 为止（1~3 秒，冷启动更久）。

```jsonc
{
  "status": 2,
  "grade": 1000,
  "test_sets_count": 1,
  "sets_error_count": 0,
  "last_compile_output": "compile successfully",
  "next_game": "a1b2c3d4e5f6",
  "test_sets": [{
    "result": true,
    "output":        "COLOR\tAVG(WEIGHT)\n红\t18.6667\n…",   // 预期输出
    "actual_output": "COLOR\tAVG(WEIGHT)\n红\t18.6667\n…\n",  // 实际输出
    "compile_success": 1,
    "matchRule": "full"
  }]
}
```

失败时（故意提交 `SELECT COLOR FROM P;` 的实测）：

```jsonc
{
  "status": 0, "sets_error_count": 1,
  "last_compile_output": "共有1组测试集，其中有1组测试结果不匹配。详情如下：",
  "test_sets": [{
    "result": false,
    "output": "COLOR\tAVG(WEIGHT)\n红\t18.6667\n绿\t17.0000\n蓝\t27.0000",
    "actual_output": "COLOR\n红\n绿\n蓝\n红\n蓝\n红\n"
  }]
}
```

`output` / `actual_output` 就是「测评结果」面板左右两栏的内容，直接可做差异比对，
不需要再截图读。

### 题面配图

`task_pass` 里的 `![,](/api/attachments/<id>)` 是相对路径，拼上 `https://www.educoder.net`。
**下载要带 cookie**，否则拿不到；带 cookie 返回的是真实图片（`image/png` 等）。

```bash
node scripts/eduapi.js img <任务URL> ./out
```

---

## 4. 与界面模式的取舍

| | 接口模式 | 界面模式 |
|---|---|---|
| 速度 | 一关 3~5 秒 | 一关 20~60 秒（含冷启动） |
| 稳定性 | 高（只依赖签名密钥） | 中（依赖 DOM 与文案） |
| 读图 | 下载后用多模态读，清晰 | 截图读，可能被缩放 |
| 需要浏览器 | 只在登录取 cookie 时 | 全程 |
| 冷启动吞点击 | 无此问题 | 会，要重点两次 |

**默认走接口**。接口失败（签名过期且一时取不到新密钥、平台改接口）再退回界面，
流程见 `SKILL.md` 的界面分支。

---

## 5. 限制与注意

- **每次 `submit` 都消耗一次评测次数**（`game.evaluate_count` 递增）。课程可能设了提交上限
  （`submit_limit` / `submit_limit_num`），**所以先把 SQL 想清楚再提交，不要边写边试**。
- 接口 3 保存的是"当前文件"，会覆盖用户编辑器里的内容。重跑前先 `code` 读一次原框架。
- `game_build` 返回的 `res.wssUrl`（`wss://webssh.educoder.net`）是 WebSSH 用的，
  和判题无关，不用接。
- 判题跑在容器里，`mirror_name` 标明镜像（本课程是 `MySQL`）；换课程镜像不同，
  但接口形态一致。
- 平台发版可能改接口路径或字段。`-102` = 签名问题；`404 页面不存在` = slug 或 hwid 解析错了
  （URL 是三段，别只取两段）；`status: -102` 与 HTTP 404 要分开看。
