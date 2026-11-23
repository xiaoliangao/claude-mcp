# ChatGPT / Gemini Web MCP Bridge

让 Claude Code 通过 MCP 控制**日常 Chrome** 里的网页版 ChatGPT（Pro）和 Gemini：不开第二个 Chrome，不开 9222 调试端口。每个站点维护一个专属标签页，两个站点可同时使用。

## 架构示意

```
Claude Code ──stdio(JSON-RPC)──▶ server/server.mjs ──ws://127.0.0.1:17373──▶ extension/background.js ──chrome.scripting──▶ 每站点一个专属标签页 (content.js)
```

## 主要功能

- **消息发送与长回复后台等待**：支持原样填入并点击发送一次（失败绝不重试），长回复未完成时返回 `wait_command` 供后台等待，期间不占对话、不耗 token。
- **多站点、项目与模型模式切换**：支持打开指定对话、ChatGPT 项目（`g-p-…` 或按侧边栏名字匹配）与 Gemini Gem，并按页面文字切换模型、模式及输入框工具。
- **Gemini 默认 Task 模式**：在 Gemini 新对话中默认自动选中 `Task` 模式并在发消息或传附件前再次确认，同时支持显式指定 `mode` 或通过环境变量修改默认模式。
- **本地附件上传与预览校验**：将本地文件分块 Base64 注入输入框（ChatGPT 走 `input[type=file]`，Gemini 优先粘贴、其次接管文件选择框），确认出现每个文件的预览卡片并等上传完成后再返回。
- **回复文件下载与 Canvas 导出**：支持识别并保存 ChatGPT 行内文件 chip、Gemini 生成文件卡片及展开的预览或 Canvas（可按 Markdown、PDF、Word 等格式导出），自动计算 sha256 并清理 Chrome 下载目录里的当次副本。
- **Deep Research 显式开启保护**：ChatGPT Deep Research 只能通过 `tool: "Deep research"` 显式开启，普通发送默认断言未开启任何工具（否则报 `TOOL_MISMATCH`），避免误耗稀缺额度。
- **隐藏标签页唤醒与切走恢复**：在发消息、传附件及 Gemini 下载文件前按 `on_hidden` 自动处理隐藏标签页，并在专属标签页被手动切到其他对话时以 `PAGE_STALE` 拦截误读写、通过退出码 `4`（`tab_moved`）指引重开原对话取回回复。
- **集中式选择器与在线排查**：将站点选择器集中在 `extension/content.js` 顶部的 `SITE_SELECTORS` 中，配合 `inspect_page` 与 `select_model({ outline: true })` 可直接读取页面 DOM 大纲并在刷新扩展后生效。

## 快速开始

### 1. 安装依赖与验收测试

```bash
cd server && npm install && cd ..
node scripts/init-token.mjs          # 生成 server/.bridge-token 与 extension/config.local.js（均已 gitignore）
node server/test-mcp.mjs             # 验收测试（端口 17373 被占用时：--port 17399）
```

### 2. 加载 Chrome 扩展

在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/` 目录（已加载过的点刷新按钮；`download_file` 需要新增的 `downloads` 权限，刷新后生效）。

### 3. 注册 MCP

```bash
claude mcp add --scope user chatgpt-web -- "$(which node)" "$PWD/server/server.mjs"
```

## 工具一览

所有工具都接受可选参数 `site: "chatgpt" | "gemini"`，省略时沿用最近一次 `open_conversation` 打开的站点（初始为 `chatgpt`）；`open_conversation` 根据 URL 自动判断站点。

| 工具 | 用途 |
| --- | --- |
| `open_conversation` | 打开指定对话、ChatGPT 项目（`g-p-…` 或侧边栏项目名）、Gemini 对话/Gem 或新对话，同时解除 `PAGE_STALE`。 |
| `get_status` | 非阻塞读取生成状态、对话 ID、当前模式与工具、Deep Research 状态、标签页可见性及页面是否过期。 |
| `show_tab` | 将专属标签页调到前台并聚焦所在窗口（最多等待 3 秒可见），也可放行被 Gemini 挂起的消息。 |
| `upload_files` | 将本地文件注入页面输入框，确认出现每个文件的预览卡片并等待上传完成，只附件不发送。 |
| `send_message` | 依次校验发送挂起、页面过期、目标对话、工具状态、隐藏标签页与默认模式后，原样填入文本并点击发送一次。 |
| `get_latest_reply` | 读取或保存最新助手回复（最多阻塞 45 秒），未完成时返回后台任务 `job_id` 和 `wait_command`。 |
| `get_job` | 继续等待并获取后台回复任务的结果。 |
| `select_model` | 按页面文字列出或切换模型、模式（ChatGPT `Chat`/`Work`、Gemini `Chat`/`Task`）及 ChatGPT「+」菜单里的工具。 |
| `list_files` | 只读列出指定助手回复中可下载的文件 chip、Gemini 文件卡片、已展开预览或 Canvas。 |
| `download_file` | 将回复中的指定文件或导出项（支持按 `format` 选择导出格式）保存到本地绝对路径并计算 sha256。 |
| `inspect_page` | 只读输出指定选择器的页面 DOM 大纲，用于在页面改版后排查和修复选择器。 |

## 安全设计

- **本地单连接与握手校验**：WebSocket 只监听 `127.0.0.1`，握手校验 `Host`、`Origin`（必须是 `chrome-extension://<32位ID>`）和经 `Sec-WebSocket-Protocol` 传递的 32 字节 Token（常量时间比较，不会出现在 Chrome 连接失败日志里），同一时间只允许一个扩展连接。
- **最小权限与按需注入**：扩展只申请 `tabs`、`scripting`、`alarms`、`downloads` 及 `https://chatgpt.com/*`、`https://gemini.google.com/*` 权限，`content.js` 不在 manifest 中声明，只按需注入扩展自己创建的专属标签页，不读 Cookie 或 Storage。
- **下载与文件钩子隔离**：`downloads` 权限仅认领并清理本扩展当次点击产生的单个下载（拒绝操作任何其他下载 ID），导出菜单绝不点击分享或发往 Drive / Google 文档 / Google Sites 的选项，且 Gemini 主世界文件选择钩子仅在单次、60 秒过期的隐藏载体输入框存在时生效。
- **专属标签页校验与元数据保护**：服务端重启后记住的标签页 ID 需通过标签页隔离世界里的随机标记校验，避免 Chrome 重启后撞上用户自己的标签页；后台等待只读 `server/.jobs/<job_id>.json` 元数据（权限 `0600`、6 小时后清理），不碰回复正文也不连接任何端口。

## 详细文档

完整的使用说明、实现细节与故障排查见 [docs/REFERENCE.md](docs/REFERENCE.md)。
