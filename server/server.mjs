#!/usr/bin/env node
// stdio MCP server that drives the ChatGPT and Gemini web UIs in the user's everyday Chrome through the
// companion MV3 extension (../extension), one dedicated tab per site. The extension connects to a
// loopback-only WebSocket bridge guarded by an Origin check and a shared token. stdout carries JSON-RPC
// only — every log line goes to stderr.
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { WebSocketServer } from 'ws';

// A stray console.log would corrupt the JSON-RPC stream, so the whole console goes to stderr.
console.log = console.info = console.debug = console.error.bind(console);

const HERE = path.dirname(fileURLToPath(import.meta.url));
const VERSION = '0.3.0';
const HOST = '127.0.0.1';
const PORT = Number(process.env.CHATGPT_BRIDGE_PORT) || 17373;
const TOKEN_FILE = path.join(HERE, '.bridge-token');
const EXTENSION_ORIGIN = /^chrome-extension:\/\/[a-p]{32}$/;
// The extension offers [BRIDGE_PROTOCOL, "token.<hex>"]; only BRIDGE_PROTOCOL is ever echoed back.
const BRIDGE_PROTOCOL = 'chatgpt-mcp-bridge';

const POLL_MS = 2_000; // reply polling interval
const STABLE_MS = 2_000; // reply must be unchanged this long after generation stops
const MAX_WAIT_S = 45; // longest a single tool call blocks
const DEFAULT_WAIT_S = 40;
const SEND_NOT_OBSERVED_MS = Number(process.env.CHATGPT_BRIDGE_SEND_NOT_OBSERVED_MS) || 60_000; // env: tests only
const JOB_MAX_MS = 4 * 3600_000;
const JOB_TTL_MS = 6 * 3600_000;
const JOBS_DIR = process.env.CHATGPT_BRIDGE_JOBS_DIR || path.join(HERE, '.jobs'); // status files for wait-job.mjs
const JOB_FILE_REFRESH_MS = 10_000; // wait-job.mjs treats a running job not refreshed for 90 s as orphaned
const HEARTBEAT_STALE_MS = 60_000;
const UPLOAD_CHUNK_BYTES = 3 * 1024 * 1024;
const MAX_UPLOAD_FILES = 10;
const MAX_UPLOAD_FILE_BYTES = 200 * 1024 * 1024;
const UPLOAD_WAIT_MS = 240_000;
// How long one attach method gets to show its previews before the next is tried; a method that handed the
// files to the site's own file input, or one the page is slow to show (Gemini paste), gets 2.5× as long
// (env: tests only).
const UPLOAD_ATTACH_MS = Number(process.env.CHATGPT_BRIDGE_UPLOAD_ATTACH_MS) || 6_000;
const UPLOAD_POLL_MS = 300;
const DOWNLOAD_TIMEOUT_S = 60;
// Capture phases in background.js (how long a press gets to start a browser download, to start one at all, and
// to leave a Save dialog); the extension's defaults unless set (env: tests only).
const DOWNLOAD_PHASES = Object.fromEntries(
  [['native_ms', 'NATIVE'], ['start_ms', 'START'], ['prompt_ms', 'PROMPT']]
    .map(([key, env]) => [key, Number(process.env[`CHATGPT_BRIDGE_DOWNLOAD_${env}_MS`]) || 0])
    .filter(([, v]) => v > 0),
);
const PREVIEW_OPEN_MS = 8_000; // a preview panel must show up this long after the press
const PREVIEW_SETTLE_MS = 2_500; // an open panel gets this long to show its download button
// show_tab: how long the page gets to report itself visible after being brought forward (env: tests only).
const SHOW_TAB_MS = Number(process.env.CHATGPT_BRIDGE_SHOW_TAB_MS) || 3_000;
// What upload_files / send_message do when the MCP tab is hidden. Gemini holds a clicked Send until the tab is shown
// (Chat and Task mode alike — on 2026-11-21 a message went out 11 h late) and shows no attachment previews while
// hidden (the same upload attached at once with the tab visible); ChatGPT works in the background.
const ON_HIDDEN = ['show', 'fail', 'proceed'];
const DEFAULT_ON_HIDDEN = { chatgpt: 'proceed', gemini: 'show' };
// The mode a new chat is put in unless the caller chose one: Gemini "Task" (the user's wish, 2026-11-22), ChatGPT
// untouched. env CHATGPT_BRIDGE_DEFAULT_MODE_GEMINI / _CHATGPT: a mode's text, or "none" to leave the page alone.
function defaultModeFor(site, fallback) {
  const v = process.env[`CHATGPT_BRIDGE_DEFAULT_MODE_${site.toUpperCase()}`];
  if (v === undefined) return fallback;
  return !v.trim() || /^(none|off)$/i.test(v.trim()) ? null : v.trim();
}
const DEFAULT_MODE = { chatgpt: defaultModeFor('chatgpt', null), gemini: defaultModeFor('gemini', 'Task') };
// How long the mode toggle gets to render, and a pressed mode to show as selected (env: tests only).
const MODE_WAIT_MS = Number(process.env.CHATGPT_BRIDGE_MODE_WAIT_MS) || 3_000;

// Must match SITES in extension/background.js and host_permissions in extension/manifest.json.
const SITES = {
  chatgpt: {
    origin: 'https://chatgpt.com',
    hosts: ['chatgpt.com', 'www.chatgpt.com', 'chat.openai.com'],
    conversation: /\/c\/([^/?#\s]+)/,
    conversationUrl: (id) => `https://chatgpt.com/c/${id}`,
  },
  gemini: {
    origin: 'https://gemini.google.com',
    hosts: ['gemini.google.com'],
    conversation: /\/(?:app|gem\/[^/?#\s]+)\/([^/?#\s]+)/,
    conversationUrl: (id) => `https://gemini.google.com/app/${id}`,
  },
};
const SITE_NAMES = Object.keys(SITES);

const log = (...parts) => process.stderr.write(`[chatgpt-web] ${parts.join(' ')}\n`);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// `details` are extra fields of the error object a tool returns ({ error: { code, message, ...details } }).
class ToolError extends Error {
  constructor(code, message, details = null) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// ---------------------------------------------------------------- loopback bridge to the extension

const bridge = {
  ws: null,
  lastSeen: 0,
  seq: 0,
  pending: new Map(),
  tabs: {}, // site → { id, mark } of the extension's dedicated tabs, remembered across worker restarts
  listenError: null,
};

function readToken() {
  try {
    const token = readFileSync(TOKEN_FILE, 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch {
    return null;
  }
}

function tokenMatches(given, expected) {
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function isConnected() {
  return bridge.ws?.readyState === 1;
}

function notConnectedError() {
  let hint;
  if (bridge.listenError) {
    hint = `this server cannot listen on ${HOST}:${PORT} (${bridge.listenError.code || bridge.listenError.message}); another instance — e.g. a second Claude Code session — probably owns the bridge`;
  } else if (!readToken()) {
    hint = 'server/.bridge-token is missing — run `node scripts/init-token.mjs`, then reload the extension';
  } else {
    hint = 'make sure Chrome is running with the "ChatGPT MCP Bridge (local)" extension enabled; it reconnects within ~30 s';
  }
  return new ToolError('EXTENSION_NOT_CONNECTED', `Chrome extension is not connected: ${hint}`);
}

function ensureConnected() {
  if (!isConnected()) throw notConnectedError();
}

async function bridgeRequest(method, params = {}, timeoutMs = 30_000) {
  ensureConnected();
  const id = ++bridge.seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      bridge.pending.delete(id);
      reject(new ToolError('EXTENSION_TIMEOUT', `extension did not answer "${method}" within ${timeoutMs / 1000}s`));
    }, timeoutMs);
    bridge.pending.set(id, { resolve, reject, timer });
    bridge.ws.send(JSON.stringify({ type: 'request', id, method, params }));
  });
}

const page = (site, cmd, args = {}, timeoutMs = 30_000) => bridgeRequest('page', { site, cmd, args }, timeoutMs);

function failPending(code, message) {
  for (const { reject, timer } of bridge.pending.values()) {
    clearTimeout(timer);
    reject(new ToolError(code, message));
  }
  bridge.pending.clear();
}

// Returns null when the handshake is acceptable, otherwise why it is refused.
function checkHandshake(req) {
  const host = req.headers.host;
  if (host !== `${HOST}:${PORT}` && host !== `localhost:${PORT}`) return [403, 'Forbidden', `bad Host ${JSON.stringify(host)}`];
  const origin = req.headers.origin;
  if (typeof origin !== 'string' || !EXTENSION_ORIGIN.test(origin)) return [403, 'Forbidden', `bad Origin ${JSON.stringify(origin ?? null)}`];
  const expected = readToken();
  if (!expected) return [503, 'Service Unavailable', 'server token missing (run scripts/init-token.mjs)'];
  const offered = String(req.headers['sec-websocket-protocol'] || '').split(',').map((p) => p.trim());
  const given = offered.find((p) => p.startsWith('token.'))?.slice('token.'.length) || '';
  if (!offered.includes(BRIDGE_PROTOCOL) || !tokenMatches(given, expected)) return [401, 'Unauthorized', `bad token from ${origin}`];
  if (isConnected() && Date.now() - bridge.lastSeen < HEARTBEAT_STALE_MS) return [409, 'Conflict', 'another extension connection is active'];
  return null;
}

function onBridgeMessage(ws, msg) {
  switch (msg.type) {
    case 'hello':
      for (const [site, tab] of Object.entries(msg.tabs || {})) {
        if (Object.hasOwn(SITES, site) && tab?.id != null) bridge.tabs[site] = { id: tab.id, mark: tab.mark };
      }
      log(`extension hello (v${msg.version}, tabs ${JSON.stringify(bridge.tabs)})`);
      ws.send(JSON.stringify({ type: 'welcome', server: VERSION, tabs: bridge.tabs }));
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', t: msg.t }));
      break;
    case 'event':
      if (!Object.hasOwn(SITES, msg.site)) break;
      if (msg.event === 'tab_bound') bridge.tabs[msg.site] = { id: msg.tabId, mark: msg.mark };
      else if (msg.event === 'tab_closed' && bridge.tabs[msg.site]?.id === msg.tabId) delete bridge.tabs[msg.site];
      break;
    case 'response': {
      const p = bridge.pending.get(msg.id);
      if (!p) return;
      bridge.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new ToolError(msg.error?.code || 'EXTENSION_ERROR', msg.error?.message || 'extension error'));
      break;
    }
  }
}

function attach(ws, req) {
  if (bridge.ws) {
    failPending('EXTENSION_DISCONNECTED', 'extension connection was replaced');
    bridge.ws.terminate();
  }
  bridge.ws = ws;
  bridge.lastSeen = Date.now();
  log(`extension connected (${req.headers.origin})`);
  ws.on('message', (data, isBinary) => {
    bridge.lastSeen = Date.now();
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(data.toString());
    } catch {
      return;
    }
    onBridgeMessage(ws, msg);
  });
  ws.on('pong', () => {
    bridge.lastSeen = Date.now();
  });
  ws.on('close', (code) => {
    if (bridge.ws !== ws) return;
    bridge.ws = null;
    failPending('EXTENSION_DISCONNECTED', 'extension disconnected');
    log(`extension disconnected (${code})`);
  });
  ws.on('error', (e) => log(`bridge socket error: ${e.message}`));
}

const httpServer = http.createServer((req, res) => {
  res.writeHead(426, { 'Content-Type': 'text/plain', Connection: 'close' });
  res.end('WebSocket only\n');
});
const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 32 * 1024 * 1024,
  handleProtocols: (protocols) => (protocols.has(BRIDGE_PROTOCOL) ? BRIDGE_PROTOCOL : false),
});

httpServer.on('upgrade', (req, socket, head) => {
  const refusal = checkHandshake(req);
  if (refusal) {
    const [status, text, reason] = refusal;
    log(`refused bridge handshake: ${reason}`);
    socket.on('error', () => {});
    socket.end(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => attach(ws, req));
});

httpServer.on('error', (err) => {
  if (httpServer.listening) {
    log(`bridge server error: ${err.message}`);
    return;
  }
  bridge.listenError = err;
  log(`cannot listen on ${HOST}:${PORT} (${err.code || err.message}); retrying every 5s`);
  setTimeout(() => httpServer.listen(PORT, HOST), 5_000).unref();
});

function startBridge() {
  httpServer.listen(PORT, HOST, () => {
    bridge.listenError = null;
    log(`bridge listening on ws://${HOST}:${PORT}${readToken() ? '' : ' (WARNING: server/.bridge-token missing — run scripts/init-token.mjs)'}`);
  });
  setInterval(() => {
    const ws = bridge.ws;
    if (!ws) return;
    if (Date.now() - bridge.lastSeen > HEARTBEAT_STALE_MS) {
      log('extension heartbeat lost; dropping connection');
      ws.terminate();
      return;
    }
    ws.ping();
  }, 15_000).unref();
}

// ---------------------------------------------------------------- reply jobs

const jobs = new Map();
// Per site: activeJob follows the reply currently on that tab; pendingSend describes the last message
// sent there through send_message: { baseline, sentAt, confirmed, observed, unobserved, conversationId, hashSeen }
// — observed latches once the message is seen on the page, unobserved once a job has reported SEND_NOT_OBSERVED,
// conversationId is where it went (filled in once a new chat gets its id), hashSeen latches once the page showed
// it as the latest user message by its fingerprint. Since the last open_conversation: modeOverride = the mode the
// caller chose explicitly (the default mode is then left alone), attached = upload_files attached files not yet
// sent, stale = { expected, seen, at } once the tab was seen on another conversation (see notePage).
const siteState = Object.fromEntries(
  SITE_NAMES.map((site) => [site, { activeJob: null, pendingSend: null, modeOverride: null, attached: false, stale: null }]),
);

// A navigation by open_conversation: the page is reloaded and every per-chat record starts over.
function resetSite(site, modeOverride = null) {
  cancelActiveJob(site, 'NAVIGATED', 'open_conversation navigated the MCP tab away');
  Object.assign(siteState[site], { pendingSend: null, modeOverride, attached: false, stale: null });
}

// ---------------------------------------------------------------- stale pages
//
// 2026-11-22: after the user switched the ChatGPT MCP tab to other conversations by hand and back (in-app
// navigation), the URL showed conversation A again while the page still showed another conversation's messages,
// and get_latest_reply saved that reply as A's. Two checks guard reads: (1) once the tab is seen on another
// conversation than the one the last send went to (or a reply job sees it move), the site is flagged stale until
// open_conversation reloads the page; (2) once the page has shown the sent message as its latest user message (by
// fingerprint), a different latest user message means the page is not showing that exchange any more. Check (2) is
// only armed after a match, so a bubble that never matches (e.g. truncated) cannot raise it.

const provisionalId = (id) => !id || String(id).startsWith('local-'); // a new chat before (or while getting) its id

// Feeds what a read of the page saw: its conversation id (undefined = not read) and, from a snapshot, the
// fingerprint of its latest user message.
function notePage(site, conversationId, s = null) {
  const st = siteState[site];
  const p = st.pendingSend;
  if (!p) return;
  if (s?.last_user_hash && s.last_user_hash === p.baseline.sent_hash) p.hashSeen = true;
  if (conversationId === undefined) return;
  if (provisionalId(p.conversationId)) {
    if (!provisionalId(conversationId)) p.conversationId = conversationId; // the new chat got its id
    return;
  }
  if (conversationId !== p.conversationId && !String(conversationId ?? '').startsWith('local-')) markStale(site, p.conversationId, conversationId);
}

function markStale(site, expected, seen) {
  siteState[site].stale ??= { expected, seen: seen ?? null, at: Date.now() };
}

// Why the page may not show what it claims, or null. `s` (a snapshot) enables the fingerprint check.
function staleReason(site, s = null) {
  const st = siteState[site];
  if (st.stale) {
    const { expected, seen, at } = st.stale;
    return `the MCP tab was seen on ${seen ? `conversation ${seen}` : 'a new chat'} instead of ${expected} at ${new Date(at).toISOString()} (switched by hand?); after such an in-app switch the page can show one conversation's URL with another conversation's messages`;
  }
  const p = st.pendingSend;
  if (p?.hashSeen && s?.last_user_hash && s.last_user_hash !== p.baseline.sent_hash) {
    return `the latest user message on the page is no longer the message sent at ${new Date(p.sentAt).toISOString()} — someone sent another message in this tab, or the page shows another conversation`;
  }
  return null;
}

// list_files / download_file: the listing's conversation id feeds the stale check; the fingerprint check needs a
// snapshot, taken only once it is armed.
async function assertFreshListing(site, listing, nothing) {
  notePage(site, listing?.conversation_id);
  const s = siteState[site].pendingSend?.hashSeen ? await page(site, 'snapshot', {}, 10_000) : null;
  assertFresh(site, s, nothing);
}

function assertFresh(site, s, nothing) {
  const why = staleReason(site, s);
  if (!why) return;
  const st = siteState[site];
  throw new ToolError(
    'PAGE_STALE',
    `${why}. ${nothing}. Call open_conversation with the conversation you want (it reloads the page), then retry`,
    st.stale ? { expected_conversation_id: st.stale.expected, seen_conversation_id: st.stale.seen } : null,
  );
}
// Tools called without "site" act on the site of the most recent open_conversation.
let defaultSite = 'chatgpt';

const TRANSIENT = new Set(['EXTENSION_NOT_CONNECTED', 'EXTENSION_DISCONNECTED', 'EXTENSION_TIMEOUT', 'PAGE_UNAVAILABLE']);

// Whether the message of `pending` has shown up in snapshot `s`; a positive answer is latched.
// Counts and ids only work while the whole thread is in the DOM — ChatGPT may keep just the latest
// turn, so the counts stay put. Hence also: the latest user message reads exactly as the sent text
// (unless the previous one already did), or a stop button appeared after the click (fill_composer
// refuses while one is shown). Snapshots from an older content.js lack the hashes; those tests skip.
function sendObserved(pending, s) {
  if (pending.observed) return true;
  if (!s) return false;
  const b = pending.baseline;
  pending.observed =
    !!s.generating ||
    s.user_count > b.user_count ||
    (!!s.last_user_id && s.last_user_id !== b.last_user_id) ||
    (!!b.sent_hash && b.last_user_hash !== b.sent_hash && s.last_user_hash === b.sent_hash);
  return pending.observed;
}

function finishJob(job, error) {
  if (job.status !== 'running') return;
  job.status = error ? 'error' : 'done';
  job.error = error || null;
  job.finishedAt = Date.now();
  job.resolveDone();
  persistJob(job);
}

// Mirrors each job into JOBS_DIR/<id>.json so wait-job.mjs, started by the client as a background
// task, can block until the reply is done and wake the client — instead of a get_job call every 45 s.
// Metadata only: the reply text stays in memory or in save_to. Writes are chained per job so a late
// heartbeat can never overwrite the final state, and each lands atomically via rename.
function persistJob(job) {
  const base = { job_id: job.id, site: job.site, status: job.status, updated_at: Date.now() };
  let data;
  if (job.status === 'running') data = { ...base, chars: job.chars };
  else if (job.status === 'error') data = { ...base, error: { code: job.error.code, message: job.error.message } };
  else data = { ...base, conversation_id: job.reply.conversation_id, chars: job.reply.chars, sha256: job.reply.sha256, saved_to: job.savedTo, ...(job.warning && { warning: job.warning }) };
  job.persistedAt = Date.now();
  job.persisting = (job.persisting ?? Promise.resolve())
    .then(async () => {
      await fs.mkdir(JOBS_DIR, { recursive: true, mode: 0o700 });
      const tmp = path.join(JOBS_DIR, `.${job.id}.tmp`);
      await fs.writeFile(tmp, JSON.stringify(data), { mode: 0o600 });
      await fs.rename(tmp, path.join(JOBS_DIR, `${job.id}.json`));
    })
    .catch((e) => log(`could not write status file for ${job.id}: ${e.message}`));
}

const waitCommand = (job) => `${JSON.stringify(process.execPath)} ${JSON.stringify(path.join(HERE, 'wait-job.mjs'))} ${job.id}`;

function cancelActiveJob(site, code, message) {
  const st = siteState[site];
  if (st.activeJob?.status === 'running') finishJob(st.activeJob, new ToolError(code, message));
  st.activeJob = null;
}

function createJob({ site, saveTo, overwrite }) {
  const { pendingSend } = siteState[site];
  const job = {
    id: `job_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
    site,
    status: 'running',
    createdAt: Date.now(),
    pending: pendingSend,
    // SEND_NOT_OBSERVED was already reported for this send: read the page as it is (with a warning)
    // instead of failing again, so a reply that did arrive can still be fetched.
    readAsIs: !!pendingSend?.unobserved,
    lastActiveAt: pendingSend?.sentAt ?? Date.now(),
    saveTo,
    overwrite,
    conversationId: null,
    chars: 0,
    stable: null,
    reply: null,
    savedTo: null,
    warning: null,
    error: null,
  };
  job.done = new Promise((resolve) => {
    job.resolveDone = resolve;
  });
  jobs.set(job.id, job);
  persistJob(job);
  runJob(job);
  return job;
}

async function runJob(job) {
  while (job.status === 'running') {
    try {
      await pollJob(job);
    } catch (e) {
      if (!TRANSIENT.has(e.code)) finishJob(job, e instanceof ToolError ? e : new ToolError('INTERNAL_ERROR', String(e?.message || e)));
    }
    if (job.status !== 'running') break;
    if (Date.now() - job.createdAt > JOB_MAX_MS) {
      finishJob(job, new ToolError('JOB_TIMEOUT', `reply did not complete within ${JOB_MAX_MS / 3600_000}h`));
      break;
    }
    if (Date.now() - job.persistedAt >= JOB_FILE_REFRESH_MS) persistJob(job);
    await sleep(POLL_MS);
  }
}

async function pollJob(job) {
  const s = await page(job.site, 'snapshot', {}, 15_000);
  job.chars = s.chars;
  notePage(job.site, s.conversation_id, s);
  // A new chat starts on a temporary "local-…" id that is later replaced by the real one.
  const provisional = !job.conversationId || job.conversationId.startsWith('local-');
  if (!provisional && s.conversation_id && s.conversation_id !== job.conversationId) {
    markStale(job.site, job.conversationId, s.conversation_id);
    throw new ToolError(
      'CONVERSATION_CHANGED',
      `MCP tab moved from conversation ${job.conversationId} to ${s.conversation_id}; reads on this tab are refused (PAGE_STALE) until open_conversation reloads it`,
    );
  }
  if (provisional && s.conversation_id) job.conversationId = s.conversation_id;
  assertFresh(job.site, s, 'Nothing was read or saved');

  const pending = job.pending;
  const observed = !!pending && sendObserved(pending, s); // ahead of the generating check: a stop button latches it
  if (s.generating) {
    job.stable = null;
    job.lastActiveAt = Date.now();
    return;
  }
  if (pending && !observed) {
    if (!job.readAsIs) {
      job.stable = null;
      if (Date.now() - pending.sentAt > SEND_NOT_OBSERVED_MS) {
        pending.unobserved = true;
        const held =
          s.tab_hidden && s.composer_has_text
            ? ' The tab is hidden and the text is still in the composer: the site is holding the message (Gemini does this in any mode) and sends it whenever the tab is next shown — call show_tab to let it go out now, or clear the composer by hand to drop it.'
            : '';
        throw new ToolError(
          'SEND_NOT_OBSERVED',
          `the sent message never appeared in the conversation. Do NOT send again: check get_status (has_reply, last_send) — a further get_latest_reply returns the latest reply on the page as it is, with a warning that it may predate the message.${held}`,
          { tab_hidden: !!s.tab_hidden },
        );
      }
      return;
    }
    job.warning = `the message sent at ${new Date(pending.sentAt).toISOString()} was never observed in the conversation; this is the latest reply on the page, which may predate it`;
  } else {
    job.warning = null;
  }
  // Once the sent message is the latest user message, every assistant block after it is the new reply;
  // assistant counts are not compared (a latest-turn-only page keeps them unchanged).
  const fresh = observed ? pending.baseline : null;
  if (s.error_text) throw new ToolError('PAGE_ERROR', `ChatGPT shows an error: ${s.error_text}`);
  const newReply = s.last_role === 'assistant' && !(fresh && s.last_assistant_id && s.last_assistant_id === fresh.last_assistant_id);
  if (!newReply) {
    job.stable = null;
    if (!fresh && s.last_role === null) throw new ToolError('NO_REPLY', 'the conversation has no messages yet');
    if (Date.now() - job.lastActiveAt > SEND_NOT_OBSERVED_MS) {
      throw new ToolError('NO_REPLY', 'the latest message is from the user and no reply is being generated');
    }
    return;
  }

  const now = Date.now();
  if (!job.stable || job.stable.hash !== s.hash || job.stable.id !== s.last_assistant_id) {
    job.stable = { hash: s.hash, id: s.last_assistant_id, since: now };
    return;
  }
  if (now - job.stable.since < STABLE_MS) return;

  const r = await page(job.site, 'extract_reply', {}, 30_000);
  const markdown = r.markdown || '';
  job.reply = {
    markdown,
    chars: markdown.length,
    sha256: createHash('sha256').update(markdown, 'utf8').digest('hex'),
    conversation_id: r.conversation_id || job.conversationId,
  };
  if (job.saveTo) job.savedTo = await saveReply(job.saveTo, markdown, job.overwrite);
  finishJob(job);
}

async function saveReply(target, text, overwrite) {
  try {
    await fs.mkdir(path.dirname(target), { recursive: true });
    if (overwrite) {
      await fs.writeFile(target, text, 'utf8');
      return target;
    }
    const { dir, name, ext } = path.parse(target);
    for (let i = 0; i < 1000; i++) {
      const candidate = i === 0 ? target : path.join(dir, `${name}-${i}${ext}`);
      try {
        await fs.writeFile(candidate, text, { encoding: 'utf8', flag: 'wx' });
        return candidate;
      } catch (e) {
        if (e.code !== 'EEXIST') throw e;
      }
    }
    throw new Error('more than 1000 numbered copies already exist');
  } catch (e) {
    throw new ToolError('SAVE_FAILED', `could not write ${target}: ${e.message}`);
  }
}

async function waitForJob(job, seconds) {
  let timer;
  await Promise.race([job.done, new Promise((resolve) => (timer = setTimeout(resolve, seconds * 1000)))]);
  clearTimeout(timer);
}

function jobResult(job) {
  if (job.status === 'error') throw job.error;
  if (job.status === 'running') return { complete: false, state: 'still_running', job_id: job.id, chars: job.chars, wait_command: waitCommand(job) };
  const r = job.reply;
  const warning = job.warning ? { warning: job.warning } : {};
  if (job.savedTo) return { complete: true, saved_to: job.savedTo, chars: r.chars, sha256: r.sha256, ...warning };
  return withText({ complete: true, conversation_id: r.conversation_id, chars: r.chars, sha256: r.sha256, ...warning }, r.markdown);
}

// Expired jobs leave memory and their status files; files from earlier server runs age out too.
async function sweepJobFiles() {
  const cutoff = Date.now() - JOB_TTL_MS;
  for (const [id, job] of jobs) if (job.finishedAt && job.finishedAt < cutoff) jobs.delete(id);
  const names = await fs.readdir(JOBS_DIR).catch(() => []);
  for (const name of names) {
    const file = path.join(JOBS_DIR, name);
    const stat = await fs.stat(file).catch(() => null);
    if (stat && stat.mtimeMs < cutoff) await fs.rm(file, { force: true }).catch(() => {});
  }
}
sweepJobFiles();
setInterval(sweepJobFiles, 600_000).unref();

// ---------------------------------------------------------------- argument helpers

function requireString(args, key) {
  const v = args[key];
  if (typeof v !== 'string' || !v.trim()) throw new ToolError('INVALID_ARGUMENT', `"${key}" must be a non-empty string`);
  return v;
}

function optNumber(args, key, def, min, max) {
  const v = args[key];
  if (v === undefined || v === null) return def;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new ToolError('INVALID_ARGUMENT', `"${key}" must be a number`);
  return Math.min(max, Math.max(min, n));
}

function optBool(args, key, def) {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw new ToolError('INVALID_ARGUMENT', `"${key}" must be a boolean`);
  return v;
}

async function optSavePath(args) {
  const v = args.save_to;
  if (v === undefined || v === null || v === '') return null;
  if (typeof v !== 'string' || !path.isAbsolute(v)) throw new ToolError('INVALID_ARGUMENT', '"save_to" must be an absolute file path');
  const target = path.normalize(v);
  const stat = await fs.stat(target).catch(() => null);
  if (stat?.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `"save_to" is a directory: ${target}`);
  return target;
}

const CONVERSATION_ID = /^[A-Za-z0-9:-]{8,}$/; // ":" for temporary "local-chatgpt:<uuid>" ids
const PROJECT_ID = /^g-p-[0-9a-f]{32}(-[\w-]+)?$/i; // optionally followed by the name slug

function resolveSite(args) {
  if (args.site === undefined || args.site === null) return defaultSite;
  if (!Object.hasOwn(SITES, args.site)) throw new ToolError('INVALID_ARGUMENT', `"site" must be one of: ${SITE_NAMES.join(', ')}`);
  return args.site;
}

// Returns { site, url }. A URL decides the site itself; bare ids use the given site.
function toTarget(input, site) {
  const s = input.trim();
  if (PROJECT_ID.test(s)) return { site: 'chatgpt', url: `https://chatgpt.com/g/${s}/project` };
  if (CONVERSATION_ID.test(s)) return { site, url: SITES[site].conversationUrl(s) };
  let url;
  try {
    url = new URL(s.startsWith('/') ? `${SITES[site].origin}${s}` : /^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    throw new ToolError('INVALID_ARGUMENT', `not a supported URL or conversation id: ${s}`);
  }
  const urlSite = SITE_NAMES.find((name) => SITES[name].hosts.includes(url.hostname));
  if (!urlSite || url.protocol !== 'https:' || url.port || url.username || url.password) {
    throw new ToolError('INVALID_ARGUMENT', `only ${SITE_NAMES.map((n) => `${SITES[n].origin}/…`).join(' and ')} URLs are allowed, got ${s}`);
  }
  url.hostname = new URL(SITES[urlSite].origin).hostname;
  return { site: urlSite, url: url.href };
}

// expect_conversation_id "new" (or a site's new-chat URL) asserts an empty new chat: no conversation id, no user
// message. Passed on to content.js fill_composer in the same field, where an older content.js fails closed.
const NEW_CHAT = 'new';
const NEW_CHAT_PATHS = { chatgpt: ['/'], gemini: ['/', '/app'] };

// The site whose new-chat page `s` is (https://chatgpt.com/, https://gemini.google.com/app, …), else null.
function newChatSiteOf(s) {
  let url;
  try {
    url = new URL(/^[a-z]+:\/\//i.test(s) ? s : `https://${s}`);
  } catch {
    return null;
  }
  const site = SITE_NAMES.find((name) => SITES[name].hosts.includes(url.hostname));
  if (!site || url.protocol !== 'https:') return null;
  return NEW_CHAT_PATHS[site].includes(url.pathname.replace(/\/+$/, '') || '/') ? site : null;
}

function toConversationId(input, site) {
  const s = input.trim();
  if (s.toLowerCase() === NEW_CHAT) return NEW_CHAT;
  const rootOf = newChatSiteOf(s);
  if (rootOf) {
    if (rootOf !== site) throw new ToolError('INVALID_ARGUMENT', `"expect_conversation_id" ${s} is the ${rootOf} new-chat page, but site is ${site}`);
    return NEW_CHAT;
  }
  const fromUrl = s.match(SITES[site].conversation)?.[1];
  if (fromUrl) return decodeURIComponent(fromUrl);
  if (CONVERSATION_ID.test(s)) return s;
  throw new ToolError('INVALID_ARGUMENT', `"expect_conversation_id" is not a ${site} conversation id or URL (or "new"): ${s}`);
}

// The tab must show `expected` (an id, or NEW_CHAT) in snapshot `s`; checked before the tab is brought forward or
// anything is typed. fill_composer checks again right before typing.
function checkConversation(s, expected, nothing = 'nothing was typed') {
  if (!expected) return;
  const current = s.conversation_id ?? null;
  const users = Number(s.user_count) || 0;
  if (expected === NEW_CHAT ? !current && users === 0 : current === expected) return;
  const shows = current ? `conversation ${current}` : users ? `a new chat that already has ${users} message(s)` : 'no conversation';
  throw new ToolError('CONVERSATION_MISMATCH', `MCP tab shows ${shows}, expected ${expected === NEW_CHAT ? 'an empty new chat' : expected}; ${nothing}`);
}

function optOnHidden(args, site) {
  const v = args.on_hidden;
  if (v === undefined || v === null) return DEFAULT_ON_HIDDEN[site];
  if (!ON_HIDDEN.includes(v)) throw new ToolError('INVALID_ARGUMENT', `"on_hidden" must be one of: ${ON_HIDDEN.join(', ')}`);
  return v;
}

// ---------------------------------------------------------------- hidden tabs (show_tab / on_hidden)

async function showTab(site) {
  try {
    return await bridgeRequest('show_tab', { site, timeout_ms: SHOW_TAB_MS }, SHOW_TAB_MS + 15_000);
  } catch (e) {
    if (e?.code === 'UNKNOWN_METHOD') {
      throw new ToolError('EXTENSION_OUTDATED', `the extension predates show_tab and cannot bring the ${site} MCP tab forward — reload it in chrome://extensions (or show the tab yourself), then retry`);
    }
    throw e;
  }
}

// Runs before upload_files / send_message touch the page; `s` is a fresh snapshot. "proceed" goes ahead regardless;
// "fail" refuses while the tab is hidden; "show" brings it forward and refuses if it stays hidden. Returns the
// show_tab result when the tab had to be brought forward, else null.
async function ensureVisible(site, onHidden, s, done) {
  if (onHidden === 'proceed' || !s?.tab_hidden) return null;
  const why = site === 'gemini' ? 'Gemini holds a clicked Send until the tab is shown and renders no attachment previews while it is hidden' : 'the page may not work while it is hidden';
  if (onHidden === 'fail') {
    throw new ToolError('TAB_HIDDEN', `the ${site} MCP tab is hidden (background tab, minimized or covered window) and ${why} — call show_tab or show it yourself, then retry; nothing was ${done}`, { tab_hidden: true });
  }
  let r;
  try {
    r = await showTab(site);
  } catch (e) {
    if (e.code !== 'EXTENSION_OUTDATED') throw e;
    throw new ToolError('TAB_HIDDEN', `the ${site} MCP tab is hidden and ${e.message}; nothing was ${done}`, { tab_hidden: true });
  }
  if (r.tab_hidden) {
    throw new ToolError(
      'TAB_HIDDEN',
      `the ${site} MCP tab is still hidden after bringing it forward: ${r.reason || 'Chrome still reports it hidden'}. ${why}, so nothing was ${done}. Show the tab yourself (best: drag it into a window of its own and keep that window uncovered), then retry`,
      { tab_hidden: true, activated: !!r.activated, focused: !!r.focused, window_state: r.window_state ?? null },
    );
  }
  return r;
}

const MIME = {
  '.pdf': 'application/pdf', '.txt': 'text/plain', '.md': 'text/markdown', '.csv': 'text/csv', '.tsv': 'text/tab-separated-values',
  '.json': 'application/json', '.xml': 'application/xml', '.yaml': 'application/yaml', '.yml': 'application/yaml',
  '.html': 'text/html', '.htm': 'text/html', '.css': 'text/css', '.js': 'text/javascript', '.mjs': 'text/javascript',
  '.cjs': 'text/javascript', '.ts': 'text/plain', '.tsx': 'text/plain', '.jsx': 'text/plain', '.py': 'text/x-python',
  '.java': 'text/x-java', '.c': 'text/x-c', '.h': 'text/x-c', '.cpp': 'text/x-c++', '.hpp': 'text/x-c++', '.cs': 'text/plain',
  '.go': 'text/plain', '.rs': 'text/plain', '.rb': 'text/plain', '.php': 'text/plain', '.swift': 'text/plain', '.kt': 'text/plain',
  '.sh': 'text/x-sh', '.sql': 'text/plain', '.log': 'text/plain', '.tex': 'text/x-tex',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml',
  '.zip': 'application/zip', '.doc': 'application/msword', '.xls': 'application/vnd.ms-excel', '.ppt': 'application/vnd.ms-powerpoint',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

function withText(meta, text) {
  return { content: [{ type: 'text', text: JSON.stringify(meta) }, { type: 'text', text }] };
}

// ---------------------------------------------------------------- model picker

const MENU_POLL_MS = 250;

// Same as content.js MENU_CONTAINERS; used for the outline of an open menu.
const MENU_CONTAINERS = '[role="menu"], [role="listbox"], .cdk-overlay-pane, :popover-open';

// Exact, then prefix, then substring (case-insensitive) — on labels first, then on descriptions
// (Gemini shows "Deeper analysis" with the model name "4 Neon" underneath). Submenu triggers and
// sliders are never a match. More than one hit at the first tier that has any is refused rather than guessed.
const norm = (s) => String(s ?? '').toLowerCase().replace(/\s+/g, ' ').trim();

function matchOption(options, wanted) {
  const w = norm(wanted);
  const candidates = options.filter((o) => !o.submenu && o.kind !== 'slider');
  for (const field of ['label', 'description']) {
    for (const test of [(l) => l === w, (l) => l.startsWith(w), (l) => l.includes(w)]) {
      const hits = candidates.filter((o) => o[field] && test(norm(o[field])));
      if (hits.length === 1) return hits[0];
      if (hits.length > 1) {
        throw new ToolError('AMBIGUOUS_OPTION', `"${wanted}" matches ${hits.map((h) => `"${h.label}"`).join(', ')}; be more specific — nothing was clicked`);
      }
    }
  }
  return null;
}

// Polls until more than `seen` items are visible (menus animate in), or returns what is there after 3 s.
async function readMenu(site, seen) {
  let items = [];
  for (const end = Date.now() + 3_000; Date.now() < end; await sleep(MENU_POLL_MS)) {
    ({ items } = await page(site, 'model_menu_read'));
    if (items.length > seen) break;
  }
  return items;
}

// Steps a slider item (ChatGPT's "Power": "Pro, 5 of 5") one arrow key at a time, reading the level
// back after each step: an exact name stops the scan; otherwise every level is visited (up to the
// maximum, then down to the minimum) and matched like options. Without a match the start is restored.
async function moveSlider(site, slider, wanted) {
  const readSlider = async () => (await page(site, 'model_menu_read')).items.find((i) => i.kind === 'slider' && i.label === slider.label) ?? null;
  const at = (s) => s?.position ?? s?.value;
  const step = async (key) => {
    const cur = await readSlider();
    if (!cur) throw new ToolError('MENU_CHANGED', 'the slider disappeared while adjusting it');
    await page(site, 'model_menu_slider_key', { index: cur.index, label: cur.label, key });
    await sleep(300);
    return readSlider();
  };
  const goTo = async (cur, target) => {
    if (typeof target !== 'number') return cur; // no positions exposed: nothing to step back to
    for (let guard = 0; cur && at(cur) !== target && guard < 24; guard++) cur = await step(cur.position < target ? 'ArrowRight' : 'ArrowLeft');
    if (at(cur) !== target) throw new ToolError('SLIDER_STUCK', `could not move the ${slider.label} slider to position ${target}; it is at ${at(cur)}`);
    return cur;
  };

  let cur = slider;
  const start = at(cur);
  const levels = new Map([[at(cur), cur.value]]);
  if (norm(cur.value) === norm(wanted)) return cur;
  for (const key of ['ArrowRight', 'ArrowLeft']) {
    for (let guard = 0; guard < 24; guard++) {
      const next = await step(key);
      if (!next || at(next) === at(cur)) break; // reached the end
      cur = next;
      levels.set(at(cur), cur.value);
      if (norm(cur.value) === norm(wanted)) return cur;
    }
  }
  const options = [...levels].map(([position, label]) => ({ position, label }));
  try {
    const hit = matchOption(options, wanted);
    if (hit && typeof hit.position === 'number') return await goTo(cur, hit.position);
  } catch (e) {
    await goTo(cur, start);
    throw e;
  }
  await goTo(cur, start);
  return { notFound: options.map((o) => o.label) };
}

async function closeModelMenu(site) {
  for (const step of [null, 'escape', 'force']) {
    if (step) await page(site, 'model_menu_close', { force: step === 'force' });
    for (const end = Date.now() + 1_000; Date.now() < end; await sleep(MENU_POLL_MS)) {
      if (!(await page(site, 'model_menu_read')).items.length) return true;
    }
  }
  return false;
}

// Opens the model picker, clicks the option matching `wanted` (if any), and always closes the menu
// again. Returns the top-level options (plus a DOM outline of the open menu when asked), or null when
// only listing and the site shows no picker.
async function useModelMenu(site, wanted, outline = false) {
  try {
    await page(site, 'model_menu_open');
  } catch (e) {
    if (!wanted && e.code === 'MODEL_PICKER_NOT_FOUND') return null;
    throw e;
  }
  try {
    let items = await readMenu(site, 0);
    const tree = outline ? (await page(site, 'inspect', { selector: MENU_CONTAINERS, depth: 14, max_nodes: 400, visible_only: true }, 20_000)).tree : null;
    if (!items.length) {
      throw new ToolError(
        'MODEL_MENU_EMPTY',
        `the model picker showed no readable options — fix the menu selectors in content.js${tree ? `; open menus:\n${tree}` : ' (select_model with outline: true shows the open menu)'}`,
      );
    }
    const top = { items, tree };
    const opened = new Set();
    while (wanted) {
      const hit = matchOption(items, wanted);
      if (hit) {
        if (hit.disabled) throw new ToolError('MODEL_UNAVAILABLE', `"${hit.label}" is disabled here`);
        await page(site, 'model_menu_choose', { index: hit.index, label: hit.label });
        await sleep(500);
        break;
      }
      const sub = items.find((i) => i.submenu && !opened.has(i.label));
      if (sub) {
        opened.add(sub.label);
        await page(site, 'model_menu_choose', { index: sub.index, label: sub.label });
        items = await readMenu(site, items.length);
        continue;
      }
      // Sliders last: finding a level means stepping through them.
      const available = items.filter((i) => !i.submenu && i.kind !== 'slider').map((i) => i.label);
      for (const slider of items.filter((i) => i.kind === 'slider' && !i.disabled)) {
        const r = await moveSlider(site, slider, wanted);
        if (!r.notFound) return top;
        available.push(`${slider.label} slider: ${r.notFound.join(' / ')}`);
      }
      throw new ToolError('MODEL_NOT_FOUND', `no model matches "${wanted}"; available: ${available.join(', ')}`);
    }
    return top;
  } finally {
    if (!(await closeModelMenu(site).catch(() => false))) log(`[${site}] model menu may still be open`);
  }
}

// ---------------------------------------------------------------- modes (Chat / Task / Work)

// No conversation id and no user message yet: the only place the mode toggle is offered (on Gemini).
const isNewChat = (s) => !!s && !s.conversation_id && !(Number(s.user_count) > 0);

// model_state ({ model, mode, modes }), waiting up to `ms` for the mode toggle to render; null if unreadable.
async function readModes(site, ms) {
  for (const end = Date.now() + ms; ; await sleep(MENU_POLL_MS)) {
    const st = await page(site, 'model_state').catch(() => null);
    if (st?.modes?.length || Date.now() >= end) return st;
  }
}

// Presses the toggle button whose text matches `wanted` (unless already selected) and waits until the page shows it
// selected. Returns { mode, switched }.
async function chooseMode(site, wanted, st) {
  const hit = matchOption(st.modes.map((m, index) => ({ ...m, index })), wanted);
  if (!hit) throw new ToolError('MODE_NOT_FOUND', `no mode matches "${wanted}"; available: ${st.modes.map((m) => m.label).join(', ')}`);
  if (hit.selected) return { mode: hit.label, switched: false };
  await page(site, 'set_mode', { index: hit.index, label: hit.label });
  for (const end = Date.now() + MODE_WAIT_MS; Date.now() < end; ) {
    await sleep(MENU_POLL_MS);
    const now = await page(site, 'model_state').catch(() => null);
    if (now?.mode != null && norm(now.mode) === norm(hit.label)) {
      await sleep(500); // the model picker may re-render with the mode
      return { mode: now.mode, switched: true };
    }
  }
  throw new ToolError('MODE_NOT_SET', `pressed "${hit.label}" but the page does not show it selected`);
}

// Puts a new chat in the site's default mode (Gemini: Task) unless the caller chose a mode explicitly since the last
// open_conversation; existing conversations are never touched. strict (upload_files / send_message): MODE_NOT_SET,
// nothing `done`, when the default cannot be confirmed — a missing toggle included, so a message never silently
// goes out in another mode; otherwise (open_conversation / select_model) the problem comes back as a warning.
// Returns { mode, switched, warning? }, or null when no default applies.
async function ensureDefaultMode(site, s, { strict, done }) {
  const st = siteState[site];
  const want = DEFAULT_MODE[site];
  if (!want || st.modeOverride || !isNewChat(s)) return null;
  const ms = await readModes(site, MODE_WAIT_MS);
  const problem = (why) => {
    if (strict) {
      throw new ToolError(
        'MODE_NOT_SET',
        `new ${site} chats start in ${want} mode, but ${why}; nothing was ${done}. To go ahead in another mode, choose it explicitly first (select_model { mode: "Chat" }, or open_conversation { mode })`,
        { mode: ms?.mode ?? null },
      );
    }
    return { mode: ms?.mode ?? null, switched: false, warning: `default mode ${want} not set: ${why}` };
  };
  if (!ms?.modes?.length) return problem('no mode toggle was found on this new chat (if the page shows one, fix SELECTORS.modeToggle in extension/content.js)');
  let hit;
  try {
    hit = matchOption(ms.modes.map((m, index) => ({ ...m, index })), want);
  } catch (e) {
    return problem(e.message);
  }
  if (!hit) return problem(`the toggle offers no "${want}" (${ms.modes.map((m) => m.label).join(', ')})`);
  if (hit.selected) return { mode: hit.label, switched: false };
  // Whether the toggle keeps attachments is unknown — never risk dropping them silently.
  if (st.attached) return problem(`files are attached in ${ms.mode ?? 'another'} mode and switching now could drop them (attach after choosing the mode)`);
  try {
    return await chooseMode(site, want, ms);
  } catch (e) {
    if (!['MODE_NOT_SET', 'MENU_CHANGED', 'MODE_UNAVAILABLE'].includes(e.code)) throw e;
    return problem(e.message);
  }
}

// After open_conversation: an explicit `mode` (already recorded as the override) is pressed on a new chat; otherwise
// the default mode is applied. Never fails — the navigation already happened; send_message enforces the mode.
// Returns { mode, warning? } (mode: the page's mode now, null if unreadable — e.g. an existing Gemini conversation).
async function modeAfterOpen(site, conversationId, explicit) {
  const fresh = { conversation_id: conversationId, user_count: 0 };
  if (explicit) {
    if (!isNewChat(fresh)) {
      const st = await page(site, 'model_state').catch(() => null);
      return { mode: st?.mode ?? null, warning: `mode "${explicit}" not pressed: the mode can only be chosen on a new chat` };
    }
    const st = await readModes(site, MODE_WAIT_MS);
    if (!st?.modes?.length) return { mode: st?.mode ?? null, warning: `mode "${explicit}" not pressed: no mode toggle on this page; send_message will not switch the mode either` };
    try {
      const chosen = await chooseMode(site, explicit, st);
      siteState[site].modeOverride = chosen.mode;
      return { mode: chosen.mode };
    } catch (e) {
      if (!(e instanceof ToolError)) throw e;
      if (e.code !== 'MODE_NOT_FOUND' && e.code !== 'AMBIGUOUS_OPTION') return { mode: st.mode ?? null, warning: `mode "${explicit}" not pressed: ${e.message}` };
      // A mode that matches nothing is no choice: the default applies (and is enforced on send) as if none was given.
      siteState[site].modeOverride = null;
      const d = await ensureDefaultMode(site, fresh, { strict: false }).catch((e2) => ({ mode: null, warning: e2.message }));
      return { mode: d?.mode ?? st.mode ?? null, warning: `mode "${explicit}" not pressed: ${e.message}${DEFAULT_MODE[site] ? `; using the default ${DEFAULT_MODE[site]} instead` : ''}${d?.warning ? `; ${d.warning}` : ''}` };
    }
  }
  const d = await ensureDefaultMode(site, fresh, { strict: false }).catch((e) => ({ mode: null, warning: `default mode not set: ${e.message}` }));
  if (d) return d.warning ? { mode: d.mode, warning: d.warning } : { mode: d.mode };
  return { mode: (await page(site, 'model_state').catch(() => null))?.mode ?? null };
}

// ---------------------------------------------------------------- projects (ChatGPT)

// Project rows in the sidebar are not links, so a project is opened by name: load the home page,
// press the project's "New chat in <name>" button, and wait for the SPA to reach /g/g-p-<id>/project.
async function openProject(args) {
  const name = requireString(args, 'project');
  if (args.site != null && args.site !== 'chatgpt') throw new ToolError('INVALID_ARGUMENT', '"project" is a ChatGPT feature');
  const mode = args.mode == null ? null : requireString(args, 'mode');
  const site = 'chatgpt';
  ensureConnected();
  resetSite(site, mode);
  defaultSite = site;
  await bridgeRequest('open_conversation', { site, url: `${SITES.chatgpt.origin}/` }, 90_000);

  const { projects } = await page(site, 'list_projects');
  const hit = matchOption(projects.map((label) => ({ label })), name);
  if (!hit) {
    throw new ToolError('PROJECT_NOT_FOUND', `no project matches "${name}"; sidebar shows: ${projects.join(', ') || '(none)'} — or pass its URL / g-p-… id as url_or_id`);
  }
  await page(site, 'open_project', { name: hit.label });
  let r = null;
  for (const end = Date.now() + 20_000; Date.now() < end; await sleep(500)) {
    r = await page(site, 'ready').catch(() => null);
    if (r?.composer && /\/g\/g-p-[0-9a-f]{32}/.test(r.href)) {
      const out = { site, url: r.href, conversation_id: r.conversation_id, project: hit.label, project_id: r.href.match(/g-p-[0-9a-f]{32}(-[\w-]+)?/)[0] };
      return { ...out, ...(await modeAfterOpen(site, out.conversation_id, mode)) };
    }
  }
  throw new ToolError('PROJECT_OPEN_FAILED', `pressed "New chat in ${hit.label}" but the project page did not load (tab shows ${r?.href ?? 'nothing'})`);
}

// ---------------------------------------------------------------- uploads

const verifyUpload = (site, uploadId) => page(site, 'upload_verify', { upload_id: uploadId }, 10_000);

// "picker": install the main-world file-chooser hook, press the site's upload button and walk its menu to
// the upload item; applied once the page asked for a file chooser and got the files.
async function attachViaPicker(site, uploadId) {
  const hook = await bridgeRequest('hook_file_chooser', { site }, 10_000).catch((e) => ({ error: e }));
  if (!hook?.installed) return { applied: false, reason: `file-chooser hook unavailable (${hook?.error?.message || 'not installed'}) — reload the extension` };
  let r = await page(site, 'upload_commit', { upload_id: uploadId, method: 'picker' });
  for (const end = Date.now() + 5_000; r.pending === 'menu' && Date.now() < end; ) {
    await sleep(250);
    r = await page(site, 'upload_menu_step', { upload_id: uploadId });
  }
  // The site may open the chooser a moment after the click.
  for (const end = Date.now() + 5_000; r.pending === 'chooser' && Date.now() < end; ) {
    await sleep(UPLOAD_POLL_MS);
    if ((await verifyUpload(site, uploadId)).intercepted) r = { ...r, applied: true, handoff: true, pending: null };
  }
  if (r.applied) return r;
  const d = await page(site, 'upload_picker_cancel', { upload_id: uploadId }).catch(() => null);
  const reason = r.reason || (r.pending === 'menu' ? 'the upload menu showed no items' : 'the page never asked for a file chooser');
  // What the page did instead, for fixing the picker (see installFileChooserHook in background.js).
  const seen =
    r.pending === 'chooser' && d
      ? `; pressed ${d.item ?? '?'}; page clicks seen: ${d.page_calls ?? 'none'}; file inputs now: ${d.file_inputs}; menu still open: ${d.menu_open ? 'yes' : 'no'}; tab hidden: ${d.tab_hidden ? 'yes' : 'no'}`
      : '';
  return { ...r, applied: false, reason: `${reason}${r.via ? ` (${r.via})` : ''}${seen}`, tab_hidden: d?.tab_hidden };
}

async function waitAttached(site, uploadId, ms) {
  const end = Date.now() + ms;
  let v = await verifyUpload(site, uploadId);
  while (!v.attached && Date.now() < end) {
    await sleep(UPLOAD_POLL_MS);
    v = await verifyUpload(site, uploadId);
  }
  return v;
}

function notShown(v) {
  return `no preview of ${v.missing.join(', ')} appeared in the composer${v.alert ? `; the page says: ${JSON.stringify(v.alert)}` : ''}`;
}

// Tries the page's attach methods in order until the composer shows every file, then waits for the
// upload indicators to settle and checks once more. Never reports success without seeing the previews.
const UPLOAD_METHODS = ['input', 'picker', 'paste', 'drop'];

// Leads an UPLOAD_NOT_ATTACHED message when the tab was hidden: Gemini renders no attachment previews in a hidden tab
// (2026-11-22: the upload that failed every method while hidden attached at once by paste with the tab visible).
const hiddenUploadHint = (site) =>
  `tab hidden: show the tab and retry (show_tab, or upload_files with on_hidden: "show") — ${site === 'gemini' ? 'Gemini shows no attachment previews in a hidden tab' : 'the page may not show attachment previews in a hidden tab'}. `;

async function attachUpload(site, uploadId, methods, files) {
  const attempts = [];
  let found = null;
  let hidden = false; // the page reported itself hidden during an attempt
  for (const method of methods) {
    const a = method === 'picker' ? await attachViaPicker(site, uploadId) : await page(site, 'upload_commit', { upload_id: uploadId, method }, 30_000);
    if (!a.applied) {
      if (a.tab_hidden) hidden = true;
      attempts.push(`${method}: ${a.reason || 'not applicable'}`);
      continue;
    }
    const v = await waitAttached(site, uploadId, a.handoff || a.patient ? UPLOAD_ATTACH_MS * 2.5 : UPLOAD_ATTACH_MS);
    if (v.attached) {
      found = { method, via: a.via, v };
      break;
    }
    if (v.tab_hidden) hidden = true;
    attempts.push(`${method} (${a.via}): ${notShown(v)}${v.tab_hidden ? ' [tab hidden]' : ''}`);
    // The site took the files through its own file input and still shows nothing: it rejected them, and
    // another method could only attach them twice once it catches up.
    if (a.handoff) break;
  }
  if (!found) {
    // A content.js from before upload_verify reported tab_hidden: ask the snapshot.
    hidden ||= await page(site, 'snapshot', {}, 10_000).then((s) => s?.tab_hidden === true, () => false);
    throw new ToolError(
      'UPLOAD_NOT_ATTACHED',
      `${hidden ? hiddenUploadHint(site) : ''}${files.map((f) => f.name).join(', ')} not attached — nothing would go out with the next message. Tried ${attempts.join('; ') || 'nothing (no attach method for this site)'}`,
      { tab_hidden: hidden, attempts },
    );
  }

  // The progress indicator appears a moment after the previews; require two quiet polls.
  const start = Date.now();
  let quiet = 0;
  let v = found.v;
  await sleep(1_500);
  while (Date.now() - start < UPLOAD_WAIT_MS) {
    v = await verifyUpload(site, uploadId);
    quiet = v.uploading ? 0 : quiet + 1;
    if (quiet >= 2 || !v.attached) break;
    await sleep(1_000);
  }
  if (!v.attached) {
    throw new ToolError(
      'UPLOAD_NOT_ATTACHED',
      `${v.tab_hidden ? hiddenUploadHint(site) : ''}the previews appeared (${found.method}) but went away again — the site probably rejected the file(s): ${notShown(v)}`,
      { tab_hidden: !!v.tab_hidden },
    );
  }
  const out = { uploading: !!v.uploading, attached: true, method: found.method, via: found.via };
  if (attempts.length) out.attempts = attempts;
  if (v.chips_added > files.length) out.warning = `the composer shows ${v.chips_added} new attachments for ${files.length} file(s) — remove the duplicates by hand before sending`;
  else if (v.alert) out.warning = `the page shows: ${JSON.stringify(v.alert)}`;
  return out;
}

// ---------------------------------------------------------------- reply files (list_files / download_file)

// A page script or extension from before list_files / download_file answers with an unknown command or method.
function rethrowOutdated(e) {
  if (e?.code === 'UNKNOWN_COMMAND' || e?.code === 'UNKNOWN_METHOD') {
    throw new ToolError('EXTENSION_OUTDATED', 'the extension predates list_files / download_file — reload it in chrome://extensions (it now asks for the "downloads" permission), then retry; nothing was clicked');
  }
  throw e;
}

function optMessage(args) {
  const v = args.message;
  if (v === undefined || v === null || v === 'latest') return 0;
  if (Number.isInteger(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v.trim())) return Number(v.trim());
  throw new ToolError('INVALID_ARGUMENT', '"message" must be "latest" or how many replies back (0 = latest, 1 = the one before, …)');
}

function optIndex(args) {
  const v = args.index;
  if (v === undefined || v === null) return null;
  if (!Number.isInteger(v) || v < 0) throw new ToolError('INVALID_ARGUMENT', '"index" must be a file index from list_files');
  return v;
}

const fileKey = (s) => String(s ?? '').normalize('NFC').trim();

// The chip at `index` (which must carry `name` when both are given), else exactly one chip named `name`.
function pickFile(files, name, index) {
  const listing = () => files.map((f) => `${f.index}: ${f.name} (${f.kind})`).join(', ') || 'no files';
  if (index != null) {
    const f = files.find((x) => x.index === index);
    if (!f) throw new ToolError('FILE_NOT_IN_REPLY', `the reply has no file ${index}; it has ${listing()}`);
    if (name != null && fileKey(f.name) !== fileKey(name)) throw new ToolError('FILE_NOT_IN_REPLY', `file ${index} of the reply is not "${name}"; the reply has ${listing()}`);
    return f;
  }
  const hits = files.filter((f) => fileKey(f.name) === fileKey(name));
  if (!hits.length) throw new ToolError('FILE_NOT_IN_REPLY', `the reply has no file named exactly "${name}"; it has ${listing()}`);
  if (hits.length > 1) {
    throw new ToolError('AMBIGUOUS_FILE', `"${name}" appears ${hits.length} times in the reply (${hits.map((h) => `index ${h.index}: ${h.kind}`).join(', ')}) — pass "index" from list_files; nothing was clicked`);
  }
  return hits[0];
}

// A file name that stays inside the directory it is written to.
function safeName(name) {
  const s = fileKey(name).replace(/[/\\]/g, '_').replace(/[\u0000-\u001f\u007f]/g, '_');
  return !s || s === '.' || s === '..' ? 'download' : s;
}

// Where download_file writes: an existing directory, or a path ending in "/", gets the file's name inside it; any
// other path is the file itself. Missing directories are created. The directory may be reached through symlinks
// the caller named (macOS /tmp is one), but the file itself never is: an existing symlink there counts as an
// existing file and is replaced, not written through, and the name cannot leave the directory.
async function downloadTarget(saveTo, name, overwrite) {
  if (typeof saveTo !== 'string' || !path.isAbsolute(saveTo)) throw new ToolError('INVALID_ARGUMENT', '"save_to" must be an absolute directory or file path');
  const given = path.normalize(saveTo);
  const stat = await fs.stat(given).catch(() => null);
  const intoDir = !!stat?.isDirectory() || /[/\\]$/.test(saveTo);
  const dir = intoDir ? given : path.dirname(given);
  const file = intoDir ? safeName(name) : path.basename(given);
  let realDir;
  try {
    await fs.mkdir(dir, { recursive: true });
    realDir = await fs.realpath(dir);
  } catch (e) {
    throw new ToolError('SAVE_FAILED', `cannot use directory ${dir}: ${e.message}`);
  }
  const target = { dir: realDir, file, path: path.join(realDir, file), shown: path.join(dir, file), overwrite };
  await checkTarget(target);
  return target;
}

async function checkTarget(target) {
  const existing = await fs.lstat(target.path).catch(() => null);
  if (existing?.isDirectory()) throw new ToolError('INVALID_ARGUMENT', `${target.shown} is a directory`);
  if (existing && !target.overwrite) throw new ToolError('FILE_EXISTS', `${target.shown} already exists — pass overwrite: true to replace it; nothing was downloaded`);
}

// Writes into a fresh temporary file next to the target (created exclusively, never through a symlink) and returns
// { tmp, size, sha256 }; `fill(write)` streams the bytes. finishTarget then moves it into place.
async function stageTarget(target, fill) {
  const tmp = path.join(target.dir, `.${target.file}.${randomUUID().slice(0, 8)}.mcp-download`);
  const { O_WRONLY, O_CREAT, O_EXCL, O_NOFOLLOW = 0 } = fs.constants;
  let fh;
  try {
    fh = await fs.open(tmp, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW, 0o644);
  } catch (e) {
    throw new ToolError('SAVE_FAILED', `cannot write in ${path.dirname(target.shown)}: ${e.message}`);
  }
  const hash = createHash('sha256');
  let size = 0;
  try {
    await fill(async (buf) => {
      hash.update(buf);
      for (let off = 0; off < buf.length; ) off += (await fh.write(buf, off, buf.length - off)).bytesWritten;
      size += buf.length;
    });
    await fh.close();
  } catch (e) {
    await fh.close().catch(() => {});
    await fs.rm(tmp, { force: true });
    throw e;
  }
  return { tmp, size, sha256: hash.digest('hex') };
}

// rename replaces whatever is at the target (a symlink itself, never its destination); without overwrite a hard
// link refuses an existing target atomically.
async function finishTarget(target, tmp) {
  try {
    await checkTarget(target);
    if (target.overwrite) {
      await fs.rename(tmp, target.path);
      return;
    }
    try {
      await fs.link(tmp, target.path);
    } catch (e) {
      if (e.code === 'EEXIST') throw new ToolError('FILE_EXISTS', `${target.shown} appeared while downloading — nothing was written`);
      if (!['EPERM', 'ENOTSUP', 'EOPNOTSUPP', 'ENOSYS', 'EXDEV'].includes(e.code)) throw e;
      await fs.copyFile(tmp, target.path, fs.constants.COPYFILE_EXCL); // file systems without hard links
    }
  } catch (e) {
    throw e instanceof ToolError ? e : new ToolError('SAVE_FAILED', `could not write ${target.shown}: ${e.message}`);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => {});
  }
}

// Copies Chrome's finished download into the target, then has the extension delete that copy (and only that one)
// and erase it from the download list — before the move, so a target in Chrome's own download folder works too.
async function saveCaptured(site, request, target, meta) {
  const d = await bridgeRequest('download', { site, ...request }, request.timeout_ms + 20_000).catch(rethrowOutdated);
  let staged = null;
  let failure = null;
  try {
    if (typeof d?.filename !== 'string' || !path.isAbsolute(d.filename)) throw new ToolError('DOWNLOAD_FAILED', 'the extension reported no file path for the download');
    staged = await stageTarget(target, async (write) => {
      let fh;
      try {
        // Chrome's own file: a symlink there is refused rather than followed.
        fh = await fs.open(d.filename, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
      } catch (e) {
        const hint = e.code === 'EPERM' || e.code === 'EACCES' ? ' — on macOS, allow the app running Claude Code to access the Downloads folder (System Settings → Privacy & Security → Files and Folders)' : '';
        throw new ToolError('DOWNLOAD_UNREADABLE', `cannot read Chrome's download ${d.filename}: ${e.message}${hint}`);
      }
      try {
        const buf = Buffer.alloc(1024 * 1024);
        for (;;) {
          const { bytesRead } = await fh.read(buf, 0, buf.length, null);
          if (!bytesRead) break;
          await write(buf.subarray(0, bytesRead));
        }
      } finally {
        await fh.close();
      }
    });
  } catch (e) {
    failure = e;
  }
  const discard = await bridgeRequest('download_discard', { download_id: d.download_id }, 15_000).catch((e) => ({ error: e }));
  if (failure) throw failure;
  await finishTarget(target, staged.tmp);
  const out = { path: target.shown, size: staged.size, sha256: staged.sha256, name: meta.name, kind: meta.kind, via: meta.via, capture: d.capture, mime: d.mime ?? null };
  if (discard.error || discard.removed === false) out.warning = `Chrome's copy ${d.filename} could not be removed (${discard.error?.message || 'still there'}) — delete it by hand`;
  return out;
}

// A preview chip opens a panel: its download button is pressed and caught like a chip; without one (or when that
// starts no download) the text the panel shows is saved instead and flagged via "preview-text".
async function savePreview(site, chip, click, timing, target) {
  await page(site, 'file_click', click);
  try {
    let st = null;
    let openSince = null;
    for (const end = Date.now() + PREVIEW_OPEN_MS; Date.now() < end; await sleep(400)) {
      st = await page(site, 'file_preview_state', { name: chip.name });
      if (st.download) break;
      if (st.open && Date.now() - (openSince ??= Date.now()) > PREVIEW_SETTLE_MS) break;
    }
    if (!st?.open) {
      throw new ToolError(
        'PREVIEW_NOT_FOUND',
        `pressed "${chip.label || chip.name}" but no preview panel appeared — fix previewPanel / previewDownload in extension/content.js${st?.outline ? `; open panels now:\n${st.outline}` : ''}`,
      );
    }
    let why = 'the preview shows no download button';
    if (st.download) {
      try {
        return await saveCaptured(site, { cmd: 'file_preview_download', args: { name: chip.name }, name: chip.name, ...timing }, target, { name: chip.name, kind: chip.kind, via: 'preview-download' });
      } catch (e) {
        if (e.code !== 'DOWNLOAD_NOT_STARTED' && e.code !== 'PREVIEW_NO_DOWNLOAD') throw e;
        why = `its download button started nothing (${e.message})`;
      }
    }
    const t = await page(site, 'file_preview_text', { name: chip.name });
    if (!t?.text?.trim()) throw new ToolError('PREVIEW_UNREADABLE', `${why}, and the panel shows no text (${t?.source || 'nothing found'})`);
    const bytes = Buffer.from(t.text, 'utf8');
    const staged = await stageTarget(target, (write) => write(bytes));
    await finishTarget(target, staged.tmp);
    return {
      path: target.shown, size: staged.size, sha256: staged.sha256, name: chip.name, kind: chip.kind, via: 'preview-text', text_source: t.source,
      warning: `${why}; saved the text the preview shows (${t.source}), not the original bytes${t.note ? ` — ${t.note}` : ''}`,
    };
  } finally {
    await page(site, 'file_preview_close', { name: chip.name }).catch(() => {});
  }
}

let downloadChain = Promise.resolve();
// One download_file at a time: a capture takes the first matching browser download after its press.
function oneDownloadAtATime(fn) {
  const run = downloadChain.then(fn, fn);
  downloadChain = run.catch(() => {});
  return run;
}

// ---------------------------------------------------------------- tools

const SITE_PROPERTY = {
  type: 'string',
  enum: SITE_NAMES,
  description: 'which dedicated tab to use; defaults to the site of the most recent open_conversation (initially chatgpt)',
};

const MESSAGE_PROPERTY = {
  anyOf: [{ type: 'string', enum: ['latest'] }, { type: 'integer', minimum: 0 }],
  default: 'latest',
  description: 'which assistant reply: "latest" or how many replies back (0 = latest, 1 = the one before, …)',
};

const ON_HIDDEN_PROPERTY = {
  type: 'string',
  enum: ON_HIDDEN,
  description:
    'what to do if the MCP tab is hidden (background tab, minimized or covered window), checked before anything is touched: "show" brings it forward like show_tab and fails with TAB_HIDDEN if it stays hidden; "fail" fails with TAB_HIDDEN at once; "proceed" goes ahead anyway. Default: "show" on gemini (it holds a clicked Send and shows no attachment previews while hidden), "proceed" on chatgpt (works in the background).',
};

const TOOLS = [
  {
    name: 'open_conversation',
    description:
      "Open a ChatGPT or Gemini page in that site's dedicated MCP tab of the user's everyday Chrome (created in the background on first use; other tabs are never touched) and wait until it is ready. The URL decides the site: https://chatgpt.com/c/<id>, a ChatGPT project URL or bare project id (g-p-…; send_message then starts a new chat inside that project), https://chatgpt.com/ for a new chat; https://gemini.google.com/app/<id>, a Gem URL, or https://gemini.google.com/app for a new chat. A bare conversation id uses `site`. Instead of url_or_id, `project` opens a new chat in the ChatGPT project with that sidebar name (matched like select_model options). Later calls without `site` target this site. A new Gemini chat is put in Task mode (the default; `mode` picks another, e.g. \"Chat\", which then sticks for this chat). Navigating reloads the page and ends a PAGE_STALE state. Returns { site, url, conversation_id, mode, warning? } (+ project, project_id); mode = the page's mode now (null where none is shown, e.g. an existing Gemini conversation); warning = a mode could not be set.",
    inputSchema: {
      type: 'object',
      properties: {
        url_or_id: { type: 'string', description: 'chatgpt.com / gemini.google.com URL, conversation id, or ChatGPT project id g-p-…' },
        project: { type: 'string', description: 'ChatGPT project name as shown in the sidebar, e.g. "My Project" (instead of url_or_id)' },
        mode: { type: 'string', description: 'mode for the new chat, e.g. "Chat" or "Task" (Gemini) / "Work" (ChatGPT); overrides the default (Gemini: Task) for this chat' },
        site: SITE_PROPERTY,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_status',
    description:
      'Non-blocking snapshot of a site\'s MCP tab: { site, state: "idle" | "thinking" | "streaming" | "done" | "error", conversation_id, mode, chars, uploading, tab_hidden, has_reply, last_role, mcp_tab_open, page_stale, last_send?, warning? }. mode = the selected Chat / Task (Gemini) or Chat / Work (ChatGPT) mode, null where the page shows none (Gemini shows its toggle on new chats only). page_stale=true (with a warning saying why) means the page may show another conversation than its URL says — e.g. after the tab was switched by hand — and reads are refused with PAGE_STALE until open_conversation. tab_hidden=true means Chrome treats the tab as not visible (background tab, minimized or covered window). has_reply=true means an assistant reply follows the latest user message (get_latest_reply can read it). last_send = { sent_at, observed } for the last send_message on this site: observed=false means its text has not been seen on the page (null: page unreadable). Read-only.',
    inputSchema: { type: 'object', properties: { site: SITE_PROPERTY }, additionalProperties: false },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'show_tab',
    description:
      'Bring a site\'s MCP tab to the front so Chrome treats it as visible: make it the active tab of its window, restore the window if minimized and focus it, then wait (≤ 3 s) until the page reports itself visible. Does nothing if the tab is already visible. Gemini holds a clicked Send (Chat and Task mode alike — possibly for hours) and shows no attachment previews while its tab is hidden; upload_files / send_message do this themselves on Gemini (on_hidden: "show"). It switches that Chrome window to the MCP tab and may put Chrome in front of other apps — keeping the MCP tab in a window of its own avoids taking over the tab the user is reading. Also lets a held message go out. Types and sends nothing. Returns { site, tab_hidden, was_hidden, activated, focused, window_state, reason? }: activated = it is the active tab of its window, focused = its window is focused, reason = why the page still reports itself hidden (window minimized, another app in front, window covered, screen locked …).',
    inputSchema: { type: 'object', properties: { site: SITE_PROPERTY }, additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
  },
  {
    name: 'upload_files',
    description:
      'Attach local files to the composer in the MCP tab, check that the composer shows a preview of every file, and wait (up to 4 min) until the upload indicators disappear. Does NOT send a message. First handles a hidden tab per on_hidden (Gemini default: bring it forward; TAB_HIDDEN with nothing attached if it stays hidden). Tries the site\'s ways of attaching in order (ChatGPT: its file input; Gemini: a paste on the prompt, then the "Upload & tools" menu; `method` forces one, also "drop") and fails with UPLOAD_NOT_ATTACHED, listing what was tried, when no preview appears — then nothing would go out with the next message; the error also carries tab_hidden and attempts, and starts with "tab hidden: show the tab and retry" when the tab was hidden. On a new Gemini chat it first selects the default mode (Task, unless a mode was chosen explicitly) — MODE_NOT_SET, nothing attached, if it cannot; the mode is never switched once files are attached. PAGE_STALE: see get_status. Returns { uploaded: [{ name, size }], uploading, attached: true, method, via, attempts?, warning?, tab_shown?, mode? } (method: "input" | "picker" | "paste" | "drop"; tab_shown: the tab was brought forward first; mode: the new chat\'s mode).',
    inputSchema: {
      type: 'object',
      properties: {
        paths: { type: 'array', items: { type: 'string' }, minItems: 1, maxItems: MAX_UPLOAD_FILES, description: 'absolute local file paths' },
        method: { type: 'string', enum: UPLOAD_METHODS, description: 'try only this attach method instead of the site\'s usual order (for diagnosing a broken upload)' },
        on_hidden: ON_HIDDEN_PROPERTY,
        site: SITE_PROPERTY,
      },
      required: ['paths'],
      additionalProperties: false,
    },
  },
  {
    name: 'send_message',
    description:
      'Type the text verbatim into the composer of the MCP tab and click Send exactly once. Fails with CONVERSATION_MISMATCH (nothing typed) when expect_conversation_id does not match the tab — "new" (or https://chatgpt.com/ / https://gemini.google.com/app) asserts an empty new chat —, STILL_GENERATING while a reply is in progress, TAB_HIDDEN (nothing typed) when the tab is hidden and on_hidden says so (Gemini default: bring it forward first, fail only if it stays hidden), MODE_NOT_SET (nothing typed) when a new Gemini chat cannot be put in its default Task mode (choose a mode explicitly with select_model to go ahead without it; an explicit choice is never switched back), PAGE_STALE (nothing typed) while the page may show another conversation than its URL (see get_status). Never retried automatically — after any failure check get_status instead of re-sending. confirmed=false comes with a warning: the click was delivered and may still go out (Gemini holds a clicked Send while the tab is hidden, in Chat and Task mode alike), so never send again; a further send_message is refused with SEND_PENDING while that text is still in the composer. Returns { sent, confirmed, conversation_id, tab_shown?, mode?, warning? } (mode: the mode a new chat went out in).',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'message to send, verbatim' },
        expect_conversation_id: {
          type: 'string',
          description: 'conversation id or URL the tab must currently show; "new" or the site\'s new-chat URL (https://chatgpt.com/, https://gemini.google.com/app) = the tab must be on an empty new chat (no conversation id, no messages)',
        },
        on_hidden: ON_HIDDEN_PROPERTY,
        site: SITE_PROPERTY,
      },
      required: ['text'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_latest_reply',
    description:
      'Wait (≤ min(wait_seconds, 45) s, polling every 2 s) for the latest assistant reply in the MCP tab to finish: no stop button and text unchanged for 2 s. If still running, returns { complete: false, state: "still_running", job_id, chars, wait_command } and keeps polling in the background. Long replies (e.g. ChatGPT Pro, Gemini Task): run wait_command as a background shell task (Claude Code: Bash with run_in_background) — it blocks at no cost and exits when the reply is done, failed or orphaned, which wakes you; then call get_job once. Otherwise continue with get_job. When complete: with save_to (absolute path; never overwrites unless overwrite=true, adds -1, -2 … instead) returns only { complete: true, saved_to, chars, sha256 }; without it returns { complete: true, conversation_id, chars, sha256 } followed by the Markdown as a second text block. After a SEND_NOT_OBSERVED error, the next call reads the latest reply on the page as it is and adds a warning that it may predate the sent message. PAGE_STALE (nothing read or saved): the tab was seen on another conversation since the last send (e.g. switched by hand), or its latest user message is no longer the one sent — the page may show another conversation than its URL; call open_conversation, then retry. expect_conversation_id → CONVERSATION_MISMATCH (nothing read) if the tab shows another conversation.',
    inputSchema: {
      type: 'object',
      properties: {
        wait_seconds: { type: 'number', default: DEFAULT_WAIT_S, description: 'max seconds to block, capped at 45' },
        expect_conversation_id: { type: 'string', description: 'conversation id or URL the tab must currently show' },
        save_to: { type: 'string', description: 'absolute path to write the Markdown reply to (recommended for long replies)' },
        overwrite: { type: 'boolean', default: false },
        site: SITE_PROPERTY,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_job',
    description:
      'Keep waiting (≤ min(wait_seconds, 45) s) for a job_id returned by get_latest_reply (the job remembers its site). Same result format as get_latest_reply.',
    inputSchema: {
      type: 'object',
      properties: {
        job_id: { type: 'string' },
        wait_seconds: { type: 'number', default: DEFAULT_WAIT_S, description: 'max seconds to block, capped at 45' },
      },
      required: ['job_id'],
      additionalProperties: false,
    },
  },
  {
    name: 'select_model',
    description:
      'Switch the model and/or mode of a site\'s MCP tab, or just list them. mode presses the button of the composer\'s mode toggle whose text matches (ChatGPT: "Chat" / "Work"; Gemini: "Chat" / "Task", shown on new chats only). model opens the model picker and clicks the option whose label matches, descending into submenus when needed. Matching is case-insensitive: exact, then prefix, then substring; an ambiguous match is refused and nothing is clicked. Without model it only lists the picker\'s options. New Gemini chats get Task mode by default (also applied here when model is given without mode); an explicit mode wins over that default until the next open_conversation and is never switched back. Use it before send_message; refused while a reply is generating. Returns { site, model, mode, modes, models: [{ label, description, selected, disabled, submenu }], warning? }.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'text of the model option, e.g. "Pro", "Thinking"' },
        mode: { type: 'string', description: 'text of the mode button, e.g. "Task", "Work", "Chat"' },
        outline: { type: 'boolean', default: false, description: 'also return a DOM outline of the open model menu (for fixing selectors)' },
        site: SITE_PROPERTY,
      },
      additionalProperties: false,
    },
  },
  {
    name: 'list_files',
    description:
      'List the files offered for download in an assistant reply of the MCP tab (ChatGPT shows them as inline chips, e.g. generated .patch / .md files). Returns { site, supported, conversation_id, message, replies, current, generating, files: [{ index, name, kind, label }] }: kind "download" is a direct download chip, "preview" opens a preview panel; index tells files of the same name apart. message: "latest" (default) or how many replies back (0 = latest; long ChatGPT threads keep only the latest turn in the page). current=false means the latest message is the user\'s, so this reply precedes it. Gemini: supported=false and no files. PAGE_STALE: see get_status. Clicks nothing; read-only.',
    inputSchema: {
      type: 'object',
      properties: {
        message: MESSAGE_PROPERTY,
        site: SITE_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
  {
    name: 'download_file',
    description:
      'Save a file from an assistant reply (see list_files) to a local path. Presses its chip in the MCP tab, catches the browser download it starts (or, if the page is held back, fetches the URL the page tried to open), copies the file to save_to and deletes Chrome\'s own copy (only that download) from the Downloads folder and the download list. A preview chip opens its panel and uses the panel\'s download button; without one, the text the panel shows is saved with via: "preview-text" and a warning (not byte-exact). Sends no message. Pick the file by name or index (from list_files), or both, which must then agree: name must equal the file name exactly; a name shown more than once → AMBIGUOUS_FILE (pass index); neither → INVALID_ARGUMENT. save_to: absolute directory (the file keeps its name) or file path; an existing file → FILE_EXISTS unless overwrite=true; symlinks at the target are replaced, never written through. Returns { path, size, sha256, name, kind, via: "download" | "preview-download" | "preview-text", capture?, mime?, warning? }. Errors: FILE_NOT_IN_REPLY, AMBIGUOUS_FILE, FILE_EXISTS, DOWNLOAD_NOT_STARTED, DOWNLOAD_PROMPTED (Chrome asks where to save), DOWNLOAD_TIMEOUT, DOWNLOAD_FAILED, NOT_SUPPORTED (Gemini), PAGE_STALE (see get_status; nothing pressed).',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'file name exactly as list_files shows it (or pass index instead)' },
        save_to: { type: 'string', description: 'absolute directory (or path ending in "/") to save into, or absolute file path' },
        message: MESSAGE_PROPERTY,
        index: { type: 'integer', minimum: 0, description: 'index from list_files: picks the file on its own, or one of several files with the same name together with name' },
        overwrite: { type: 'boolean', default: false },
        timeout_seconds: { type: 'number', default: DOWNLOAD_TIMEOUT_S, description: 'how long the download may take (2–600 s)' },
        site: SITE_PROPERTY,
      },
      required: ['save_to'],
      additionalProperties: false,
    },
  },
  {
    name: 'inspect_page',
    description:
      'Read-only DOM outline of a site\'s MCP tab for repairing selectors after the site changes: tag#id.classes [data-testid] [role] [aria-label] … "short text". Never reads cookies, storage or input values. Fix selectors in SELECTORS at the top of extension/content.js.',
    inputSchema: {
      type: 'object',
      properties: {
        selector: { type: 'string', default: 'body', description: 'CSS selector of the root element(s)' },
        depth: { type: 'number', default: 6 },
        max_nodes: { type: 'number', default: 400 },
        visible_only: { type: 'boolean', default: true },
        site: SITE_PROPERTY,
      },
      additionalProperties: false,
    },
    annotations: { readOnlyHint: true },
  },
];

const handlers = {
  async open_conversation(args) {
    if ((args.url_or_id == null) === (args.project == null)) throw new ToolError('INVALID_ARGUMENT', 'pass exactly one of "url_or_id" and "project"');
    if (args.project != null) return openProject(args);
    const requested = resolveSite(args);
    const { site, url } = toTarget(requireString(args, 'url_or_id'), requested);
    if (args.site != null && args.site !== site) {
      throw new ToolError('INVALID_ARGUMENT', `"site" is ${args.site} but the URL belongs to ${site}`);
    }
    const mode = args.mode == null ? null : requireString(args, 'mode');
    ensureConnected();
    // An explicit mode wins over the default for this chat, also if pressing it fails below.
    resetSite(site, mode);
    defaultSite = site;
    const r = await bridgeRequest('open_conversation', { site, url }, 90_000);
    return { site, url: r.url, conversation_id: r.conversation_id, ...(await modeAfterOpen(site, r.conversation_id, mode)) };
  },

  async get_status(args) {
    const site = resolveSite(args);
    const out = { site, ...(await bridgeRequest('status', { site }, 10_000)) };
    const readable = out.mcp_tab_open && !out.page_loading;
    // content.js from before "mode" in status: ask the mode toggle.
    if (out.mode === undefined) out.mode = readable ? ((await page(site, 'model_state', {}, 10_000).catch(() => null))?.mode ?? null) : null;
    const pending = siteState[site].pendingSend;
    const s = pending && readable ? await page(site, 'snapshot', {}, 10_000).catch(() => null) : null;
    if (readable) notePage(site, out.conversation_id, s);
    if (pending) {
      // Whether the last send_message's text has been seen on the page (null: the page is unreadable).
      out.last_send = { sent_at: new Date(pending.sentAt).toISOString(), observed: pending.observed || (s ? sendObserved(pending, s) : null) };
    }
    const stale = staleReason(site, s);
    out.page_stale = !!stale;
    if (stale) out.warning = `${stale} — get_latest_reply / list_files / download_file / send_message / upload_files refuse with PAGE_STALE until open_conversation reloads the page`;
    return out;
  },

  async upload_files(args) {
    const site = resolveSite(args);
    const paths = args.paths;
    if (args.method != null && !UPLOAD_METHODS.includes(args.method)) {
      throw new ToolError('INVALID_ARGUMENT', `"method" must be one of: ${UPLOAD_METHODS.join(', ')}`);
    }
    if (!Array.isArray(paths) || paths.length === 0 || paths.length > MAX_UPLOAD_FILES) {
      throw new ToolError('INVALID_ARGUMENT', `"paths" must be an array of 1–${MAX_UPLOAD_FILES} absolute file paths`);
    }
    const onHidden = optOnHidden(args, site);
    const files = [];
    for (const p of paths) {
      if (typeof p !== 'string' || !path.isAbsolute(p)) throw new ToolError('INVALID_ARGUMENT', `not an absolute path: ${p}`);
      const stat = await fs.stat(p).catch(() => null);
      if (!stat?.isFile()) throw new ToolError('FILE_NOT_FOUND', `not a readable file: ${p}`);
      if (stat.size > MAX_UPLOAD_FILE_BYTES) throw new ToolError('FILE_TOO_LARGE', `${p} is larger than ${MAX_UPLOAD_FILE_BYTES / 1024 / 1024} MiB`);
      files.push({ path: p, name: path.basename(p), mime: MIME[path.extname(p).toLowerCase()] || 'application/octet-stream', size: stat.size });
    }
    ensureConnected();
    // Before anything is handed to the page: a stale page, a hidden tab, then the new chat's default mode.
    const s = onHidden !== 'proceed' || (DEFAULT_MODE[site] && !siteState[site].modeOverride) ? await page(site, 'snapshot', {}, 10_000) : null;
    if (s) notePage(site, s.conversation_id, s);
    assertFresh(site, null, 'Nothing was attached');
    const shown = await ensureVisible(site, onHidden, s, 'attached');
    const mode = await ensureDefaultMode(site, s, { strict: true, done: 'attached' });

    const uploadId = randomUUID();
    const begun = await page(site, 'upload_begin', { upload_id: uploadId, files: files.map(({ name, mime, size }) => ({ name, mime, size })) });
    let result;
    try {
      // content.js from before the post-check can only attach blindly; refuse rather than report success.
      if (!Array.isArray(begun?.methods)) {
        throw new ToolError('EXTENSION_OUTDATED', 'the page script cannot verify attachments — reload the extension in chrome://extensions, then retry; nothing was attached');
      }
      for (const [index, f] of files.entries()) {
        const fh = await fs.open(f.path, 'r');
        try {
          const buf = Buffer.alloc(Math.min(UPLOAD_CHUNK_BYTES, Math.max(f.size, 1)));
          for (let pos = 0; pos < f.size; ) {
            const { bytesRead } = await fh.read(buf, 0, buf.length, pos);
            if (bytesRead === 0) throw new ToolError('FILE_READ_FAILED', `${f.path} shrank while reading`);
            await page(site, 'upload_chunk', { upload_id: uploadId, index, b64: buf.subarray(0, bytesRead).toString('base64') }, 60_000);
            pos += bytesRead;
          }
        } finally {
          await fh.close();
        }
      }
      result = await attachUpload(site, uploadId, args.method != null ? [args.method] : begun.methods, files);
    } finally {
      await page(site, 'upload_release', { upload_id: uploadId }).catch(() => page(site, 'upload_abort', { upload_id: uploadId }).catch(() => {}));
    }
    siteState[site].attached = true;
    return { uploaded: files.map(({ name, size }) => ({ name, size })), ...result, ...(shown && { tab_shown: true }), ...(mode && { mode: mode.mode }) };
  },

  async send_message(args) {
    const site = resolveSite(args);
    const text = requireString(args, 'text');
    const expected = args.expect_conversation_id ? toConversationId(String(args.expect_conversation_id), site) : null;
    const onHidden = optOnHidden(args, site);
    ensureConnected();
    const st = siteState[site];
    const prev = st.pendingSend;
    const unconfirmed = !!prev && !prev.confirmed;
    const wantsMode = !!DEFAULT_MODE[site] && !st.modeOverride;
    const s = unconfirmed || onHidden !== 'proceed' || expected === NEW_CHAT || wantsMode ? await page(site, 'snapshot', {}, 10_000) : null;
    if (s) notePage(site, s.conversation_id, s);
    // An unconfirmed send whose text is still in the composer may yet go out (see the warning below);
    // typing and clicking again would send it twice. Checked before the tab is shown, which would release it.
    if (unconfirmed && s.composer_has_text && !sendObserved(prev, s)) {
      throw new ToolError(
        'SEND_PENDING',
        'the previous message was never confirmed and is still in the composer — the site may still send it (Gemini holds a clicked Send while the tab is hidden, in Chat and Task mode alike). Nothing was typed or clicked; call show_tab to let it go out now (or clear the composer by hand to drop it), or check get_status.',
      );
    }
    // The URL of a stale page cannot be trusted, so expect_conversation_id could not catch a wrong conversation.
    assertFresh(site, null, 'Nothing was typed');
    // A wrong conversation is refused before the tab is brought forward; fill_composer checks again.
    if (s) checkConversation(s, expected);
    const shown = await ensureVisible(site, onHidden, s, 'typed');
    // A new chat goes out in the default mode (Gemini: Task) — switched after the tab is shown, before typing.
    const mode = await ensureDefaultMode(site, s, { strict: true, done: 'typed' });

    const filled = await page(site, 'fill_composer', { text, expect_conversation_id: expected }, 30_000);
    // Wait for the send button to enable. click_send clicks at most once per fill, and any error
    // or timeout from it ends the attempt — it is never retried after a possible click.
    const deadline = Date.now() + 8_000;
    let click;
    do {
      await sleep(300);
      click = await page(site, 'click_send', {}, 10_000);
    } while (!click.clicked && Date.now() < deadline);
    if (!click.clicked) {
      // Don't leave the text behind: sites persist composer drafts and show them in other tabs.
      const cleared = await page(site, 'clear_composer', {}, 10_000).then((r) => r.cleared, () => false);
      throw new ToolError(
        'SEND_BUTTON_UNAVAILABLE',
        `could not click Send (${click.reason}); nothing was sent and the composer was ${cleared ? 'cleared' : 'NOT cleared — clear it manually'}`,
      );
    }

    cancelActiveJob(site, 'SUPERSEDED', 'a new message was sent');
    const pending = (st.pendingSend = {
      baseline: filled.baseline, sentAt: Date.now(), confirmed: false, observed: false, unobserved: false, conversationId: filled.conversation_id ?? null, hashSeen: false,
    });
    st.attached = false; // the attachments went out with it
    let confirmed = false;
    let conversationId = filled.conversation_id;
    let last = null;
    for (const end = Date.now() + 10_000; !confirmed && Date.now() < end; ) {
      await sleep(500);
      const s = await page(site, 'snapshot', {}, 10_000).catch(() => null);
      if (!s) continue;
      last = s;
      conversationId = s.conversation_id ?? conversationId;
      notePage(site, s.conversation_id, s);
      confirmed = sendObserved(pending, s);
    }
    pending.confirmed = confirmed;
    const tabShown = { ...(shown && { tab_shown: true }), ...(mode && { mode: mode.mode }) };
    if (confirmed) return { sent: true, confirmed, conversation_id: conversationId, ...tabShown };
    return {
      sent: true,
      confirmed: false,
      conversation_id: conversationId,
      ...tabShown,
      warning:
        last?.tab_hidden && last?.composer_has_text
          ? 'Send was clicked, but the site is holding the message while the tab is hidden (Gemini does this in Chat and Task mode alike); it goes out only once the tab is shown — possibly hours later. Do NOT send again: call show_tab to let it go out now, or clear the composer by hand to drop it.'
          : 'Send was clicked, but no new message has appeared yet; it may still go out. Do NOT send again — check get_status / get_latest_reply.',
    };
  },

  async show_tab(args) {
    const site = resolveSite(args);
    ensureConnected();
    return { site, ...(await showTab(site)) };
  },

  async get_latest_reply(args) {
    const site = resolveSite(args);
    const wait = optNumber(args, 'wait_seconds', DEFAULT_WAIT_S, 0, MAX_WAIT_S);
    const saveTo = await optSavePath(args);
    const overwrite = optBool(args, 'overwrite', false);
    const expected = args.expect_conversation_id ? toConversationId(String(args.expect_conversation_id), site) : null;
    ensureConnected();
    if (expected) {
      const s = await page(site, 'snapshot', {}, 10_000);
      notePage(site, s.conversation_id, s);
      checkConversation(s, expected, 'nothing was read');
    }
    const st = siteState[site];
    let job = st.activeJob?.status === 'running' ? st.activeJob : null;
    if (job) {
      if (saveTo) Object.assign(job, { saveTo, overwrite });
    } else {
      job = st.activeJob = createJob({ site, saveTo, overwrite });
    }
    await waitForJob(job, wait);
    return jobResult(job);
  },

  async get_job(args) {
    const id = requireString(args, 'job_id');
    const wait = optNumber(args, 'wait_seconds', DEFAULT_WAIT_S, 0, MAX_WAIT_S);
    const job = jobs.get(id);
    if (!job) throw new ToolError('JOB_NOT_FOUND', `unknown or expired job_id: ${id}`);
    await waitForJob(job, wait);
    return jobResult(job);
  },

  async select_model(args) {
    const site = resolveSite(args);
    const model = args.model == null ? null : requireString(args, 'model');
    const mode = args.mode == null ? null : requireString(args, 'mode');
    ensureConnected();
    const snap = await page(site, 'snapshot', {}, 10_000);
    if (snap.generating) {
      throw new ToolError('STILL_GENERATING', 'a reply is still being generated; switch model or mode after it finishes');
    }
    notePage(site, snap.conversation_id, snap);

    let warning = null;
    if (mode) {
      const ms = await page(site, 'model_state');
      if (!ms.modes?.length) {
        // Still the caller's explicit choice: the default mode is not forced on this chat afterwards.
        siteState[site].modeOverride = mode;
        throw new ToolError(
          'MODE_TOGGLE_NOT_FOUND',
          `${site === 'gemini' ? 'no Chat / Task toggle here — Gemini shows it only on a new chat (open_conversation https://gemini.google.com/app)' : 'no mode toggle on this page'}; "${mode}" is recorded as this chat's choice, so upload_files / send_message will not switch the mode`,
        );
      }
      const hit = matchOption(ms.modes.map((m, index) => ({ ...m, index })), mode);
      if (!hit) throw new ToolError('MODE_NOT_FOUND', `no mode matches "${mode}"; available: ${ms.modes.map((m) => m.label).join(', ')}`);
      // Explicit beats the default (Gemini: Task) until the next open_conversation.
      siteState[site].modeOverride = hit.label;
      try {
        await chooseMode(site, hit.label, ms);
      } catch (e) {
        if (e.code !== 'MODE_NOT_SET') throw e;
        warning = `${e.message} — the model part still ran; check mode in the result`;
      }
    } else if (model) {
      // A model is chosen in the mode the message will go out in (2026-11-21: a Gemini model was picked in Chat).
      warning = (await ensureDefaultMode(site, snap, { strict: false }))?.warning ?? null;
    }

    const outline = optBool(args, 'outline', false);
    const first = await useModelMenu(site, model, outline);
    // Re-read after a change so `models` shows what the page now has selected, not the pre-click state.
    const menu = model ? await useModelMenu(site, null) : first;
    const st = await page(site, 'model_state');
    const result = {
      site,
      model: st.model,
      mode: st.mode,
      modes: st.modes?.map((m) => m.label) ?? [],
      models: menu?.items.map(({ index, ...option }) => option) ?? null,
      ...(warning && { warning }),
    };
    return outline ? withText(result, first?.tree || '(no open menu found)') : result;
  },

  async list_files(args) {
    const site = resolveSite(args);
    const message = optMessage(args);
    ensureConnected();
    const r = await page(site, 'files_list', { message }).catch(rethrowOutdated);
    await assertFreshListing(site, r, 'Nothing was listed');
    return { site, ...r };
  },

  async download_file(args) {
    const site = resolveSite(args);
    const name = args.name == null ? null : requireString(args, 'name');
    const message = optMessage(args);
    const index = optIndex(args);
    if (name == null && index == null) throw new ToolError('INVALID_ARGUMENT', 'pass "name" (the exact file name) or "index" (from list_files), or both; nothing was pressed');
    const overwrite = optBool(args, 'overwrite', false);
    const timeoutS = optNumber(args, 'timeout_seconds', DOWNLOAD_TIMEOUT_S, 2, 600);
    if (typeof args.save_to !== 'string' || !path.isAbsolute(args.save_to)) throw new ToolError('INVALID_ARGUMENT', '"save_to" must be an absolute directory or file path');
    ensureConnected();
    return oneDownloadAtATime(async () => {
      const listing = await page(site, 'files_list', { message }).catch(rethrowOutdated);
      await assertFreshListing(site, listing, 'Nothing was pressed or downloaded');
      if (!listing.supported) throw new ToolError('NOT_SUPPORTED', `downloading reply files is not supported on ${site} yet`);
      const chip = pickFile(listing.files, name, index);
      // Checked before anything is pressed: a bad or taken target downloads nothing.
      const target = await downloadTarget(args.save_to, chip.name, overwrite);
      const timing = { timeout_ms: timeoutS * 1000, ...DOWNLOAD_PHASES };
      const click = { message: listing.message, index: chip.index, name: chip.name };
      if (chip.kind === 'preview') return savePreview(site, chip, click, timing, target);
      return saveCaptured(site, { cmd: 'file_click', args: click, name: chip.name, ...timing }, target, { name: chip.name, kind: chip.kind, via: 'download' });
    });
  },

  async inspect_page(args) {
    const site = resolveSite(args);
    const selector = args.selector == null ? 'body' : requireString(args, 'selector');
    const r = await page(
      site,
      'inspect',
      {
        selector,
        depth: optNumber(args, 'depth', 6, 0, 30),
        max_nodes: optNumber(args, 'max_nodes', 400, 1, 3000),
        visible_only: optBool(args, 'visible_only', true),
      },
      20_000,
    );
    const { tree, ...meta } = r;
    return withText(meta, tree || '(no matching visible elements)');
  },
};

const INSTRUCTIONS = `Drives ChatGPT (chatgpt.com) and Gemini (gemini.google.com) in one dedicated tab per site of the user's everyday Chrome.
Flow: open_conversation → (select_model) → (upload_files) → send_message → get_latest_reply.
If get_latest_reply returns still_running, do not keep calling get_job every 45 s: run its wait_command as a background shell task (Claude Code: Bash with run_in_background: true). It prints one line of JSON and exits when the reply is done (exit 0), failed (1), orphaned because the server restarted (2) or after 4 h (3); you are woken when it exits. Then call get_job once (it returns immediately). Meanwhile you can keep working or answer the user.
select_model switches the model ("Pro", "Thinking", …) and mode (ChatGPT "Work", Gemini "Task" — on a new chat) by the text shown in the page; call it without arguments to list the options. New Gemini chats are put in Task mode by default (open_conversation, and checked again before upload_files / send_message: MODE_NOT_SET, nothing typed, if it cannot be set); an explicit mode ("Chat") wins until the next open_conversation.
Every tool takes an optional site ("chatgpt" | "gemini"), defaulting to the site of the most recent open_conversation; pass it explicitly when working with both sites at once.
Prefer save_to for long replies so the full text stays out of context.
Files a reply offers (ChatGPT's inline file chips): list_files shows them, download_file saves one to a local path and returns its size and sha256 — no message is sent.
Never re-send after a failed or unconfirmed send_message — call get_status first; every send spends the user's quota.
Gemini holds a clicked Send (Chat and Task mode alike) and shows no attachment previews while its tab is hidden, so on Gemini upload_files / send_message first bring the tab to the front (on_hidden: "show", same as show_tab) and fail with TAB_HIDDEN, touching nothing, if it stays hidden (minimized or covered window) — ask the user to show the tab, then retry.
send_message's expect_conversation_id: "new" asserts the tab is on an empty new chat.
PAGE_STALE means the page may show another conversation than its URL (e.g. the tab was switched by hand): call open_conversation with the conversation you want — it reloads the page — then retry.
If selectors break after a site update, use inspect_page and patch SELECTORS in extension/content.js.`;

// ---------------------------------------------------------------- main

const mcp = new Server({ name: 'chatgpt-web', version: VERSION }, { capabilities: { tools: {} }, instructions: INSTRUCTIONS });

mcp.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));

mcp.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name } = req.params;
  const args = req.params.arguments ?? {};
  try {
    const fn = handlers[name];
    if (!fn) throw new ToolError('UNKNOWN_TOOL', `unknown tool: ${name}`);
    const result = await fn(args);
    return Array.isArray(result?.content) ? result : { content: [{ type: 'text', text: JSON.stringify(result) }] };
  } catch (e) {
    if (!(e instanceof ToolError)) log(`tool ${name} failed: ${e?.stack || e}`);
    const error = { code: e?.code || 'INTERNAL_ERROR', message: String(e?.message || e), ...(e instanceof ToolError && e.details) };
    return { isError: true, content: [{ type: 'text', text: JSON.stringify({ error }) }] };
  }
});

let shuttingDown = false;
function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  log(`shutting down (${reason})`);
  try {
    bridge.ws?.close(1001, 'server shutting down');
  } catch {}
  wss.close();
  httpServer.close();
  setTimeout(() => process.exit(0), 200).unref();
}

process.stdin.on('end', () => shutdown('stdin closed'));
process.stdin.on('close', () => shutdown('stdin closed'));
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => shutdown(sig));
process.on('uncaughtException', (e) => log(`uncaught exception: ${e?.stack || e}`));
process.on('unhandledRejection', (e) => log(`unhandled rejection: ${e?.stack || e}`));

startBridge();
await mcp.connect(new StdioServerTransport());
log(`MCP server ready on stdio (v${VERSION})`);
