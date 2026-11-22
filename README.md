# ChatGPT / Gemini Web MCP Bridge

让 Claude Code 通过 MCP 控制**日常 Chrome** 里的网页版 ChatGPT（Pro）和 Gemini：不开第二个 Chrome，不开 9222 调试端口。每个站点一个专属标签页，可同时使用。

```
Claude Code ──stdio(JSON-RPC)──▶ server/server.mjs ──ws://127.0.0.1:17373──▶ extension/background.js ──chrome.scripting──▶ 每站点一个专属标签页 (content.js)
```

## 安装

```bash
cd server && npm install && cd ..
node scripts/init-token.mjs          # 生成 server/.bridge-token 与 extension/config.local.js（均已 gitignore）
node server/test-mcp.mjs             # 验收测试（端口 17373 被占用时：--port 17399）
```

然后在 `chrome://extensions` 打开「开发者模式」→「加载已解压的扩展程序」→ 选择 `extension/` 目录（已加载过的点刷新按钮；`download_file` 需要新增的 `downloads` 权限，刷新后生效），再注册 MCP：

```bash
claude mcp add --scope user chatgpt-web -- "$(which node)" "$PWD/server/server.mjs"
```

## 工具

所有工具都接受可选参数 `site: "chatgpt" | "gemini"`，省略时沿用最近一次 `open_conversation` 打开的站点（初始为 chatgpt）。`open_conversation` 根据 URL 自动判断站点。

| 工具 | 作用 |
| --- | --- |
| `open_conversation({ url_or_id, site, mode })` | 打开对话 / ChatGPT 项目（`g-p-…`）/ Gemini 对话或 Gem / 新对话（整页加载，同时解除 `PAGE_STALE`），返回 `{ site, url, conversation_id, mode, warning? }`。Gemini 新对话自动选 **Task**（见下文「Gemini 默认 Task 模式」）；`mode`（如 `"Chat"`）为这个新对话指定别的模式，之后不会被切回。`mode` 是页面当前模式，读不到为 `null`（Gemini 已有对话没有切换按钮）；模式没设成时附 `warning`，不报错 |
| `open_conversation({ project, mode })` | 按侧边栏里的名字在 ChatGPT 项目中开新对话（如 `"My Project"`，匹配规则同 `select_model`），额外返回 `project`、`project_id`；`mode`（如 `"Work"`）同上 |
| `get_status()` | 非阻塞：`{ state, conversation_id, mode, chars, uploading, tab_hidden, has_reply, last_role, mcp_tab_open, page_stale, last_send?, warning? }`。`mode`：当前选中的模式（Gemini `Chat`/`Task`，只有新对话页有；ChatGPT `Chat`/`Work`），读不到为 `null`；`has_reply: true` 表示最新用户消息后面已有助手回复（`get_latest_reply` 能读）；`last_send: { sent_at, observed }` 说明最近一次 `send_message` 的文字是否已在页面上出现；`page_stale: true`（附 `warning` 说明原因）表示页面内容可能不是 URL 所示的对话，读取类工具会报 `PAGE_STALE` |
| `show_tab()` | 把专属标签页调到前台：设为所在窗口的活动标签页、窗口最小化则还原、聚焦窗口，再等页面报告 `visibilityState === 'visible'`（≤3 s）。标签页本来就可见时什么都不做。返回 `{ site, tab_hidden, was_hidden, activated, focused, window_state, reason? }`，仍不可见时 `reason` 说明原因（窗口仍最小化 / 别的 App 在前面、系统不让 Chrome 抢焦点 / 窗口被遮住、在别的桌面、锁屏）。也能放行被 Gemini 挂起的消息。不打字、不发送 |
| `upload_files({ paths, method })` | 本地文件分块 Base64 → 页面内 `File` 注入输入框，**确认输入框里出现了每个文件的预览卡片**后等上传完成，不发送。依次尝试站点的附件方式（ChatGPT：`input[type=file]`；Gemini：在输入框粘贴文件（2026-11-21 实测可用，预览有时要好几秒，期间不换方式），其次「Upload & tools」菜单 →「Upload files」→ 接管文件选择框或填入隐藏选择按钮对应的输入框；合成拖放在 Gemini 上无效且会干扰后续粘贴，默认不试），都看不到预览就报 `UPLOAD_NOT_ATTACHED`（列出每种方式的结果；错误对象另带 `tab_hidden` 和 `attempts`，标签页隐藏时信息以 `tab hidden: show the tab and retry` 开头），绝不假成功。开始前先按 `on_hidden` 处理隐藏标签页、Gemini 新对话先选好默认模式（见下文）。`method`（`input` / `drop` / `paste` / `picker`）只试这一种，用于排查。返回 `{ uploaded, uploading, attached: true, method, via, attempts?, warning?, tab_shown?, mode? }` |
| `send_message({ text, expect_conversation_id, on_hidden })` | 原样填入并点击发送一次；失败绝不重试。`expect_conversation_id`：对话 id / URL，或 `"new"`（以及 `https://chatgpt.com/`、`https://gemini.google.com/app`）= 标签页必须停在空的新对话上，否则 `CONVERSATION_MISMATCH`、什么都不输入。打字前依次检查：`SEND_PENDING` → `PAGE_STALE` → 对话 → 隐藏标签页（`on_hidden`）→ Gemini 新对话的默认模式（`MODE_NOT_SET`）。返回 `{ sent, confirmed, conversation_id, tab_shown?, mode?, warning? }` |
| `get_latest_reply({ wait_seconds, save_to, overwrite, expect_conversation_id })` | 最多阻塞 45 s；未完成返回 `job_id` 和 `wait_command`；`save_to` 时只回元数据。报过 `SEND_NOT_OBSERVED` 之后再调用，会按页面现状读最新回复并附 `warning`（回复可能早于那条消息）。页面可能不是 URL 所示的对话时报 `PAGE_STALE`，什么都不读不存；`expect_conversation_id` 不符报 `CONVERSATION_MISMATCH` |
| `get_job({ job_id, wait_seconds })` | 继续等待后台任务 |
| `select_model({ model, mode, outline })` | 按页面上的文字切换模型和模式（ChatGPT `Chat`/`Work`，Gemini `Chat`/`Task`，后者仅新对话页有）。显式给的 `mode` 记为这个新对话的选择，直到下一次 `open_conversation` 都不会被默认模式切回（页面上没有切换按钮时报 `MODE_TOGGLE_NOT_FOUND`，但同样记下）；只给 `model` 不给 `mode` 时，Gemini 新对话先切到默认的 Task 再选模型。`model` 先匹配选项名再匹配副标题（Gemini 的 `"Neon"`、`"Carbon"`），再进子菜单，最后用方向键调 ChatGPT 的 Power 滑块（如 `"Pro"`）；不带参数只列出可选项；匹配有歧义时拒绝点击；`outline` 附带打开时的菜单 DOM 大纲，用于修选择器 |
| `list_files({ message })` | 只读（页面过期时报 `PAGE_STALE`）：列出某条助手回复里可下载的文件（ChatGPT 回复里的行内文件 chip）。`message`：`"latest"`（默认）或往前数第几条回复（0 = 最新；长对话页面里通常只有最新一轮）。返回 `{ site, supported, conversation_id, message, replies, current, generating, files: [{ index, name, kind, label }] }`，`kind`：`download`（直接下载）/ `preview`（打开预览面板）；`current: false` 表示最新消息是用户的、这条是它之前的回复。Gemini：`supported: false`、空列表 |
| `download_file({ name, save_to, message, index, overwrite, timeout_seconds })` | 把回复里的一个文件存到本地，不发消息。用 `name` 或 `index`（`list_files` 给的）指定文件，可以只给其一；两个都给时必须对得上，都不给报 `INVALID_ARGUMENT`。点该文件的 chip，用 `chrome.downloads` 抓住这次点击触发的浏览器下载，服务端复制到 `save_to` 并算 sha256，随后**只删除这一次下载**在 Chrome 下载目录里的副本并从下载列表抹掉。`name` 必须与文件名完全一致，同名出现多次报 `AMBIGUOUS_FILE`（用 `list_files` 的 `index` 指定）。`save_to` 为绝对路径：已存在的目录或以 `/` 结尾 → 存为其中的同名文件，否则就是文件路径；目标已存在且没给 `overwrite: true` 报 `FILE_EXISTS`（先检查，不会白下载）；目标处的符号链接被替换、绝不写穿。预览 chip：打开面板 → 点面板里的下载按钮；没有下载按钮（或按了没下载）时保存面板显示的文字，并标 `via: "preview-text"` 和 `warning`（不保证与原文件逐字节一致）。返回 `{ path, size, sha256, name, kind, via: "download" \| "preview-download" \| "preview-text", capture?, mime?, warning? }` |
| `inspect_page({ selector, depth, max_nodes, visible_only })` | 只读 DOM 大纲，用于修选择器 |

## 隐藏标签页、Gemini 默认 Task 模式、页面过期

**隐藏标签页（`on_hidden` / `show_tab`）。** Gemini 的标签页在后台（或窗口最小化、被别的 App 盖住）时，**Chat 和 Task 模式都会**把点过的「发送」挂起，直到标签页显示出来才真正发出（2026-11-21 实测：一条 Chat 模式的消息晚了约 11.5 小时才发出），也不渲染附件预览（同样的 4 个 .txt，隐藏时三种附件方式全失败，可见时粘贴一次成功）。因此 `upload_files` / `send_message` 在**动页面之前**先看 `tab_hidden`，按 `on_hidden` 处理：

| `on_hidden` | 行为 |
| --- | --- |
| `"show"`（**Gemini 默认**） | 像 `show_tab` 那样把标签页调到前台；仍不可见就报 `TAB_HIDDEN`（附原因：窗口最小化 / 别的 App 在前面 / 被遮住…），什么都不输入、不附件 |
| `"fail"` | 隐藏就直接 `TAB_HIDDEN`，不碰标签页 |
| `"proceed"`（**ChatGPT 默认**，后台照常工作） | 不检查，照旧执行 |

调到前台会把该窗口切到专属标签页、并可能把 Chrome 提到别的 App 前面；建议把专属标签页拖到**单独的窗口**里，就不会占用你正在看的标签页。被挂起的消息会在标签页下次显示时发出，`send_message` 的警告、`SEND_PENDING` 和 `SEND_NOT_OBSERVED` 都会提示「调 `show_tab` 立即放行，或手动清空输入框作废」。`show_tab` 只用 `chrome.tabs.update({active})` 和 `chrome.windows.update({focused, state})`，不需要新权限。

**Gemini 默认 Task 模式。** Gemini 新对话（没有对话 id、还没有用户消息，切换按钮只在这时出现）默认用 **Task**：`open_conversation` 打开新对话后自动选上（尽力而为，失败只附 `warning`）；`select_model` 只给 `model` 时先切 Task 再选模型；`upload_files` / `send_message` 在新对话上**动手前再确认一次**（在标签页调到前台之后），确认不了就报 `MODE_NOT_SET`、什么都不输入——包括页面上找不到切换按钮的情况，保证消息不会悄悄用别的模式发出。已经附了文件之后不再切模式（不确定切换会不会丢附件），此时报 `MODE_NOT_SET`。已有对话从不切换。要用别的模式：`select_model({ mode: "Chat" })` 或 `open_conversation({ url_or_id, mode: "Chat" })`，这个显式选择到下一次 `open_conversation` 之前都不会被切回。默认值可用服务端环境变量改：`CHATGPT_BRIDGE_DEFAULT_MODE_GEMINI`（默认 `Task`，设 `none` 关闭）、`CHATGPT_BRIDGE_DEFAULT_MODE_CHATGPT`（默认不切换，可设 `Work`），例如 `claude mcp add --scope user -e CHATGPT_BRIDGE_DEFAULT_MODE_GEMINI=none chatgpt-web -- …`。

**页面过期（`PAGE_STALE`）。** 2026-11-22 实测：用户在 ChatGPT 专属标签页里手动切到别的对话再切回来（站内跳转）后，URL 显示对话 A，页面却还是对话 C 的内容，`get_latest_reply` 把 C 的回复当成 A 的存进了 `save_to`。现在有两道检查：

1. 页面被看到停在另一个对话上（与最近一次 `send_message` 发往的对话不同，或回复任务报了 `CONVERSATION_CHANGED`）后，该站点标为过期，直到 `open_conversation` 整页重新加载；
2. 页面曾按指纹认出刚发的消息是最新用户消息之后，若最新用户消息变成了别的，也视为过期（只有认出过才启用，所以气泡被截断、从来对不上的情况不会误报）。

过期期间 `get_latest_reply` / `get_job` / `list_files` / `download_file` 什么都不读、不存、不点，`send_message` / `upload_files` 什么都不输入、不附件，一律报 `PAGE_STALE`；`get_status` 不报错，只给 `page_stale: true` 和原因。处理办法：`open_conversation` 打开想要的对话，再重试。局限：本次服务端运行里还没发过消息、且切走切回期间没有任何读取时，第 1 道检查无从比较；第 2 道检查也需要页面曾认出过发出的消息。

## 长回复：后台等待，不轮询

ChatGPT Pro、Gemini Task 的回复常要几分钟到几十分钟。`get_latest_reply` 未完成时返回 `wait_command`（形如 `node server/wait-job.mjs job_…`）：Claude Code 用 Bash 的 `run_in_background` 跑它，等待期间不占对话、不耗 token；回复完成（退出码 0）、失败（1）、服务端重启导致任务丢失（2）或超过 4 小时（3）时它打印一行 JSON 退出，Claude Code 随即唤醒模型，再调一次 `get_job` 取结果。

它只读 `server/.jobs/<job_id>.json`（仅元数据、权限 0600、已 gitignore、6 小时后清理），不碰回复正文，也不连接任何端口。Claude Code 的 hooks 只在它自身事件上触发，无法被「网页回复完成」唤醒，所以这里用的是后台任务结束通知。

## 回复里的文件：`list_files` / `download_file`

ChatGPT 常把结果做成沙盒里的文件（`.patch` / `.md` / `.json`），回复里显示为行内 chip（2026-11-21 实测：`span[role="button"][aria-label="Download <文件名>"]` 或 `[aria-label="Open preview of <文件名>"]`，不是 `<a href>`，由页面 JS 处理点击）。实现：

1. `content.js` 在指定回复里认 chip（`SITE_SELECTORS.chatgpt.fileChip` / `fileChipLabel`；只认文字里也显示该文件名的控件，图片的「Download this image」图标按钮、「Worked for …」面板里的文件不算），按 `index` + 名字点它。
2. `background.js` 在点击前挂上 `chrome.downloads.onCreated` / `onChanged`，认领点击后出现的第一个来自本站（URL / 最终 URL / referrer 在站点域名下，或本站的 `blob:`）或文件名吻合的下载，等它 `complete`，把绝对路径交给服务端。不装 `onDeterminingFilename`：那会让 Chrome 每个下载都等这个扩展。
3. 页面自己的下载没开始时（Chrome 拦住同一页面的第二个自动下载、没有用户手势的 `window.open` 被拦截），点击前在页面主世界装的捕获器（`installDownloadCatcher`，不改变页面行为）记下了页面想打开的 https 地址（链接点击、`window.open`、下载接口 JSON 里的地址），扩展改用 `chrome.downloads.download` 自己下载它（不受页面限制，按下载 id 跟踪），结果标 `capture: "caught-url"`。
4. 服务端把文件流式复制到目标目录里的临时文件（独占创建、不跟随符号链接）并算 sha256，然后让扩展删除 Chrome 那份副本（`removeFile` + `erase`，只认本扩展这次产生的下载 id，别的下载一律拒绝），最后原子地移到目标位置（不覆盖时用硬链接，目标已存在就失败）。失败、超时、弹出保存对话框时同样只清理这一次下载（未完成的先 `cancel`，连同 `.crdownload` 一起删）。服务端没来得及清理的下载，扩展 10 分钟后自己删。

使用前提与限制：

- Chrome 设置里「下载前询问每个文件的保存位置」要关掉，否则报 `DOWNLOAD_PROMPTED`（下载已取消；若保存对话框还开着，手动关掉）。
- 若专属标签页提示「此网站想下载多个文件」，点允许，或在 `chrome://settings/content/automaticDownloads` 里允许 `https://chatgpt.com`。被拦住且页面没有可捕获的 https 地址时报 `DOWNLOAD_NOT_STARTED`。
- macOS 上服务端要能读 `~/Downloads`（运行 Claude Code 的终端 App 需有「下载」文件夹权限），否则报 `DOWNLOAD_UNREADABLE`。
- Gemini 回复里的文件尚未支持：`list_files` 返回空，`download_file` 报 `NOT_SUPPORTED`。
- 预览面板的选择器（`previewDownload` / `previewPanel` / `previewClose`）按「点击后新出现的元素」推断，尚未在真页面上核对；找不到面板时 `PREVIEW_NOT_FOUND` 会附上当时的面板大纲。

## 安全设计

- WebSocket 只监听 `127.0.0.1`；握手校验 `Host`、`Origin`（必须是 `chrome-extension://<32位ID>`）和 32 字节 Token（常量时间比较）；Token 走 `Sec-WebSocket-Protocol` 而不是 URL，因此不会出现在 Chrome 的连接失败日志里；同一时间只允许一个扩展连接。
- Claude Code 没运行时，扩展每 ≤30 s 重连一次，`chrome://extensions` 的「错误」里会出现 `WebSocket connection ... failed`，属正常现象，可随时「全部清除」。
- 扩展只申请 `tabs` / `scripting` / `alarms` / `downloads` + `https://chatgpt.com/*`、`https://gemini.google.com/*`（`show_tab` 用的 `chrome.tabs.update` / `chrome.windows.update` 不需要额外权限，且只作用于专属标签页及其窗口）；`content.js` 不在 manifest 中声明，只按需注入扩展自己创建的专属标签页，不读 Cookie / Storage。`downloads` 只用于 `download_file`：监听点击后出现的那一次下载、必要时下载页面想打开的地址、事后删除这次下载的副本并从列表抹掉；不读、不改、不删任何别的下载（`download_discard` 对非本扩展这次产生的下载 id 一律拒绝）。
- 服务端重启后记住的标签页 ID，需要通过标签页隔离世界里的随机标记校验，避免 Chrome 重启后 ID 撞上你自己的标签页。
- Gemini 页面里没有常驻的 `input[type=file]`（2026-11 实测 0 个），平时靠粘贴附件；粘贴不行时，`upload_files` 会用 `chrome.scripting`（`world: 'MAIN'`，沿用已有的 `scripting` 权限，manifest 不变）在**专属标签页**的页面主世界装一个钩子（`background.js` 的 `installFileChooserHook`）：只有 `content.js` 放了一个隐藏的「载体」输入框（`input[data-mcp-file-carrier]`，60 s 过期、只用一次、上传结束即移除）时，才把载体里的文件交给页面的 `click()` / `showPicker()` / 派发的 click / `showOpenFilePicker()` 并触发 `input`/`change`，不弹系统文件框，同时把页面这期间的程序化点击记在载体上（最后点的元素标 `data-mcp-clicked`），供失败信息排查；没有载体时原样放行。Gemini 的「Upload files」只会点一个隐藏的选择按钮，标签页在后台时不再打开选择框，这时 `content.js` 像系统文件框那样把文件填进该按钮对应的 `input[type=file]`（跳过只收图片的和选文件夹的），并先把载体标记为已用，之后迟到的选择框调用会原样放行，不会重复附件。

## ChatGPT 改版后修选择器

所有选择器按站点集中在 `extension/content.js` 顶部的 `SITE_SELECTORS`（`chatgpt` / `gemini`）。上传相关的是 `uploadMethods`（尝试顺序）、`attachmentScope` / `attachment` / `attachmentIgnore`（预览卡片在哪、长什么样；另外还按文件名和缩略图判断）、`uploadMenuButton` / `uploadTrigger`、`dropzone`。让 Claude 调用 `inspect_page`（例如 `selector: "form"`，或 `visible_only: false` 查找隐藏的 `input[type=file]`），改完在 `chrome://extensions` 点扩展的刷新按钮即可。

判断「发出的消息已出现」不只看消息条数：2026-11 起 ChatGPT 长对话只在 DOM 里保留最新一轮（一个 `stack-*` 下 用户块 /「Worked for …」块 / 回复块），发送前后用户消息都是 1 条。服务端因此依次认：消息条数或 `data-message-id` 变了；最新用户消息的文字指纹（`userText`，只比字母和数字，因为气泡里的 `代码` 会去掉反引号）等于刚发的文字；点击后出现过停止按钮。读回复时只取 Markdown 根节点，「Worked for …」这类没有 Markdown 的块和展开的思考面板不会混进回复。

## 故障排查

- `EXTENSION_NOT_CONNECTED`：确认扩展已启用；扩展最多 30 s 内自动重连。查看日志：`chrome://extensions` → 本扩展 →「Service Worker」。
- `SEND_NOT_OBSERVED`：点了发送，但页面上始终认不出这条消息（发出满 60 s 且页面不在生成时才报，生成期间一直等）。**不要重发**，先 `get_status`：`has_reply` 说明有没有回复，`last_send.observed` 说明消息是否已被认出。之后再调 `get_latest_reply`（可带 `save_to`）会按页面现状读最新回复并附 `warning`，不会再被这个错误挡住；消息一旦被认出，`warning` 就消失。
- `UPLOAD_NOT_ATTACHED`：文件没进输入框，下一条消息不会带上它。错误信息逐条列出试过的方式和原因（如菜单里没有上传项、粘贴/拖放后没出现预览、页面提示）；信息以 `tab hidden: show the tab and retry` 开头（`tab_hidden: true`）时，原因就是标签页不可见：调 `show_tab` 或用默认的 `on_hidden: "show"` 重试。拿 `inspect_page`（`selector: "input-container"`、`visible_only: false`）对照修 `SITE_SELECTORS` 里的上传选择器；`upload_files({ method })` 可单独试某一种方式。预览出现后又消失（站点拒收该文件）也报这个错。
- `EXTENSION_OUTDATED`：服务端已更新但页面里还是旧 `content.js`（无法核对附件），或扩展早于 `list_files` / `download_file`——在 `chrome://extensions` 刷新本扩展后重试。
- `download_file` 的错误：`FILE_NOT_IN_REPLY`（回复里没有这个确切的文件名，错误里列出有哪些）、`AMBIGUOUS_FILE`（同名多次，传 `index`）、`FILE_EXISTS`（目标已存在，传 `overwrite: true`）、`DOWNLOAD_NOT_STARTED`（点了没有下载，见上面「多个文件」的允许方法）、`DOWNLOAD_PROMPTED`（Chrome 在问保存位置）、`DOWNLOAD_TIMEOUT`（`timeout_seconds` 内没下完，已取消并删掉半截文件）、`DOWNLOAD_FAILED`（Chrome 中断了下载，附原因）、`DOWNLOAD_UNREADABLE`（服务端读不到 Chrome 下好的文件）、`DOWNLOADS_UNAVAILABLE`（扩展还没有 `downloads` 权限，刷新扩展）、`PREVIEW_NOT_FOUND`（点了预览 chip 没出现面板，附大纲，用来修 `previewPanel` / `previewDownload`）。
- 改了 `extension/` 下的文件要在 `chrome://extensions` 点本扩展的刷新按钮（不会刷新标签页，页面上的回复还在；扩展版本号会显示为新版本）；扩展比服务端旧时 `show_tab` 报 `EXTENSION_OUTDATED`、隐藏标签页上的 Gemini 发送报 `TAB_HIDDEN` 并提示刷新扩展；改了 `server/` 下的文件要在 Claude Code 里 `/mcp` 重连 chatgpt-web。服务端重启会清空内存里的任务和发送记录。
- 两个 Claude Code 会话同时启动本服务器时，只有第一个能占用 17373 端口，另一个会每 5 s 重试。
- 专属标签页在后台运行；若某次回复一直不刷新，把该标签页拖到单独窗口即可。
- Gemini 在标签页不可见时（**Chat 和 Task 模式都一样**）会把「发送」挂起，文字留在输入框里，直到标签页显示出来才真正发出，可能是几个小时之后。默认的 `on_hidden: "show"` 会先把标签页调到前台；用 `"proceed"` 时若被挂起，`send_message` 返回 `confirmed: false` 和警告，再次发送会被 `SEND_PENDING` 拒绝（防止重复发送），调 `show_tab` 可立即放行。`get_status` 的 `tab_hidden` 显示 Chrome 是否认为该标签页可见。
- `TAB_HIDDEN`：标签页不可见且调不到前台（错误里的原因、`activated` / `focused` / `window_state` 说明卡在哪）：还原最小化的窗口、把它移到当前桌面且不被遮住，或干脆拖成单独窗口，再重试。什么都没输入、没附件。
- `MODE_NOT_SET`：Gemini 新对话没能确认是 Task 模式（找不到切换按钮、按了没生效，或已附件后需要切换）。什么都没输入。要用当前模式继续就先 `select_model({ mode: "Chat" })`（或想要的模式），切换按钮选择器坏了就用 `inspect_page` 修 `SITE_SELECTORS.gemini.modeToggle`。
- `PAGE_STALE`：页面可能不是 URL 所示的对话（见上文「页面过期」）。`open_conversation` 打开想要的对话后重试；不要直接重读或重发。
