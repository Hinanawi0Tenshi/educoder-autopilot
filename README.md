# educoder-autopilot · 头歌作业自动驾驶

给 AI agent 用的 skill：把头歌（educoder）实验的关卡一关一关做穿。

两种执行模式，同一套判断逻辑：

| | **接口模式**（默认） | **界面模式**（兜底） |
|---|---|---|
| 怎么走 | cookie + 签名头直接调 REST | 接管浏览器，点页面 |
| 速度 | 一关 3~5 秒 | 一关 20~60 秒 |
| 稳定性 | 高，只依赖签名密钥 | 中，依赖 DOM 与文案 |
| 读图 | 下载原图后多模态读 | 截图读 |
| 浏览器 | 只在登录取 cookie 时开一次 | 全程需要 |
| 适用 | 代码题、选择题与判断题 | 文件上传、复杂图形化、接口改版 |

先试接口，接口不可用再退界面。两边拿到的判定信息等价：**通过 / 不通过 + 预期输出 vs 实际输出**。

> **脚本只到平台层，不含任何课程数据。** 每门课的表结构、字段、判分点都不同，
> 写死课程内容换课就废——所以 `scripts/` 里是通用接口客户端与 cookie 抓取，
> 具体答案由 agent 现场读题写出。

## 闭环

```
取题（下一道未通过的）→ 读文字 + 读配图 → 读编辑器已有框架 → 填答案
      ↑                                                          ↓
      │                                                      提交评测
      │                                                          ↓
      └── 改 ← 读差异：左预期输出 vs 右实际输出 ←────────── 未通过
                                                                 ↓
                                                          通过 → 下一关 / 完成
```

关键在于第 2 步和第 7 步——这两步决定了你是"三关过一关"还是"一次过"：

- **读题必须看图**。ER 图、表结构图、示例结果截图常常是字段名和数据取值的唯一来源。
- **失败必须读差异**。左边是预期、右边是实际，差异形态直接指向病因（列名？排序？聚合粒度？），
  比盲改快一个数量级。

## 安装

```bash
git clone <this-repo> ~/.claude/skills/educoder-autopilot
# 或把目录拷进 ~/.claude/skills/ 或项目的 .claude/skills/
```

接口模式需要 Node 22+（内置 `fetch` / `WebSocket`），不需要 `npm install`。

## 怎么用

**接口模式（快）**

```bash
# 1. 起一个带调试端口、独立 profile 的可见 Chrome，你自己登录
chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=./chrome-profile

# 2. 取登录态（之后浏览器可以关掉）
node scripts/get-cookies.js            # -> cookies.json

# 3. 纯命令行做题
node scripts/eduapi.js list   <任务URL>              # 全部关卡 + 通过状态
node scripts/eduapi.js walk   <任务URL>              # 下一道未通过的题：正文 + 图片 + 现有框架
node scripts/eduapi.js submit <任务URL> answer.sql   # 提交代码并拿回 预期/实际 差异
node scripts/eduapi.js choose <任务URL> BC C         # 提交选择题答案直接判分（多选/单选）
```

`submit` 退出码：`0` 通过、`3` 未通过（附差异）、`1` 出错。

对 agent 说：

- "用 educoder-autopilot 把这个实验刷完：<任务链接>"
- "从头歌任务链接开始，做到最后一关，已完成的跳过"

**界面模式**：不给 cookie、或接口不通时，agent 会起一个**可见 Chrome**，等你登录完，
然后按主循环点页面。登录永远由你自己完成——它不读密码、不点验证码、不存凭据。

## 文件

| 文件 | 内容 |
|---|---|
| `SKILL.md` | 两种模式的取舍 + 主循环八步 + 差异对照表 + 纪律与反模式 |
| `scripts/eduapi.js` | 接口客户端：`list` / `walk` / `submit` / `choose` / `code` / `task` / `img` |
| `scripts/get-cookies.js` | 从带调试端口的 Chrome 取 cookie |
| `references/api.md` | 接口清单、签名算法、密钥失效后的重取步骤、字段与限制 |
| `references/platform.md` | 头歌页面结构、文案表、Monaco 用法、判题语义（实测值，会随改版失效） |
| `references/pitfalls.md` | 按症状排错，含"平台改版了怎么找回来" |

## 隐私与安全

- **登录态在 Chrome profile 目录和 `cookies.json` 里，那等于你的账号。**
  两者都已在 `.gitignore` 中，不要提交、不要打包外发。
- 不要指向你日常使用的 Chrome 用户目录，务必用独立 profile。
- **截图会带真实身份**：判题页右上角通常有姓名、班级、分数，存证截图不要进公开仓库。
- 调试端口默认只监听 `127.0.0.1`；不要加 `--remote-debugging-address=0.0.0.0`。
- 接口模式下的学号参数（`zzud`）是可选的，本客户端不发送它——少一处泄露面。

## 适用范围与限制

- 面向代码题与选择题关卡。文件上传、复杂图形化关卡走界面模式。
- **接口签名密钥硬编码在前端 bundle 里，平台发版可能变**；变了解析步骤见 `references/api.md`。
- **每次提交都消耗一次评测配额**，课程可能设上限——想清楚再提交，别连点。
- 文案表与 DOM 结构硬绑头歌当前版本，改版后需按 `references/pitfalls.md` 的 I 节找回来。
- 不做自动化登录，也不应该做。

## License

MIT
