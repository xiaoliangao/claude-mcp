// Injected on demand by background.js (chrome.scripting) into the dedicated MCP tabs only — it is not
// declared in manifest.json, so it never runs in your other chatgpt.com / gemini.google.com tabs. Pure
// DOM logic: no chrome.* APIs, no cookies, no storage, and no timers (hidden tabs throttle timers, so
// every wait is driven from the server). When a site changes its markup, fix SELECTORS — inspect_page helps.
(() => {
  const SITE = location.hostname === 'gemini.google.com' ? 'gemini' : 'chatgpt';

  // Per site, ordered by preference; semantic hooks (data-testid / role / aria) first. aria-labels are
  // localised, so English and Chinese variants are both listed. Messages are the outermost elements
  // matching userMessage / assistantMessage, in document order; messageId names an attribute holding a
  // stable id where the site has one. Without ids the server compares message counts and the text
  // fingerprint of the latest user message (userText, first selector with a match) against what it sent:
  // counts alone fail when the site renders only the latest turn.
  const SITE_SELECTORS = {
    chatgpt: {
      conversationPath: /\/c\/([^/]+)/, // new chats first show a temporary "/c/local-chatgpt%3A<uuid>"
      composer: [
        '#prompt-textarea[contenteditable="true"]',
        'div.ProseMirror[contenteditable="true"]',
        '[role="textbox"][contenteditable="true"]',
        'textarea#prompt-textarea',
        'textarea[data-testid="prompt-textarea"]',
      ],
      // Tried with closest() from the composer; scopes upload-progress detection.
      composerRoot: ['form', '[data-type="unified-composer"]', '[data-testid="composer"]'],
      sendButton: [
        'button[data-testid="send-button"]',
        'form button[type="submit"][aria-label="Send"]', // 2026-11 composer redesign (no data-testid)
        'form button[type="submit"][aria-label="发送"]',
        'button#composer-submit-button:not([data-testid="stop-button"])',
        'button[aria-label="Send prompt"]',
        'button[aria-label="发送提示"]',
      ],
      stopButton: [
        'button[data-testid="stop-button"]',
        'form button[aria-label="Stop"]',
        'form button[aria-label^="Stop "]',
        'form button[aria-label*="停止"]',
        'button#composer-submit-button[aria-label*="Stop"]',
        'button#composer-submit-button[aria-label*="停止"]',
        'button[aria-label="Stop streaming"]',
        'button[aria-label="停止流式传输"]',
      ],
      // Legacy layout carries role/id attributes. 2026-11 layout: each turn is a "stack-*" of "block-*"
      // messages; the user's block contains the user bubble, every other block is the assistant ("Thought
      // for …" row, tool rows, then the reply with the Markdown). Long threads may keep only the latest
      // turn in the DOM, so counts stay put after a send — hence the userText fingerprint.
      userMessage: ['[data-message-author-role="user"]', 'main [class*="stack-"] > [class*="block-"]:has(.bg-user-message)'],
      assistantMessage: [
        '[data-message-author-role="assistant"]',
        'main [class*="stack-"] > [class*="block-"]:not(:has(.bg-user-message))',
      ],
      userText: ['.bg-user-message .whitespace-pre-wrap', '.whitespace-pre-wrap'],
      messageId: 'data-message-id',
      markdown: '.markdown, .prose, [class*="MarkdownRoot-"]',
      // 2026-11 "Worked for …" / "Thought for …" row: its collapsible panel sits under .text-secondary,
      // which the reply's MarkdownRoot never has above it.
      replyExclude: '[class*="block-"] .text-secondary',
      fileInput: 'input[type="file"]:not([data-mcp-file-carrier])',
      uploadProgress: ['[role="progressbar"]', '.animate-spin', '[aria-busy="true"]', 'circle[stroke-dashoffset]'],
      // upload_files tries these in order (see ATTACH) until the composer shows the files.
      uploadMethods: ['input', 'paste', 'drop'],
      // Where attachment previews render (closest() from the composer), what a preview looks like, and
      // what inside that area is never a preview. The post-check also matches file names and thumbnails.
      attachmentScope: ['form', '[data-type="unified-composer"]', '[data-testid="composer"]'],
      attachment: ['[data-testid*="attachment"]', '[data-testid*="file-tile"]', 'button[aria-label^="Remove file"]', 'button[aria-label*="删除文件"]', 'button[aria-label*="移除文件"]'],
      attachmentIgnore: null,
      uploadTrigger: [],
      uploadMenuButton: [],
      dropzone: [],
      error: ['[data-testid*="error"]', '.text-token-text-error', '.text-red-500', '.text-red-600'],
      loginButton: ['[data-testid="login-button"]', '[data-testid="welcome-login-button"]'],
      // Header controls: the model dropdown (a Radix menu) and the Chat / Work segmented toggle. The menu
      // has a "Power" slider ("Pro, 5 of 5", arrow keys) above the model radios; its first row only
      // echoes the slider level and switches views, so it is skipped.
      modelButton: [
        'button[data-testid="model-switcher-dropdown-button"]',
        'button[aria-label="Select ChatGPT model"]',
        'button[aria-label="选择 ChatGPT 模型"]',
        'button[aria-label^="Model selector"]',
      ],
      modeToggle: ['[role="group"][aria-label="Composer mode"]'],
      menuSkip: ['[aria-label="Select model"]', '[aria-label="选择模型"]'],
      // Sidebar project rows are not links; each has a "New chat in <name>" button that opens the
      // project page (/g/g-p-<id>/project). Hidden rows still carry the button.
      projectNewChat: ['nav button[aria-label^="New chat in "]'],
      projectName: /^New chat in (.+)$/,
      // Files in a reply (live 2026-11-21): inline chips, not links — span.InlineMentionFocusRing-…[role="button"]
      // [aria-label="Download <name>"] or [aria-label="Open preview of <name>"], whose text is the file name.
      // fileChipLabel turns a label into [kind, name]; a control whose text does not show that name (an image's
      // "Download this image" icon button) is no chip. The panel a preview chip opens is found by what appears
      // after the click: a download control (previewDownload, or a button reading "Download"), the panel around
      // it (previewPanel) and its close button (previewClose). Chinese labels are unverified guesses.
      fileChip: ['[role="button"][aria-label]', 'button[aria-label]', 'a[aria-label]'],
      fileChipLabel: [
        [/^Download (.+)$/i, 'download'],
        [/^Open preview of (.+)$/i, 'preview'],
        [/^下载\s*(.+)$/, 'download'],
        [/^打开\s*(.+?)\s*的预览$/, 'preview'],
        [/^预览\s*(.+)$/, 'preview'],
      ],
      previewDownload: [
        'button[aria-label^="Download"]',
        '[role="button"][aria-label^="Download"]',
        'a[aria-label^="Download"]',
        'button[aria-label*="下载"]',
        '[role="button"][aria-label*="下载"]',
        '[data-testid*="download"]',
        'a[download]',
      ],
      previewPanel: ['[role="dialog"]', 'aside', '[data-testid*="preview"]', '[class*="preview" i]', '[data-state="open"]', 'section'],
      previewClose: ['button[aria-label="Close"]', 'button[aria-label^="Close "]', 'button[aria-label*="关闭"]', '[data-testid*="close"]'],
      // Composer tools ("Deep research", "Create image", … — not in the model menu, live 2026-11-22). toolsButton is
      // the "+" left of the prompt (live 2026-11-22: button[aria-label="Add files and more"], a Radix menu trigger
      // with aria-expanded / data-state); its menu is read like the model menu, "More" opening a submenu.
      // UNVERIFIED: the menu's contents (Deep research is expected there, not yet seen) and, never seen with a tool
      // on, how the chosen tool shows in the composer. toolPill / toolRemove are
      // guesses; toolNames backs them up: a control in the composer (outside the prompt) whose label starts with a
      // known tool name — every tool name read from the "+" menu on this page counts too.
      toolsButton: ['form button[aria-label="Add files and more"]', 'button[data-testid="composer-plus-btn"]', 'form button[aria-label="添加文件等"]'],
      toolPill: [
        '[data-testid*="composer-pill" i]',
        '[data-testid*="system-hint" i]',
        '[class*="composer-pill" i]',
        '[class*="ComposerPill"]',
        '[class*="SystemHint"]',
        '[class*="ToolPill"]',
        'button[aria-label*="click to remove" i]',
      ],
      toolRemove: ['button[aria-label*="remove" i]', 'button[aria-label*="clear" i]', 'button[aria-label^="Close" i]', 'button[aria-label*="移除"]', 'button[aria-label*="删除"]', 'button[aria-label*="取消"]'],
      toolNames: ['Deep research', 'Agent mode', 'Create image', 'Web search', 'Canvas', 'Study and learn', 'Shopping research', '深度研究', '代理模式', '创建图片', '网页搜索', '画布'],
      // Deep Research in progress / finished, looked for in the current reply only — all UNVERIFIED (its running
      // and report DOM was never observed). researchBusy / researchBusyText are research-specific (strong);
      // researchProgress only counts while the last send went out with a research tool (a progress bar alone is
      // not proof). The server also waits out a research reply that has no Markdown yet.
      researchBusy: ['button[aria-label*="stop research" i]', 'button[aria-label*="cancel research" i]', 'button[aria-label*="停止研究"]', '[data-testid*="research-progress" i]'],
      // Research-specific phrases only: a lingering "Searching the web" row of an ordinary reply must not hold a job
      // (or block sends) for hours.
      researchBusyText: /^(starting (deep )?research|researching\b|deep research (is )?(in progress|running)|compiling (the )?(research )?report|writing (the )?(research )?report|正在研究|研究中|正在进行深度研究)/i,
      researchProgress: ['[role="progressbar"]', '[aria-busy="true"]'],
      researchDoneText: /^(research completed|completed research|research finished|deep research completed|研究完成|已完成研究)/i,
      // An export / download control of a report (UNVERIFIED), offered by list_files as kind "export". One that opens
      // a menu (aria-haspopup / aria-expanded) gets its format picked there by download_file.
      exportControl: ['button', '[role="button"]', 'a[href]'],
      exportLabel: /^(export|download)(\s+(report|research|as|to)\b.*)?$|^(导出|下载报告)/i,
    },
    // Verified 2026-11: composer, send/stop, messages, reply extraction, model menu, Chat / Task toggle.
    gemini: {
      conversationPath: /\/(?:app|gem\/[^/]+)\/([^/]+)/,
      composer: ['rich-textarea .ql-editor[contenteditable="true"]', '.ql-editor[contenteditable="true"]', '[role="textbox"][contenteditable="true"]'],
      composerRoot: ['input-area-v2', '.input-area-container', '.input-area', 'fieldset', 'form'],
      sendButton: ['button.send-button:not(.stop)', 'button[aria-label="Send message"]', 'button[aria-label="发送消息"]', 'button[aria-label="发送"]'],
      stopButton: ['button.send-button.stop', 'button[aria-label="Stop response"]', 'button[aria-label*="停止"]'],
      userMessage: ['user-query'],
      assistantMessage: ['model-response'],
      userText: ['.query-text'],
      messageId: null,
      markdown: '.markdown',
      replyExclude: 'model-thoughts, .thoughts-container', // the collapsible "Show thinking" panel
      fileInput: 'input[type="file"]:not([data-mcp-file-carrier])',
      uploadProgress: ['[role="progressbar"]', 'mat-progress-spinner', 'mat-spinner', '[aria-busy="true"]'],
      // 2026-11: no <input type=file> in the DOM at rest. Live 2026-11-21: a paste of the files on the prompt
      // attaches (on a fresh page within 6 s, after other attempts only later or not at all); synthetic
      // drops never attach (neither on input-area-v2 nor on .ql-editor) and spoil a following paste, so drop
      // is not tried unless asked for. "Upload & tools" → "Upload files" (gem-menu-item) makes the page
      // click button.hidden-local-file-image-selector-button while three file inputs sit in the open menu,
      // but in a hidden tab no chooser call follows; picker then fills the input belonging to that button.
      // Previews: div.text-input-field > .attachment-preview-wrapper > uploader-file-preview-container >
      // uploader-file-preview.file-preview-chip > … gem-attachment; sent messages show theirs in
      // user-query .file-preview-container, outside attachmentScope.
      uploadMethods: ['input', 'paste', 'picker'],
      attachmentScope: ['.input-area-container', 'input-container', 'input-area-v2'],
      attachment: [
        'uploader-file-preview',
        'gem-attachment',
        '.file-preview-chip',
        '[data-test-id*="file-preview"]',
        '[data-test-id*="image-preview"]',
        'button[aria-label^="Remove file"]',
        'button[aria-label*="移除文件"]',
        'button[aria-label*="删除文件"]',
      ],
      attachmentIgnore: 'file-drop-indicator, auto-suggest',
      uploadTrigger: ['[xapfileselectortrigger]', 'button.hidden-local-upload-button', 'button.hidden-local-file-upload-button'],
      uploadMenuButton: ['button[aria-label="Upload & tools"]', 'button[aria-label="上传和工具"]', 'simplified-input-menu button[aria-haspopup="menu"]'],
      dropzone: ['.xap-uploader-dropzone'],
      error: ['.error-message', '[data-test-id*="error"]'],
      loginButton: ['a[href*="accounts.google.com/ServiceLogin"]', 'a[aria-label="Sign in"]', 'a[aria-label="登录"]'],
      // "Open mode picker, currently Neon" under the composer, and the Chat / Task toggle (new chats only).
      modelButton: ['bard-mode-switcher button', 'button[aria-label^="Open mode picker"]', 'button.input-area-switch'],
      modeToggle: ['chat-spark-toggle', 'gem-segmented-button-row'],
      menuSkip: [],
      projectNewChat: [],
      projectName: null,
      // Reply file chips are not known for Gemini yet: list_files returns none, download_file NOT_SUPPORTED.
      fileChip: [],
      fileChipLabel: [],
      previewDownload: [],
      previewPanel: [],
      previewClose: [],
      // Gemini's "Tools" (Deep Research, Canvas, …) are not wired up: select_model { tool } → NOT_SUPPORTED.
      toolsButton: [],
      toolPill: [],
      toolRemove: [],
      toolNames: [],
      researchBusy: [],
      researchBusyText: null,
      researchProgress: [],
      researchDoneText: null,
      exportControl: [],
      exportLabel: null,
    },
  };
  const SELECTORS = SITE_SELECTORS[SITE];

  // toolLabels: tool names read from the composer's "+" menu on this page (they back up activeTool).
  const state = { uploads: new Map(), pendingText: null, menuBaseline: null, menuItems: [], preview: null, toolLabels: new Set() };

  // ---------------------------------------------------------------- DOM helpers

  function fail(code, message) {
    return Object.assign(new Error(message), { code });
  }

  function all(selectors, root = document) {
    const out = [];
    for (const s of [].concat(selectors)) {
      try {
        out.push(...root.querySelectorAll(s));
      } catch {
        // selector unsupported by this Chrome build — skip it
      }
    }
    return out;
  }

  function visible(el) {
    if (!el?.isConnected) return false;
    if (typeof el.checkVisibility === 'function') {
      return el.checkVisibility({ checkVisibilityCSS: true, visibilityProperty: true }) || getComputedStyle(el).display === 'contents';
    }
    return el.getClientRects().length > 0;
  }

  const firstVisible = (selectors, root) => all(selectors, root).find(visible) || null;
  const isDisabled = (btn) => btn.disabled || btn.getAttribute('aria-disabled') === 'true';
  const squash = (s) => String(s ?? '').replace(/\s+/g, '');
  const clip = (s, n) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

  function conversationId() {
    const raw = location.pathname.match(SELECTORS.conversationPath)?.[1];
    return raw ? decodeURIComponent(raw) : null;
  }

  function composer() {
    return firstVisible(SELECTORS.composer);
  }

  function composerRoot() {
    const box = composer();
    if (!box) return null;
    for (const s of SELECTORS.composerRoot) {
      const root = box.closest(s);
      if (root) return root;
    }
    return box.parentElement;
  }

  function generating() {
    return !!firstVisible(SELECTORS.stopButton);
  }

  function uploading() {
    const root = composerRoot();
    if (root && all(SELECTORS.uploadProgress, root).some(visible)) return true;
    return attachmentChips().some((chip) => all(SELECTORS.uploadProgress, chip).some(visible));
  }

  // [{ el, role: 'user' | 'assistant', id }] for the outermost message elements, in document order.
  function messageNodes() {
    const users = new Set(all(SELECTORS.userMessage));
    const found = new Set([...users, ...all(SELECTORS.assistantMessage)]);
    const outermost = [...found].filter((el) => {
      for (let p = el.parentElement; p; p = p.parentElement) if (found.has(p)) return false;
      return true;
    });
    outermost.sort((a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    return outermost.map((el) => ({
      el,
      role: users.has(el) ? 'user' : 'assistant',
      id: SELECTORS.messageId ? el.getAttribute(SELECTORS.messageId) : null,
    }));
  }

  function threadInfo() {
    const msgs = messageNodes();
    let lastUserIdx = -1;
    let lastUser = null;
    let lastAssistant = null;
    let userCount = 0;
    let assistantCount = 0;
    msgs.forEach((m, i) => {
      if (m.role === 'user') {
        userCount++;
        lastUser = m;
        lastUserIdx = i;
      } else {
        assistantCount++;
        lastAssistant = m;
      }
    });
    return {
      lastUser: lastUser?.el ?? null,
      // Every assistant message after the latest user message forms the current reply.
      replyParts: msgs.slice(lastUserIdx + 1).map((m) => m.el),
      last_role: msgs.at(-1)?.role ?? null,
      user_count: userCount,
      assistant_count: assistantCount,
      last_user_id: lastUser?.id ?? null,
      last_assistant_id: lastAssistant?.id ?? null,
      // Same form as fill_composer's sent_hash, so the server can tell its own message is the latest one.
      last_user_hash: lastUser ? fingerprint(userTextOf(lastUser.el)) : null,
    };
  }

  // Letters and digits only: ChatGPT renders `inline code` in the user bubble without the backticks
  // (seen 2026-11-21), so punctuation, Markdown marks and whitespace are left out on both sides. Null
  // when nothing is left to compare.
  function fingerprint(text) {
    const core = String(text ?? '').normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '');
    return core ? hash(core) : null;
  }

  // Text of a user message: its userText element(s) if any, else the whole message, without
  // screen-reader labels ("You said:") and buttons.
  function userTextOf(message) {
    let roots = [message];
    for (const s of SELECTORS.userText || []) {
      const hits = all(s, message);
      if (hits.length) {
        roots = hits.filter((el) => !hits.some((o) => o !== el && o.contains(el)));
        break;
      }
    }
    const hidden = '.sr-only, .cdk-visually-hidden, button, script, style, template';
    let text = '';
    for (const root of roots) {
      const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const h = n.parentElement?.closest(hidden);
          return h && root.contains(h) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
        },
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) text += n.data;
      text += '\n';
    }
    return text;
  }

  function markdownRoots(message) {
    return [...message.querySelectorAll(SELECTORS.markdown)].filter((el) => {
      if (SELECTORS.replyExclude && el.closest(SELECTORS.replyExclude)) return false;
      const outer = el.parentElement?.closest(SELECTORS.markdown);
      return !outer || !message.contains(outer);
    });
  }

  function replyText(parts) {
    return parts
      .flatMap(markdownRoots)
      .map((r) => r.textContent)
      .join('\n');
  }

  function errorText(info) {
    const root = composerRoot();
    const scope = document.querySelector('main') || document.body;
    const el = all(SELECTORS.error, scope).find(
      (e) =>
        visible(e) &&
        e.innerText.trim() &&
        !e.closest(SELECTORS.markdown) &&
        !root?.contains(e) &&
        (!info.lastUser || info.lastUser.compareDocumentPosition(e) & Node.DOCUMENT_POSITION_FOLLOWING),
    );
    return el ? clip(el.innerText.trim(), 300) : null;
  }

  function hash(str) {
    let h = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return `${(h >>> 0).toString(16)}:${str.length}`;
  }

  function microtask() {
    return Promise.resolve();
  }

  // ---------------------------------------------------------------- status

  function snapshot() {
    const info = threadInfo();
    const isGenerating = generating();
    const text = replyText(info.replyParts);
    // Deep Research shows its own progress UI (UNVERIFIED); a strong sign of it counts as still working.
    const research = researchState(info.replyParts);
    const error = isGenerating || research.active ? null : errorText(info);
    let pageState;
    if (isGenerating || research.active) pageState = text.length > 0 ? 'streaming' : 'thinking';
    else if (error) pageState = 'error';
    else if (info.last_role === 'assistant') pageState = 'done';
    else pageState = 'idle';
    return {
      state: pageState,
      conversation_id: conversationId(),
      chars: text.length,
      uploading: uploading(),
      generating: isGenerating,
      error_text: error,
      last_role: info.last_role,
      user_count: info.user_count,
      assistant_count: info.assistant_count,
      last_user_id: info.last_user_id,
      last_assistant_id: info.last_assistant_id,
      last_user_hash: info.last_user_hash,
      has_reply: info.replyParts.length > 0,
      hash: hash(text),
      // Gemini (Chat and Task mode alike) holds a clicked send until the tab is shown, and renders no
      // attachment previews while hidden: the text stays in the composer.
      tab_hidden: document.visibilityState !== 'visible',
      composer_has_text: !!squash(readComposer(composer() || document.createElement('div'))),
      // The composer tool that is on ("Deep research" …), else null; and the research state of the current reply:
      // { active, progress, completed, frame, label, hash } (see researchState).
      tool: activeTool()?.label ?? null,
      research,
    };
  }

  function status() {
    const s = snapshot();
    return {
      state: s.state,
      conversation_id: s.conversation_id,
      chars: s.chars,
      uploading: s.uploading,
      tab_hidden: s.tab_hidden,
      // The selected mode of the composer's toggle (Gemini Chat / Task, new chats only; ChatGPT Chat / Work), else null.
      mode: modelState().mode,
      // An assistant reply follows the latest user message on the page (readable with get_latest_reply).
      has_reply: s.has_reply,
      last_role: s.last_role,
      tool: s.tool,
      research_active: s.research.active,
      research_progress: s.research.progress,
    };
  }

  function ready() {
    return {
      href: location.href,
      title: document.title,
      conversation_id: conversationId(),
      composer: !!composer(),
      login_required: !!firstVisible(SELECTORS.loginButton),
      messages: messageNodes().length,
    };
  }

  // ---------------------------------------------------------------- composer + send

  function readComposer(box) {
    return box instanceof HTMLTextAreaElement ? box.value : box.innerText;
  }

  function writeComposer(box, text, mode) {
    if (box instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set.call(box, text);
      box.dispatchEvent(new Event('input', { bubbles: true }));
      return;
    }
    box.focus();
    if (mode === 'execCommand') {
      const range = document.createRange();
      range.selectNodeContents(box);
      const sel = getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      try {
        document.execCommand('insertText', false, text); // replaces any leftover draft
      } catch {
        // verified by the caller, which falls back to the DOM path below
      }
      return;
    }
    // Fallback: rebuild the paragraphs directly; the editor picks the change up via its MutationObserver.
    box.replaceChildren(
      ...text.split('\n').map((line) => {
        const p = document.createElement('p');
        p.append(line ? document.createTextNode(line) : document.createElement('br'));
        return p;
      }),
    );
    box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText' }));
  }

  function clearComposer() {
    const box = composer();
    if (!box) return;
    if (box instanceof HTMLTextAreaElement) {
      writeComposer(box, '', 'value');
      return;
    }
    box.focus();
    const range = document.createRange();
    range.selectNodeContents(box);
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    try {
      document.execCommand('delete', false); // goes through the editor, so ChatGPT's saved draft is cleared too
    } catch {
      // fall through to the DOM path
    }
    if (squash(readComposer(box))) {
      box.replaceChildren(document.createElement('p'));
      box.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'deleteContentBackward' }));
    }
  }

  // expect_conversation_id NEW_CHAT: the tab must be on an empty new chat — no conversation id and no user
  // message yet. Sent in the same field as an id, so a content.js from before it fails closed (mismatch).
  const NEW_CHAT = 'new';

  async function fillComposer({ text, expect_conversation_id: expected }) {
    if (typeof text !== 'string' || !text.trim()) throw fail('INVALID_ARGUMENT', 'text is empty');
    const current = conversationId();
    const info = threadInfo();
    if (expected === NEW_CHAT ? current || info.user_count > 0 : expected && current !== expected) {
      const shows = current ? `conversation ${current}` : info.user_count > 0 ? `a new chat that already has ${info.user_count} message(s)` : `no conversation (${location.pathname})`;
      throw fail('CONVERSATION_MISMATCH', `MCP tab shows ${shows}, expected ${expected === NEW_CHAT ? 'an empty new chat' : expected}; nothing was typed`);
    }
    if (generating()) throw fail('STILL_GENERATING', 'ChatGPT is still generating a reply; nothing was typed');
    // A message sent into a running Deep Research could interrupt it (and its scarce quota).
    const research = researchState(info.replyParts);
    if (research.active) throw fail('STILL_GENERATING', `Deep Research still seems to be running (${research.label}); nothing was typed — wait for get_latest_reply / wait_command`);
    if (uploading()) throw fail('UPLOAD_IN_PROGRESS', 'a file upload is still in progress; nothing was typed');
    const box = composer();
    if (!box) throw fail('COMPOSER_NOT_FOUND', 'composer not found — update SELECTORS.composer (use inspect_page)');

    const want = squash(text);
    writeComposer(box, text, 'execCommand');
    await microtask();
    if (squash(readComposer(box)) !== want) {
      writeComposer(box, text, 'dom');
      await microtask();
    }
    const got = squash(readComposer(composer() || box));
    if (got !== want) {
      clearComposer();
      throw fail('INPUT_MISMATCH', `composer content differs after filling (expected ${want.length} non-space chars, got ${got.length}); nothing was sent`);
    }
    state.pendingText = want;
    return {
      conversation_id: current,
      tool: activeTool()?.label ?? null, // the composer tool the message goes out with

      baseline: {
        user_count: info.user_count,
        assistant_count: info.assistant_count,
        last_user_id: info.last_user_id,
        last_assistant_id: info.last_assistant_id,
        last_user_hash: info.last_user_hash,
        sent_hash: fingerprint(text), // the latest user message shows this once the send has gone out
      },
    };
  }

  // Clicks at most once per fill_composer: pendingText is consumed before the click.
  function clickSend() {
    if (state.pendingText == null) throw fail('NOTHING_TO_SEND', 'no filled message is pending; call fill_composer first');
    const box = composer();
    if (!box || squash(readComposer(box)) !== state.pendingText) {
      state.pendingText = null;
      throw fail('INPUT_MISMATCH', 'composer content changed before sending; nothing was sent');
    }
    if (generating()) return { clicked: false, reason: 'still generating' };
    const btn = firstVisible(SELECTORS.sendButton);
    if (!btn) return { clicked: false, reason: 'send button not found' };
    if (isDisabled(btn)) return { clicked: false, reason: 'send button disabled' };
    state.pendingText = null;
    btn.click();
    return { clicked: true };
  }

  // ---------------------------------------------------------------- model picker & mode toggle

  // Option matching, submenus and waiting live in the server; these commands only read and press.
  // Menus render in portals at the end of <body>, so they are searched globally, ignoring any item
  // that was already visible before the picker was opened.
  const MENU_CONTAINERS = ['[role="menu"]', '[role="listbox"]', '.cdk-overlay-pane', ':popover-open'];
  const MENU_ITEMS = ['[role="menuitemradio"]', '[role="menuitemcheckbox"]', '[role="menuitem"]', '[role="option"]'];
  const ICONS = 'mat-icon, gem-icon, svg, [aria-hidden="true"], .google-symbols, .material-symbols-outlined';

  function textLines(el) {
    let t = el.innerText ?? el.textContent ?? '';
    for (const icon of el.querySelectorAll(ICONS)) {
      const it = icon.textContent.trim();
      if (it) t = t.replace(it, '');
    }
    return t.split('\n').map((s) => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
  }
  const labelOf = (el) => textLines(el)[0] || el.getAttribute('aria-label') || '';

  // An explicit ARIA state is final; classes are only a fallback (".active" means focused, not chosen).
  function isSelected(el, stop) {
    for (let n = el; n && n !== stop; n = n.parentElement) {
      for (const a of ['aria-pressed', 'aria-checked', 'aria-selected']) {
        const v = n.getAttribute(a);
        if (v != null) return v === 'true';
      }
      if (['on', 'active', 'checked'].includes(n.getAttribute('data-state'))) return true;
      if ([...n.classList].some((c) => /(^|[-_])(selected|checked)$/i.test(c))) return true;
    }
    return false;
  }

  // A full pointer sequence, as from a real click: Radix opens menus on pointerdown, others on click.
  function press(el) {
    const r = el.getBoundingClientRect();
    const at = { bubbles: true, cancelable: true, composed: true, view: window, button: 0, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
    const pointer = { ...at, pointerId: 1, pointerType: 'mouse', isPrimary: true };
    el.dispatchEvent(new PointerEvent('pointerdown', { ...pointer, buttons: 1 }));
    el.dispatchEvent(new MouseEvent('mousedown', { ...at, buttons: 1 }));
    el.dispatchEvent(new PointerEvent('pointerup', pointer));
    el.dispatchEvent(new MouseEvent('mouseup', at));
    el.click();
  }

  const byDocumentOrder = (a, b) => (a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1);

  function menuItems(baseline) {
    const containers = all(MENU_CONTAINERS).filter(visible);
    let items = containers.flatMap((c) => all(MENU_ITEMS, c));
    if (!items.length) items = containers.flatMap((c) => all(['button', '[role="button"]', 'a[href]'], c));
    const skip = SELECTORS.menuSkip.join(', ');
    const found = [...new Set(items)].filter((el) => visible(el) && !baseline?.has(el) && !(skip && el.matches(skip)));
    return found.filter((el) => !found.some((o) => o !== el && o.contains(el))).sort(byDocumentOrder);
  }

  // Level of a slider item: aria-valuetext / aria-valuenow, or the live region next to it ("Pro, 5 of 5.").
  function sliderLevel(item, slider) {
    const said = item.parentElement?.querySelector('[role="status"]')?.textContent.trim().match(/^(.+?),\s*(\d+)\D+(\d+)\.?$/);
    const num = (a) => (slider.hasAttribute(a) ? Number(slider.getAttribute(a)) : null);
    return {
      value: slider.getAttribute('aria-valuetext') || said?.[1] || null,
      position: said ? Number(said[2]) : num('aria-valuenow'),
      count: said ? Number(said[3]) : num('aria-valuemax'),
    };
  }

  function describeItem(el, index) {
    const [label = el.getAttribute('aria-label') || '', ...rest] = textLines(el);
    const disabled = isDisabled(el) || el.hasAttribute('data-disabled');
    const slider = el.querySelector('[role="slider"]');
    if (slider) return { index, kind: 'slider', label: el.getAttribute('aria-label') || label, ...sliderLevel(el, slider), disabled };
    const described = (el.getAttribute('aria-describedby') || '')
      .split(/\s+/)
      .map((id) => id && document.getElementById(id)?.textContent.trim())
      .filter(Boolean);
    const popup = el.getAttribute('aria-haspopup');
    return {
      index,
      label,
      description: rest.length || described.length ? clip([...rest, ...described].join(' '), 160) : null,
      selected: isSelected(el, el.parentElement) || !!el.querySelector('[aria-checked="true"], [data-state="checked"]'),
      disabled,
      submenu: popup === 'menu' || popup === 'true' || el.hasAttribute('aria-expanded'),
    };
  }

  function modeButtons() {
    const group = firstVisible(SELECTORS.modeToggle);
    if (!group) return null;
    return { group, buttons: [...new Set(all(['button', '[role="radio"]', '[role="tab"]'], group))].filter(visible).sort(byDocumentOrder) };
  }

  function modelState() {
    const btn = firstVisible(SELECTORS.modelButton);
    const g = modeButtons();
    const modes = g ? g.buttons.map((b) => ({ label: labelOf(b), selected: isSelected(b, g.group) })) : null;
    return { model: btn ? labelOf(btn) : null, modes, mode: modes?.find((m) => m.selected)?.label ?? null, tool: activeTool()?.label ?? null };
  }

  function setMode({ index, label }) {
    const el = modeButtons()?.buttons[index];
    if (!el || labelOf(el) !== label) throw fail('MENU_CHANGED', 'the mode toggle changed; nothing was pressed');
    if (isDisabled(el)) throw fail('MODE_UNAVAILABLE', `mode "${label}" is disabled`);
    press(el);
    return { pressed: label };
  }

  function openModelMenu() {
    const btn = firstVisible(SELECTORS.modelButton);
    if (!btn) throw fail('MODEL_PICKER_NOT_FOUND', 'model picker button not found — fix SELECTORS.modelButton (inspect_page)');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    state.menuBaseline = expanded ? new Set() : new Set(menuItems(null));
    if (!expanded) press(btn);
    return { model: labelOf(btn) };
  }

  function readModelMenu() {
    state.menuItems = menuItems(state.menuBaseline);
    return { items: state.menuItems.map(describeItem) };
  }

  function chooseModelItem({ index, label }) {
    const el = state.menuItems[index];
    if (!el || !visible(el) || describeItem(el, index).label !== label) throw fail('MENU_CHANGED', 'the model menu changed or closed; nothing was pressed');
    press(el);
    return { pressed: label };
  }

  // One arrow key on the slider; it bubbles to the menu item, which handles it on ChatGPT.
  function sliderKey({ index, label, key }) {
    const el = state.menuItems[index];
    const slider = el?.querySelector('[role="slider"]');
    if (!slider || !visible(el) || describeItem(el, index).label !== label) throw fail('MENU_CHANGED', 'the slider changed or the menu closed');
    if (key !== 'ArrowLeft' && key !== 'ArrowRight') throw fail('INVALID_ARGUMENT', `unsupported key: ${key}`);
    for (const type of ['keydown', 'keyup']) {
      slider.dispatchEvent(new KeyboardEvent(type, { key, code: key, bubbles: true, cancelable: true, composed: true }));
    }
    return {};
  }

  // which: "tools" when the composer's "+" menu is the one open (its button toggles it shut).
  function closeModelMenu({ force = false, which = 'model' }) {
    if (!force) {
      const target = document.activeElement || document.body;
      for (const type of ['keydown', 'keyup']) {
        target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true, composed: true }));
      }
      return { method: 'escape' };
    }
    const backdrop = firstVisible('.cdk-overlay-backdrop');
    const btn = firstVisible(which === 'tools' ? SELECTORS.toolsButton : SELECTORS.modelButton);
    if (backdrop) press(backdrop);
    else if (btn && btn.getAttribute('aria-expanded') !== 'false') press(btn);
    return { method: backdrop ? 'backdrop' : 'toggle' };
  }

  // ---------------------------------------------------------------- composer tools (ChatGPT "+" menu)
  //
  // tools_menu_open presses the "+" button; tools_menu_read / tools_menu_choose then work like the model menu's (the
  // server walks submenus such as "More" and matches labels). Items that add files or photos are never pressed: they
  // open the OS file dialog. activeTool reads which tool is on from the composer (UNVERIFIED, see toolPill).

  const NOT_A_TOOL = /photo|file|upload|image from|camera|照片|文件|上传|相机/i;
  const toolKey = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
  // "Deep research, click to remove" / "Remove Deep research" / "Deep research ×" → "Deep research"
  const toolNameOf = (s) =>
    String(s ?? '')
      .replace(/[,，]?\s*(click to remove|点击移除)\s*$/i, '')
      .replace(/^(remove|clear|移除|删除)\s*/i, '')
      .replace(/\s*[×✕✖]\s*$/, '')
      .replace(/\s+/g, ' ')
      .trim();

  function openToolsMenu() {
    if (!SELECTORS.toolsButton.length) throw fail('NOT_SUPPORTED', `composer tools are not supported on ${SITE} yet`);
    const btn = firstVisible(SELECTORS.toolsButton);
    if (!btn) throw fail('TOOLS_BUTTON_NOT_FOUND', 'the composer "+" button was not found — fix SELECTORS.toolsButton (inspect_page selector "form")');
    if (isDisabled(btn)) throw fail('TOOLS_UNAVAILABLE', 'the composer "+" button is disabled');
    const expanded = btn.getAttribute('aria-expanded') === 'true';
    state.menuBaseline = expanded ? new Set() : new Set(menuItems(null));
    if (!expanded) press(btn);
    return { opened: true, button: btn.getAttribute('aria-label') || labelOf(btn), tool: activeTool()?.label ?? null };
  }

  function readToolsMenu() {
    const out = readModelMenu();
    for (const i of out.items) if (i.label && !i.submenu && i.kind !== 'slider' && !NOT_A_TOOL.test(i.label)) state.toolLabels.add(toolNameOf(i.label));
    return out;
  }

  function chooseTool(args) {
    if (NOT_A_TOOL.test(args.label || '')) throw fail('NOT_A_TOOL', `"${args.label}" adds files — it is never pressed`);
    return chooseModelItem(args);
  }

  // { label, el } of the tool that is on, else null. A toggle button counts only while pressed; a pill (toolPill) or a
  // control labelled with a known tool name counts by being there. The prompt, the "+" button and attachments are
  // never one.
  function activeTool() {
    if (!SELECTORS.toolsButton.length) return null;
    const root = composerRoot();
    if (!root) return null;
    const box = composer();
    const plus = firstVisible(SELECTORS.toolsButton, root);
    const chips = attachmentChips();
    const pillSel = SELECTORS.toolPill.join(', ');
    const names = [...new Set([...state.toolLabels, ...SELECTORS.toolNames].map(toolKey))].filter(Boolean);
    const cands = [...new Set([...all(SELECTORS.toolPill, root), ...all(['button', '[role="button"]', '[aria-pressed]'], root)])].sort(byDocumentOrder);
    for (const el of cands) {
      if (!visible(el) || el.getAttribute('aria-pressed') === 'false') continue;
      if (box && (box.contains(el) || el.contains(box))) continue;
      if (plus && (plus === el || plus.contains(el) || el.contains(plus))) continue;
      if (chips.some((c) => c.contains(el) || el.contains(c))) continue;
      const label = toolNameOf(el.getAttribute('aria-label') || textLines(el)[0] || '');
      if (!label || NOT_A_TOOL.test(label)) continue;
      const key = toolKey(label);
      const known = names.some((n) => key === n || key.startsWith(`${n} `) || key.startsWith(`${n},`));
      let pill = false;
      try {
        pill = !!pillSel && el.matches(pillSel);
      } catch {
        // selector unsupported by this Chrome build
      }
      if (known || (pill && label.length <= 40)) return { label, el };
    }
    return null;
  }

  // Turns the active tool off: the pill's remove control, the pill itself when it says "click to remove", or a pressed
  // toggle pressed again. The server checks the result (and falls back to the "+" menu).
  function toolClear() {
    const t = activeTool();
    if (!t) return { pressed: null, tool: null };
    const ok = (b) => !/file|文件/i.test(b.getAttribute('aria-label') || '') && !attachmentChips().some((c) => c.contains(b));
    const inside = all(SELECTORS.toolRemove, t.el).filter(ok);
    let btn = inside.find(visible) || inside[0] || null;
    if (!btn && /remove|移除|删除/i.test(t.el.getAttribute('aria-label') || '')) btn = t.el;
    if (!btn && t.el.parentElement) btn = all(SELECTORS.toolRemove, t.el.parentElement).filter(ok).find(visible) || null;
    if (!btn && t.el.getAttribute('aria-pressed') === 'true') btn = t.el;
    if (!btn) return { pressed: null, tool: t.label, reason: `no remove control found on the "${t.label}" pill` };
    press(btn);
    return { pressed: describe(btn), tool: t.label };
  }

  // ---------------------------------------------------------------- Deep Research state (UNVERIFIED)

  // Text of the current reply outside its Markdown, its thinking panels and its buttons: status rows such as
  // "Researching…" / "Research completed in 12m". Short lines only, so a thought summary is not taken for one.
  function cardLines(parts) {
    const skipSel = [SELECTORS.markdown, SELECTORS.replyExclude, '.sr-only', 'script', 'style', 'svg', 'button'].filter(Boolean).join(', ');
    const lines = [];
    for (const part of parts) {
      const walker = document.createTreeWalker(part, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.nodeType === 1 ? (n.matches(skipSel) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP) : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = walker.nextNode(); n && lines.length < 200; n = walker.nextNode()) {
        const t = n.data.replace(/\s+/g, ' ').trim();
        if (t) lines.push(t);
      }
    }
    return lines;
  }

  // active: a research-specific sign that it is still running (a "stop research" control, a status row such as
  // "Researching…"); progress: a progress indicator in the reply (only counts for a research send, see the server);
  // completed: a "Research completed …" row; frame: the reply holds an iframe (a report there is unreadable from here
  // unless it is same-origin); hash: of the status rows, so the server sees them change.
  function researchState(parts) {
    const none = { active: false, progress: false, completed: false, frame: false, label: null, hash: null };
    if (!parts.length || !(SELECTORS.researchBusyText || SELECTORS.researchBusy.length)) return none;
    const lines = cardLines(parts);
    const short = lines.filter((l) => l.length <= 80);
    const outsideMd = (sel) => parts.flatMap((p) => all(sel, p)).find((el) => visible(el) && !el.closest(SELECTORS.markdown)) || null;
    const busyEl = outsideMd(SELECTORS.researchBusy);
    const busyLine = (SELECTORS.researchBusyText && short.find((l) => SELECTORS.researchBusyText.test(l))) || null;
    const doneLine = (SELECTORS.researchDoneText && short.find((l) => SELECTORS.researchDoneText.test(l))) || null;
    const progressEl = outsideMd(SELECTORS.researchProgress);
    return {
      active: !doneLine && !!(busyEl || busyLine),
      progress: !doneLine && !!progressEl,
      completed: !!doneLine,
      frame: parts.some((p) => !!p.querySelector('iframe')),
      label: busyLine || (busyEl ? describe(busyEl) : doneLine),
      hash: hash(lines.join('\n')),
    };
  }

  // ---------------------------------------------------------------- projects (ChatGPT)

  function projectButtons() {
    return all(SELECTORS.projectNewChat)
      .map((el) => ({ el, name: (el.getAttribute('aria-label') || '').match(SELECTORS.projectName)?.[1]?.trim() }))
      .filter((p) => p.name);
  }

  function openProject({ name }) {
    const p = projectButtons().find((x) => x.name === name);
    if (!p) throw fail('PROJECT_NOT_FOUND', `no "New chat in ${name}" button in the sidebar`);
    press(p.el);
    return { pressed: name };
  }

  // ---------------------------------------------------------------- uploads
  //
  // upload_begin / upload_chunk stream the files in; upload_commit { method } tries one way of attaching
  // them (methods: SELECTORS.uploadMethods, in order) and upload_verify tells the server whether the
  // composer now shows them. The files stay here until upload_release / upload_abort, so the server can
  // fall back to the next method when the site silently ignores one. Waiting is the server's job.

  function b64ToBytes(b64) {
    if (typeof Uint8Array.fromBase64 === 'function') return Uint8Array.fromBase64(b64);
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function uploadBegin({ upload_id: id, files }) {
    state.uploads.set(id, { files: files.map((f) => ({ ...f, parts: [], received: 0 })), built: null, baseline: null, attached: false, carrier: null, menu: null, dropped: null });
    return { ok: true, methods: SELECTORS.uploadMethods };
  }

  function uploadChunk({ upload_id: id, index, b64 }) {
    const file = state.uploads.get(id)?.files[index];
    if (!file?.parts) throw fail('UPLOAD_NOT_FOUND', `unknown upload ${id}/${index}`);
    const bytes = b64ToBytes(b64);
    file.parts.push(bytes);
    file.received += bytes.length;
    return { received: file.received };
  }

  function uploadRelease({ upload_id: id }) {
    const up = state.uploads.get(id);
    state.uploads.delete(id);
    for (const el of document.querySelectorAll('[data-mcp-clicked]')) el.removeAttribute('data-mcp-clicked');
    if (up) {
      up.carrier?.remove();
      if (up.menu && menuItems(up.menu.baseline).length) closeOverlayMenus();
      if (up.dropped && !up.attached) for (const t of up.dropped.targets) if (t.isConnected) up.dropped.fire(t, 'dragleave');
    }
    return { released: !!up };
  }

  function uploadOf(id) {
    const up = state.uploads.get(id);
    if (!up) throw fail('UPLOAD_NOT_FOUND', `unknown upload ${id}`);
    return up;
  }

  function pickFileInput(files, candidates = document.querySelectorAll(SELECTORS.fileInput)) {
    const allImages = files.every((f) => f.type.startsWith('image/'));
    const root = composerRoot();
    let best = null;
    let bestScore = -Infinity;
    for (const input of candidates) {
      if (input.disabled) continue;
      const accept = (input.getAttribute('accept') || '').trim();
      const imageOnly = !!accept && accept.split(',').every((a) => /^(image\/|\.(png|jpe?g|gif|webp|heic)$)/i.test(a.trim()));
      if (imageOnly && !allImages) continue;
      const score = (accept ? 0 : 2) + (input.multiple ? 1 : 0) + (root?.contains(input) ? 1 : 0) - (imageOnly ? 1 : 0);
      if (score > bestScore) {
        best = input;
        bestScore = score;
      }
    }
    return best;
  }

  function transfer(files) {
    const dt = new DataTransfer();
    for (const f of files) dt.items.add(f);
    return dt;
  }

  // ---- post-check: does the composer show the files?

  const ATTACHMENT_ATTRS = ['aria-label', 'title', 'alt', 'data-filename', 'data-file-name', 'mattooltip'];
  const ALERTS = ['[role="alert"]', 'mat-snack-bar-container', '.mat-mdc-snack-bar-container'];
  const keyOf = (s) => String(s ?? '').normalize('NFKC').toLowerCase().replace(/\s+/g, '');
  const outermost = (els) => els.filter((el) => !els.some((o) => o !== el && o.contains(el)));

  function attachmentScope() {
    const box = composer();
    if (box) {
      for (const s of SELECTORS.attachmentScope) {
        const scope = box.closest(s);
        if (scope) return scope;
      }
    }
    return composerRoot();
  }

  // Never a preview: the prompt itself (its text may name the file) and the site's ignore list.
  function notPreview(el) {
    const box = composer();
    return (!!box && box.contains(el)) || (!!SELECTORS.attachmentIgnore && !!el.closest(SELECTORS.attachmentIgnore));
  }

  function attachmentChips() {
    const scope = attachmentScope();
    // One element can match several selectors (uploader-file-preview.file-preview-chip): count it once.
    return scope ? outermost([...new Set(all(SELECTORS.attachment, scope))].filter((el) => visible(el) && !notPreview(el))) : [];
  }

  // A shown name: the whole name, the name without its extension (sites print the type separately), or a
  // shortened "long-file-na…" form.
  function namesFile(text, name) {
    if (!text) return false;
    if (text.includes(name)) return true;
    const stem = name.replace(/\.[^.]*$/, '');
    if (stem.length >= 3 && stem !== name && text.includes(stem)) return true;
    const cut = text.match(/^(.{4,}?)(?:…|\.\.\.)/);
    return !!cut && name.startsWith(cut[1]);
  }

  // Per file, how many elements in the preview area name it (the deepest element whose text does, plus
  // elements whose label/title/alt does); the number of preview chips and of thumbnails.
  function attachmentState(files) {
    const scope = attachmentScope();
    if (!scope) return { names: files.map(() => 0), chips: 0, thumbs: 0 };
    const els = [...scope.querySelectorAll('*')].filter((el) => !INSPECT_NOISE.has(el.localName) && !notPreview(el) && visible(el));
    const texts = new Map(els.map((el) => [el, keyOf(el.textContent)]));
    const names = files.map((f) => {
      const name = keyOf(f.name);
      const byText = els.filter((el) => namesFile(texts.get(el), name));
      const hits = new Set(byText.filter((el) => !byText.some((o) => o !== el && el.contains(o))));
      for (const el of els) if (ATTACHMENT_ATTRS.some((a) => namesFile(keyOf(el.getAttribute(a)), name))) hits.add(el);
      return hits.size;
    });
    const thumbs = els.filter((el) => el.localName === 'img' || el.localName === 'canvas' || el.localName === 'video').length;
    return { names, chips: attachmentChips().length, thumbs };
  }

  function alertText() {
    const el = all(ALERTS).find((e) => visible(e) && e.innerText?.trim());
    return el ? clip(el.innerText.trim().replace(/\s+/g, ' '), 200) : null;
  }

  // Attached when every file's name newly shows in the preview area; files without a shown name count
  // when enough new preview chips (any file) or thumbnails (images only) appeared for them.
  function uploadVerify({ upload_id: id }) {
    const up = uploadOf(id);
    if (!up.built) throw fail('UPLOAD_NOT_COMMITTED', `upload ${id} was never committed`);
    const now = attachmentState(up.built);
    const base = up.baseline;
    const named = up.built.map((f, i) => now.names[i] > base.names[i]);
    const missing = up.built.filter((f, i) => !named[i]);
    const chipsAdded = now.chips - base.chips;
    const thumbsAdded = now.thumbs - base.thumbs;
    const spareChips = Math.max(0, chipsAdded - (up.built.length - missing.length));
    const unnamedDocs = missing.filter((f) => !f.type.startsWith('image/')).length;
    up.attached = missing.length === 0 || (unnamedDocs <= spareChips && missing.length <= spareChips + Math.max(0, thumbsAdded));
    return {
      attached: up.attached,
      shown: up.built.filter((f, i) => named[i]).map((f) => f.name),
      missing: missing.map((f) => f.name),
      chips_added: chipsAdded,
      thumbs_added: thumbsAdded,
      uploading: uploading(),
      // picker only: whether the page asked for a file chooser and was handed the files
      intercepted: up.carrier ? up.carrier.hasAttribute('data-mcp-used') : null,
      alert: alertText(),
      // Gemini shows no attachment previews in a hidden tab (confirmed 2026-11-22: the same upload attaches at
      // once when the tab is visible).
      tab_hidden: document.visibilityState !== 'visible',
    };
  }

  // ---- ways to attach. Each returns { applied, via?, reason?, handoff?, pending? }: applied = the files
  // were handed to the page; handoff = handed to the site's own file input, so if no preview shows up the
  // site rejected them and another method would only risk attaching them twice.

  // Main-world hook (background.js installFileChooserHook) answers the site's input.click() with the
  // files of this hidden carrier input; it marks the carrier data-mcp-used. Expires on its own.
  function placeCarrier(up) {
    up.carrier?.remove();
    const c = document.createElement('input');
    c.type = 'file';
    c.multiple = true;
    c.hidden = true;
    c.tabIndex = -1;
    c.setAttribute('aria-hidden', 'true');
    c.setAttribute('data-mcp-file-carrier', '');
    c.setAttribute('data-mcp-expires', String(Date.now() + 60_000));
    c.files = transfer(up.built).files;
    (document.body || document.documentElement).append(c);
    up.carrier = c;
    return c;
  }

  function chooserAnswered(up, via) {
    const used = up.carrier?.getAttribute('data-mcp-used');
    if (used == null) return { applied: false, pending: 'chooser', via };
    return { applied: true, handoff: true, via: `${via} → ${used || 'file chooser'}` };
  }

  const UPLOAD_ITEM = /^((upload|add) (files?|documents?)|upload( from (this )?(computer|device))?|files?|上传(文件)?|添加文件|从(电脑|设备)上传|本地文件)$/i;
  const UPLOAD_ITEM_LOOSE = /upload|上传|^add files?\b/i;
  const UPLOAD_ITEM_AVOID = /drive|photo|code|notebook|folder|link|url|camera|云端硬盘|相册|照片|代码|文件夹|链接|相机/i;

  function pickUploadItem(items) {
    const ok = items.filter((i) => i.kind !== 'slider' && !i.disabled && !UPLOAD_ITEM_AVOID.test(i.label));
    return ok.find((i) => UPLOAD_ITEM.test(i.label)) || ok.find((i) => UPLOAD_ITEM_LOOSE.test(i.label)) || null;
  }

  function closeOverlayMenus() {
    const target = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true, composed: true }));
    }
    const backdrop = firstVisible('.cdk-overlay-backdrop');
    if (backdrop) press(backdrop);
  }

  const short = (el) => `${el.localName}${[...el.classList].slice(0, 1).map((c) => `.${c}`).join('')}`;

  const ATTACH = {
    // A file input somewhere else on the page may belong to another feature: not a sure handoff.
    input(up) {
      const input = pickFileInput(up.built);
      if (!input) return { applied: false, reason: 'no usable input[type=file] on the page' };
      input.files = transfer(up.built).files;
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return { applied: true, handoff: !!attachmentScope()?.contains(input), via: describe(input) };
    },

    // The site's own upload button; its menu (if any) is walked by upload_menu_step.
    picker(up) {
      if (!document.documentElement.hasAttribute('data-mcp-chooser-hook')) {
        return { applied: false, reason: 'file-chooser hook not installed (reload the extension)' };
      }
      placeCarrier(up);
      const trigger = all(SELECTORS.uploadTrigger).find((t) => !isDisabled(t));
      if (trigger) {
        trigger.click();
        return chooserAnswered(up, `picker ${describe(trigger)}`);
      }
      const btn = firstVisible(SELECTORS.uploadMenuButton);
      if (!btn || isDisabled(btn)) {
        up.carrier.remove();
        return { applied: false, reason: btn ? 'the upload button is disabled' : 'no upload button found' };
      }
      const open = btn.getAttribute('aria-expanded') === 'true';
      up.menu = {
        baseline: open ? new Set() : new Set(menuItems(null)),
        inputsBefore: new Set(document.querySelectorAll(SELECTORS.fileInput)),
        depth: 0,
        via: `picker ${btn.getAttribute('aria-label') || btn.localName}`,
      };
      if (!open) press(btn);
      return { applied: false, pending: 'menu', via: up.menu.via };
    },

    // A paste of the files into the prompt, as from a screenshot or a file copied in Finder.
    paste(up) {
      const box = composer();
      if (!box) return { applied: false, reason: 'composer not found' };
      const ev = new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: transfer(up.built) });
      if (!ev.clipboardData?.files?.length) return { applied: false, reason: 'this Chrome cannot build a paste event carrying files' };
      box.focus();
      box.dispatchEvent(ev);
      // Gemini shows a pasted file's preview only after several seconds at times: wait long before moving on.
      return { applied: true, patient: true, via: `paste on ${short(box)}${ev.defaultPrevented ? ' (handled)' : ' (not handled)'}` };
    },

    // Drag over the prompt into the site's drop zone; an overlay shown on dragenter gets the drop.
    drop(up) {
      const box = composer();
      const first = box || composerRoot();
      if (!first) return { applied: false, reason: 'no composer to drop onto' };
      const zone = SELECTORS.dropzone.map((s) => first.closest(s)).find(Boolean) || composerRoot() || first;
      const dt = transfer(up.built);
      dt.effectAllowed = 'copy';
      const r = first.getBoundingClientRect();
      const at = { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
      const fire = (el, type) => el.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, composed: true, dataTransfer: dt, ...at }));
      fire(first, 'dragenter');
      fire(first, 'dragover');
      const over = r.width && r.height ? document.elementFromPoint(at.clientX, at.clientY) : null;
      const target = over && over !== first && zone.contains(over) && !first.contains(over) ? over : first;
      if (target !== first) {
        fire(target, 'dragenter');
        fire(target, 'dragover');
      }
      fire(target, 'drop');
      // An ignored drop could leave the site's drop overlay up; uploadRelease sends dragleave then.
      up.dropped = { targets: [...new Set([target, first, zone])], fire };
      return { applied: true, via: `drop on ${short(target)}` };
    },
  };

  function uploadCommit({ upload_id: id, method }) {
    const up = uploadOf(id);
    if (!up.built) {
      for (const f of up.files) {
        if (f.received !== f.size) throw fail('UPLOAD_INCOMPLETE', `${f.name}: received ${f.received} of ${f.size} bytes`);
      }
      up.built = up.files.map((f) => new File(f.parts, f.name, { type: f.mime, lastModified: Date.now() }));
      for (const f of up.files) f.parts = null;
      up.baseline = attachmentState(up.built);
    }
    const files = up.built.map((f) => f.name);
    if (method == null) {
      // Server from before the post-check: one shot, as it used to be.
      state.uploads.delete(id);
      let out = ATTACH.input(up);
      if (!out.applied) out = ATTACH.drop(up);
      if (!out.applied) throw fail('FILE_INPUT_NOT_FOUND', 'no input[type=file] and no composer to drop onto — update SELECTORS (use inspect_page)');
      return { files, via: out.via };
    }
    const attach = Object.hasOwn(ATTACH, method) ? ATTACH[method] : null;
    if (!attach) throw fail('INVALID_ARGUMENT', `unknown upload method: ${method}`);
    return { files, method, ...attach(up) };
  }

  // After picker opened the upload menu: press its upload item (descending into a submenu if needed).
  function uploadMenuStep({ upload_id: id }) {
    const up = uploadOf(id);
    if (!up.menu) throw fail('UPLOAD_NOT_FOUND', `upload ${id} has no open upload menu`);
    const els = menuItems(up.menu.baseline);
    if (!els.length) return { applied: false, pending: 'menu', via: up.menu.via };
    const items = els.map(describeItem);
    const hit = pickUploadItem(items);
    if (!hit) {
      closeOverlayMenus();
      up.menu = null;
      up.carrier?.remove();
      return { applied: false, reason: `no upload item in the menu (${items.map((i) => JSON.stringify(i.label)).join(', ')})` };
    }
    const via = `${up.menu.via} → ${JSON.stringify(hit.label)}`;
    // A menu item that wraps its own file input (label > input): fill that input instead of clicking.
    const own = els[hit.index].matches('input[type="file"]') ? els[hit.index] : els[hit.index].querySelector('input[type="file"]') || els[hit.index].control;
    if (own instanceof HTMLInputElement && own.type === 'file' && !own.disabled) {
      own.files = transfer(up.built).files;
      own.dispatchEvent(new Event('input', { bubbles: true }));
      own.dispatchEvent(new Event('change', { bubbles: true }));
      closeOverlayMenus();
      up.menu = null;
      return { applied: true, handoff: true, via: `${via} → ${describe(own)}` };
    }
    up.menu.item = describe(els[hit.index]);
    press(els[hit.index]);
    if (hit.submenu && up.menu.depth < 2) {
      up.menu = { baseline: new Set([...up.menu.baseline, ...els]), depth: up.menu.depth + 1, via };
      return { applied: false, pending: 'menu', via };
    }
    up.menu.via = via;
    const answered = chooserAnswered(up, via);
    return answered.applied ? answered : fillChooserInput(up, via) || answered;
  }

  // The page clicked a hidden selector button (marked data-mcp-clicked by the main-world hook) but asked
  // for no chooser, e.g. because it waits for a frame that a hidden tab never renders. Do what the OS
  // dialog would: put the files into the file input belonging to that button — else one that appeared
  // with the menu — and fire input/change. The carrier is marked used first, so a chooser call arriving
  // later passes through instead of attaching the files a second time.
  function fillChooserInput(up, via) {
    const clicked = document.querySelector('[data-mcp-clicked]');
    const usable = (list) => [...list].filter((i) => !i.disabled && !i.webkitdirectory && !i.hasAttribute('directory'));
    let input = null;
    for (let anc = clicked, depth = 0; anc && depth < 5 && !input; anc = anc.parentElement, depth++) {
      input = pickFileInput(up.built, usable(anc.querySelectorAll(SELECTORS.fileInput)));
    }
    const all = usable(document.querySelectorAll(SELECTORS.fileInput));
    input ||= pickFileInput(up.built, all.filter((i) => !up.menu?.inputsBefore?.has(i)));
    if (!input) return null;
    up.carrier?.setAttribute('data-mcp-used', 'filled');
    input.files = transfer(up.built).files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { applied: true, handoff: true, via: `${via}${clicked ? ` → ${short(clicked)}` : ''} → filled ${describe(input)}` };
  }

  // picker gave up (no menu item, chooser never asked for): take the files back, close the menu and say
  // what the page did meanwhile (programmatic clicks / picker calls the main-world hook noted on the carrier).
  function uploadPickerCancel({ upload_id: id }) {
    const up = uploadOf(id);
    const diag = {
      cancelled: true,
      item: up.menu?.item ?? null,
      page_calls: up.carrier?.getAttribute('data-mcp-seen') || null,
      file_inputs: document.querySelectorAll(SELECTORS.fileInput).length,
      menu_open: !!up.menu && menuItems(up.menu.baseline).length > 0,
      tab_hidden: document.visibilityState !== 'visible',
    };
    up.carrier?.remove();
    up.carrier = null;
    for (const el of document.querySelectorAll('[data-mcp-clicked]')) el.removeAttribute('data-mcp-clicked');
    if (diag.menu_open) closeOverlayMenus();
    up.menu = null;
    return diag;
  }

  // ---------------------------------------------------------------- files in replies (list_files / download_file)
  //
  // files_list names the file chips of one assistant reply (message 0 = the latest, 1 = the one before …) and
  // file_click presses one. The browser download that the click starts is caught by background.js. A preview chip
  // opens a panel instead: file_preview_state finds it (polled by the server), then file_preview_download presses
  // its download control, or file_preview_text reads what it shows, and file_preview_close closes it.

  // Assistant replies, oldest first: each is the run of assistant messages between two user messages.
  function replyGroups() {
    const groups = [];
    let run = null;
    let lastRole = null;
    for (const m of messageNodes()) {
      lastRole = m.role;
      if (m.role === 'user') {
        run = null;
        continue;
      }
      if (!run) groups.push((run = []));
      run.push(m.el);
    }
    return { groups, lastRole };
  }

  function replyAt(message) {
    const back = message == null || message === 'latest' ? 0 : Number(message);
    if (!Number.isInteger(back) || back < 0) throw fail('INVALID_ARGUMENT', '"message" must be "latest" or a whole number of replies back');
    const { groups, lastRole } = replyGroups();
    if (!groups.length) throw fail('NO_REPLY', 'the page shows no assistant reply');
    if (back >= groups.length) {
      const n = groups.length;
      throw fail('MESSAGE_NOT_FOUND', `the page holds ${n} assistant repl${n === 1 ? 'y' : 'ies'} (message 0${n > 1 ? `–${n - 1}` : ''}); long ChatGPT threads keep only the latest turn in the DOM`);
    }
    return { parts: groups[groups.length - 1 - back], back, count: groups.length, current: back === 0 && lastRole === 'assistant' };
  }

  const fileKey = (s) => String(s ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();

  // { kind, name, label } when the control's label names a file and its text shows that name (or the start of it).
  function chipFile(el) {
    const label = fileKey(el.getAttribute('aria-label'));
    for (const [re, kind] of SELECTORS.fileChipLabel) {
      const name = label.match(re)?.[1]?.trim();
      if (!name) continue;
      const text = fileKey(el.textContent).replace(/(…|\.\.\.)$/, '');
      if (text && (text.includes(name) || (text.length >= 4 && name.startsWith(text)))) return { kind, name, label };
    }
    return null;
  }

  function fileChips(parts) {
    const found = new Set();
    for (const part of parts) for (const el of all(SELECTORS.fileChip, part)) found.add(el);
    const chips = [];
    for (const el of [...found].sort(byDocumentOrder)) {
      if (SELECTORS.replyExclude && el.closest(SELECTORS.replyExclude)) continue;
      const f = chipFile(el);
      if (f) chips.push({ el, ...f });
    }
    return chips.filter((c) => !chips.some((o) => o !== c && o.el.contains(c.el)));
  }

  // Export / download controls of a report (UNVERIFIED: Deep Research) in the reply, or in an open dialog showing a
  // report (a report view): kind "export", named by their label; menu = it opens a menu of formats.
  function exportControls(parts) {
    if (!SELECTORS.exportLabel) return [];
    const scopes = [...parts, ...all('[role="dialog"]').filter((d) => visible(d) && d.querySelector(SELECTORS.markdown))];
    const found = new Set();
    for (const s of scopes) for (const el of all(SELECTORS.exportControl, s)) found.add(el);
    const labelled = (el) => fileKey(el.getAttribute('aria-label') || el.textContent);
    const hits = [...found]
      .sort(byDocumentOrder)
      .filter((el) => visible(el) && !el.closest(SELECTORS.markdown) && !chipFile(el) && SELECTORS.exportLabel.test(labelled(el)));
    return outermost(hits).map((el) => {
      const popup = el.getAttribute('aria-haspopup');
      return { el, kind: 'export', name: labelled(el), label: labelled(el), menu: popup === 'menu' || popup === 'true' || el.hasAttribute('aria-expanded') };
    });
  }

  // File chips first, then export controls; list_files' index refers to this order.
  function replyFiles(parts) {
    return [...fileChips(parts), ...exportControls(parts)];
  }

  function filesList({ message }) {
    if (!SELECTORS.fileChip.length) return { supported: false, conversation_id: conversationId(), files: [] };
    const r = replyAt(message);
    return {
      supported: true,
      conversation_id: conversationId(),
      message: r.back,
      replies: r.count,
      // false: the latest message is the user's, so this is the reply before it
      current: r.current,
      generating: generating(),
      files: replyFiles(r.parts).map(({ kind, name, label, menu }, index) => ({ index, name, kind, label, ...(kind === 'export' && { menu }) })),
    };
  }

  function fileClick({ message, index, name }) {
    const chip = replyFiles(replyAt(message).parts)[index];
    if (!chip || chip.name !== name) throw fail('FILE_CHANGED', `the reply no longer shows "${name}" as file ${index} — call list_files again; nothing was clicked`);
    if (chip.kind === 'preview') {
      // What is on the page before the click, so the panel is told apart by what appears.
      state.preview = { name, chip: chip.el, controls: new Set(previewControls()), panels: new Set(all(SELECTORS.previewPanel)), control: null, panel: null };
    }
    // An export control may open a menu of formats: read afterwards with model_menu_read (new items only).
    if (chip.kind === 'export') state.menuBaseline = new Set(menuItems(null));
    press(chip.el);
    return { clicked: true, kind: chip.kind, name };
  }

  function previewControls() {
    const els = new Set(all(SELECTORS.previewDownload));
    for (const b of all(['button', '[role="button"]'])) if (/^(download|下载)$/i.test(fileKey(b.textContent))) els.add(b);
    return [...els];
  }

  function previewState() {
    const p = state.preview;
    if (!p) throw fail('NO_PREVIEW', 'no preview was opened — file_click a preview chip first');
    const key = fileKey(p.name);
    const names = (el) => fileKey(el.textContent).includes(key) || fileKey(el.getAttribute('aria-label')).includes(key);
    // Never the chip, the reply around it, or anything inside the chip.
    const apart = (el) => visible(el) && !el.contains(p.chip) && !p.chip.contains(el);
    // Download controls that came with the panel; a chip of another file is never one.
    const controls = previewControls().filter((el) => apart(el) && !p.controls.has(el) && (chipFile(el)?.name ?? p.name) === p.name);
    const fresh = outermost(all(SELECTORS.previewPanel).filter((el) => apart(el) && !p.panels.has(el)));
    let panel = fresh.find(names) || fresh.find((el) => controls.some((c) => el.contains(c))) || null;
    if (!panel && controls.length) {
      // No known panel container: the nearest ancestor of the control that names the file.
      for (let el = controls[0].parentElement, i = 0; el && el !== document.body && i < 12; el = el.parentElement, i++) {
        if (el.contains(p.chip)) break;
        if (names(el)) {
          panel = el;
          break;
        }
      }
    }
    if (!panel) {
      // A panel that was already open (another file's preview) and now shows this file.
      panel = outermost(all(SELECTORS.previewPanel).filter((el) => apart(el) && names(el)))[0] || null;
    }
    const control = controls.find((c) => panel?.contains(c)) || (controls.length === 1 ? controls[0] : null);
    p.panel = panel;
    p.control = control;
    const out = { open: !!(panel || control), download: !!control, panel: panel ? describe(panel) : null, control: control ? describe(control) : null };
    if (!out.open) out.outline = inspect({ selector: '[role="dialog"], aside, [class*="preview" i]', depth: 4, max_nodes: 80 }).tree;
    return out;
  }

  function previewDownload() {
    if (!state.preview?.control?.isConnected) previewState();
    const c = state.preview.control;
    if (!c) throw fail('PREVIEW_NO_DOWNLOAD', 'the preview shows no download button');
    press(c);
    return { clicked: describe(c) };
  }

  const endLine = (s) => (s.endsWith('\n') ? s : `${s}\n`);

  // What the panel shows, best source first. Never byte-exact: the server marks it via "preview-text".
  function previewText() {
    if (!state.preview?.panel?.isConnected) previewState();
    const panel = state.preview.panel;
    if (!panel) throw fail('PREVIEW_NOT_FOUND', 'no preview panel to read');
    const editor = panel.querySelector('.cm-content');
    if (editor) {
      const lines = editor.querySelectorAll('.cm-line');
      const text = lines.length ? [...lines].map((l) => l.textContent).join('\n') : editor.textContent;
      return { text: endLine(text), source: 'code-editor', note: 'a code editor renders only the lines in view, so a long file may come out incomplete' };
    }
    const pre = panel.querySelector('pre');
    if (pre) return { text: endLine((pre.querySelector('code') || pre).textContent), source: 'pre' };
    const md = panel.querySelector(SELECTORS.markdown);
    if (md) return { text: endLine(blocks(md).join('\n\n')), source: 'rendered-markdown', note: 'rebuilt from the rendered Markdown; markup may differ from the original file' };
    return { text: endLine(panel.innerText.trim()), source: 'panel-text', note: "the panel's visible text, including its header" };
  }

  function previewClose() {
    const p = state.preview;
    state.preview = null;
    const panel = p?.panel?.isConnected ? p.panel : null;
    if (!panel) return { closed: null };
    for (let scope = panel, i = 0; scope && scope !== document.body && i < 4; scope = scope.parentElement, i++) {
      const btn = firstVisible(SELECTORS.previewClose, scope);
      if (btn && !btn.contains(p.chip)) {
        press(btn);
        return { closed: 'button' };
      }
    }
    const target = document.activeElement || document.body;
    for (const type of ['keydown', 'keyup']) {
      target.dispatchEvent(new KeyboardEvent(type, { key: 'Escape', code: 'Escape', keyCode: 27, bubbles: true, cancelable: true, composed: true }));
    }
    return { closed: 'escape' };
  }

  // ---------------------------------------------------------------- reply → Markdown

  const BLOCK_TAGS = new Set([
    'address', 'article', 'aside', 'blockquote', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption', 'figure',
    'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
    'section', 'summary', 'table', 'ul',
  ]);
  const SKIP_TAGS = new Set([
    'audio', 'button', 'canvas', 'iframe', 'input', 'noscript', 'script', 'select', 'style', 'svg', 'template', 'textarea', 'video',
  ]);

  const isBlock = (n) => n.nodeType === 1 && (BLOCK_TAGS.has(n.localName) || n.classList.contains('katex-display'));
  const skip = (el) => SKIP_TAGS.has(el.localName) || el.classList.contains('sr-only') || el.hidden === true;
  const tex = (el) => (el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ?? el.textContent).trim();

  function wrap(s, mark) {
    const m = s.match(/^(\s*)([\s\S]*?)(\s*)$/);
    return m[2] ? `${m[1]}${mark}${m[2]}${mark}${m[3]}` : s;
  }

  function inlineCode(t) {
    const longest = Math.max(0, ...(t.match(/`+/g) || []).map((r) => r.length));
    const fence = '`'.repeat(longest + 1);
    const pad = /^`|`$/.test(t) ? ' ' : '';
    return `${fence}${pad}${t}${pad}${fence}`;
  }

  function link(el, text) {
    const href = el.getAttribute('href') || '';
    if (!href || /^(javascript:|#)/i.test(href)) return text;
    const abs = el.href || href;
    const label = text.trim();
    if (!label || label === abs) return `<${abs}>`;
    return `[${label}](${abs.replace(/ /g, '%20').replace(/\)/g, '%29')})`;
  }

  function codeBlock(pre) {
    const code = pre.querySelector('code') || pre.querySelector('.cm-content');
    let text;
    if (code) {
      const lines = code.querySelectorAll('.cm-line');
      text = lines.length ? [...lines].map((l) => l.textContent).join('\n') : code.textContent;
    } else {
      const clone = pre.cloneNode(true);
      clone.querySelectorAll('button').forEach((b) => b.remove());
      text = clone.textContent;
    }
    text = text.replace(/\n$/, '');
    const lang = (code?.getAttribute('class') || '').match(/language-([\w#+.-]+)/)?.[1] || '';
    const longest = Math.max(0, ...(text.match(/`{3,}/g) || []).map((r) => r.length));
    const fence = '`'.repeat(Math.max(3, longest + 1));
    return `${fence}${lang}\n${text}\n${fence}`;
  }

  function inline(node) {
    if (node.nodeType === 3) return node.data.replace(/[ \t\n\r\f]+/g, ' ');
    if (node.nodeType !== 1 || skip(node)) return '';
    const el = node;
    if (el.classList.contains('katex-display')) return `\n$$\n${tex(el)}\n$$\n`;
    if (el.classList.contains('katex')) return `$${tex(el)}$`;
    const inner = () => [...el.childNodes].map(inline).join('');
    switch (el.localName) {
      case 'br':
        return '\n';
      case 'strong':
      case 'b':
        return wrap(inner(), '**');
      case 'em':
      case 'i':
        return wrap(inner(), '*');
      case 'del':
      case 's':
      case 'strike':
        return wrap(inner(), '~~');
      case 'code':
        return inlineCode(el.textContent);
      case 'a':
        return link(el, inner());
      case 'img':
        return el.getAttribute('src') ? `![${el.getAttribute('alt') || ''}](${el.src})` : '';
      case 'pre':
        return `\n${codeBlock(el)}\n`;
      default:
        return isBlock(el) ? ` ${inner()} ` : inner();
    }
  }

  // Returns the Markdown blocks (paragraphs, lists, code, tables …) of a container, in order.
  function blocks(container) {
    const out = [];
    let buf = '';
    const flush = () => {
      const s = buf.replace(/[ \t]*\n[ \t]*/g, '\n').trim();
      if (s) out.push(s);
      buf = '';
    };
    for (const n of container.childNodes) {
      if (isBlock(n)) {
        flush();
        out.push(...block(n));
      } else {
        buf += inline(n);
      }
    }
    flush();
    return out.filter(Boolean);
  }

  function block(el) {
    if (skip(el)) return [];
    if (el.classList.contains('katex-display')) return [`$$\n${tex(el)}\n$$`];
    const tag = el.localName;
    if (/^h[1-6]$/.test(tag)) return [`${'#'.repeat(Number(tag[1]))} ${blocks(el).join(' ').replace(/\n+/g, ' ')}`];
    switch (tag) {
      case 'pre':
        return [codeBlock(el)];
      case 'ul':
      case 'ol':
        return [listBlock(el)];
      case 'table':
        return [tableBlock(el)];
      case 'hr':
        return ['---'];
      case 'blockquote':
        return [
          blocks(el)
            .join('\n\n')
            .split('\n')
            .map((l) => (l ? `> ${l}` : '>'))
            .join('\n'),
        ];
      default:
        return blocks(el);
    }
  }

  function listBlock(list) {
    const ordered = list.localName === 'ol';
    let n = Number.parseInt(list.getAttribute('start') || '1', 10);
    if (!Number.isFinite(n)) n = 1;
    const items = [];
    for (const li of list.children) {
      if (li.localName !== 'li') continue;
      const marker = ordered ? `${n++}. ` : '- ';
      const loose = [...li.children].some((c) => c.localName === 'p');
      let body = blocks(li).join(loose ? '\n\n' : '\n');
      const box = li.querySelector('input[type="checkbox"]');
      if (box && box.closest('li') === li) body = `[${box.checked ? 'x' : ' '}] ${body}`;
      const pad = ' '.repeat(marker.length);
      items.push(marker + body.split('\n').map((l, i) => (i && l ? pad + l : l)).join('\n'));
    }
    return items.join('\n');
  }

  function tableBlock(table) {
    const rows = [...table.querySelectorAll('tr')].filter((tr) => tr.closest('table') === table);
    if (!rows.length) return '';
    const cellsOf = (tr) => [...tr.children].filter((c) => c.localName === 'td' || c.localName === 'th');
    const grid = rows.map((tr) => cellsOf(tr).map((c) => blocks(c).join('<br>').replace(/\n/g, '<br>').replace(/\|/g, '\\|')));
    const cols = Math.max(...grid.map((r) => r.length));
    const pad = (r, fill) => [...r, ...Array(cols - r.length).fill(fill)];
    const align = cellsOf(rows[0]).map((c) => {
      const a = (c.getAttribute('align') || c.style.textAlign || '').toLowerCase();
      return a === 'center' ? ':---:' : a === 'right' ? '---:' : a === 'left' ? ':---' : '---';
    });
    return [pad(grid[0], ''), pad(align, '---'), ...grid.slice(1).map((r) => pad(r, ''))]
      .map((r) => `| ${r.join(' | ')} |`)
      .join('\n');
  }

  // Documents of the iframes in a reply that this script may read (same-origin); cross-origin ones are counted.
  function frameDocs(parts) {
    const docs = [];
    let unreadable = 0;
    for (const f of parts.flatMap((p) => [...p.querySelectorAll('iframe')])) {
      let doc = null;
      try {
        doc = f.contentDocument;
      } catch {
        // cross-origin
      }
      if (doc?.body) docs.push(doc);
      else unreadable++;
    }
    return { docs, unreadable };
  }

  function extractReply() {
    const info = threadInfo();
    if (!info.replyParts.length) throw fail('NO_REPLY', 'there is no assistant reply after the latest user message');
    // 2026-11 layout: the "Thought for …" and tool rows are separate assistant blocks without Markdown;
    // they are left out whenever some block has Markdown. Without any, the blocks' text is the reply.
    let roots = info.replyParts.flatMap(markdownRoots);
    let source = 'markdown';
    // A report rendered in a same-origin iframe (UNVERIFIED for Deep Research): its Markdown, links kept.
    const frames = frameDocs(info.replyParts);
    if (!roots.length && frames.docs.length) {
      roots = frames.docs.flatMap((d) => markdownRoots(d.body));
      source = 'frame';
    }
    if (!roots.length) source = 'text';
    const parts = roots.length ? roots.map((r) => blocks(r).join('\n\n')) : info.replyParts.map((m) => m.innerText.trim());
    const markdown = parts.filter(Boolean).join('\n\n').trim();
    return {
      markdown: markdown ? `${markdown}\n` : '',
      conversation_id: conversationId(),
      message_id: info.last_assistant_id,
      source,
      frames_unreadable: frames.unreadable,
    };
  }

  // ---------------------------------------------------------------- inspect_page (read-only)

  const INSPECT_ATTRS = [
    'data-testid', 'role', 'aria-label', 'data-message-author-role', 'data-message-id', 'contenteditable',
    'type', 'name', 'placeholder', 'accept', 'multiple', 'disabled', 'aria-disabled', 'href',
    'aria-pressed', 'aria-checked', 'aria-selected', 'aria-expanded', 'aria-haspopup', 'data-state',
  ];
  const INSPECT_NOISE = new Set(['script', 'style', 'noscript', 'template', 'link', 'meta']);

  function ownText(el) {
    if (el.localName === 'input' || el.localName === 'textarea') return '';
    let t = '';
    for (const n of el.childNodes) if (n.nodeType === 3) t += n.data;
    t = t.replace(/\s+/g, ' ').trim();
    if (!t && el.children.length === 0) t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return t;
  }

  function describe(el) {
    let s = el.localName;
    if (el.id) s += `#${el.id}`;
    const cls = [...el.classList].filter((c) => /^[a-z][\w-]*$/i.test(c)).slice(0, 4);
    if (cls.length) s += `.${cls.join('.')}`;
    for (const a of INSPECT_ATTRS) {
      const v = el.getAttribute(a);
      if (v != null) s += v === '' ? ` [${a}]` : ` [${a}=${JSON.stringify(clip(v, 60))}]`;
    }
    const text = ownText(el);
    if (text) s += ` ${JSON.stringify(clip(text, 80))}`;
    return s;
  }

  function inspect({ selector = 'body', depth = 6, max_nodes: maxNodes = 400, visible_only: visibleOnly = true }) {
    let roots;
    try {
      roots = [...document.querySelectorAll(selector)];
    } catch {
      throw fail('INVALID_SELECTOR', `invalid CSS selector: ${selector}`);
    }
    const lines = [];
    let count = 0;
    let truncated = false;
    const walk = (el, d) => {
      if (count >= maxNodes) {
        truncated = true;
        return;
      }
      if (visibleOnly && !visible(el)) return;
      lines.push('  '.repeat(d) + describe(el));
      count++;
      const kids = [...el.children].filter((c) => !INSPECT_NOISE.has(c.localName));
      if (!kids.length || el.localName === 'svg') return;
      if (d >= depth) {
        lines.push(`${'  '.repeat(d + 1)}… ${kids.length} child element(s) below depth limit`);
        return;
      }
      for (const c of kids) walk(c, d + 1);
    };
    for (const r of roots) walk(r, 0);
    return { url: location.href, selector, matched: roots.length, nodes: count, truncated, tree: lines.join('\n') };
  }

  // ---------------------------------------------------------------- MCP tab marker
  //
  // 2026-11-22 the user switched the MCP tab to another conversation by hand while a reply was generating. The tab
  // now says what it is: "[MCP] " before its title — kept there by an observer, as the site rewrites document.title
  // on every route change (an observer is no timer) — and a small badge at the bottom of <body> (outside main / form /
  // menus) that takes no clicks and is hidden from screen readers. Idempotent across injections. Never while the page
  // is still loading or on the "ready" probe of open_conversation, so the site's hydration never sees either.

  const TITLE_PREFIX = '[MCP] ';
  const BADGE_TEXT = 'MCP tab · driven by Claude Code — please don’t switch conversations here';

  function markTab() {
    if (document.readyState !== 'complete') return;
    try {
      const fix = () => {
        if (!document.title.startsWith(TITLE_PREFIX)) document.title = TITLE_PREFIX + document.title;
      };
      fix();
      const g = globalThis;
      if (!g.__mcpTitleObserver) {
        let burst = { at: 0, n: 0 };
        const obs = new MutationObserver(() => {
          if (document.title.startsWith(TITLE_PREFIX)) return;
          // Never fight the page: give up after 30 rewrites within a second.
          const now = Date.now();
          burst = now - burst.at > 1_000 ? { at: now, n: 1 } : { at: burst.at, n: burst.n + 1 };
          if (burst.n > 30) {
            obs.disconnect();
            return;
          }
          fix();
        });
        obs.observe(document.head || document.documentElement, { subtree: true, childList: true, characterData: true });
        g.__mcpTitleObserver = obs;
      }
      if (!document.querySelector('[data-mcp-badge]')) {
        const b = document.createElement('div');
        b.setAttribute('data-mcp-badge', '');
        b.setAttribute('aria-hidden', 'true');
        b.textContent = BADGE_TEXT;
        b.style.cssText =
          'all:initial;position:fixed;z-index:2147483646;left:50%;bottom:2px;transform:translateX(-50%);pointer-events:none;user-select:none;' +
          'font:600 10px/14px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#fff;background:rgba(194,65,12,.82);padding:1px 8px;border-radius:7px;white-space:nowrap;';
        (document.body || document.documentElement).append(b);
      }
    } catch {
      // cosmetic only: never let it break a command
    }
  }

  // ---------------------------------------------------------------- dispatch

  const HANDLERS = {
    ready,
    status,
    snapshot,
    // Polled by background.js show_tab while it brings the tab forward.
    visibility: () => ({ visibility: document.visibilityState, tab_hidden: document.visibilityState !== 'visible', has_focus: document.hasFocus() }),
    fill_composer: fillComposer,
    click_send: clickSend,
    clear_composer: () => {
      state.pendingText = null;
      clearComposer();
      return { cleared: !squash(readComposer(composer() || document.body)) };
    },
    upload_begin: uploadBegin,
    upload_chunk: uploadChunk,
    upload_commit: uploadCommit,
    upload_verify: uploadVerify,
    upload_menu_step: uploadMenuStep,
    upload_picker_cancel: uploadPickerCancel,
    upload_release: uploadRelease,
    upload_abort: uploadRelease,
    extract_reply: extractReply,
    model_state: modelState,
    set_mode: setMode,
    model_menu_open: openModelMenu,
    model_menu_read: readModelMenu,
    model_menu_choose: chooseModelItem,
    model_menu_slider_key: sliderKey,
    model_menu_close: closeModelMenu,
    tools_menu_open: openToolsMenu,
    tools_menu_read: readToolsMenu,
    tools_menu_choose: chooseTool,
    tools_menu_close: (a) => closeModelMenu({ ...a, which: 'tools' }),
    tool_state: () => ({ tool: activeTool()?.label ?? null, supported: SELECTORS.toolsButton.length > 0 }),
    tool_clear: toolClear,
    list_projects: () => ({ projects: [...new Set(projectButtons().map((p) => p.name))] }),
    open_project: openProject,
    files_list: filesList,
    file_click: fileClick,
    file_preview_state: previewState,
    file_preview_download: previewDownload,
    file_preview_text: previewText,
    file_preview_close: previewClose,
    inspect,
  };

  async function handle(cmd, args) {
    if (cmd !== 'ready' && cmd !== 'visibility') markTab();
    const fn = HANDLERS[cmd];
    if (!fn) return { ok: false, error: { code: 'UNKNOWN_COMMAND', message: `unknown page command: ${cmd}` } };
    try {
      return { ok: true, result: await fn(args || {}) };
    } catch (e) {
      return { ok: false, error: { code: e.code || 'PAGE_SCRIPT_ERROR', message: String(e?.message || e) } };
    }
  }

  globalThis.__mcpBridge = { instance: null, tabMark: globalThis.__mcpBridge?.tabMark ?? null, handle };
})();
