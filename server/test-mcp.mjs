#!/usr/bin/env node
// Acceptance test for server.mjs (run `node scripts/init-token.mjs` first):
//   1. stdio MCP: initialize + tools/list register every tool (EXPECTED_TOOLS) and stdout carries JSON-RPC only;
//   2. bridge security: wrong Origin / no Origin / wrong Host / wrong or missing token are refused;
//   3. a fake extension (chrome-extension:// Origin + correct token) completes command round trips,
//      including send → still_running job → get_job → save_to numbering, and a chunked upload;
//   4. a page that keeps only the latest turn in the DOM (message counts never change): the send is
//      still observed, the new reply is read, and after SEND_NOT_OBSERVED the reply stays readable;
//   5. upload_files never reports success unless the page shows the attachment previews: methods are
//      tried in order (Gemini: paste → menu), UPLOAD_NOT_ATTACHED otherwise;
//   6. list_files / download_file against the fake extension: target rules (FILE_EXISTS, symlinks, names that
//      would leave the directory), name matching (FILE_NOT_IN_REPLY / AMBIGUOUS_FILE), preview chips, errors;
//   7. the real extension/background.js (in a vm, chrome.* simulated) connected to the server: download_file
//      catches the browser download, falls back to a URL the page tried to open, cleans up Chrome's copy after a
//      success, a timeout or a Save prompt, and never touches the user's other downloads; show_tab activates the
//      tab, restores and focuses its window, and says why a tab stays hidden;
//   8. hidden tabs (the 2026-11-21 Gemini incident): upload_files / send_message bring a hidden Gemini tab forward
//      first (on_hidden "show"), fail with TAB_HIDDEN before touching anything when it stays hidden or on "fail",
//      leave ChatGPT alone ("proceed"); expect_conversation_id "new"; UPLOAD_NOT_ATTACHED says the tab was hidden;
//   9. new Gemini chats default to Task (open_conversation, select_model { model }, the upload / send preflight;
//      MODE_NOT_SET rather than another mode); an explicit mode is never switched back; existing chats untouched;
//  10. a stale page (URL of conversation A, messages of another one — 2026-11-22): PAGE_STALE instead of a silent
//      save_to, until open_conversation reloads the page.
//  11. ChatGPT composer tools / Deep Research (opt-in): select_model lists the "+" menu (submenus included) and turns a
//      tool on or off, confirmed by the composer or the menu (TOOL_NOT_CONFIRMED otherwise), never pressing an item
//      that adds files; a send without `tool` refuses any tool that is on or was turned on and not off (TOOL_MISMATCH,
//      nothing typed); send_message { tool } turns it on; get_status shows the tool; a research reply stays
//      still_running while the research runs (or shows no report text yet), also after a tab-moved reopen; a
//      clarifying question completes at once; a report export is downloaded in the chosen format;
//  12. a tab moved to another conversation mid-reply (2026-11-22): the job ends with tab_moved + the conversation to
//      reopen, wait-job.mjs exits 4, and reopening + get_latest_reply recovers the reply without a resend.
// Usage: node server/test-mcp.mjs [--port 17373]
import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import WebSocket from 'ws';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const portArg = process.argv.indexOf('--port');
const PORT = portArg > 0 ? Number(process.argv[portArg + 1]) : 17373;
const TMP = path.join(HERE, '.test-tmp');
const JOBS_DIR = path.join(os.tmpdir(), `chatgpt-web-test-jobs-${process.pid}`);
const EXT_ORIGIN = 'chrome-extension://abcdefghijklmnopabcdefghijklmnop';
const EXPECTED_TOOLS = ['open_conversation', 'get_status', 'show_tab', 'upload_files', 'send_message', 'get_latest_reply', 'get_job', 'select_model', 'list_files', 'download_file', 'inspect_page'];
const SEND_NOT_OBSERVED_MS = 5_000; // 60 s in production
const UPLOAD_ATTACH_MS = 1_200; // 6 s in production
const SHOW_TAB_MS = 600; // 3 s in production
const MODE_WAIT_MS = 600; // 3 s in production
const RESEARCH_QUIET_MS = 3_000; // 15 min in production
// download capture phases in background.js (production: 6 s / 20 s / 8 s)
const DOWNLOAD_NATIVE_MS = 600;
const DOWNLOAD_START_MS = 1_500;
const DOWNLOAD_PROMPT_MS = 800;

let TOKEN;
try {
  TOKEN = readFileSync(path.join(HERE, '.bridge-token'), 'utf8').trim();
} catch {
  console.error('server/.bridge-token not found — run `node scripts/init-token.mjs` first.');
  process.exit(2);
}

let failures = 0;
function check(name, ok, detail = '') {
  if (!ok) failures++;
  console.log(`${ok ? '✓' : '✗'} ${name}${!ok && detail ? `\n    ${detail}` : ''}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const sha256 = (data) => createHash('sha256').update(data).digest('hex');

async function portFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.listen(port, '127.0.0.1', () => srv.close(() => resolve(true)));
  });
}

// ---------------------------------------------------------------- stdio MCP client (raw, to audit stdout)

if (!(await portFree(PORT))) {
  console.error(`Port ${PORT} is busy (probably the MCP server running inside Claude Code). Stop it or pass --port <other>.`);
  process.exit(2);
}

const child = spawn(process.execPath, [path.join(HERE, 'server.mjs')], {
  stdio: ['pipe', 'pipe', 'pipe'],
  env: { ...process.env, CHATGPT_BRIDGE_PORT: String(PORT), CHATGPT_BRIDGE_JOBS_DIR: JOBS_DIR, CHATGPT_BRIDGE_SEND_NOT_OBSERVED_MS: String(SEND_NOT_OBSERVED_MS), CHATGPT_BRIDGE_UPLOAD_ATTACH_MS: String(UPLOAD_ATTACH_MS),
    CHATGPT_BRIDGE_DOWNLOAD_NATIVE_MS: String(DOWNLOAD_NATIVE_MS), CHATGPT_BRIDGE_DOWNLOAD_START_MS: String(DOWNLOAD_START_MS), CHATGPT_BRIDGE_DOWNLOAD_PROMPT_MS: String(DOWNLOAD_PROMPT_MS),
    CHATGPT_BRIDGE_SHOW_TAB_MS: String(SHOW_TAB_MS), CHATGPT_BRIDGE_MODE_WAIT_MS: String(MODE_WAIT_MS), CHATGPT_BRIDGE_RESEARCH_QUIET_MS: String(RESEARCH_QUIET_MS) },
});

// Runs wait-job.mjs the way a client would in the background; resolves with its exit code and JSON line.
function runWaiter(args, timeoutMs = 20_000) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [path.join(HERE, 'wait-job.mjs'), ...args], { env: { ...process.env, CHATGPT_BRIDGE_JOBS_DIR: JOBS_DIR } });
    let out = '';
    p.stdout.on('data', (d) => (out += d));
    const timer = setTimeout(() => p.kill(), timeoutMs);
    p.on('exit', (code) => {
      clearTimeout(timer);
      let json = null;
      try {
        json = JSON.parse(out);
      } catch {
        // leave null
      }
      resolve({ code, out: json });
    });
  });
}
let stdoutBuf = '';
let stderrBuf = '';
const noise = [];
const waiters = new Map();
let seq = 0;

child.stdout.setEncoding('utf8');
child.stdout.on('data', (chunk) => {
  stdoutBuf += chunk;
  let nl;
  while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
    const line = stdoutBuf.slice(0, nl);
    stdoutBuf = stdoutBuf.slice(nl + 1);
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      noise.push(line);
      continue;
    }
    if (msg?.jsonrpc !== '2.0') noise.push(line);
    if (msg?.id != null && waiters.has(msg.id)) {
      waiters.get(msg.id)(msg);
      waiters.delete(msg.id);
    }
  }
});
child.stderr.setEncoding('utf8');
child.stderr.on('data', (chunk) => {
  stderrBuf += chunk;
});
const exited = new Promise((resolve) => child.once('exit', (code, signal) => resolve({ code, signal })));

function rpc(method, params, timeoutMs = 60_000) {
  const id = ++seq;
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  return Promise.race([
    new Promise((resolve) => waiters.set(id, resolve)),
    sleep(timeoutMs).then(() => {
      throw new Error(`${method} timed out`);
    }),
  ]);
}

async function call(name, args = {}) {
  const res = await rpc('tools/call', { name, arguments: args });
  if (res.error) throw new Error(`${name}: JSON-RPC error ${JSON.stringify(res.error)}`);
  const [first, second] = res.result.content;
  return { isError: !!res.result.isError, data: JSON.parse(first.text), text: second?.text };
}

// ---------------------------------------------------------------- fake extension

// Mirrors the 2026-11 chatgpt.com layout: no message ids (counts only), and a new chat shows a
// temporary "local-chatgpt:<uuid>" id while generating before switching to the real one.
const BASELINE = { user_count: 1, assistant_count: 1, last_user_id: null, last_assistant_id: null };
const REPLY = '# Answer\n\n```python\ndef f():\n\n\n    return 1\n```\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n';
const fake = { phase: 'done', clicks: 0, sendDisabled: false, received: [], uploads: new Map(), committed: null, reply: REPLY };
// latestTurn mode mirrors the 2026-11-21 chatgpt.com page: only the latest turn is in the DOM (one user
// block, then "Thought for …" and the reply block), so the counts are the same before and after a send.
// The page reports a fingerprint of the latest user message when `fingerprint` is on (current content.js)
// and none when it is off (older content.js or unreadable bubble); `generateOnClick` shows a stop button.
const fakeHash = (text) => `h:${text.normalize('NFKC').replace(/[^\p{L}\p{N}]+/gu, '')}`; // like fingerprint() in content.js
Object.assign(fake, { latestTurn: false, userHash: null, fingerprint: false, generateOnClick: true, nextReply: null, sentHash: null });
// Hidden tabs: `hidden` is what the page reports (document.visibilityState), `show` what background.js show_tab
// achieves ("ok" → visible; "minimized" / "unfocused" → still hidden, with that reason), `showLegacy` an extension
// from before show_tab. `newChat`: the tab is on a new chat (no conversation id) with `newChatUsers` user messages.
Object.assign(fake, { hidden: false, show: 'ok', showLegacy: false, newChat: false, newChatUsers: 0, lastFill: null });
// `conv`: the conversation id the page reports (URL). Gemini's Chat / Task toggle (`gem`) shows on new chats only:
// `toggle` whether it renders, `sticks` whether a press takes, `presses` what was pressed.
Object.assign(fake, { conv: 'conv-test', gem: { mode: 'Chat', toggle: true, sticks: true, presses: [] } });
// Composer tools ("+" menu) like ChatGPT's (live 2026-11-22: Deep research is not in the model menu; expected here, menu contents not yet seen): an item
// that adds files (never to be pressed), Deep research, a "More" submenu. `sticks`: a press shows the tool in the
// composer; `clearWorks`: the pill's remove control works; `legacy`: a content.js from before composer tools.
// fake.research: what content.js researchState reports for the current reply; convWhileGenerating: the page keeps its
// real conversation id while generating (instead of a temporary local- id).
// `pill`: content.js recognises the active tool in the composer (UNVERIFIED live); `menuSelected`: the "+" menu shows
// the active tool as selected.
const tools = { active: null, open: false, sub: false, pressed: [], sticks: true, clearWorks: true, legacy: false, pill: true, menuSelected: true };
const shownTool = () => (tools.pill ? tools.active : null);
const TOOL_TOP = [{ label: 'Add photos & files' }, { label: 'Deep research', description: 'Get a detailed report' }, { label: 'Create image' }, { label: 'More', submenu: true }];
const TOOL_MORE = [{ label: 'Web search' }, { label: 'Canvas' }];
const toolItems = () =>
  tools.open
    ? [...TOOL_TOP, ...(tools.sub ? TOOL_MORE : [])].map((t, index) => ({ index, label: t.label, description: t.description ?? null, selected: tools.menuSelected && t.label === tools.active, disabled: false, submenu: !!t.submenu }))
    : [];
const NO_RESEARCH = { active: false, progress: false, completed: false, frame: false, label: null, hash: 'r0' };
Object.assign(fake, { research: NO_RESEARCH, convWhileGenerating: false, extract: {}, exportMenu: null });
const SHOW_REASONS = {
  minimized: 'its window is still minimized',
  unfocused: 'Chrome could not bring its window to the front — another app is in front and the OS refused the focus change (macOS may), or the window is on another desktop / Space',
};
function fakeShowTab() {
  if (fake.showLegacy) throw { code: 'UNKNOWN_METHOD', message: 'unknown bridge method: show_tab' };
  if (!fake.hidden) return { tab_hidden: false, was_hidden: false, activated: true, focused: true, window_state: 'normal' };
  if (fake.show === 'ok') {
    fake.hidden = false;
    return { tab_hidden: false, was_hidden: true, activated: true, focused: true, window_state: 'normal' };
  }
  return { tab_hidden: true, was_hidden: true, activated: true, focused: fake.show !== 'unfocused', window_state: fake.show === 'minimized' ? 'minimized' : 'normal', reason: SHOW_REASONS[fake.show] };
}

// Attachments as content.js reports them. `attach` says what each method does when committed
// (applied / handoff / reason / pending), `chipOn` which methods make the previews appear, `menu` what
// upload_menu_step answers, `intercept` whether the page then asks for a file chooser, `lateMs` how long
// the previews take to show, `vanishAfter` after how many upload_verify calls an appeared preview goes
// away again, `legacy` an old content.js.
const UPLOAD_DEFAULT = {
  methods: ['input'],
  attach: { input: { applied: true, handoff: true, via: 'input[type="file"][multiple]' } },
  chipOn: ['input'],
  menu: null,
  intercept: false,
  lateMs: 0,
  vanishAfter: null,
  legacy: false,
  pickerHidden: false, // what upload_picker_cancel says about the tab
};
function resetUpload(opts = {}) {
  Object.assign(fake, { upload: { ...UPLOAD_DEFAULT, ...opts }, chip: false, chipAt: null, intercepted: false, verifies: 0, attachLog: [] });
}
resetUpload();

// Reply files as content.js lists them — the live reply of 2026-11-21: three download chips, two preview chips —
// and what the fake extension's "download" method does (dl.mode): "ok" writes the file into FAKE_DOWNLOADS (standing
// in for Chrome's Downloads folder) and returns its path, "timeout" / "not_started" fail like background.js.
// dl.previewButton: whether a preview panel shows a download button.
const FAKE_DOWNLOADS = path.join(TMP, 'fake-chrome-downloads');
const FILE_BODY = (name) =>
  name.endsWith('.patch') ? `From 0593c80 Mon Sep 17 00:00:00 2001\nSubject: [PATCH] ${name}\n\ndiff --git a/x b/x\n` : `# ${name}\n\nThe original file.\n`;
const REPLY_FILES = [
  ['0593c80_A_gemma.patch', 'download'],
  ['0593c80_B_cpu_probe.patch', 'download'],
  ['0593c80_C_confirmation.patch', 'download'],
  ['0593c80_three_patches.md', 'preview'],
  ['decision_summary.md', 'preview'],
].map(([name, kind], index) => ({ index, name, kind, label: `${kind === 'download' ? 'Download' : 'Open preview of'} ${name}` }));
const PREVIEW_TEXT = '# Decision summary\n\n- take A and C\n';
function resetFiles() {
  Object.assign(fake, { files: REPLY_FILES, filesLegacy: false, clickedFiles: [], previewClosed: 0, dl: { mode: 'ok', previewButton: true, requests: [], discarded: [], live: new Map(), ids: 0 } });
}
resetFiles();

function fakeDownload(params) {
  fake.dl.requests.push(params);
  if (fake.dl.mode === 'timeout') throw { code: 'DOWNLOAD_TIMEOUT', message: `the download did not finish within ${params.timeout_ms / 1000}s; it was cancelled and its partial file removed` };
  if (fake.dl.mode === 'not_started') throw { code: 'DOWNLOAD_NOT_STARTED', message: 'the press started no download in Chrome' };
  if (fake.dl.mode === 'button_gone' && params.cmd === 'file_preview_download') throw { code: 'PREVIEW_NO_DOWNLOAD', message: 'the preview panel shows no download button' };
  if (params.cmd === 'file_click') fake.clickedFiles.push(params.args.name);
  // A report export: Chrome names the file (the format chosen in the export menu, or a direct download).
  const exported = params.cmd === 'model_menu_choose' ? `deep-research-report.${/pdf/i.test(params.args.label) ? 'pdf' : 'md'}` : fake.files[params.args?.index]?.kind === 'export' ? 'deep-research-report.pdf' : null;
  if (params.cmd === 'model_menu_choose') fake.exportMenu = null;
  mkdirSync(FAKE_DOWNLOADS, { recursive: true });
  const file = path.join(FAKE_DOWNLOADS, exported ?? path.basename(params.name));
  writeFileSync(file, FILE_BODY(params.name));
  const id = ++fake.dl.ids;
  fake.dl.live.set(id, file);
  return { download_id: id, filename: file, bytes: Buffer.byteLength(FILE_BODY(params.name)), mime: 'text/x-diff', capture: 'click', from: 'https://files.oaiusercontent.com/file-x' };
}

// Model picker like ChatGPT's: a "Power" slider (arrow keys) above the models, a "Legacy models"
// submenu, and a Chat / Work mode toggle.
const MODELS = [{ label: 'Instant', description: 'Answers right away' }, { label: 'Thinking' }, { label: 'Pro', description: 'Research-grade' }, { label: 'Legacy models', submenu: true }];
const LEGACY = [{ label: 'GPT-4o' }, { label: 'GPT-4o mini' }];
const LEVELS = ['Light', 'Standard', 'Extended', 'Heavy', 'Pro'];
const picker = { model: 'Instant', mode: 'Chat', level: 5, keys: 0, open: false, sub: false, pressed: [] };
const pickerItems = () =>
  picker.open
    ? [
        { kind: 'slider', label: 'Power', value: LEVELS[picker.level - 1], position: picker.level, count: LEVELS.length, disabled: false },
        ...[...MODELS, ...(picker.sub ? LEGACY : [])].map((m) => ({
          label: m.label, description: m.description ?? null, selected: m.label === picker.model, disabled: false, submenu: !!m.submenu,
        })),
      ].map((m, index) => ({ index, ...m }))
    : [];

function fakeSnapshot() {
  const generating = fake.phase === 'generating';
  const sent = fake.clicks > 0;
  return {
    state: generating ? 'streaming' : 'done',
    conversation_id: fake.newChat ? null : generating && !fake.convWhileGenerating ? 'local-chatgpt:00000000-0000-4000-8000-000000000001' : fake.conv,
    chars: generating ? 5 : fake.reply.length,
    uploading: false,
    generating,
    error_text: null,
    last_role: 'assistant',
    user_count: fake.newChat ? fake.newChatUsers : fake.latestTurn ? 1 : sent ? 2 : 1,
    assistant_count: fake.latestTurn ? 2 : sent ? 2 : 1,
    last_user_id: null,
    last_assistant_id: null,
    ...(fake.latestTurn && { last_user_hash: fake.userHash }),
    has_reply: true,
    hash: generating ? `partial-${Date.now()}` : `final-${fake.reply.length}`,
    tab_hidden: !!fake.held || !!fake.hidden,
    composer_has_text: !!fake.held,
    ...(!tools.legacy && { tool: shownTool(), research: fake.research }),
  };
}

function fakeHandle(method, params) {
  fake.received.push(method === 'page' ? `page:${params.cmd}` : method);
  fake.lastSite = params.site;
  if (method === 'status') {
    const research = tools.legacy ? {} : { tool: shownTool(), research_active: !!fake.research.active, research_progress: !!fake.research.progress };
    return { state: fake.research.active ? 'thinking' : 'done', conversation_id: fake.newChat ? null : fake.conv, chars: 42, uploading: false, has_reply: true, last_role: 'assistant', mcp_tab_open: true, ...research };
  }
  if (method === 'open_conversation') {
    return { url: params.url, conversation_id: params.url.match(/\/(?:c|app)\/([\w-]+)/)?.[1] ?? null, tab_id: 7 };
  }
  if (method === 'hook_file_chooser') return { installed: true };
  if (method === 'show_tab') return fakeShowTab();
  if (method === 'download') return fakeDownload(params);
  if (method === 'download_discard') {
    fake.dl.discarded.push(params.download_id);
    const file = fake.dl.live.get(params.download_id);
    fake.dl.live.delete(params.download_id);
    if (file) rmSync(file, { force: true });
    return { removed: true, erased: true, file: file ?? null };
  }
  const { cmd, args } = params;
  switch (cmd) {
    case 'fill_composer':
      fake.lastFill = args;
      // like content.js: "new" = no conversation id and no user message yet
      if (args.expect_conversation_id === 'new' ? !fake.newChat || fake.newChatUsers > 0 : args.expect_conversation_id && (fake.newChat || args.expect_conversation_id !== fake.conv)) {
        throw { code: 'CONVERSATION_MISMATCH', message: `tab shows ${fake.newChat ? 'a new chat' : fake.conv}` };
      }
      if (fake.phase === 'generating') throw { code: 'STILL_GENERATING', message: 'still generating' };
      if (fake.research.active) throw { code: 'STILL_GENERATING', message: 'Deep Research still seems to be running' }; // like content.js
      if (!fake.latestTurn) return { conversation_id: fake.newChat ? null : fake.conv, tool: shownTool(), baseline: BASELINE };
      fake.sentHash = fakeHash(args.text);
      fake.renderedHash = fakeHash(args.text.replace(/`/g, '')); // the bubble shows `code` without backticks
      return { conversation_id: fake.newChat ? null : fake.conv, tool: shownTool(), baseline: { ...BASELINE, assistant_count: 2, last_user_hash: fake.userHash, sent_hash: fake.sentHash } };
    case 'clear_composer':
      return { cleared: true };
    case 'click_send':
      if (fake.sendDisabled) return { clicked: false, reason: 'send button not found' };
      if (fake.holdSend) {
        fake.held = true; // like Gemini Task mode in a hidden tab: clicked, but nothing goes out yet
        return { clicked: true };
      }
      fake.clicks++;
      if (fake.latestTurn) {
        // the new turn replaces the old one in the DOM: same counts, new user text, new reply
        if (fake.fingerprint) fake.userHash = fake.renderedHash;
        fake.reply = fake.nextReply;
        if (!fake.generateOnClick) return { clicked: true };
      }
      fake.phase = 'generating';
      return { clicked: true };
    case 'snapshot':
      return fakeSnapshot();
    case 'extract_reply':
      return { markdown: fake.reply, conversation_id: fake.conv, message_id: 'a2', ...fake.extract };
    case 'upload_begin':
      fake.uploads.set(args.upload_id, args.files.map((f) => ({ ...f, chunks: [] })));
      return fake.upload.legacy ? { ok: true } : { ok: true, methods: fake.upload.methods };
    case 'upload_chunk':
      fake.uploads.get(args.upload_id)[args.index].chunks.push(Buffer.from(args.b64, 'base64'));
      return {};
    case 'upload_commit': {
      fake.committed = fake.uploads.get(args.upload_id).map((f) => ({ name: f.name, mime: f.mime, chunks: f.chunks.length, sha: sha256(Buffer.concat(f.chunks)) }));
      fake.attachLog.push(args.method);
      const a = fake.upload.attach[args.method] ?? { applied: false, reason: 'not applicable' };
      if (a.applied && fake.upload.chipOn.includes(args.method)) fake.chipAt = Date.now() + fake.upload.lateMs;
      return { files: fake.committed.map((f) => f.name), method: args.method, ...a };
    }
    case 'upload_menu_step': {
      const m = fake.upload.menu;
      if (m.pending === 'chooser' && fake.upload.intercept) fake.intercepted = true;
      if ((fake.intercepted || m.applied) && fake.upload.chipOn.includes('picker')) fake.chipAt = Date.now();
      return m;
    }
    case 'upload_verify': {
      fake.verifies++;
      if (fake.chipAt != null && Date.now() >= fake.chipAt) [fake.chip, fake.chipAt] = [true, null];
      if (fake.chip && fake.upload.vanishAfter != null && fake.verifies > fake.upload.vanishAfter) fake.chip = false;
      const names = fake.committed.map((f) => f.name);
      return {
        attached: fake.chip, shown: fake.chip ? names : [], missing: fake.chip ? [] : names, chips_added: fake.chip ? names.length : 0,
        thumbs_added: 0, uploading: false, intercepted: fake.upload.menu ? fake.intercepted : null, alert: null, tab_hidden: !!fake.hidden,
      };
    }
    case 'upload_picker_cancel':
      return { cancelled: true, item: 'button.mat-mdc-menu-item "Upload files"', page_calls: null, file_inputs: 0, menu_open: false, tab_hidden: fake.upload.pickerHidden || !!fake.hidden };
    case 'upload_release':
    case 'upload_abort':
      return {};
    case 'list_projects':
      return { projects: ['Alpha', 'Research notes', 'Sandbox'] };
    case 'open_project':
      fake.href = `https://chatgpt.com/g/g-p-${'ab'.repeat(16)}/project`;
      return { pressed: args.name };
    case 'ready':
      return { href: fake.href ?? 'https://chatgpt.com/', conversation_id: null, composer: true, login_required: false, messages: 0 };
    case 'model_state':
      if (params.site === 'gemini') {
        const shown = fake.newChat && fake.gem.toggle;
        return { model: picker.model, mode: shown ? fake.gem.mode : null, modes: shown ? ['Chat', 'Task'].map((label) => ({ label, selected: label === fake.gem.mode })) : null };
      }
      return { model: picker.model, mode: picker.mode, modes: ['Chat', 'Work'].map((label) => ({ label, selected: label === picker.mode })), ...(!tools.legacy && { tool: shownTool() }) };
    case 'set_mode':
      if (params.site === 'gemini') {
        fake.gem.presses.push(args.label);
        if (fake.gem.sticks) fake.gem.mode = ['Chat', 'Task'][args.index];
        return { pressed: args.label };
      }
      picker.mode = ['Chat', 'Work'][args.index];
      return { pressed: args.label };
    case 'model_menu_open':
      picker.open = true;
      return { model: picker.model };
    case 'model_menu_read':
      return { items: fake.exportMenu ? fake.exportMenu.map((label, index) => ({ index, label, description: null, selected: false, disabled: false, submenu: false })) : pickerItems() };
    case 'model_menu_choose': {
      if (fake.exportMenu) {
        if (fake.exportMenu[args.index] !== args.label) throw { code: 'MENU_CHANGED', message: 'menu changed' };
        fake.exportMenu = null;
        return { pressed: args.label };
      }
      const item = pickerItems()[args.index];
      if (item?.label !== args.label) throw { code: 'MENU_CHANGED', message: 'menu changed' };
      picker.pressed.push(item.label);
      if (item.submenu) picker.sub = true;
      else Object.assign(picker, { model: item.label, open: false, sub: false });
      return { pressed: item.label };
    }
    case 'model_menu_slider_key':
      if (pickerItems()[args.index]?.kind !== 'slider') throw { code: 'MENU_CHANGED', message: 'not a slider' };
      picker.keys++;
      picker.level = Math.min(LEVELS.length, Math.max(1, picker.level + (args.key === 'ArrowRight' ? 1 : -1)));
      return {};
    case 'model_menu_close':
      Object.assign(picker, { open: false, sub: false });
      fake.exportMenu = null;
      return { method: 'escape' };
    case 'tool_state':
      if (tools.legacy) throw { code: 'UNKNOWN_COMMAND', message: 'unknown page command: tool_state' };
      return { tool: params.site === 'gemini' ? null : shownTool(), supported: params.site !== 'gemini' };
    case 'tools_menu_open':
      if (tools.legacy) throw { code: 'UNKNOWN_COMMAND', message: 'unknown page command: tools_menu_open' };
      tools.open = true;
      return { opened: true, tool: tools.active };
    case 'tools_menu_read':
      return { items: toolItems() };
    case 'tools_menu_choose': {
      const item = toolItems()[args.index];
      if (item?.label !== args.label) throw { code: 'MENU_CHANGED', message: 'menu changed' };
      tools.pressed.push(item.label);
      if (/photo|file/i.test(item.label)) throw { code: 'NOT_A_TOOL', message: 'adds files' };
      if (item.submenu) tools.sub = true;
      else {
        if (tools.sticks) tools.active = tools.active === item.label ? null : item.label;
        Object.assign(tools, { open: false, sub: false });
      }
      return { pressed: item.label };
    }
    case 'tools_menu_close':
      Object.assign(tools, { open: false, sub: false });
      return { method: 'escape' };
    case 'tool_clear':
      if (!tools.active) return { pressed: null, tool: null };
      if (!tools.clearWorks) return { pressed: null, tool: tools.active, reason: `no remove control found on the "${tools.active}" pill` };
      tools.pressed.push(`remove ${tools.active}`);
      tools.active = null;
      return { pressed: 'button [aria-label="Remove"]', tool: null };
    case 'files_list':
      if (fake.filesLegacy) throw { code: 'UNKNOWN_COMMAND', message: 'unknown page command: files_list' };
      if (params.site === 'gemini') return { supported: false, conversation_id: fake.newChat ? null : fake.conv, files: [] };
      return { supported: true, conversation_id: fake.newChat ? null : fake.conv, message: args.message, replies: 1, current: true, generating: false, files: fake.files };
    case 'file_click':
      fake.clickedFiles.push(args.name);
      if (fake.files[args.index]?.kind === 'export' && fake.files[args.index].menu) fake.exportMenu = ['Copy contents', 'Export to Markdown', 'Export to PDF'];
      return { clicked: true, kind: fake.files[args.index]?.kind, name: args.name };
    case 'file_preview_state':
      return { open: true, download: fake.dl.previewButton, panel: 'aside [role="dialog"]', control: fake.dl.previewButton ? 'button [aria-label="Download"]' : null };
    case 'file_preview_text':
      return { text: PREVIEW_TEXT, source: 'pre' };
    case 'file_preview_close':
      fake.previewClosed++;
      return { closed: 'button' };
    case 'inspect':
      return { url: 'https://chatgpt.com/c/conv-test', selector: args.selector, matched: 1, nodes: 2, truncated: false, tree: args.selector.includes('menu') ? 'div [role="menu"]\n  div [role="menuitemradio"] "Instant"' : 'main\n  div [data-testid="x"]' };
    default:
      throw { code: 'UNKNOWN_COMMAND', message: cmd };
  }
}

// Mirrors background.js: the token is offered as a WebSocket subprotocol, never put in the URL.
function tryConnect({ origin, token, headers, query = '' } = {}) {
  return new Promise((resolve) => {
    const protocols = token === undefined ? [] : ['chatgpt-mcp-bridge', `token.${token}`];
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/${query}`, protocols, { origin, headers });
    let settled = false;
    const done = (r) => {
      if (!settled) {
        settled = true;
        resolve(r);
      }
    };
    ws.on('open', () => done({ ok: true, ws }));
    ws.on('unexpected-response', (req, res) => {
      done({ ok: false, status: res.statusCode });
      req.destroy();
    });
    ws.on('error', (e) => done({ ok: false, error: e.message }));
  });
}

// ---------------------------------------------------------------- 7. the real background.js, chrome.* simulated

const EXT_ID = EXT_ORIGIN.slice('chrome-extension://'.length);

function listeners() {
  const fns = new Set();
  return { addListener: (f) => fns.add(f), removeListener: (f) => fns.delete(f), hasListener: (f) => fns.has(f), emit: (...a) => [...fns].forEach((f) => f(...a)) };
}

// chrome.downloads over a directory standing in for ~/Downloads, with Chrome's event order: onCreated without a
// file name, then onChanged naming it, then complete. start() is a page download; `how` it goes: "ok", "stall"
// (named, a partial .crdownload, never finishes), "prompt" (held by a Save dialog, never named) or "dismissed" (the
// Save dialog cancelled before naming — what headless Chrome 157 does at once when "Ask where to save" is on) or
// "slow" (like "ok", finishing after 300 ms). urls entries for chrome.downloads.download may carry `echo`: the page's
// own download of the same URL then starts too, 50 ms after the extension's, going as `echo` says ("ok", "prompt", …).
function simDownloads(dir) {
  const items = new Map();
  const log = { removed: [], erased: [], cancelled: [], fetched: [] };
  const urls = new Map(); // what chrome.downloads.download(url) receives: URL → { name, body }
  let next = 500;
  const onCreated = listeners();
  const onChanged = listeners();
  const view = (it) => ({ ...it, exists: !!it.filename && existsSync(it.filename) });
  const freePath = (name) => {
    const { name: stem, ext } = path.parse(name);
    for (let i = 0; ; i++) {
      const p = path.join(dir, i ? `${stem} (${i})${ext}` : name);
      // Chrome reserves a name as soon as it gives it, so concurrent downloads get "name (1)" …
      if (!existsSync(p) && !existsSync(`${p}.crdownload`) && ![...items.values()].some((x) => x.filename === p)) return p;
    }
  };
  function start({ url, referrer = '', name, body, how = 'ok', byExtensionId }) {
    const it = { id: ++next, url, finalUrl: url, referrer, filename: '', state: 'in_progress', startTime: new Date().toISOString(), bytesReceived: 0, totalBytes: body.length, fileSize: 0, mime: 'text/plain', danger: 'safe', byExtensionId };
    items.set(it.id, it);
    // Real Chrome 157 (checked end to end): onCreated carries no file name yet and no byExtensionId, even for an
    // extension's own chrome.downloads.download — whose onCreated arrives before download() answers.
    const created = () => onCreated.emit({ ...view(it), byExtensionId: undefined });
    if (byExtensionId) created();
    setTimeout(() => {
      if (!byExtensionId) created();
      if (how === 'prompt') return;
      if (how === 'dismissed') {
        setTimeout(() => {
          Object.assign(it, { state: 'interrupted', error: 'USER_CANCELED' });
          onChanged.emit({ id: it.id, state: { previous: 'in_progress', current: 'interrupted' }, error: { current: 'USER_CANCELED' } });
        }, 30);
        return;
      }
      setTimeout(() => {
        it.filename = freePath(name);
        if (how === 'slow') {
          onChanged.emit({ id: it.id, filename: { current: it.filename } });
          setTimeout(() => {
            writeFileSync(it.filename, body);
            it.bytesReceived = it.fileSize = body.length;
            it.state = 'complete';
            onChanged.emit({ id: it.id, state: { previous: 'in_progress', current: 'complete' } });
          }, 300);
          return;
        }
        if (how === 'stall') {
          it.partial = `${it.filename}.crdownload`;
          writeFileSync(it.partial, body.subarray(0, 3));
          it.bytesReceived = 3;
          onChanged.emit({ id: it.id, filename: { current: it.filename } });
          return;
        }
        writeFileSync(it.filename, body);
        it.bytesReceived = it.fileSize = body.length;
        onChanged.emit({ id: it.id, filename: { current: it.filename } });
        it.state = 'complete';
        onChanged.emit({ id: it.id, state: { previous: 'in_progress', current: 'complete' } });
      }, 30);
    }, 10);
    return it.id;
  }
  const api = {
    onCreated,
    onChanged,
    search: async ({ id }) => (items.has(id) ? [view(items.get(id))] : []),
    removeFile: async (id) => {
      const it = items.get(id);
      if (!it || it.state !== 'complete') throw new Error('Download must be complete');
      rmSync(it.filename);
      log.removed.push(id);
    },
    erase: async ({ id }) => {
      items.delete(id);
      log.erased.push(id);
      return [id];
    },
    cancel: async (id) => {
      const it = items.get(id);
      if (it?.state === 'in_progress') {
        Object.assign(it, { state: 'interrupted', error: 'USER_CANCELED' });
        if (it.partial) rmSync(it.partial, { force: true });
      }
      log.cancelled.push(id);
    },
    download: async ({ url }) => {
      log.fetched.push(url);
      const f = urls.get(url);
      if (!f) throw new Error('Invalid URL');
      if (f.echo) setTimeout(() => start({ url, referrer: 'https://chatgpt.com/c/conv-e2e', name: f.name, body: f.body, how: f.echo }), 50);
      return start({ url, name: f.name, body: f.body, how: f.how, byExtensionId: EXT_ID });
    },
  };
  return { api, items, log, urls, start };
}

// Loads extension/background.js into a vm context with chrome.* simulated; its WebSocket is a real one (ws, with
// the extension's Origin) to the server under test. Page commands go to sim.page, main-world scripts to
// sim.mainWorld (by function name). Tabs live in window 1 (sim.windows: { focused, state }); sim.focusRefused makes
// chrome.windows.update ignore focused: true, like macOS refusing Chrome the focus; sim.ui logs tab / window updates.
function loadBackground(sim) {
  const config = { port: PORT, token: TOKEN };
  const tabs = (sim.tabs = new Map());
  let nextTab = 40;
  const pageBridge = {
    instance: null,
    tabMark: null,
    handle: async (cmd, args) => {
      try {
        return { ok: true, result: await sim.page(cmd, args) };
      } catch (e) {
        return { ok: false, error: { code: e.code || 'PAGE_SCRIPT_ERROR', message: e.message } };
      }
    },
  };
  class Socket {
    static CONNECTING = 0;
    static OPEN = 1;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url, protocols) {
      this.inner = new WebSocket(url, protocols, { origin: EXT_ORIGIN });
      this.inner.on('open', () => this.onopen?.());
      this.inner.on('message', (data) => this.onmessage?.({ data: data.toString() }));
      this.inner.on('close', () => this.onclose?.());
      this.inner.on('error', () => this.onerror?.());
    }
    get readyState() {
      return this.inner.readyState;
    }
    send(data) {
      this.inner.send(data);
    }
    close() {
      this.inner.close();
    }
  }
  const sandbox = {
    console: { log() {}, info() {}, warn() {}, error: (...a) => sim.errors.push(a.join(' ')) },
    setTimeout, clearTimeout, setInterval, clearInterval, URL, crypto: globalThis.crypto, WebSocket: Socket,
    importScripts: () => {
      sandbox.MCP_BRIDGE_CONFIG = config;
    },
    chrome: {
      runtime: { id: EXT_ID, getManifest: () => ({ version: 'vm-test' }), onStartup: listeners(), onInstalled: listeners() },
      alarms: { onAlarm: listeners(), get: async () => null, create() {} },
      tabs: {
        onRemoved: listeners(),
        onUpdated: listeners(),
        create: async ({ url, active }) => {
          const tab = { id: ++nextTab, url, status: 'complete', windowId: 1, active: !!active };
          tabs.set(tab.id, tab);
          return { ...tab };
        },
        get: async (id) => {
          if (!tabs.has(id)) throw new Error(`No tab with id: ${id}.`);
          return { ...tabs.get(id) };
        },
        update: async (id, props) => {
          if (props.url) tabs.get(id).url = props.url;
          if (props.active) {
            sim.ui.push(`tab ${id} active`);
            for (const t of tabs.values()) if (t.windowId === tabs.get(id).windowId) t.active = t.id === id;
          }
          return { ...tabs.get(id) };
        },
      },
      windows: {
        get: async (id) => {
          if (!sim.windows.has(id)) throw new Error(`No window with id: ${id}.`);
          return { id, ...sim.windows.get(id) };
        },
        update: async (id, props) => {
          const w = sim.windows.get(id);
          sim.ui.push(`window ${id} ${JSON.stringify(props)}`);
          if (props.state) w.state = props.state;
          if (props.focused && !sim.focusRefused) w.focused = true;
          return { id, ...w };
        },
      },
      scripting: {
        executeScript: async ({ files, func, args = [], world }) => {
          if (files) {
            sandbox.__mcpBridge = pageBridge; // "content.js"
            return [{ result: null }];
          }
          if (world === 'MAIN') return [{ result: sim.mainWorld(func.name, args) }];
          return [{ result: await func(...args) }];
        },
      },
      downloads: sim.downloads.api,
    },
  };
  sandbox.self = sandbox;
  const ctx = vm.createContext(sandbox);
  vm.runInContext(readFileSync(path.join(HERE, '..', 'extension', 'background.js'), 'utf8'), ctx, { filename: 'background.js' });
  return {
    ctx,
    stop() {
      config.token = ''; // no reconnects
      vm.runInContext('ws?.close()', ctx);
    },
  };
}

async function testRealBackground() {
  const SIM_DIR = path.join(TMP, 'sim-chrome-downloads');
  const OUT = path.join(TMP, 'e2e-out');
  mkdirSync(SIM_DIR, { recursive: true });
  mkdirSync(OUT, { recursive: true });
  const sim = {
    errors: [],
    windows: new Map([[1, { focused: true, state: 'normal' }]]),
    ui: [],
    covered: false, // another app's window covers Chrome's
    focusRefused: false,
    downloads: simDownloads(SIM_DIR),
    catcher: null, // the main-world download catcher's notes while armed
    onPress: null, // what pressing a chip (file_click) or a preview's download button does
    pressed: [],
    previewClosed: 0,
    mainWorld(fn, args) {
      if (fn === 'installDownloadCatcher') {
        sim.catcher = { log: [] };
        return { armed: true };
      }
      if (fn === 'readDownloadCatcher') {
        const log = sim.catcher?.log ?? [];
        if (args[0]) sim.catcher = null;
        return log;
      }
      return null;
    },
    async page(cmd, args) {
      switch (cmd) {
        case 'ready':
          return { href: 'https://chatgpt.com/c/conv-e2e', title: 'e2e', conversation_id: 'conv-e2e', composer: true, login_required: false, messages: 2 };
        case 'visibility': {
          // what document.visibilityState says: the active tab of a focused, unminimized, uncovered window
          const tab = [...sim.tabs.values()].at(-1);
          const w = sim.windows.get(tab.windowId);
          const hidden = !tab.active || w.state === 'minimized' || !w.focused || sim.covered;
          return { visibility: hidden ? 'hidden' : 'visible', tab_hidden: hidden, has_focus: !hidden };
        }
        case 'files_list':
          return { supported: true, conversation_id: 'conv-e2e', message: 0, replies: 1, current: true, generating: false, files: REPLY_FILES };
        case 'file_click':
        case 'file_preview_download':
          sim.pressed.push(`${cmd}:${args.name}`);
          sim.onPress?.(cmd, args.name);
          return { clicked: true };
        case 'file_preview_state':
          return { open: true, download: true, panel: 'aside', control: 'button' };
        case 'file_preview_close':
          sim.previewClosed++;
          return { closed: 'button' };
        default:
          throw Object.assign(new Error(`unknown page command: ${cmd}`), { code: 'UNKNOWN_COMMAND' });
      }
    },
  };
  const { log, items } = sim.downloads;
  const signed = (name) => `https://files.oaiusercontent.com/file-${name}?se=2026-11-21&sig=SECRET`;
  const body = (name) => Buffer.from(FILE_BODY(name));
  // The page downloads the pressed file itself, as ChatGPT does after a click.
  const pageDownload = (how = 'ok') => (cmd, name) =>
    setTimeout(() => sim.downloads.start({ url: signed(name), referrer: 'https://chatgpt.com/c/conv-e2e', name, body: body(name), how }), 20);
  const simFiles = () => readdirSync(SIM_DIR).sort().join();

  const bg = loadBackground(sim);
  try {
    let r = null;
    for (const end = Date.now() + 5_000; Date.now() < end; await sleep(100)) {
      r = await call('get_status', { site: 'chatgpt' });
      if (!r.isError) break;
    }
    check('the real background.js (vm, chrome.* simulated) connects to the bridge', !r.isError && r.data.mcp_tab_open === false, JSON.stringify(r.data));
    r = await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-e2e' });
    check('…opens its dedicated tab', !r.isError && r.data.conversation_id === 'conv-e2e', JSON.stringify(r.data));
    r = await call('list_files');
    check('…list_files reaches the page through it', !r.isError && r.data.files.length === 5, JSON.stringify(r.data));

    // show_tab: the tab was opened in the background (active: false).
    r = await call('show_tab', { site: 'chatgpt' });
    check(
      'background show_tab: a background tab is made the active tab of its window → visible',
      !r.isError && r.data.tab_hidden === false && r.data.was_hidden === true && r.data.activated === true && r.data.focused === true && /tab \d+ active/.test(sim.ui.join()),
      JSON.stringify({ data: r.data, ui: sim.ui }),
    );
    sim.ui = [];
    r = await call('show_tab', { site: 'chatgpt' });
    check('…a visible tab is left alone (no tab or window update)', !r.isError && r.data.was_hidden === false && sim.ui.length === 0, JSON.stringify({ data: r.data, ui: sim.ui }));
    Object.assign(sim.windows.get(1), { state: 'minimized', focused: false });
    r = await call('show_tab', { site: 'chatgpt' });
    check(
      '…a minimized window is restored ("normal") and focused',
      !r.isError && r.data.tab_hidden === false && r.data.window_state === 'normal' && sim.ui.some((u) => /"state":"normal"/.test(u) && /"focused":true/.test(u)),
      JSON.stringify({ data: r.data, ui: sim.ui }),
    );
    Object.assign(sim.windows.get(1), { focused: false });
    sim.focusRefused = true;
    r = await call('show_tab', { site: 'chatgpt' });
    check('…focus refused (another app in front) → still hidden, reason says so', !r.isError && r.data.tab_hidden === true && r.data.focused === false && /another app is in front/.test(r.data.reason), JSON.stringify(r.data));
    sim.focusRefused = false;
    sim.covered = true;
    r = await call('show_tab', { site: 'chatgpt' });
    check('…active and focused but covered → still hidden, reason: covered by another window', !r.isError && r.data.tab_hidden === true && r.data.focused === true && /covered/.test(r.data.reason), JSON.stringify(r.data));
    sim.covered = false;

    // While the press downloads A, the user downloads a file of their own from another site.
    let userId = null;
    sim.onPress = (cmd, name) => {
      pageDownload()(cmd, name);
      userId = sim.downloads.start({ url: 'https://example.com/report.pdf', referrer: 'https://example.com/', name: 'report.pdf', body: Buffer.from('%PDF user file') });
    };
    r = await call('download_file', { name: '0593c80_A_gemma.patch', save_to: OUT });
    const aId = log.removed[0];
    check(
      'background: the download started by the press is caught, copied, and returned with size + sha256',
      !r.isError && r.data.capture === 'click' && r.data.path === path.join(OUT, '0593c80_A_gemma.patch') && readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_A_gemma.patch') &&
        r.data.sha256 === sha256(FILE_BODY('0593c80_A_gemma.patch')) && sim.pressed.join() === 'file_click:0593c80_A_gemma.patch',
      JSON.stringify(r.data),
    );
    check(
      '…Chrome\'s copy is deleted and erased; the user\'s own download stays untouched',
      log.removed.length === 1 && log.erased.join() === String(aId) && simFiles() === 'report.pdf' && items.has(userId) && items.get(userId).state === 'complete',
      JSON.stringify({ log, files: simFiles() }),
    );

    // The press starts nothing (e.g. Chrome holds the page's second download); the page tried to open a signed URL.
    sim.onPress = (cmd, name) => {
      sim.catcher.log.push({ how: 'window.open()', url: signed(name), name: null });
      sim.downloads.urls.set(signed(name), { name, body: body(name) });
    };
    r = await call('download_file', { name: '0593c80_B_cpu_probe.patch', save_to: OUT });
    check(
      'background: no page download → the URL the page tried to open is downloaded by the extension instead',
      !r.isError && r.data.capture === 'caught-url' && log.fetched.join() === signed('0593c80_B_cpu_probe.patch') && readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_B_cpu_probe.patch') && simFiles() === 'report.pdf',
      JSON.stringify({ data: r.data, log, files: simFiles() }),
    );

    // The page's own download of that URL turns up late, while the extension's is still running, and is still
    // unnamed when the capture ends (so not recognisable by name): removed as well.
    sim.onPress = (cmd, name) => {
      sim.catcher.log.push({ how: 'link click()', url: signed(name), name });
      sim.downloads.urls.set(signed(name), { name, body: body(name), how: 'slow', echo: 'prompt' });
    };
    let before = log.erased.length;
    let cancelledBefore = log.cancelled.length;
    r = await call('download_file', { name: '0593c80_C_confirmation.patch', save_to: OUT });
    check(
      'background: a late page download of the same URL during the fallback (still unnamed at the end) is removed too',
      !r.isError && r.data.capture === 'caught-url' && log.erased.length === before + 2 && log.cancelled.length === cancelledBefore + 1 && simFiles() === 'report.pdf' && readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_C_confirmation.patch'),
      JSON.stringify({ data: r.data, log, files: simFiles() }),
    );
    await fs.rm(r.data.path ?? path.join(OUT, 'none'), { force: true });

    sim.onPress = pageDownload('stall');
    before = log.erased.length;
    cancelledBefore = log.cancelled.length;
    r = await call('download_file', { name: '0593c80_C_confirmation.patch', save_to: OUT, timeout_seconds: 2 });
    check(
      'background: a download that never finishes → DOWNLOAD_TIMEOUT; it is cancelled, its partial file removed and the entry erased',
      r.isError && r.data.error.code === 'DOWNLOAD_TIMEOUT' && log.cancelled.length === cancelledBefore + 1 && log.erased.length === before + 1 && simFiles() === 'report.pdf' && !existsSync(path.join(OUT, '0593c80_C_confirmation.patch')),
      JSON.stringify({ data: r.data, log, files: simFiles() }),
    );

    sim.onPress = pageDownload('prompt');
    before = log.erased.length;
    cancelledBefore = log.cancelled.length;
    r = await call('download_file', { name: '0593c80_C_confirmation.patch', save_to: OUT });
    check(
      'background: a download held by a Save dialog → DOWNLOAD_PROMPTED, cancelled and erased',
      r.isError && r.data.error.code === 'DOWNLOAD_PROMPTED' && /Ask where to save/.test(r.data.error.message) && log.cancelled.length === cancelledBefore + 1 && log.erased.length === before + 1 && simFiles() === 'report.pdf',
      JSON.stringify({ data: r.data, log }),
    );

    sim.onPress = pageDownload('dismissed');
    before = log.erased.length;
    r = await call('download_file', { name: '0593c80_C_confirmation.patch', save_to: OUT });
    check(
      'background: a Save dialog cancelled before Chrome named the file → DOWNLOAD_PROMPTED (not a generic failure), erased',
      r.isError && r.data.error.code === 'DOWNLOAD_PROMPTED' && /Save dialog was cancelled/.test(r.data.error.message) && log.erased.length === before + 1 && simFiles() === 'report.pdf',
      JSON.stringify({ data: r.data, log }),
    );

    sim.onPress = () => {};
    r = await call('download_file', { name: '0593c80_C_confirmation.patch', save_to: OUT });
    check(
      'background: a press that starts nothing and opens no URL → DOWNLOAD_NOT_STARTED with what to allow',
      r.isError && r.data.error.code === 'DOWNLOAD_NOT_STARTED' && /automaticDownloads/.test(r.data.error.message),
      JSON.stringify(r.data),
    );

    sim.pressed = [];
    sim.onPress = (cmd, name) => cmd === 'file_preview_download' && pageDownload()(cmd, name);
    r = await call('download_file', { name: '0593c80_three_patches.md', save_to: OUT });
    check(
      'background: a preview chip opens its panel, the panel\'s download button is caught, the panel closed',
      !r.isError && r.data.via === 'preview-download' && r.data.capture === 'click' && sim.pressed.join() === 'file_click:0593c80_three_patches.md,file_preview_download:0593c80_three_patches.md' &&
        sim.previewClosed === 1 && readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_three_patches.md') && simFiles() === 'report.pdf',
      JSON.stringify({ data: r.data, pressed: sim.pressed }),
    );

    let refused = null;
    try {
      vm.runInContext(`METHODS.download_discard({ download_id: ${userId} })`, bg.ctx);
    } catch (e) {
      refused = e;
    }
    check(
      'background: download_discard refuses a download it did not make',
      refused?.code === 'DOWNLOAD_UNKNOWN' && items.has(userId) && existsSync(path.join(SIM_DIR, 'report.pdf')),
      String(refused),
    );
    check(
      'background: nothing left behind — no capture running, no download kept, only the user\'s file in Downloads',
      vm.runInContext('capture === null && captured.size === 0', bg.ctx) && simFiles() === 'report.pdf' && [...items.keys()].join() === String(userId) && sim.catcher === null,
      JSON.stringify({ files: simFiles(), items: [...items.keys()], errors: sim.errors }),
    );
  } finally {
    bg.stop();
    await sleep(200);
  }
}

// ---------------------------------------------------------------- run

try {
  // 1. MCP handshake over stdio
  const init = await rpc('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'test-mcp', version: '0.0.0' },
  });
  check('initialize returns serverInfo', init.result?.serverInfo?.name === 'chatgpt-web', JSON.stringify(init));
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

  const list = await rpc('tools/list', {});
  const names = (list.result?.tools || []).map((t) => t.name);
  check(
    `tools/list registers exactly the ${EXPECTED_TOOLS.length} tools`,
    names.length === EXPECTED_TOOLS.length && EXPECTED_TOOLS.every((n) => names.includes(n)),
    JSON.stringify(names),
  );
  check('every tool has an object inputSchema', list.result.tools.every((t) => t.inputSchema?.type === 'object'));

  let r = await call('get_status');
  check('get_status without extension → EXTENSION_NOT_CONNECTED', r.isError && r.data.error.code === 'EXTENSION_NOT_CONNECTED', JSON.stringify(r.data));

  // wait for the bridge to listen
  for (let i = 0; i < 50 && !/bridge listening/.test(stderrBuf); i++) await sleep(100);
  check(`bridge listens on 127.0.0.1:${PORT}`, /bridge listening on ws:\/\/127\.0\.0\.1:/.test(stderrBuf), stderrBuf);

  // 2. handshake security
  const refused = [
    ['Origin https://evil.example', { origin: 'https://evil.example', token: TOKEN }, 403],
    ['Origin http://localhost:3000', { origin: 'http://localhost:3000', token: TOKEN }, 403],
    ['missing Origin', { token: TOKEN }, 403],
    ['malformed chrome-extension Origin', { origin: 'chrome-extension://evil', token: TOKEN }, 403],
    ['DNS-rebinding Host header', { origin: EXT_ORIGIN, token: TOKEN, headers: { Host: `evil.example:${PORT}` } }, 403],
    ['wrong token', { origin: EXT_ORIGIN, token: randomBytes(32).toString('hex') }, 401],
    ['missing token', { origin: EXT_ORIGIN }, 401],
    ['token in the URL query (would leak into Chrome error logs)', { origin: EXT_ORIGIN, query: `?token=${TOKEN}` }, 401],
  ];
  for (const [label, opts, status] of refused) {
    const res = await tryConnect(opts);
    check(`refuses ${label} (HTTP ${status})`, !res.ok && res.status === status, JSON.stringify({ ...res, ws: undefined }));
    res.ws?.close();
  }

  // 3. legitimate extension connection
  const good = await tryConnect({ origin: EXT_ORIGIN, token: TOKEN });
  check('accepts chrome-extension:// Origin + correct token', good.ok, JSON.stringify(good));
  if (!good.ok) throw new Error('cannot continue without a bridge connection');
  const ext = good.ws;
  check('server echoes only the protocol name, never the token', ext.protocol === 'chatgpt-mcp-bridge', ext.protocol);
  const welcome = new Promise((resolve) => {
    ext.on('message', (raw) => {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'welcome') resolve(msg);
      if (msg.type !== 'request') return;
      try {
        ext.send(JSON.stringify({ type: 'response', id: msg.id, ok: true, result: fakeHandle(msg.method, msg.params) }));
      } catch (e) {
        ext.send(JSON.stringify({ type: 'response', id: msg.id, ok: false, error: e }));
      }
    });
  });
  ext.send(JSON.stringify({ type: 'hello', version: 'test', tabs: {} }));
  check('server answers hello with welcome', (await welcome).type === 'welcome');

  const second = await tryConnect({ origin: EXT_ORIGIN, token: TOKEN });
  check('refuses a second concurrent extension connection (HTTP 409)', !second.ok && second.status === 409, JSON.stringify({ ...second, ws: undefined }));

  r = await call('get_status');
  check(
    'get_status round trip through the extension',
    !r.isError && r.data.state === 'done' && r.data.chars === 42 && fake.received.includes('status'),
    JSON.stringify(r.data),
  );

  const before = fake.received.length;
  r = await call('open_conversation', { url_or_id: 'https://evil.example/c/abc' });
  check('open_conversation rejects non-chatgpt.com URLs before reaching Chrome', r.isError && r.data.error.code === 'INVALID_ARGUMENT' && fake.received.length === before, JSON.stringify(r.data));

  const convId = '6745a1b2-0c3d-8000-a1b2-c3d4e5f60718';
  r = await call('open_conversation', { url_or_id: convId });
  check('open_conversation maps a bare id to https://chatgpt.com/c/<id>', r.data.url === `https://chatgpt.com/c/${convId}` && r.data.conversation_id === convId, JSON.stringify(r.data));

  const geminiId = '3f2a9c1d7e8b4a60';
  r = await call('open_conversation', { url_or_id: `https://gemini.google.com/app/${geminiId}` });
  check(
    'open_conversation routes gemini.google.com URLs to the Gemini tab',
    !r.isError && r.data.site === 'gemini' && fake.lastSite === 'gemini' && r.data.conversation_id === geminiId,
    JSON.stringify(r.data),
  );
  r = await call('get_status');
  check('tools without "site" follow the most recent open_conversation', !r.isError && r.data.site === 'gemini' && fake.lastSite === 'gemini', JSON.stringify(r.data));
  r = await call('get_status', { site: 'chatgpt' });
  check('an explicit "site" overrides the default', !r.isError && r.data.site === 'chatgpt' && fake.lastSite === 'chatgpt', JSON.stringify(r.data));
  r = await call('open_conversation', { url_or_id: geminiId, site: 'gemini' });
  check('bare id + site "gemini" → https://gemini.google.com/app/<id>', r.data.url === `https://gemini.google.com/app/${geminiId}`, JSON.stringify(r.data));
  r = await call('open_conversation', { url_or_id: 'https://accounts.google.com/signin' });
  check('other Google hosts are rejected', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));
  r = await call('open_conversation', { url_or_id: 'https://chatgpt.com/', site: 'gemini' });
  check('a "site" that contradicts the URL is rejected', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));
  r = await call('get_status', { site: 'bard' });
  check('unknown "site" is rejected', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));

  const project = 'g-p-0123456789abcdef0123456789abcdef';
  r = await call('open_conversation', { url_or_id: project });
  check('open_conversation maps a bare project id to its /project page', r.data.url === `https://chatgpt.com/g/${project}/project`, JSON.stringify(r.data));

  r = await call('select_model');
  check(
    'select_model without arguments lists options and closes the menu',
    !r.isError && r.data.model === 'Instant' && r.data.mode === 'Chat' && r.data.models.length === 5 && r.data.models[0].kind === 'slider' && r.data.models[0].value === 'Pro' && r.data.models[1].selected && r.data.models[4].submenu && !picker.open && picker.pressed.length === 0,
    JSON.stringify(r.data),
  );
  r = await call('select_model', { model: 'pro', mode: 'work' });
  check(
    'select_model switches mode and model by case-insensitive text, then re-reads the selection',
    !r.isError && r.data.model === 'Pro' && r.data.mode === 'Work' && r.data.models.find((m) => m.selected)?.label === 'Pro' && !picker.open,
    JSON.stringify(r.data),
  );
  r = await call('select_model', { model: 'right away', outline: true });
  check(
    'select_model falls back to descriptions and returns the open menu outline on request',
    !r.isError && r.data.model === 'Instant' && /\[role="menu"\]/.test(r.text) && fake.received.includes('page:inspect'),
    JSON.stringify(r.data),
  );
  r = await call('select_model', { model: 'Pro' });
  picker.pressed = [];
  r = await call('select_model', { model: 'gpt-4o' });
  check('select_model descends into submenus; an exact label beats a prefix match', !r.isError && r.data.model === 'GPT-4o' && picker.pressed.join() === 'Legacy models,GPT-4o', JSON.stringify(r.data));
  picker.pressed = [];
  r = await call('select_model', { model: 'GPT' });
  check('ambiguous model → AMBIGUOUS_OPTION, nothing chosen, menu closed', r.isError && r.data.error.code === 'AMBIGUOUS_OPTION' && picker.model === 'GPT-4o' && !picker.open, JSON.stringify(r.data));
  r = await call('select_model', { model: 'heavy' });
  check('a slider level is reached with arrow keys, stopping at the exact name', !r.isError && picker.level === 4 && picker.keys === 2 && r.data.models[0].value === 'Heavy' && picker.model === 'GPT-4o', JSON.stringify(r.data));
  r = await call('select_model', { model: 'ext' });
  check('a partial slider level name is matched after scanning every level', !r.isError && picker.level === 3 && r.data.models[0].value === 'Extended', JSON.stringify(r.data));
  r = await call('select_model', { model: 'claude' });
  check(
    'unknown model → MODEL_NOT_FOUND listing slider levels, slider restored, menu closed',
    r.isError && r.data.error.code === 'MODEL_NOT_FOUND' && /Power slider: .*Light/.test(r.data.error.message) && picker.level === 3 && !picker.open,
    JSON.stringify(r.data),
  );
  r = await call('select_model', { mode: 'Task' });
  check('unknown mode → MODE_NOT_FOUND', r.isError && r.data.error.code === 'MODE_NOT_FOUND' && picker.mode === 'Work', JSON.stringify(r.data));
  fake.phase = 'generating';
  r = await call('select_model', { model: 'Pro' });
  check('select_model while generating → STILL_GENERATING', r.isError && r.data.error.code === 'STILL_GENERATING' && picker.model === 'GPT-4o', JSON.stringify(r.data));
  fake.phase = 'done';

  r = await call('open_conversation', { project: 'sand' });
  check(
    'open_conversation { project } opens a ChatGPT project by sidebar name',
    !r.isError && r.data.site === 'chatgpt' && r.data.project === 'Sandbox' && r.data.project_id === `g-p-${'ab'.repeat(16)}` && fake.received.includes('page:open_project'),
    JSON.stringify(r.data),
  );
  r = await call('open_conversation', { project: 'nope' });
  check('unknown project → PROJECT_NOT_FOUND listing the sidebar', r.isError && r.data.error.code === 'PROJECT_NOT_FOUND' && /Alpha/.test(r.data.error.message), JSON.stringify(r.data));
  r = await call('open_conversation', { project: 'Alpha', site: 'gemini' });
  check('project on Gemini → INVALID_ARGUMENT', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));
  r = await call('open_conversation', {});
  check('open_conversation needs url_or_id or project', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));

  fake.holdSend = true;
  r = await call('send_message', { text: 'task' });
  check(
    'a send held by a hidden tab → confirmed:false with a do-not-resend warning (not blamed on Task mode only; show_tab releases it)',
    !r.isError && r.data.sent && r.data.confirmed === false && /holding the message while the tab is hidden/.test(r.data.warning) && /Chat and Task mode alike/.test(r.data.warning) &&
      !/Task mode does this/.test(r.data.warning) && /show_tab/.test(r.data.warning),
    JSON.stringify(r.data),
  );
  const fillsBefore = fake.received.filter((x) => x === 'page:fill_composer').length;
  r = await call('send_message', { text: 'task' });
  check(
    'sending again while that text is still held → SEND_PENDING, nothing typed',
    r.isError && r.data.error.code === 'SEND_PENDING' && fake.received.filter((x) => x === 'page:fill_composer').length === fillsBefore,
    JSON.stringify(r.data),
  );
  Object.assign(fake, { holdSend: false, held: false });

  fake.sendDisabled = true;
  r = await call('send_message', { text: 'hi' });
  check(
    'missing Send button → SEND_BUTTON_UNAVAILABLE, nothing clicked, composer cleared',
    r.isError && r.data.error.code === 'SEND_BUTTON_UNAVAILABLE' && fake.clicks === 0 && fake.received.includes('page:clear_composer'),
    JSON.stringify(r.data),
  );
  fake.sendDisabled = false;

  r = await call('send_message', { text: 'hi', expect_conversation_id: 'some-other-conversation' });
  check('send_message → CONVERSATION_MISMATCH without clicking', r.isError && r.data.error.code === 'CONVERSATION_MISMATCH' && fake.clicks === 0, JSON.stringify(r.data));

  r = await call('send_message', { text: 'hello\nworld', expect_conversation_id: 'https://chatgpt.com/c/conv-test' });
  check('send_message clicks Send exactly once and confirms', !r.isError && r.data.sent && r.data.confirmed && fake.clicks === 1, JSON.stringify(r.data));

  r = await call('send_message', { text: 'again' });
  check('send_message while generating → STILL_GENERATING', r.isError && r.data.error.code === 'STILL_GENERATING' && fake.clicks === 1, JSON.stringify(r.data));

  r = await call('get_latest_reply', { wait_seconds: 3 });
  check(
    'get_latest_reply times out into a still_running job without partial text',
    !r.isError && r.data.complete === false && r.data.state === 'still_running' && /^job_/.test(r.data.job_id) && r.text === undefined,
    JSON.stringify(r.data),
  );
  const jobId = r.data.job_id;
  check(
    'still_running carries a wait_command for a background waiter',
    typeof r.data.wait_command === 'string' && r.data.wait_command.includes('wait-job.mjs') && r.data.wait_command.endsWith(jobId),
    JSON.stringify(r.data),
  );
  const waiter = runWaiter([jobId]);

  fake.phase = 'done';
  r = await call('get_job', { job_id: jobId, wait_seconds: 20 });
  check(
    'get_job completes (temporary local- id → real id) with Markdown, chars and sha256',
    !r.isError && r.data.complete === true && r.data.conversation_id === 'conv-test' && r.text === REPLY && r.data.sha256 === sha256(REPLY) && r.data.chars === REPLY.length,
    JSON.stringify(r.data),
  );
  let w = await waiter;
  check('wait-job.mjs exits 0 once the job is done, printing metadata only', w.code === 0 && w.out?.status === 'done' && w.out.sha256 === sha256(REPLY) && !JSON.stringify(w.out).includes('def f()'), JSON.stringify(w));

  await call('send_message', { text: 'one more' });
  r = await call('get_latest_reply', { wait_seconds: 1 });
  const failing = runWaiter([r.data.job_id]);
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' }); // cancels the job
  fake.phase = 'done';
  w = await failing;
  check('wait-job.mjs exits 1 when the job fails (navigated away)', w.code === 1 && w.out?.error?.code === 'NAVIGATED', JSON.stringify(w));
  w = await runWaiter(['job_000000000000', '--grace-seconds', '1']);
  check('wait-job.mjs exits 2 for an unknown job', w.code === 2 && w.out?.error?.code === 'JOB_NOT_FOUND', JSON.stringify(w));
  check('job status files are owner-only', ((await fs.stat(path.join(JOBS_DIR, `${jobId}.json`))).mode & 0o077) === 0);

  await fs.rm(TMP, { recursive: true, force: true });
  const target = path.join(TMP, 'reply.md');
  r = await call('get_latest_reply', { save_to: target, wait_seconds: 20 });
  const saved = r.data.saved_to && (await fs.readFile(r.data.saved_to, 'utf8'));
  check(
    'get_latest_reply save_to writes the file and returns only metadata',
    !r.isError && r.data.saved_to === target && saved === REPLY && r.data.sha256 === sha256(REPLY) && r.text === undefined && !('markdown' in r.data),
    JSON.stringify(r.data),
  );
  r = await call('get_latest_reply', { save_to: target, wait_seconds: 20 });
  check('save_to never overwrites by default (reply-1.md)', r.data.saved_to === path.join(TMP, 'reply-1.md'), JSON.stringify(r.data));
  r = await call('get_latest_reply', { save_to: target, overwrite: true, wait_seconds: 20 });
  check('overwrite=true reuses the same path', r.data.saved_to === target, JSON.stringify(r.data));
  r = await call('get_latest_reply', { save_to: 'relative/reply.md' });
  check('relative save_to → INVALID_ARGUMENT', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));

  r = await call('get_job', { job_id: 'job_nope', wait_seconds: 0 });
  check('unknown job_id → JOB_NOT_FOUND', r.isError && r.data.error.code === 'JOB_NOT_FOUND', JSON.stringify(r.data));

  // 4. Only the latest turn is in the DOM (2026-11-21 chatgpt.com): user_count stays 1 and
  //    assistant_count 2 ("Worked for …" + reply) before and after every send.
  const REPLY_B = '**Round two.**\n\nNew answer.\n';
  const REPLY_C = 'Third answer after 29 minutes of work.\n';
  const REPLY_D = 'Answer that arrived although the send was never seen.\n';
  Object.assign(fake, { latestTurn: true, phase: 'done', userHash: fakeHash('first question'), fingerprint: true, generateOnClick: false, nextReply: REPLY_B });
  let clicksBefore = fake.clicks;
  r = await call('send_message', { text: 'Second `question` with\n  code' });
  check(
    'latest-turn-only page: the send is confirmed by the user-message fingerprint although counts never change',
    !r.isError && r.data.confirmed === true && fake.clicks === clicksBefore + 1,
    JSON.stringify(r.data),
  );
  r = await call('get_latest_reply', { wait_seconds: 20 });
  check(
    'latest-turn-only page: get_latest_reply reads the new reply (no SEND_NOT_OBSERVED, assistant count unchanged)',
    !r.isError && r.data.complete === true && r.text === REPLY_B && !r.data.warning,
    JSON.stringify(r.data),
  );

  // The incident: older content.js (no fingerprint), the stop button seen while the reply is generated.
  Object.assign(fake, { userHash: null, fingerprint: false, generateOnClick: true, nextReply: REPLY_C });
  r = await call('send_message', { text: 'third question' });
  check('latest-turn-only page without a fingerprint: a stop button after the click confirms the send', !r.isError && r.data.confirmed === true, JSON.stringify(r.data));
  r = await call('get_latest_reply', { wait_seconds: 1 });
  const longJob = r.data.job_id;
  await sleep(SEND_NOT_OBSERVED_MS + 1_000); // generating for longer than SEND_NOT_OBSERVED_MS
  fake.phase = 'done';
  r = await call('get_job', { job_id: longJob, wait_seconds: 20 });
  check(
    'a long generation that ends on an unchanged-count page completes instead of SEND_NOT_OBSERVED',
    !r.isError && r.data.complete === true && r.text === REPLY_C && !r.data.warning,
    JSON.stringify(r.data),
  );

  // Nothing observable after the click (no fingerprint, no stop button): SEND_NOT_OBSERVED once, then
  // the reply on the page stays readable, with and without save_to.
  Object.assign(fake, { userHash: null, fingerprint: false, generateOnClick: false, nextReply: REPLY_D });
  r = await call('send_message', { text: 'fourth question' });
  check('an unobservable send → confirmed:false with a do-not-resend warning', !r.isError && r.data.confirmed === false && /Do NOT send again/.test(r.data.warning), JSON.stringify(r.data));
  r = await call('get_latest_reply', { wait_seconds: 20 });
  check('…the job reports SEND_NOT_OBSERVED', r.isError && r.data.error.code === 'SEND_NOT_OBSERVED' && /Do NOT send again/.test(r.data.error.message), JSON.stringify(r.data));
  r = await call('get_status');
  check(
    '…get_status shows the reply exists and the send was not observed',
    !r.isError && r.data.has_reply === true && r.data.last_role === 'assistant' && r.data.last_send?.observed === false && typeof r.data.last_send.sent_at === 'string',
    JSON.stringify(r.data),
  );
  await fs.mkdir(TMP, { recursive: true });
  const stuckTarget = path.join(TMP, 'after-not-observed.md');
  r = await call('get_latest_reply', { save_to: stuckTarget, wait_seconds: 20 });
  check(
    '…a later get_latest_reply(save_to) reads the reply on the page, with a warning, instead of SEND_NOT_OBSERVED',
    !r.isError && r.data.complete === true && r.data.saved_to === stuckTarget && (await fs.readFile(stuckTarget, 'utf8')) === REPLY_D && /never observed/.test(r.data.warning),
    JSON.stringify(r.data),
  );
  r = await call('get_latest_reply', { wait_seconds: 20 });
  check('…and so does get_latest_reply without save_to', !r.isError && r.text === REPLY_D && /never observed/.test(r.data.warning), JSON.stringify(r.data));
  fake.userHash = fake.renderedHash; // e.g. after reloading the extension, the message is recognised
  r = await call('get_latest_reply', { wait_seconds: 20 });
  check('…once the sent message is recognised, the warning goes away', !r.isError && r.text === REPLY_D && !r.data.warning, JSON.stringify(r.data));
  r = await call('get_status');
  check('…and get_status reports last_send.observed = true', !r.isError && r.data.last_send?.observed === true, JSON.stringify(r.data));
  Object.assign(fake, { latestTurn: false, userHash: null, fingerprint: false, generateOnClick: true, reply: REPLY });

  const blob = randomBytes(7 * 1024 * 1024 + 123);
  const blobPath = path.join(TMP, 'sample.pdf');
  await fs.writeFile(blobPath, blob);
  r = await call('upload_files', { paths: [blobPath] });
  check(
    'upload_files streams base64 chunks that reassemble byte-for-byte',
    !r.isError && r.data.uploaded?.[0]?.name === 'sample.pdf' && fake.committed?.[0]?.sha === sha256(blob) && fake.committed[0].chunks === 3 && fake.committed[0].mime === 'application/pdf',
    JSON.stringify({ result: r.data, committed: fake.committed }),
  );
  check(
    'upload_files reports the attach method once the preview is seen (ChatGPT file input)',
    !r.isError && r.data.attached === true && r.data.method === 'input' && r.data.uploading === false && fake.received.includes('page:upload_verify') && fake.received.at(-1) === 'page:upload_release',
    JSON.stringify(r.data),
  );
  r = await call('upload_files', { paths: ['relative.txt'] });
  check('upload_files rejects relative paths', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));

  // 5. Upload post-check (the 2026-11-21 Gemini incident: the drop was ignored, yet success was reported).
  const notePath = path.join(TMP, 'note.txt');
  await fs.writeFile(notePath, 'attach me\n');
  const GEMINI_METHODS = ['input', 'paste', 'picker']; // content.js order since the live tests
  const NO_INPUT = { applied: false, reason: 'no usable input[type=file] on the page' };
  const PICKER_MENU = { applied: false, pending: 'menu', via: 'picker Upload & tools' };
  const BLIND = {
    input: NO_INPUT,
    picker: PICKER_MENU,
    paste: { applied: true, patient: true, via: 'paste on div.ql-editor (handled)' },
    drop: { applied: true, via: 'drop on div.ql-editor' },
  };
  const NO_ITEM = { applied: false, reason: 'no upload item in the menu ("Add from Drive")' };
  const CHOOSER = { applied: false, pending: 'chooser', via: 'picker Upload & tools → "Upload files"' };

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: [], menu: NO_ITEM });
  let mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check(
    'no preview after any method → UPLOAD_NOT_ATTACHED listing each attempt, never success',
    r.isError && r.data.error.code === 'UPLOAD_NOT_ATTACHED' && /note\.txt/.test(r.data.error.message) && /picker: no upload item/.test(r.data.error.message) &&
      /paste \(paste on .*\): no preview of note\.txt/.test(r.data.error.message) && fake.attachLog.join() === 'input,paste,picker',
    JSON.stringify(r.data),
  );
  check(
    '…the files are released and the picker cleaned up afterwards',
    fake.received.slice(mark).includes('page:upload_picker_cancel') && fake.received.at(-1) === 'page:upload_release' && fake.lastSite === 'gemini',
    JSON.stringify(fake.received.slice(mark)),
  );

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['paste'], menu: NO_ITEM, lateMs: UPLOAD_ATTACH_MS + 800 });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check(
    'Gemini: a pasted file whose preview shows only after the usual window → still success via "paste", no other method tried meanwhile',
    !r.isError && r.data.attached === true && r.data.method === 'paste' && !r.data.warning && fake.attachLog.join() === 'input,paste' && !fake.received.slice(mark).includes('hook_file_chooser'),
    JSON.stringify(r.data),
  );

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['picker'], menu: CHOOSER, intercept: true });
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check(
    'a method the page ignores falls through to the next one; the result says which one worked',
    !r.isError && r.data.method === 'picker' && r.data.attempts.length === 2 && /^paste \(paste on div\.ql-editor \(handled\)\): no preview/.test(r.data.attempts[1]) && fake.attachLog.join() === 'input,paste,picker',
    JSON.stringify(r.data),
  );

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['picker'], menu: CHOOSER, intercept: true });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini', method: 'picker' });
  check(
    'method:"picker" tries only the upload menu, which hands the files to the page\'s file chooser',
    !r.isError && r.data.attached === true && r.data.method === 'picker' && /Upload files/.test(r.data.via) && !r.data.attempts &&
      fake.received.slice(mark).includes('hook_file_chooser') && fake.attachLog.join() === 'picker',
    JSON.stringify(r.data),
  );

  const FILLED = { applied: true, handoff: true, via: 'picker Upload & tools → "Upload files" → button.hidden-local-file-image-selector-button → filled input [type="file"]' };
  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['picker'], menu: FILLED });
  r = await call('upload_files', { paths: [notePath], site: 'gemini', method: 'picker' });
  check('picker that fills the clicked selector button\'s input (no chooser call in a hidden tab) → success', !r.isError && r.data.method === 'picker' && /filled input/.test(r.data.via), JSON.stringify(r.data));

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: [], menu: CHOOSER, intercept: false, pickerHidden: true });
  r = await call('upload_files', { paths: [notePath], site: 'gemini', method: 'picker' });
  check(
    'a pressed upload item that never asks for a chooser → UPLOAD_NOT_ATTACHED with what the page did instead',
    r.isError && r.data.error.code === 'UPLOAD_NOT_ATTACHED' && /never asked for a file chooser .*Upload files.*; pressed button\.mat-mdc-menu-item.*page clicks seen: none; file inputs now: 0; menu still open: no; tab hidden: yes/.test(r.data.error.message),
    JSON.stringify(r.data),
  );

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['drop'], menu: NO_ITEM });
  r = await call('upload_files', { paths: [notePath], site: 'gemini', method: 'drop' });
  check('method:"drop" is still available on request', !r.isError && r.data.method === 'drop' && fake.attachLog.join() === 'drop', JSON.stringify(r.data));

  r = await call('upload_files', { paths: [notePath], site: 'gemini', method: 'telepathy' });
  check('an unknown method → INVALID_ARGUMENT', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));

  resetUpload({ methods: GEMINI_METHODS, attach: { ...BLIND, input: { applied: true, handoff: true, via: 'input[type="file"]' } }, chipOn: [], menu: NO_ITEM });
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check(
    'files taken by the page\'s own file input but never shown → UPLOAD_NOT_ATTACHED without trying other methods (no double attach)',
    r.isError && r.data.error.code === 'UPLOAD_NOT_ATTACHED' && /input \(input\[type="file"\]\): no preview/.test(r.data.error.message) && fake.attachLog.join() === 'input',
    JSON.stringify(r.data),
  );

  resetUpload({ vanishAfter: 2 });
  r = await call('upload_files', { paths: [notePath], site: 'chatgpt' });
  check('a preview that goes away while uploading → UPLOAD_NOT_ATTACHED', r.isError && r.data.error.code === 'UPLOAD_NOT_ATTACHED' && /went away/.test(r.data.error.message), JSON.stringify(r.data));

  resetUpload({ legacy: true });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'chatgpt' });
  check(
    'an old content.js that cannot verify → EXTENSION_OUTDATED, nothing committed',
    r.isError && r.data.error.code === 'EXTENSION_OUTDATED' && !fake.received.slice(mark).includes('page:upload_commit'),
    JSON.stringify(r.data),
  );
  resetUpload();

  // 8. Hidden tabs — the 2026-11-21 Gemini incident: every upload method failed and a Chat-mode send went out 11 h
  //    late, all while the tab was hidden; with the tab visible the same upload attached at once.
  const since = (m) => fake.received.slice(m);
  const before8 = (m, a, b) => since(m).indexOf(a) >= 0 && since(m).indexOf(a) < since(m).indexOf(b);
  Object.assign(fake, { hidden: false, show: 'ok' });
  r = await call('show_tab', { site: 'gemini' });
  check('show_tab on a visible tab changes nothing', !r.isError && r.data.site === 'gemini' && r.data.tab_hidden === false && r.data.was_hidden === false, JSON.stringify(r.data));
  fake.hidden = true;
  r = await call('show_tab', { site: 'gemini' });
  check(
    'show_tab on a hidden tab brings it forward → { tab_hidden: false, activated, focused }',
    !r.isError && r.data.tab_hidden === false && r.data.was_hidden === true && r.data.activated === true && r.data.focused === true && !fake.hidden,
    JSON.stringify(r.data),
  );
  Object.assign(fake, { hidden: true, show: 'minimized' });
  r = await call('show_tab', { site: 'gemini' });
  check('show_tab that cannot make the tab visible reports why (not an error)', !r.isError && r.data.tab_hidden === true && /minimized/.test(r.data.reason) && r.data.window_state === 'minimized', JSON.stringify(r.data));

  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['paste'], menu: NO_ITEM });
  Object.assign(fake, { hidden: true, show: 'ok' });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check(
    'Gemini upload_files on a hidden tab brings it forward first (default on_hidden "show"), then attaches → tab_shown',
    !r.isError && r.data.attached === true && r.data.method === 'paste' && r.data.tab_shown === true && before8(mark, 'show_tab', 'page:upload_begin'),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['paste'], menu: NO_ITEM });
  Object.assign(fake, { hidden: true, show: 'minimized' });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check(
    '…a tab that stays hidden → TAB_HIDDEN saying why, before anything is attached',
    r.isError && r.data.error.code === 'TAB_HIDDEN' && /minimized/.test(r.data.error.message) && /nothing was attached/.test(r.data.error.message) && r.data.error.tab_hidden === true &&
      r.data.error.window_state === 'minimized' && !since(mark).some((x) => /upload_(begin|chunk|commit)/.test(x)),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  fake.show = 'ok';
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini', on_hidden: 'fail' });
  check(
    '…on_hidden "fail" → TAB_HIDDEN at once, the tab is not touched',
    r.isError && r.data.error.code === 'TAB_HIDDEN' && !since(mark).includes('show_tab') && !since(mark).includes('page:upload_begin') && fake.hidden,
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: [], menu: NO_ITEM });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini', on_hidden: 'proceed' });
  check(
    '…on_hidden "proceed" on a hidden tab, no previews → UPLOAD_NOT_ATTACHED led by "tab hidden: show the tab and retry", with tab_hidden + attempts',
    r.isError && r.data.error.code === 'UPLOAD_NOT_ATTACHED' && /^tab hidden: show the tab and retry/.test(r.data.error.message) && r.data.error.tab_hidden === true &&
      Array.isArray(r.data.error.attempts) && r.data.error.attempts.some((a) => /\[tab hidden\]$/.test(a)) && !since(mark).includes('show_tab'),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: [], menu: NO_ITEM });
  fake.hidden = false;
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check('…an upload that fails with the tab visible does not blame the tab', r.isError && r.data.error.code === 'UPLOAD_NOT_ATTACHED' && !/tab hidden:/.test(r.data.error.message) && r.data.error.tab_hidden === false, JSON.stringify(r.data));
  resetUpload();
  fake.hidden = true;
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'chatgpt' });
  check('ChatGPT keeps working in the background: hidden tab, default on_hidden "proceed", show_tab not called', !r.isError && r.data.attached === true && !r.data.tab_shown && !since(mark).includes('show_tab'), JSON.stringify(r.data));
  r = await call('upload_files', { paths: [notePath], site: 'gemini', on_hidden: 'later' });
  check('an unknown on_hidden → INVALID_ARGUMENT', r.isError && r.data.error.code === 'INVALID_ARGUMENT' && /on_hidden/.test(r.data.error.message), JSON.stringify(r.data));

  Object.assign(fake, { hidden: true, show: 'ok', phase: 'done' });
  let clicks8 = fake.clicks;
  mark = fake.received.length;
  r = await call('send_message', { text: 'round 2', site: 'gemini' });
  check(
    'Gemini send_message on a hidden tab brings it forward before typing, then sends → tab_shown',
    !r.isError && r.data.sent && r.data.confirmed && r.data.tab_shown === true && fake.clicks === clicks8 + 1 && before8(mark, 'show_tab', 'page:fill_composer'),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  Object.assign(fake, { hidden: true, show: 'unfocused', phase: 'done' });
  clicks8 = fake.clicks;
  mark = fake.received.length;
  r = await call('send_message', { text: 'round 2', site: 'gemini' });
  check(
    '…a tab that stays hidden → TAB_HIDDEN (another app in front), nothing typed or clicked',
    r.isError && r.data.error.code === 'TAB_HIDDEN' && /another app/.test(r.data.error.message) && /nothing was typed/.test(r.data.error.message) && r.data.error.focused === false &&
      !since(mark).includes('page:fill_composer') && fake.clicks === clicks8,
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  fake.show = 'ok';
  mark = fake.received.length;
  r = await call('send_message', { text: 'round 2', site: 'gemini', on_hidden: 'fail' });
  check('…on_hidden "fail" → TAB_HIDDEN, the tab is not touched, nothing typed', r.isError && r.data.error.code === 'TAB_HIDDEN' && !since(mark).includes('show_tab') && !since(mark).includes('page:fill_composer'), JSON.stringify(r.data));
  fake.showLegacy = true;
  mark = fake.received.length;
  r = await call('send_message', { text: 'round 2', site: 'gemini' });
  check('…an extension from before show_tab → TAB_HIDDEN asking to reload it, nothing typed', r.isError && r.data.error.code === 'TAB_HIDDEN' && /reload/.test(r.data.error.message) && !since(mark).includes('page:fill_composer'), JSON.stringify(r.data));
  r = await call('show_tab', { site: 'gemini' });
  check('…and show_tab itself → EXTENSION_OUTDATED', r.isError && r.data.error.code === 'EXTENSION_OUTDATED', JSON.stringify(r.data));
  fake.showLegacy = false;

  // A send held in the composer (counts unchanged, nothing observable): the preflight must not release it.
  Object.assign(fake, { latestTurn: true, fingerprint: false, userHash: null, generateOnClick: false, holdSend: true, hidden: true, phase: 'done' });
  r = await call('send_message', { text: 'held one', site: 'gemini', on_hidden: 'proceed' });
  check('Gemini on_hidden "proceed" → typed and clicked while hidden; held → confirmed:false with the hold warning', !r.isError && r.data.confirmed === false && /holding the message while the tab is hidden/.test(r.data.warning), JSON.stringify(r.data));
  mark = fake.received.length;
  r = await call('send_message', { text: 'held one', site: 'gemini' });
  check(
    '…sending again → SEND_PENDING before the preflight could show the tab (which would release the held text)',
    r.isError && r.data.error.code === 'SEND_PENDING' && /show_tab/.test(r.data.error.message) && !since(mark).includes('show_tab') && !since(mark).includes('page:fill_composer'),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  r = await call('get_latest_reply', { site: 'gemini', wait_seconds: 20 });
  check(
    '…SEND_NOT_OBSERVED for a held message says it is held and that show_tab lets it go out',
    r.isError && r.data.error.code === 'SEND_NOT_OBSERVED' && /holding the message/.test(r.data.error.message) && /show_tab/.test(r.data.error.message) && r.data.error.tab_hidden === true,
    JSON.stringify(r.data),
  );
  Object.assign(fake, { latestTurn: false, holdSend: false, held: false, hidden: false, generateOnClick: true, reply: REPLY, phase: 'done' });

  // expect_conversation_id "new" / a site's new-chat URL.
  Object.assign(fake, { hidden: true, newChat: false });
  mark = fake.received.length;
  r = await call('send_message', { text: 'fresh', site: 'gemini', expect_conversation_id: 'new' });
  check(
    'expect_conversation_id "new" on a tab showing a conversation → CONVERSATION_MISMATCH, nothing typed, the tab not even shown',
    r.isError && r.data.error.code === 'CONVERSATION_MISMATCH' && /expected an empty new chat/.test(r.data.error.message) && !since(mark).includes('page:fill_composer') && !since(mark).includes('show_tab'),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  Object.assign(fake, { hidden: false, newChat: true, newChatUsers: 1 });
  await call('open_conversation', { url_or_id: 'https://gemini.google.com/app' });
  r = await call('send_message', { text: 'fresh', site: 'gemini', expect_conversation_id: 'https://gemini.google.com/app' });
  check('…a new chat that already has a message is not "empty" → CONVERSATION_MISMATCH', r.isError && r.data.error.code === 'CONVERSATION_MISMATCH' && /already has 1 message/.test(r.data.error.message), JSON.stringify(r.data));
  fake.newChatUsers = 0;
  clicks8 = fake.clicks;
  r = await call('send_message', { text: 'fresh', site: 'gemini', expect_conversation_id: 'https://gemini.google.com/app' });
  check(
    '…https://gemini.google.com/app (the 2026-11-21 call that got INVALID_ARGUMENT) asserts an empty new chat → sent; content.js gets "new"',
    !r.isError && r.data.sent && fake.clicks === clicks8 + 1 && fake.lastFill?.expect_conversation_id === 'new',
    JSON.stringify(r.data),
  );
  fake.phase = 'done';
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/' });
  r = await call('send_message', { text: 'fresh', site: 'chatgpt', expect_conversation_id: 'https://chatgpt.com/' });
  check('…https://chatgpt.com/ does the same on ChatGPT', !r.isError && r.data.sent && fake.lastFill?.expect_conversation_id === 'new', JSON.stringify(r.data));
  fake.phase = 'done';
  r = await call('send_message', { text: 'fresh', site: 'chatgpt', expect_conversation_id: 'NEW' });
  check('…so does "NEW" (any case)', !r.isError && r.data.sent, JSON.stringify(r.data));
  fake.phase = 'done';
  mark = fake.received.length;
  r = await call('send_message', { text: 'fresh', site: 'gemini', expect_conversation_id: 'https://chatgpt.com/' });
  check('…another site\'s new-chat URL → INVALID_ARGUMENT before reaching Chrome', r.isError && r.data.error.code === 'INVALID_ARGUMENT' && since(mark).length === 0, JSON.stringify(r.data));
  fake.newChat = false;

  // 6. Reply files: list_files / download_file against the fake extension.
  const DL = path.join(TMP, 'downloads-out');
  r = await call('list_files', { site: 'chatgpt' });
  check(
    'list_files lists the reply\'s file chips with name, kind and index',
    !r.isError && r.data.supported === true && r.data.message === 0 && r.data.files.length === 5 &&
      r.data.files.filter((f) => f.kind === 'download').length === 3 && r.data.files[3].kind === 'preview' && r.data.files[4].index === 4 && r.data.files[0].name === '0593c80_A_gemma.patch',
    JSON.stringify(r.data),
  );
  r = await call('list_files', { site: 'chatgpt', message: 1 });
  check('list_files passes "message" (replies back) to the page', !r.isError && r.data.message === 1, JSON.stringify(r.data));
  r = await call('list_files', { site: 'chatgpt', message: 'previous' });
  check('a malformed "message" → INVALID_ARGUMENT', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));
  r = await call('list_files', { site: 'gemini' });
  check('list_files on Gemini → supported: false, no files', !r.isError && r.data.supported === false && r.data.files.length === 0, JSON.stringify(r.data));

  const bodyA = FILE_BODY('0593c80_A_gemma.patch');
  const savedA = path.join(DL, '0593c80_A_gemma.patch');
  mark = fake.received.length;
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_A_gemma.patch', save_to: `${DL}/` });
  check(
    'download_file saves into a directory (a trailing "/" creates it) and returns path, size, sha256, name',
    !r.isError && r.data.path === savedA && r.data.size === Buffer.byteLength(bodyA) && r.data.sha256 === sha256(bodyA) && r.data.name === '0593c80_A_gemma.patch' &&
      r.data.via === 'download' && r.data.capture === 'click' && readFileSync(savedA, 'utf8') === bodyA && !r.data.warning,
    JSON.stringify(r.data),
  );
  let dlReq = fake.dl.requests.at(-1);
  check(
    '…pressing that chip (index + name), then deleting Chrome\'s copy of exactly that download',
    dlReq?.cmd === 'file_click' && dlReq.args.index === 0 && dlReq.args.name === '0593c80_A_gemma.patch' && dlReq.native_ms === DOWNLOAD_NATIVE_MS &&
      fake.dl.discarded.join() === '1' && readdirSync(FAKE_DOWNLOADS).length === 0 && fake.received.slice(mark).join() === 'page:files_list,download,download_discard',
    JSON.stringify({ dlReq, discarded: fake.dl.discarded, received: fake.received.slice(mark) }),
  );
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_A_gemma.patch', save_to: DL });
  check('an existing target → FILE_EXISTS before anything is pressed', r.isError && r.data.error.code === 'FILE_EXISTS' && fake.dl.requests.length === 1, JSON.stringify(r.data));
  writeFileSync(savedA, 'old content');
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_A_gemma.patch', save_to: DL, overwrite: true });
  check('overwrite=true replaces it', !r.isError && readFileSync(savedA, 'utf8') === bodyA && r.data.sha256 === sha256(bodyA), JSON.stringify(r.data));
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_B_cpu_probe.patch', save_to: path.join(DL, 'renamed', 'B.patch') });
  check(
    'save_to naming a file saves under that name (missing directories are created)',
    !r.isError && r.data.path === path.join(DL, 'renamed', 'B.patch') && readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_B_cpu_probe.patch') && fake.dl.requests.at(-1).args.index === 1,
    JSON.stringify(r.data),
  );
  check('no temporary files are left in the target directory', !readdirSync(DL).some((f) => f.includes('.mcp-download')), JSON.stringify(readdirSync(DL)));

  let requests = fake.dl.requests.length;
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_a_gemma.patch', save_to: DL });
  check(
    'a name that is not exactly one of the reply\'s files → FILE_NOT_IN_REPLY listing them, nothing pressed',
    r.isError && r.data.error.code === 'FILE_NOT_IN_REPLY' && /0: 0593c80_A_gemma\.patch \(download\)/.test(r.data.error.message) && fake.dl.requests.length === requests,
    JSON.stringify(r.data),
  );
  fake.files = [...REPLY_FILES, { index: 5, name: 'decision_summary.md', kind: 'download', label: 'Download decision_summary.md' }];
  r = await call('download_file', { site: 'chatgpt', name: 'decision_summary.md', save_to: DL });
  check(
    'a name shown twice → AMBIGUOUS_FILE naming both indexes, nothing pressed',
    r.isError && r.data.error.code === 'AMBIGUOUS_FILE' && /index 4: preview, index 5: download/.test(r.data.error.message) && fake.dl.requests.length === requests && fake.clickedFiles.length === 3,
    JSON.stringify(r.data),
  );
  r = await call('download_file', { site: 'chatgpt', name: 'decision_summary.md', index: 5, save_to: DL });
  check('…"index" picks one of them', !r.isError && r.data.via === 'download' && fake.dl.requests.at(-1).args.index === 5, JSON.stringify(r.data));
  r = await call('download_file', { site: 'chatgpt', name: 'decision_summary.md', index: 0, save_to: DL });
  check('an index whose file has another name → FILE_NOT_IN_REPLY', r.isError && r.data.error.code === 'FILE_NOT_IN_REPLY', JSON.stringify(r.data));
  const BY_INDEX = path.join(DL, 'by-index');
  r = await call('download_file', { site: 'chatgpt', index: 1, save_to: BY_INDEX + '/' });
  check(
    '"index" alone picks the file (no name needed); it keeps its own name',
    !r.isError && r.data.name === '0593c80_B_cpu_probe.patch' && r.data.path === path.join(BY_INDEX, '0593c80_B_cpu_probe.patch') && fake.dl.requests.at(-1).args.index === 1 &&
      readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_B_cpu_probe.patch'),
    JSON.stringify(r.data),
  );
  requests = fake.dl.requests.length;
  r = await call('download_file', { site: 'chatgpt', index: 9, save_to: BY_INDEX });
  check('an index the reply does not have → FILE_NOT_IN_REPLY listing the files, nothing pressed', r.isError && r.data.error.code === 'FILE_NOT_IN_REPLY' && /no file 9/.test(r.data.error.message) && fake.dl.requests.length === requests, JSON.stringify(r.data));
  mark = fake.received.length;
  r = await call('download_file', { site: 'chatgpt', save_to: BY_INDEX });
  check('neither name nor index → INVALID_ARGUMENT before reaching Chrome', r.isError && r.data.error.code === 'INVALID_ARGUMENT' && /"index"/.test(r.data.error.message) && fake.received.length === mark, JSON.stringify(r.data));
  fake.files = [{ index: 0, name: '../../escape.patch', kind: 'download', label: 'Download ../../escape.patch' }];
  r = await call('download_file', { site: 'chatgpt', name: '../../escape.patch', save_to: DL });
  check(
    'a file name with path parts stays inside save_to',
    !r.isError && r.data.path === path.join(DL, '.._.._escape.patch') && existsSync(r.data.path) && !existsSync(path.join(TMP, 'escape.patch')) && !existsSync(path.join(HERE, 'escape.patch')),
    JSON.stringify(r.data),
  );
  fake.files = REPLY_FILES;

  const outside = path.join(TMP, 'outside.txt');
  writeFileSync(outside, 'keep me');
  const linkC = path.join(DL, '0593c80_C_confirmation.patch');
  await fs.symlink(outside, linkC);
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_C_confirmation.patch', save_to: DL });
  check('a symlink at the target counts as an existing file → FILE_EXISTS', r.isError && r.data.error.code === 'FILE_EXISTS' && readFileSync(outside, 'utf8') === 'keep me', JSON.stringify(r.data));
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_C_confirmation.patch', save_to: DL, overwrite: true });
  check(
    '…with overwrite the symlink itself is replaced; what it points to is never written',
    !r.isError && readFileSync(outside, 'utf8') === 'keep me' && !(await fs.lstat(linkC)).isSymbolicLink() && readFileSync(linkC, 'utf8') === FILE_BODY('0593c80_C_confirmation.patch'),
    JSON.stringify(r.data),
  );

  mark = fake.received.length;
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_three_patches.md', save_to: DL });
  dlReq = fake.dl.requests.at(-1);
  check(
    'a preview chip: opens the panel, downloads through its download button, closes the panel',
    !r.isError && r.data.via === 'preview-download' && r.data.kind === 'preview' && dlReq.cmd === 'file_preview_download' && fake.clickedFiles.at(-1) === '0593c80_three_patches.md' &&
      fake.previewClosed === 1 && readFileSync(r.data.path, 'utf8') === FILE_BODY('0593c80_three_patches.md') && fake.received.slice(mark).join() === 'page:files_list,page:file_click,page:file_preview_state,download,download_discard,page:file_preview_close',
    JSON.stringify({ data: r.data, received: fake.received.slice(mark) }),
  );
  fake.dl.previewButton = false;
  r = await call('download_file', { site: 'chatgpt', name: 'decision_summary.md', save_to: path.join(DL, 'summary.md') });
  check(
    'a preview without a download button → its text, flagged via: "preview-text" with a warning',
    !r.isError && r.data.via === 'preview-text' && /not the original bytes/.test(r.data.warning) && readFileSync(r.data.path, 'utf8') === PREVIEW_TEXT && r.data.sha256 === sha256(PREVIEW_TEXT) && fake.previewClosed === 2,
    JSON.stringify(r.data),
  );
  Object.assign(fake.dl, { previewButton: true, mode: 'not_started' });
  r = await call('download_file', { site: 'chatgpt', name: 'decision_summary.md', save_to: path.join(DL, 'summary-2.md') });
  check('a preview download button that starts nothing → falls back to the text', !r.isError && r.data.via === 'preview-text' && /started nothing/.test(r.data.warning) && fake.previewClosed === 3, JSON.stringify(r.data));
  fake.dl.mode = 'button_gone';
  r = await call('download_file', { site: 'chatgpt', name: 'decision_summary.md', save_to: path.join(DL, 'summary-3.md') });
  check('a preview download button gone by the time it is pressed → falls back to the text too', !r.isError && r.data.via === 'preview-text' && /no download button/.test(r.data.warning) && fake.previewClosed === 4, JSON.stringify(r.data));
  fake.dl.mode = 'not_started';
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_B_cpu_probe.patch', save_to: DL });
  check('a chip press that starts no download → DOWNLOAD_NOT_STARTED, nothing written', r.isError && r.data.error.code === 'DOWNLOAD_NOT_STARTED' && !existsSync(path.join(DL, '0593c80_B_cpu_probe.patch')), JSON.stringify(r.data));
  fake.dl.mode = 'timeout';
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_B_cpu_probe.patch', save_to: DL, timeout_seconds: 2 });
  check(
    'a download that does not finish → DOWNLOAD_TIMEOUT (timeout_seconds passed on), nothing written',
    r.isError && r.data.error.code === 'DOWNLOAD_TIMEOUT' && fake.dl.requests.at(-1).timeout_ms === 2_000 && !existsSync(path.join(DL, '0593c80_B_cpu_probe.patch')) && !readdirSync(DL).some((f) => f.includes('.mcp-download')),
    JSON.stringify(r.data),
  );
  fake.dl.mode = 'ok';
  r = await call('download_file', { site: 'gemini', name: 'notes.md', save_to: DL });
  check('download_file on Gemini → NOT_SUPPORTED', r.isError && r.data.error.code === 'NOT_SUPPORTED', JSON.stringify(r.data));
  r = await call('download_file', { site: 'chatgpt', name: '0593c80_A_gemma.patch', save_to: 'relative/dir' });
  check('a relative save_to → INVALID_ARGUMENT', r.isError && r.data.error.code === 'INVALID_ARGUMENT', JSON.stringify(r.data));
  fake.filesLegacy = true;
  r = await call('list_files', { site: 'chatgpt' });
  check('an extension from before list_files → EXTENSION_OUTDATED', r.isError && r.data.error.code === 'EXTENSION_OUTDATED', JSON.stringify(r.data));
  resetFiles();

  // 9. Gemini new chats default to Task mode (2026-11-22: both brainstorm rounds ran in Chat because no mode was
  //    passed); an explicit mode wins and is never switched back; existing conversations are never switched.
  const presses = () => fake.gem.presses.join();
  const GEM_NEW = 'https://gemini.google.com/app';
  Object.assign(fake, { newChat: true, newChatUsers: 0, hidden: false, phase: 'done', gem: { mode: 'Chat', toggle: true, sticks: true, presses: [] } });
  r = await call('open_conversation', { url_or_id: GEM_NEW });
  check('open_conversation on a new Gemini chat selects Task and reports it', !r.isError && r.data.conversation_id === null && r.data.mode === 'Task' && presses() === 'Task' && !r.data.warning, JSON.stringify(r.data));
  r = await call('get_status', { site: 'gemini' });
  check('get_status reports the mode', !r.isError && r.data.mode === 'Task' && r.data.page_stale === false, JSON.stringify(r.data));
  r = await call('select_model', { site: 'gemini', mode: 'Chat' });
  check('select_model { mode: "Chat" } switches to Chat', !r.isError && r.data.mode === 'Chat' && fake.gem.mode === 'Chat', JSON.stringify(r.data));
  let clicks9 = fake.clicks;
  mark = fake.received.length;
  r = await call('send_message', { site: 'gemini', text: 'brainstorm in chat', expect_conversation_id: 'new' });
  check(
    '…and send_message does not switch the explicit Chat back to Task',
    !r.isError && r.data.sent && fake.clicks === clicks9 + 1 && fake.gem.mode === 'Chat' && presses() === 'Task,Chat' && !since(mark).includes('page:set_mode'),
    JSON.stringify({ data: r.data, presses: presses() }),
  );
  fake.phase = 'done';
  r = await call('open_conversation', { url_or_id: GEM_NEW });
  check('the next open_conversation forgets that choice: Task again', !r.isError && r.data.mode === 'Task' && fake.gem.mode === 'Task', JSON.stringify(r.data));
  r = await call('open_conversation', { url_or_id: GEM_NEW, mode: 'Chat' });
  check('open_conversation { mode: "Chat" } picks Chat for this chat', !r.isError && r.data.mode === 'Chat' && fake.gem.mode === 'Chat', JSON.stringify(r.data));
  r = await call('send_message', { site: 'gemini', text: 'chat again' });
  check('…which send_message keeps', !r.isError && r.data.sent && fake.gem.mode === 'Chat' && !r.data.mode, JSON.stringify(r.data));
  fake.phase = 'done';

  // An existing conversation: no toggle, nothing pressed.
  Object.assign(fake, { newChat: false, gem: { ...fake.gem, presses: [] } });
  r = await call('open_conversation', { url_or_id: 'https://gemini.google.com/app/cf79525506f7daaa' });
  check('an existing Gemini conversation: mode null, nothing pressed', !r.isError && r.data.mode === null && presses() === '' && !r.data.warning, JSON.stringify(r.data));
  mark = fake.received.length;
  r = await call('send_message', { site: 'gemini', text: 'round 3' });
  check('…send_message there never touches the mode', !r.isError && r.data.sent && !since(mark).includes('page:set_mode') && !since(mark).includes('page:model_state') && presses() === '', JSON.stringify({ data: r.data, received: since(mark) }));
  fake.phase = 'done';

  // The toggle is not there yet when the chat opens: open_conversation warns, send_message refuses.
  Object.assign(fake, { newChat: true, gem: { mode: 'Chat', toggle: false, sticks: true, presses: [] } });
  r = await call('open_conversation', { url_or_id: GEM_NEW });
  check('a new chat whose toggle does not render → open_conversation still opens it, with a warning', !r.isError && r.data.mode === null && /no mode toggle/.test(r.data.warning), JSON.stringify(r.data));
  clicks9 = fake.clicks;
  mark = fake.received.length;
  r = await call('send_message', { site: 'gemini', text: 'must be task' });
  check(
    '…send_message → MODE_NOT_SET, nothing typed (never silently in another mode)',
    r.isError && r.data.error.code === 'MODE_NOT_SET' && /Task/.test(r.data.error.message) && /nothing was typed/.test(r.data.error.message) && !since(mark).includes('page:fill_composer') && fake.clicks === clicks9,
    JSON.stringify(r.data),
  );
  fake.gem.toggle = true;
  mark = fake.received.length;
  r = await call('send_message', { site: 'gemini', text: 'must be task' });
  check(
    '…once the toggle shows, send_message switches to Task before typing → mode: "Task"',
    !r.isError && r.data.sent && r.data.mode === 'Task' && fake.gem.mode === 'Task' && before8(mark, 'page:set_mode', 'page:fill_composer'),
    JSON.stringify({ data: r.data, received: since(mark) }),
  );
  fake.phase = 'done';

  // A press that does not take.
  Object.assign(fake, { gem: { mode: 'Chat', toggle: true, sticks: false, presses: [] } });
  await call('open_conversation', { url_or_id: GEM_NEW });
  r = await call('send_message', { site: 'gemini', text: 'must be task' });
  check('a mode press that does not take → MODE_NOT_SET, nothing typed', r.isError && r.data.error.code === 'MODE_NOT_SET' && /does not show it selected/.test(r.data.error.message), JSON.stringify(r.data));

  // upload_files puts the chat in Task before attaching; afterwards the mode is never switched under the files.
  Object.assign(fake, { gem: { mode: 'Chat', toggle: false, sticks: true, presses: [] } });
  await call('open_conversation', { url_or_id: GEM_NEW });
  fake.gem.toggle = true;
  resetUpload({ methods: GEMINI_METHODS, attach: BLIND, chipOn: ['paste'], menu: NO_ITEM });
  mark = fake.received.length;
  r = await call('upload_files', { paths: [notePath], site: 'gemini' });
  check('upload_files on a new Gemini chat selects Task before attaching → mode: "Task"', !r.isError && r.data.mode === 'Task' && before8(mark, 'page:set_mode', 'page:upload_begin'), JSON.stringify({ data: r.data, received: since(mark) }));
  fake.gem.mode = 'Chat'; // switched by hand after the upload
  mark = fake.received.length;
  r = await call('send_message', { site: 'gemini', text: 'with files' });
  check(
    '…a send that would have to switch the mode with files attached → MODE_NOT_SET, nothing pressed or typed',
    r.isError && r.data.error.code === 'MODE_NOT_SET' && /files are attached/.test(r.data.error.message) && !since(mark).includes('page:set_mode') && !since(mark).includes('page:fill_composer'),
    JSON.stringify(r.data),
  );
  r = await call('select_model', { site: 'gemini', mode: 'Chat' });
  r = await call('send_message', { site: 'gemini', text: 'with files' });
  check('…choosing the mode explicitly lets it go out in that mode', !r.isError && r.data.sent && fake.gem.mode === 'Chat', JSON.stringify(r.data));
  fake.phase = 'done';
  resetUpload();

  // select_model { model } without a mode applies the default first; { mode } without a toggle is still recorded.
  Object.assign(fake, { gem: { mode: 'Chat', toggle: false, sticks: true, presses: [] } });
  await call('open_conversation', { url_or_id: GEM_NEW });
  fake.gem.toggle = true;
  r = await call('select_model', { site: 'gemini', model: 'Thinking' });
  check('select_model { model } on a new Gemini chat selects Task first (the 2026-11-21 call)', !r.isError && r.data.mode === 'Task' && presses() === 'Task' && picker.model === 'Thinking', JSON.stringify(r.data));
  Object.assign(fake, { gem: { mode: 'Chat', toggle: false, sticks: true, presses: [] } });
  await call('open_conversation', { url_or_id: GEM_NEW });
  r = await call('select_model', { site: 'gemini', mode: 'Chat' });
  check('select_model { mode } without a toggle → MODE_TOGGLE_NOT_FOUND, but recorded as the choice', r.isError && r.data.error.code === 'MODE_TOGGLE_NOT_FOUND' && /recorded/.test(r.data.error.message), JSON.stringify(r.data));
  r = await call('send_message', { site: 'gemini', text: 'no toggle, chat is fine' });
  check('…so send_message goes ahead instead of MODE_NOT_SET', !r.isError && r.data.sent, JSON.stringify(r.data));
  Object.assign(fake, { newChat: false, phase: 'done', gem: { mode: 'Chat', toggle: true, sticks: true, presses: [] } });

  // A mistyped explicit mode is no choice: the default still applies and is still enforced.
  Object.assign(fake, { newChat: true, gem: { mode: 'Chat', toggle: true, sticks: true, presses: [] } });
  r = await call('open_conversation', { url_or_id: GEM_NEW, mode: 'Turbo' });
  check('open_conversation { mode } matching nothing → warning, the default Task applies instead', !r.isError && r.data.mode === 'Task' && /"Turbo" not pressed/.test(r.data.warning) && fake.gem.mode === 'Task', JSON.stringify(r.data));
  fake.gem.mode = 'Chat'; // switched by hand
  r = await call('send_message', { site: 'gemini', text: 'still task' });
  check('…and send_message still enforces Task (no override was recorded)', !r.isError && r.data.sent && r.data.mode === 'Task' && fake.gem.mode === 'Task', JSON.stringify(r.data));
  Object.assign(fake, { newChat: false, phase: 'done', gem: { mode: 'Chat', toggle: true, sticks: true, presses: [] } });
  picker.mode = 'Chat';
  r = await call('open_conversation', { project: 'sand', mode: 'Work' });
  check('open_conversation { project, mode } applies the mode on the project\'s new chat', !r.isError && r.data.project === 'Sandbox' && r.data.mode === 'Work' && picker.mode === 'Work', JSON.stringify(r.data));

  // 10. Stale page (2026-11-22, reproduced live): the user switched the ChatGPT tab to other conversations by hand
  //     and back; the URL said conversation A, the page still showed C's messages, and C's reply was saved as A's.
  const REPLY_A6 = 'Reply in conversation A.\n';
  const REPLY_C6 = 'r16 patch notes from conversation C.\n';
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' });
  Object.assign(fake, { conv: 'conv-test', latestTurn: true, fingerprint: true, userHash: fakeHash('an earlier question'), generateOnClick: false, nextReply: REPLY_A6, phase: 'done' });
  r = await call('send_message', { site: 'chatgpt', text: 'Question for A', expect_conversation_id: 'conv-test' });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 20 });
  check('stale page: a normal send + read in conversation A', !r.isError && r.text === REPLY_A6, JSON.stringify(r.data));
  fake.conv = 'conv-other'; // switched by hand …
  r = await call('get_status', { site: 'chatgpt' });
  check('…get_status sees the tab on another conversation → page_stale with a warning', !r.isError && r.data.conversation_id === 'conv-other' && r.data.page_stale === true && /conv-other/.test(r.data.warning), JSON.stringify(r.data));
  Object.assign(fake, { conv: 'conv-test', userHash: fakeHash('Question for C'), reply: REPLY_C6 }); // … and back: URL A, C's messages
  r = await call('get_status', { site: 'chatgpt' });
  check('…back on A\'s URL: still page_stale', !r.isError && r.data.conversation_id === 'conv-test' && r.data.page_stale === true, JSON.stringify(r.data));
  const staleTarget = path.join(TMP, 'stale', 'round2.md');
  r = await call('get_latest_reply', { site: 'chatgpt', save_to: staleTarget, wait_seconds: 20 });
  check(
    '…get_latest_reply(save_to) → PAGE_STALE, nothing saved (was: C\'s reply silently saved as A\'s)',
    r.isError && r.data.error.code === 'PAGE_STALE' && /open_conversation/.test(r.data.error.message) && r.data.error.expected_conversation_id === 'conv-test' && r.data.error.seen_conversation_id === 'conv-other' && !existsSync(staleTarget),
    JSON.stringify(r.data),
  );
  requests = fake.dl.requests.length;
  mark = fake.received.length;
  const staleCalls = [
    await call('list_files', { site: 'chatgpt' }),
    await call('download_file', { site: 'chatgpt', index: 0, save_to: path.join(TMP, 'stale') }),
    await call('send_message', { site: 'chatgpt', text: 'next round', expect_conversation_id: 'conv-test' }),
    await call('upload_files', { site: 'chatgpt', paths: [notePath] }),
  ];
  check(
    '…list_files / download_file / send_message / upload_files → PAGE_STALE, nothing pressed, typed or attached',
    staleCalls.every((x) => x.isError && x.data.error.code === 'PAGE_STALE') && fake.dl.requests.length === requests && !since(mark).some((x) => /fill_composer|upload_begin|file_click/.test(x)),
    JSON.stringify(staleCalls.map((x) => x.data.error?.code ?? x.data)),
  );
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' });
  Object.assign(fake, { userHash: fakeHash('Question for A'), reply: REPLY_A6 }); // the reload shows A's messages
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 20 });
  check('…open_conversation (a reload) clears it: A\'s reply is read', !r.isError && r.text === REPLY_A6 && !r.data.warning, JSON.stringify(r.data));
  r = await call('get_status', { site: 'chatgpt' });
  check('…and get_status reports page_stale: false', !r.isError && r.data.page_stale === false, JSON.stringify(r.data));

  // No read while the tab was away and back: the fingerprint of the latest user message gives it away.
  fake.nextReply = 'Second reply in A.\n';
  r = await call('send_message', { site: 'chatgpt', text: 'Second question for A' });
  check('stale page without a seen switch: the send is confirmed by its fingerprint', !r.isError && r.data.confirmed === true, JSON.stringify(r.data));
  Object.assign(fake, { userHash: fakeHash('Question for C'), reply: REPLY_C6 });
  r = await call('get_latest_reply', { site: 'chatgpt', save_to: staleTarget, wait_seconds: 20 });
  check(
    '…a latest user message that is no longer the sent one → PAGE_STALE, nothing saved',
    r.isError && r.data.error.code === 'PAGE_STALE' && /latest user message/.test(r.data.error.message) && !existsSync(staleTarget),
    JSON.stringify(r.data),
  );
  r = await call('get_latest_reply', { site: 'chatgpt', expect_conversation_id: 'conv-elsewhere-0000', wait_seconds: 1 });
  check('get_latest_reply { expect_conversation_id } on another conversation → CONVERSATION_MISMATCH, nothing read', r.isError && r.data.error.code === 'CONVERSATION_MISMATCH' && /nothing was read/.test(r.data.error.message), JSON.stringify(r.data));

  // The fingerprint check is armed only after the page showed the sent message (a truncated bubble never matches).
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' });
  Object.assign(fake, { fingerprint: false, userHash: null, generateOnClick: true, nextReply: 'Reply to a long prompt.\n' });
  r = await call('send_message', { site: 'chatgpt', text: 'A very long prompt whose bubble the page shortens' });
  fake.phase = 'done';
  fake.userHash = fakeHash('A very long prompt whose bub…');
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 20 });
  check('…a send never recognised by its fingerprint is not checked against it: the reply is read', !r.isError && r.text === 'Reply to a long prompt.\n', JSON.stringify(r.data));
  Object.assign(fake, { latestTurn: false, userHash: null, fingerprint: false, generateOnClick: true, reply: REPLY, conv: 'conv-test', phase: 'done' });

  // 11. ChatGPT composer tools / Deep Research (live 2026-11-22: not in the model menu, not a mode — expected as a "+" menu tool).
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/' });
  Object.assign(tools, { active: null, open: false, sub: false, pressed: [], sticks: true, clearWorks: true, legacy: false, pill: true, menuSelected: true });
  r = await call('select_model', { site: 'chatgpt' });
  check(
    'select_model without arguments also lists the composer "+" menu, its "More" submenu included, pressing no tool and closing it',
    !r.isError && r.data.tool === null && r.data.tools?.map((t) => t.label).join() === 'Add photos & files,Deep research,Create image,More,Web search,Canvas' &&
      r.data.tools.find((t) => t.label === 'Canvas').in === 'More' && r.data.tools.find((t) => t.label === 'Deep research').in === null &&
      r.data.models.length > 0 && tools.pressed.join() === 'More' && !tools.open && tools.active === null,
    JSON.stringify(r.data),
  );
  tools.pressed = [];
  mark = fake.received.length;
  r = await call('select_model', { site: 'chatgpt', tool: 'deep research' });
  check(
    'select_model { tool: "deep research" } presses it in the "+" menu, confirms it on the page, leaves the model picker alone',
    !r.isError && r.data.tool === 'Deep research' && tools.active === 'Deep research' && tools.pressed.join() === 'Deep research' && r.data.models === null &&
      !since(mark).includes('page:model_menu_open') && !tools.open,
    JSON.stringify(r.data),
  );
  r = await call('get_status', { site: 'chatgpt' });
  check('get_status shows the active tool (research_active: false before sending)', !r.isError && r.data.tool === 'Deep research' && r.data.research_active === false, JSON.stringify(r.data));
  r = await call('select_model', { site: 'chatgpt', tool: 'Deep research' });
  check('…choosing the tool that is already on presses nothing', !r.isError && r.data.tool === 'Deep research' && tools.pressed.length === 1, JSON.stringify(r.data));
  tools.pressed = [];
  r = await call('select_model', { site: 'chatgpt', tool: 'Add photos' });
  check(
    'an item that adds files is never a tool: TOOL_NOT_FOUND, only the submenu opened, nothing else pressed',
    r.isError && r.data.error.code === 'TOOL_NOT_FOUND' && /never pressed/.test(r.data.error.message) && tools.pressed.join() === 'More' && !tools.open && tools.active === 'Deep research',
    JSON.stringify(r.data),
  );
  tools.pressed = [];
  r = await call('select_model', { site: 'chatgpt', tool: 'canvas' });
  check('a tool inside the "More" submenu is found there', !r.isError && r.data.tool === 'Canvas' && tools.pressed.join() === 'More,Canvas' && !tools.open, JSON.stringify(r.data));
  r = await call('select_model', { site: 'chatgpt', tool: 'Deep research' });
  tools.sticks = false;
  r = await call('select_model', { site: 'chatgpt', tool: 'Create image' });
  check(
    'a press the composer does not show → TOOL_NOT_CONFIRMED (look at the tab before sending)',
    r.isError && r.data.error.code === 'TOOL_NOT_CONFIRMED' && r.data.error.pressed === 'Create image' && r.data.error.tool === 'Deep research' && /show_tab/.test(r.data.error.message),
    JSON.stringify(r.data),
  );
  tools.sticks = true;
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  check('select_model { tool: "none" } turns the tool off via its pill', !r.isError && r.data.tool === null && tools.active === null && tools.pressed.at(-1) === 'remove Deep research', JSON.stringify(r.data));
  Object.assign(tools, { active: 'Deep research', clearWorks: false, pressed: [] });
  r = await call('select_model', { site: 'chatgpt', tool: 'off' });
  check('…without a usable remove control: its "+" menu entry (shown selected) is pressed again', !r.isError && r.data.tool === null && tools.pressed[0] === 'Deep research' && tools.active === null, JSON.stringify(r.data));
  Object.assign(tools, { active: 'Deep research', sticks: false });
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  check('…and when nothing turns it off → TOOL_NOT_CLEARED', r.isError && r.data.error.code === 'TOOL_NOT_CLEARED' && r.data.error.tool === 'Deep research', JSON.stringify(r.data));
  Object.assign(tools, { active: null, sticks: true, clearWorks: true, legacy: true, pressed: [] });
  r = await call('select_model', { site: 'chatgpt' });
  check('content.js from before composer tools: a plain select_model still lists models (tools: null + a reload warning)', !r.isError && r.data.models.length > 0 && r.data.tools === null && r.data.tool === null && /reload/.test(r.data.warning), JSON.stringify(r.data));
  r = await call('select_model', { site: 'chatgpt', tool: 'Deep research' });
  check('…select_model { tool } → EXTENSION_OUTDATED', r.isError && r.data.error.code === 'EXTENSION_OUTDATED', JSON.stringify(r.data));
  r = await call('get_status', { site: 'chatgpt' });
  check('…get_status → tool: null, research_active: false', !r.isError && r.data.tool === null && r.data.research_active === false, JSON.stringify(r.data));
  tools.legacy = false;
  r = await call('select_model', { site: 'gemini', tool: 'Deep Research' });
  check('Gemini tools are not wired up → NOT_SUPPORTED', r.isError && r.data.error.code === 'NOT_SUPPORTED', JSON.stringify(r.data));

  // Opt-in only: a send without `tool` asserts that no tool is on (a leftover Deep research must not spend its quota).
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' });
  Object.assign(tools, { active: 'Deep research', pressed: [] }); // left on by hand
  mark = fake.received.length;
  const gateClicks = fake.clicks;
  r = await call('send_message', { site: 'chatgpt', text: 'a normal question' });
  check(
    'a default send with a tool on in the composer → TOOL_MISMATCH, nothing typed or clicked',
    r.isError && r.data.error.code === 'TOOL_MISMATCH' && r.data.error.tool === 'Deep research' && /tool: "Deep research"/.test(r.data.error.message) && !since(mark).includes('page:fill_composer') && fake.clicks === gateClicks,
    JSON.stringify(r.data),
  );
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  check('…select_model { tool: "none" } clears it', !r.isError && r.data.tool === null && tools.active === null, JSON.stringify(r.data));
  // The composer pill is not recognised (UNVERIFIED selectors) but the "+" menu shows the tool selected.
  Object.assign(tools, { pill: false, pressed: [] });
  r = await call('select_model', { site: 'chatgpt', tool: 'Deep research' });
  check('without a recognised pill the "+" menu\'s selected state confirms the tool', !r.isError && r.data.tool === 'Deep research' && r.data.tool_confirmed_by === 'menu' && tools.active === 'Deep research', JSON.stringify(r.data));
  r = await call('get_status', { site: 'chatgpt' });
  check('…get_status reports the menu-confirmed tool too', !r.isError && r.data.tool === 'Deep research', JSON.stringify(r.data));
  mark = fake.received.length;
  r = await call('send_message', { site: 'chatgpt', text: 'a normal question' });
  check(
    '…a default send is refused by what this server turned on, though the page shows no pill (TOOL_MISMATCH, nothing typed)',
    r.isError && r.data.error.code === 'TOOL_MISMATCH' && /turned on through this server/.test(r.data.error.message) && !since(mark).includes('page:fill_composer'),
    JSON.stringify(r.data),
  );
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  check('…tool "none" turns it off through the menu', !r.isError && r.data.tool === null && tools.active === null, JSON.stringify(r.data));
  // Neither pill nor menu state: the press stays unconfirmed, sends refuse until tool "none" (with a warning).
  Object.assign(tools, { menuSelected: false, pressed: [] });
  r = await call('select_model', { site: 'chatgpt', tool: 'Canvas' });
  check('a press neither the composer nor the menu shows → TOOL_NOT_CONFIRMED', r.isError && r.data.error.code === 'TOOL_NOT_CONFIRMED' && r.data.error.pressed === 'Canvas', JSON.stringify(r.data));
  r = await call('send_message', { site: 'chatgpt', text: 'a normal question' });
  check('…then a default send → TOOL_MISMATCH (never confirmed)', r.isError && r.data.error.code === 'TOOL_MISMATCH' && /never confirmed/.test(r.data.error.message), JSON.stringify(r.data));
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  check('…tool "none" with nothing on the page to tell: taken as off, with a warning to check the tab', !r.isError && r.data.tool === null && /remove it by hand/.test(r.data.warning), JSON.stringify(r.data));
  Object.assign(tools, { active: null, pill: true, menuSelected: true, pressed: [] });
  // send_message { tool } turns the tool on itself (and confirms it) before typing; a failure types nothing.
  tools.sticks = false;
  mark = fake.received.length;
  r = await call('send_message', { site: 'chatgpt', text: 'research this', tool: 'Deep research' });
  check('send_message { tool } that cannot be confirmed → TOOL_NOT_CONFIRMED, nothing typed', r.isError && r.data.error.code === 'TOOL_NOT_CONFIRMED' && !since(mark).includes('page:fill_composer'), JSON.stringify(r.data));
  tools.sticks = true;
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  Object.assign(tools, { active: null, pressed: [] });

  // A Deep Research send: the research runs without a stop button (UNVERIFIED UI) — still_running, then the report.
  const REPORT = '# Report\n\nFindings with a [source](https://example.org/a).\n';
  tools.pill = false; // confirmed by the menu only, as long as the pill selectors are unverified
  Object.assign(fake, { conv: 'conv-test', latestTurn: true, fingerprint: true, userHash: fakeHash('earlier'), generateOnClick: false, nextReply: '', phase: 'done' });
  r = await call('send_message', { site: 'chatgpt', text: 'Research the topic', tool: 'Deep research' });
  check('send_message { tool: "Deep research" } turns it on, then sends and reports the tool', !r.isError && r.data.confirmed && r.data.tool === 'Deep research' && tools.active === 'Deep research' && tools.pressed.includes('Deep research'), JSON.stringify(r.data));
  fake.research = { active: true, progress: true, completed: false, frame: false, label: 'Researching…', hash: 'r1' };
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 5 });
  check('while the research runs (no stop button): still_running with researching: true', !r.isError && r.data.state === 'still_running' && r.data.researching === true, JSON.stringify(r.data));
  const drJob = r.data.job_id;
  r = await call('get_status', { site: 'chatgpt' });
  check('…get_status: research_active, state "thinking"', !r.isError && r.data.research_active === true && r.data.state === 'thinking', JSON.stringify(r.data));
  const clicksDuringResearch = fake.clicks;
  r = await call('send_message', { site: 'chatgpt', text: 'are you done?', tool: 'Deep research' });
  check('…a send is refused meanwhile (it could interrupt the research)', r.isError && r.data.error.code === 'STILL_GENERATING' && fake.clicks === clicksDuringResearch, JSON.stringify(r.data));
  const drWaiter = runWaiter([drJob]);
  await sleep(4_000);
  r = await call('get_job', { job_id: drJob, wait_seconds: 1 });
  check('…still running after a while (a research reply is never "done" by a quiet page alone)', !r.isError && r.data.state === 'still_running', JSON.stringify(r.data));
  const drTarget = path.join(TMP, 'dr', 'report.md');
  r = await call('get_latest_reply', { site: 'chatgpt', save_to: drTarget, wait_seconds: 1 });
  Object.assign(fake, { reply: REPORT, research: { active: false, progress: false, completed: true, frame: false, label: 'Research completed in 14m', hash: 'r2' } });
  r = await call('get_job', { job_id: drJob, wait_seconds: 20 });
  check('the finished report is saved to save_to with its links', !r.isError && r.data.complete && readFileSync(r.data.saved_to, 'utf8') === REPORT && !r.data.warning, JSON.stringify(r.data));
  w = await drWaiter;
  check('…wait-job.mjs exits 0', w.code === 0 && w.out?.status === 'done', JSON.stringify(w));

  // Only a progress indicator, no report text: waited out (RESEARCH_QUIET_MS), then read as it is with a warning.
  Object.assign(fake, { userHash: fakeHash('Research the topic'), nextReply: '', extract: { source: 'text', frames_unreadable: 1 } });
  fake.research = { active: false, progress: true, completed: false, frame: true, label: null, hash: 'p1' };
  r = await call('send_message', { site: 'chatgpt', text: 'Research another topic', tool: 'Deep research' });
  const started = Date.now();
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 2 });
  check('a progress indicator after a research send keeps the job running', !r.isError && r.data.state === 'still_running' && r.data.researching === true, JSON.stringify(r.data));
  r = await call('get_status', { site: 'chatgpt' });
  check('…and get_status counts it as research (the send went out with Deep research)', !r.isError && r.data.research_active === true, JSON.stringify(r.data));
  fake.research = { ...fake.research, progress: false, hash: 'p2' };
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 20 });
  check(
    '…a research reply without report text is read only after RESEARCH_QUIET_MS, with warnings pointing at list_files',
    !r.isError && r.data.complete && Date.now() - started >= RESEARCH_QUIET_MS && /no report text/.test(r.data.warning) && /list_files/.test(r.data.warning),
    JSON.stringify(r.data),
  );

  // A clarifying question is an ordinary reply: it completes at once, without the research wait or a warning.
  Object.assign(fake, { userHash: fakeHash('Research another topic'), nextReply: 'Before I start: which years should I cover?\n', extract: {}, research: NO_RESEARCH });
  r = await call('send_message', { site: 'chatgpt', text: 'Research a third topic', tool: 'Deep research' });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 20 });
  check('a clarifying question from Deep Research completes like a normal reply', !r.isError && r.data.complete && r.text === 'Before I start: which years should I cover?\n' && !r.data.warning, JSON.stringify(r.data));

  // A research job whose tab is moved: exit 4, and after the reopen the job still knows it waits for the research
  // (a bare progress indicator keeps it running although the reopen forgot the send).
  Object.assign(fake, { userHash: fakeHash('Research a third topic'), nextReply: '' });
  r = await call('send_message', { site: 'chatgpt', text: 'Research a fourth topic', tool: 'Deep research' });
  fake.research = { active: false, progress: true, completed: false, frame: false, label: null, hash: 'm1' };
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 2 });
  const movedResearch = runWaiter([r.data.job_id]);
  fake.conv = 'conv-other';
  w = await movedResearch;
  check('a research job on a moved tab → wait-job exits 4 (tab_moved)', w.code === 4 && w.out?.conversation_id === 'conv-test', JSON.stringify(w));
  fake.conv = 'conv-test';
  await call('open_conversation', { url_or_id: 'conv-test', site: 'chatgpt' });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: RESEARCH_QUIET_MS / 1000 + 3 });
  check('…after open_conversation the new job still waits for the research (researching: true, no premature "done")', !r.isError && r.data.state === 'still_running' && r.data.researching === true, JSON.stringify(r.data));
  Object.assign(fake, { reply: REPORT, research: { active: false, progress: false, completed: true, frame: false, label: 'Research completed in 31m', hash: 'm2' } });
  r = await call('get_job', { job_id: r.data.job_id, wait_seconds: 20 });
  check('…and reads the report once it is done', !r.isError && r.data.complete && r.text === REPORT, JSON.stringify(r.data));
  // The same from a new chat (the documented flow): the research send's conversation id is learned after the send.
  Object.assign(fake, { research: NO_RESEARCH, reply: REPLY, userHash: fakeHash('Research a fourth topic'), nextReply: '' });
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/' });
  Object.assign(fake, { newChat: true, latestTurn: false });
  r = await call('send_message', { site: 'chatgpt', text: 'Research from a new chat', tool: 'Deep research', expect_conversation_id: 'new' });
  check('a research send from a new chat goes out with the tool', !r.isError && r.data.tool === 'Deep research', JSON.stringify(r.data));
  // The research card shows no stop button and no report text yet; the new chat gets its id.
  Object.assign(fake, { newChat: false, conv: 'conv-dr-new', phase: 'done', reply: '', research: { active: false, progress: true, completed: false, frame: false, label: null, hash: 'n1' } });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 2 });
  const movedNew = runWaiter([r.data.job_id]);
  fake.conv = 'conv-other';
  w = await movedNew;
  check('…its job on a moved tab → exit 4 naming the conversation the new chat became', w.code === 4 && w.out?.conversation_id === 'conv-dr-new', JSON.stringify(w));
  fake.conv = 'conv-dr-new';
  await call('open_conversation', { url_or_id: 'conv-dr-new', site: 'chatgpt' });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: RESEARCH_QUIET_MS / 1000 + 3 });
  check('…after the reopen it still waits for the research (researching: true)', !r.isError && r.data.state === 'still_running' && r.data.researching === true, JSON.stringify(r.data));
  Object.assign(fake, { reply: REPORT, research: { active: false, progress: false, completed: true, frame: false, label: 'Research completed in 12m', hash: 'n2' } });
  r = await call('get_job', { job_id: r.data.job_id, wait_seconds: 20 });
  check('…and reads the report once it is done', !r.isError && r.data.complete && r.text === REPORT, JSON.stringify(r.data));
  Object.assign(fake, { conv: 'conv-test', phase: 'done' });

  // A report's export control (UNVERIFIED): list_files offers it, download_file picks the format in its menu.
  fake.files = [...REPLY_FILES, { index: REPLY_FILES.length, name: 'Export', kind: 'export', label: 'Export', menu: true }];
  r = await call('list_files', { site: 'chatgpt' });
  check('list_files offers a report export as kind "export"', !r.isError && r.data.files.at(-1).kind === 'export' && r.data.files.at(-1).menu === true, JSON.stringify(r.data));
  const exportDir = path.join(TMP, 'exports');
  const discardedBefore = fake.dl.discarded.length;
  r = await call('download_file', { site: 'chatgpt', name: 'Export', save_to: `${exportDir}/` });
  check(
    'download_file on an export: Markdown chosen by default, saved under the downloaded name, Chrome\'s copy removed',
    !r.isError && r.data.via === 'export' && r.data.format === 'Export to Markdown' && r.data.path === path.join(exportDir, 'deep-research-report.md') && existsSync(r.data.path) &&
      fake.dl.discarded.length === discardedBefore + 1 && fake.exportMenu === null,
    JSON.stringify(r.data),
  );
  r = await call('download_file', { site: 'chatgpt', name: 'Export', save_to: exportDir, format: 'pdf' });
  check('…format "pdf" picks the PDF entry', !r.isError && r.data.format === 'Export to PDF' && r.data.path.endsWith('deep-research-report.pdf'), JSON.stringify(r.data));
  const discardedBeforeTaken = fake.dl.discarded.length;
  r = await call('download_file', { site: 'chatgpt', name: 'Export', save_to: exportDir });
  check('…a taken name → FILE_EXISTS, and Chrome\'s copy is still removed', r.isError && r.data.error.code === 'FILE_EXISTS' && fake.dl.discarded.length === discardedBeforeTaken + 1, JSON.stringify(r.data));
  r = await call('download_file', { site: 'chatgpt', name: 'Export', save_to: exportDir, format: 'docx' });
  check('…a format the menu lacks → FORMAT_NOT_FOUND listing the offered ones', r.isError && r.data.error.code === 'FORMAT_NOT_FOUND' && /Export to PDF/.test(r.data.error.message) && fake.exportMenu === null, JSON.stringify(r.data));
  resetFiles();
  Object.assign(tools, { pill: true, menuSelected: true });
  r = await call('select_model', { site: 'chatgpt', tool: 'none' });
  check('select_model { tool: "none" } leaves the tab with no tool (the opt-in end state)', !r.isError && r.data.tool === null && tools.active === null, JSON.stringify(r.data));
  Object.assign(fake, { latestTurn: false, userHash: null, fingerprint: false, generateOnClick: true, reply: REPLY, conv: 'conv-test', phase: 'done', research: NO_RESEARCH, extract: {} });

  // 12. The tab moved to another conversation mid-reply (2026-11-22): the reply is fine, so the job says how to recover.
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' });
  fake.convWhileGenerating = true;
  r = await call('send_message', { site: 'chatgpt', text: 'a long question' });
  const clicksAfterSend = fake.clicks;
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 3 });
  const movedJob = r.data.job_id;
  const movedWaiter = runWaiter([movedJob]);
  fake.conv = 'conv-other'; // switched by hand
  w = await movedWaiter;
  check(
    'wait-job.mjs exits 4 with status "tab_moved", the conversation to reopen and a never-resend recovery',
    w.code === 4 && w.out?.status === 'tab_moved' && w.out.conversation_id === 'conv-test' && w.out.error?.code === 'CONVERSATION_CHANGED' && w.out.error.tab_moved === true &&
      /open_conversation \{ url_or_id: "conv-test", site: "chatgpt" \}/.test(w.out.error.recovery) && /get_latest_reply/.test(w.out.error.recovery) && /Do NOT send/.test(w.out.error.recovery),
    JSON.stringify(w),
  );
  r = await call('get_job', { job_id: movedJob, wait_seconds: 1 });
  check('…get_job carries tab_moved, conversation_id and recovery too', r.isError && r.data.error.tab_moved === true && r.data.error.conversation_id === 'conv-test' && /Do NOT send/.test(r.data.error.message), JSON.stringify(r.data));
  Object.assign(fake, { conv: 'conv-test', phase: 'done' });
  await call('open_conversation', { url_or_id: 'conv-test', site: 'chatgpt' });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 20 });
  check('…the documented recovery (open_conversation + get_latest_reply) reads the reply without a resend', !r.isError && r.data.complete && r.text === REPLY && fake.clicks === clicksAfterSend, JSON.stringify(r.data));

  // Seen moved by get_status first and back on the URL by the next poll: PAGE_STALE inside the job, same exit 4.
  r = await call('send_message', { site: 'chatgpt', text: 'another long question' });
  r = await call('get_latest_reply', { site: 'chatgpt', wait_seconds: 3 });
  const staleWaiter = runWaiter([r.data.job_id]);
  fake.conv = 'conv-other';
  await call('get_status', { site: 'chatgpt' });
  fake.conv = 'conv-test';
  w = await staleWaiter;
  check('…a stale page inside a reply job also exits 4 (tab_moved)', w.code === 4 && w.out?.status === 'tab_moved' && w.out.conversation_id === 'conv-test' && /Do NOT send/.test(w.out.error?.recovery ?? ''), JSON.stringify(w));
  await call('open_conversation', { url_or_id: 'https://chatgpt.com/c/conv-test' });
  Object.assign(fake, { phase: 'done', convWhileGenerating: false });

  r = await call('inspect_page', { selector: 'main', depth: 3 });
  check('inspect_page returns metadata plus a DOM outline', !r.isError && r.data.matched === 1 && /data-testid/.test(r.text || ''), JSON.stringify(r));

  ext.close();
  await sleep(200);
  r = await call('get_status');
  check('after the extension disconnects → EXTENSION_NOT_CONNECTED', r.isError && r.data.error.code === 'EXTENSION_NOT_CONNECTED', JSON.stringify(r.data));

  await testRealBackground();

  check('stdout carried nothing but JSON-RPC messages', noise.length === 0 && stdoutBuf === '', JSON.stringify(noise.slice(0, 3)));

  child.stdin.end();
  const exit = await Promise.race([exited, sleep(3_000).then(() => null)]);
  check('server exits when stdin closes (Claude Code session ends)', exit !== null, 'still running 3s after stdin closed');
  check(`port ${PORT} is released afterwards`, await portFree(PORT));
} catch (e) {
  failures++;
  console.log(`✗ test aborted: ${e.stack || e}`);
} finally {
  if (child.exitCode === null) child.kill();
  await fs.rm(TMP, { recursive: true, force: true });
  await fs.rm(JOBS_DIR, { recursive: true, force: true });
}

if (failures) console.log(`\n--- server stderr ---\n${stderrBuf}`);
console.log(failures ? `\n${failures} check(s) FAILED` : '\nAll checks passed.');
process.exit(failures ? 1 : 0);
