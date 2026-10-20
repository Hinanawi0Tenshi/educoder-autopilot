# 排错手册

按症状查。每条都写明"是平台行为"还是"是你的问题"，避免把环境故障当成代码错。

## A. Chrome 起不来（CDP 端口没开）

**症状**：进程秒退，日志里

```
crashpad_client_win.cc:430 OpenProcess: 拒绝访问 (0x5)
crash server failed to launch, self-terminating
```

`--user-data-dir` 目录一直是空的，`DevToolsActivePort` 不生成。

**原因**：Chrome 从受限沙箱 / 受管进程里被拉起，crashpad 打不开自己的子进程。
`--disable-breakpad --disable-crash-reporter` 都压不住。

**处理**：在沙箱外重新拉一次。CDP 一旦起来，后续所有命令都不再需要额外权限——它们只是 websocket 客户端。

**备用**：手动双击 Chrome，或从普通终端执行

```bash
chrome --remote-debugging-port=9222 --remote-allow-origins=* --user-data-dir=<独立目录> <url>
```

## B. websocket 连不上

```
websocket error connecting to ws://127.0.0.1:9222/devtools/page/...
```

- 缺 `--remote-allow-origins=*`（Chrome 111+ 对 Origin 做校验）。
- 或端口被上一次的 Chrome 占着、但那个实例没开调试端口 → 全部退掉后重启。

自检：

```bash
curl http://127.0.0.1:9222/json/version
```

## C. 选错标签页

多个标签时"取第一个 page"会打到错的页面。先列 target（拿 id / url），
再用 URL 片段或 target id 精确锁定，不要靠顺序。

## D. 评测没有判定

| 面板文案 | 含义 | 处理 |
|---|---|---|
| `服务启动中` | 环境冷启动，第一次点击被吞 | 等它消失后再点一次「评测」 |
| `0/1 启动环境失败，请稍后重试` | 平台侧环境挂了 | 原样重跑，通常第二次就过；连续 3 次再怀疑代码 |
| 只有 `测试集1`、无对勾无耗时 | 还没跑完 | 再等 4–8 秒 |
| `1/1 全部通过` 但代码区空了 | 弹窗渲染重置了 Monaco 模型 | 以判定为准，别以代码区为准 |

## E. 读不到题目

读到的内容是"您好，我是您的 AI Coding 助教…" → 当前停在「实验助教」标签。
**每次 URL 变化后都要重新点一次「学习内容」**，这一步漏掉是最常见的失误。

## F. 截图超时

```
ERROR: timeout: Page.captureScreenshot
```

页面在做重排或长任务。等 2–3 秒重试；仍失败就用 innerText 代替肉眼。
注意：题面配图只能靠截图读，所以 F 没解决就别急着写代码。

## G. 点击没反应

- 类名是哈希，改版即失效 → **一律按文案匹配**。
- 弹窗遮挡时 `element.click()` 仍生效（不走命中测试），但按坐标发鼠标事件会点到遮罩上 → 优先用 JS 点击。
- 弹窗里的「下一关」「完成」是 `<a>` 但无 `href` → 只能 JS 点击，不能靠跳转。
- 底部栏的「下一关」和弹窗里的「下一关」**可能指向不同 URL** → 优先用带 `href` 的那个。

## H. 判定通过但关卡没算

判题通过 ≠ 关卡记录。确认关卡标题旁出现 `100` 徽标，或再读一次状态；
必要时点一次「完成」收尾。

## I. 平台改版了

文案表对不上时，不要硬编码新类名救急，按这个顺序找回来：

1. 用 innerText 把可见按钮文案全打出来，看「评测 / 下一关 / 学习内容」被改成了什么。
2. 用标签名 + 文案模糊匹配（`contains` 而不是全等）兜住细微措辞变化。
3. 编辑器若不再是 Monaco，改读 `textarea.value` 或 `contenteditable` 的 innerText，
   写回时优先找框架暴露的实例（Vue/React 的 `__vue__`、`__reactProps`）而不是改 DOM。
4. 判题结果改为按"出现对勾图标 / 出现『未通过』"两种信号判定，别只依赖一句文案。
