// MV3 service worker. Connects to the local MCP server over ws://127.0.0.1 (token-authenticated),
// keeps itself alive with 20 s heartbeats, reconnects via chrome.alarms, and runs page commands only
// inside its own dedicated tab per site (ChatGPT, Gemini). It never reads cookies and never touches other tabs.

try {
  importScripts('config.local.js');
} catch {
  console.error('[mcp-bridge] config.local.js not found — run `node scripts/init-token.mjs`, then reload the extension.');
}

const CONFIG = self.MCP_BRIDGE_CONFIG || {};
const PORT = Number(CONFIG.port) || 17373;
const BRIDGE_URL = `ws://127.0.0.1:${PORT}/`;
const BRIDGE_PROTOCOL = 'chatgpt-mcp-bridge';
const HEARTBEAT_MS = 20_000;
const RECONNECT_ALARM = 'mcp-bridge-reconnect';
const VERSION = chrome.runtime.getManifest().version;
// New on every service-worker start, so a stale content.js (e.g. after an extension reload) gets replaced.
const INSTANCE = crypto.randomUUID();

// Origins must match host_permissions in manifest.json.
const SITES = {
  chatgpt: { origin: 'https://chatgpt.com', conversation: /\/c\/([^/]+)/, loginHost: /(^|\.)openai\.com$/ },
  gemini: { origin: 'https://gemini.google.com', conversation: /\/(?:app|gem\/[^/]+)\/([^/]+)/, loginHost: /^accounts\.google\.com$/ },
};

let ws = null;
let heartbeat = null;
let retryTimer = null;
let retryDelay = 1_000;
// Per site: the dedicated tab and a secret stored in its isolated world. The mark proves that a tab id
// remembered by the server (after a worker restart) still belongs to our tab rather than to one of the
// user's own tabs.
const tabs = Object.fromEntries(Object.keys(SITES).map((site) => [site, { id: null, mark: null }]));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function bridgeError(code, message) {
  return Object.assign(new Error(message), { code });
}

function siteConfig(site) {
  const cfg = SITES[site];
  if (!cfg) throw bridgeError('INVALID_ARGUMENT', `unknown site: ${site}`);
  return cfg;
}

function isSiteUrl(site, url) {
  try {
    return new URL(url).origin === SITES[site].origin;
  } catch {
    return false;
  }
}

function conversationIdOf(site, url) {
  try {
    const raw = new URL(url).pathname.match(SITES[site].conversation)?.[1];
    return raw ? decodeURIComponent(raw) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- WebSocket link to the MCP server

function send(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function boundTabs() {
  return Object.fromEntries(Object.entries(tabs).filter(([, t]) => t.id != null).map(([site, t]) => [site, { ...t }]));
}

function connect() {
  if (!CONFIG.token) return;
  if (ws && (ws.readyState === WebSocket.CONNECTING || ws.readyState === WebSocket.OPEN)) return;
  clearTimeout(retryTimer);

  // The token travels as a subprotocol, never in the URL: Chrome logs the URL of every failed
  // connection attempt (e.g. while Claude Code is closed) on the chrome://extensions Errors page.
  const sock = new WebSocket(BRIDGE_URL, [BRIDGE_PROTOCOL, `token.${CONFIG.token}`]);
  ws = sock;
  sock.onopen = () => {
    retryDelay = 1_000;
    send({ type: 'hello', version: VERSION, tabs: boundTabs() });
    clearInterval(heartbeat);
    heartbeat = setInterval(() => send({ type: 'ping', t: Date.now() }), HEARTBEAT_MS);
  };
  sock.onmessage = (ev) => {
    let msg;
    try {
      msg = JSON.parse(ev.data);
    } catch {
      return;
    }
    if (msg.type === 'welcome') {
      for (const [site, tab] of Object.entries(msg.tabs || {})) {
        if (tabs[site] && tabs[site].id == null && tab) adoptTab(site, tab);
      }
    } else if (msg.type === 'request') {
      handleRequest(msg);
    }
  };
  sock.onclose = () => {
    if (ws !== sock) return;
    ws = null;
    clearInterval(heartbeat);
    clearTimeout(retryTimer);
    retryTimer = setTimeout(connect, retryDelay);
    retryDelay = Math.min(retryDelay * 2, 30_000);
  };
  // onclose always follows; while the worker sleeps, the alarm below is the fallback.
  sock.onerror = () => {};
}

async function adoptTab(site, { id, mark }) {
  try {
    const tab = await chrome.tabs.get(id);
    if (!mark || !isSiteUrl(site, tab.url)) throw new Error('not adoptable');
    const [res] = await chrome.scripting.executeScript({
      target: { tabId: id },
      func: () => globalThis.__mcpBridge?.tabMark ?? null,
    });
    if (res?.result !== mark) throw new Error('mark mismatch');
    if (tabs[site].id == null) tabs[site] = { id, mark };
  } catch {
    send({ type: 'event', event: 'tab_closed', site, tabId: id });
  }
}

const METHODS = {
  open_conversation: openConversation,
  status: tabStatus,
  show_tab: showTab,
  page: async ({ site, cmd, args }) => runInPage((await requireTab(site)).id, cmd, args || {}),
  hook_file_chooser: async ({ site }) => {
    const [res] = await exec((await requireTab(site)).id, { world: 'MAIN', func: installFileChooserHook });
    return res?.result ?? { installed: false };
  },
  download: captureDownload,
  download_discard: ({ download_id: id }) => {
    // Only ever a download this worker produced itself; anything else in the user's list is off limits.
    if (!captured.has(id)) throw bridgeError('DOWNLOAD_UNKNOWN', `download ${id} was not made by download_file; not touching it`);
    return discardDownload(id);
  },
};

// Runs in the page's main world of the dedicated tab (chrome.scripting world: 'MAIN'; content.js lives in
// an isolated world, where patching the page's prototypes has no effect). Gemini keeps no
// <input type=file> in the DOM; an upload button may create one and open it with click() / showPicker()
// / a dispatched click, or use showOpenFilePicker(). While content.js has placed a hidden carrier input
// holding the files (input[data-mcp-file-carrier], expires after 60 s, one use), such a request is
// answered with the carrier's files and input/change events instead of the OS file dialog. The page's
// other programmatic clicks are noted on the carrier (data-mcp-seen), and the element clicked last is
// marked data-mcp-clicked: Gemini clicks a hidden selector button and, in a hidden tab, never asks for
// the chooser, so content.js fills that button's file input itself. Without a live carrier everything
// passes straight through. Self-contained: it is serialised into the page. Bump KEY when changing it
// (a page keeps the first version it got).
function installFileChooserHook() {
  const MARK = 'data-mcp-chooser-hook';
  const KEY = '__mcpFileChooserHook3';
  if (!window[KEY]) {
    const carrier = () => {
      const c = document.querySelector('input[data-mcp-file-carrier]');
      if (!c || c.hasAttribute('data-mcp-used') || !(Number(c.getAttribute('data-mcp-expires')) > Date.now()) || !c.files?.length) return null;
      return c;
    };
    const name = (el) =>
      `${el.localName}${el.id ? `#${el.id}` : ''}${[...el.classList].slice(0, 2).map((k) => `.${k}`).join('')}${el.getAttribute?.('type') ? `[type=${el.getAttribute('type')}]` : ''}`;
    const note = (el, how) => {
      const c = carrier();
      if (!c) return;
      const seen = (c.getAttribute('data-mcp-seen') || '').split(' | ').filter(Boolean);
      if (seen.length < 8) c.setAttribute('data-mcp-seen', [...seen, `${how} ${name(el)}`].join(' | '));
      for (const m of document.querySelectorAll('[data-mcp-clicked]')) m.removeAttribute('data-mcp-clicked');
      el.setAttribute('data-mcp-clicked', '');
    };
    const isFileInput = (el) => el instanceof HTMLInputElement && el.type === 'file' && !el.hasAttribute('data-mcp-file-carrier');
    const answer = (input, how) => {
      if (!isFileInput(input)) return false;
      const c = carrier();
      if (!c) return false;
      const accept = input.getAttribute('accept');
      c.setAttribute('data-mcp-used', `${how} input[type=file]${input.multiple ? '[multiple]' : ''}${accept ? `[accept=${JSON.stringify(accept.slice(0, 60))}]` : ''}`);
      input.files = c.files;
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    };
    const click = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      if (answer(this, 'click()')) return;
      note(this, 'click() on');
      return click.call(this);
    };
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (ev) {
      if (ev?.type === 'click' && this instanceof Element) {
        if (answer(this, 'dispatched click on')) return false;
        note(this, 'dispatched click on');
      }
      return dispatch.call(this, ev);
    };
    if (typeof HTMLInputElement.prototype.showPicker === 'function') {
      const showPicker = HTMLInputElement.prototype.showPicker;
      HTMLInputElement.prototype.showPicker = function () {
        if (!answer(this, 'showPicker()')) return showPicker.call(this);
      };
    }
    if (typeof window.showOpenFilePicker === 'function') {
      const open = window.showOpenFilePicker;
      window.showOpenFilePicker = function (...args) {
        const c = carrier();
        if (!c) return open.apply(this, args);
        c.setAttribute('data-mcp-used', 'showOpenFilePicker()');
        const handle = (file) => ({ kind: 'file', name: file.name, getFile: async () => file, queryPermission: async () => 'granted', requestPermission: async () => 'granted' });
        return Promise.resolve([...c.files].map(handle));
      };
    }
    Object.defineProperty(window, KEY, { value: true });
  }
  document.documentElement.setAttribute(MARK, '');
  return { installed: true };
}

// ---------------------------------------------------------------- downloads (download_file)
//
// download_file presses a file chip in the dedicated tab (a page command) and catches the browser download the
// press starts: the first download created after the press that comes from the site (URL, final URL or referrer on
// its hosts, or a blob: of its origin) or carries the file's name. Its absolute path goes back to the server, which
// copies the file and then calls download_discard: the browser's copy — that download id only — is deleted and
// erased from the download list. A page download that never starts (Chrome holds a page's second automatic
// download behind "download multiple files" and blocks window.open without a user gesture) is covered by a
// main-world catcher armed around the press (installDownloadCatcher). It notes the https URL the page tries to
// open, and background then downloads that URL itself with chrome.downloads.download, which page limits don't
// apply to, tracked by its id. No onDeterminingFilename hook: it would make Chrome wait on this extension for
// every download in the profile.

const DOWNLOAD_HOSTS = {
  chatgpt: /(^|\.)(chatgpt\.com|openai\.com|oaiusercontent\.com|oaistatic\.com)$/,
  gemini: /(^|\.)(gemini\.google\.com|googleusercontent\.com|usercontent\.google\.com)$/,
};
const DOWNLOAD_DEFAULTS = {
  timeout_ms: 60_000, // the whole capture, from the press to a finished file
  native_ms: 6_000, // the press gets this long to start a download before a caught URL is fetched instead
  start_ms: 20_000, // … and this long to start one at all
  prompt_ms: 8_000, // a started download still without a file name this long is waiting in a Save dialog
};
const DOWNLOAD_POLL_MS = 300;
const DOWNLOAD_ORPHAN_MS = 10 * 60_000; // a finished capture the server never discards is removed after this long
const ASK_WHERE = '"Ask where to save each file before downloading" is on in chrome://settings/downloads — turn it off for download_file, then retry';

let capture = null; // the capture in progress; one at a time
const captured = new Map(); // download id → orphan timer, for each finished capture not yet discarded

function downloadsApi() {
  if (!chrome.downloads) throw bridgeError('DOWNLOADS_UNAVAILABLE', 'the extension has no "downloads" permission yet — reload it in chrome://extensions');
  return chrome.downloads;
}

const baseName = (p) => String(p || '').split(/[\\/]/).pop();
// Chrome renames a download whose name is taken to "name (1).ext".
const plainName = (n) => String(n || '').normalize('NFC').replace(/ \(\d+\)(?=\.[^.]*$|$)/, '');
const sameFile = (filename, name) => !!filename && plainName(baseName(filename)) === plainName(name);

function fromSite(site, item) {
  return [item.url, item.finalUrl, item.referrer].some((u) => {
    try {
      const url = new URL(u);
      if (url.protocol === 'blob:') return url.origin === SITES[site].origin;
      return url.protocol === 'https:' && DOWNLOAD_HOSTS[site].test(url.hostname);
    } catch {
      return false;
    }
  });
}

// Without query and fragment — signed URLs carry their signature there.
function shortUrl(u) {
  try {
    const url = new URL(u);
    if (url.protocol === 'blob:') return `blob:${url.origin}/…`;
    if (url.protocol === 'data:') return 'data:…';
    return `${url.origin}${url.pathname}`.slice(0, 120);
  } catch {
    return '(no URL)';
  }
}

// Main world of the dedicated tab, like installFileChooserHook. While armed (data-mcp-download-arm holds an expiry
// time) it notes — without changing what the page does — the URLs the page tries to download: clicks (click() or a
// dispatched click) on links that have a download attribute, a blob:/data: URL, another origin or a download path;
// window.open(); and a download URL in the JSON answer of a fetch to a "download" endpoint. Notes go to
// data-mcp-download-log as JSON, at most 20. Self-contained; bump KEY when changing it.
function installDownloadCatcher(armMs) {
  const KEY = '__mcpDownloadCatcher1';
  const ARM = 'data-mcp-download-arm';
  const LOG = 'data-mcp-download-log';
  const root = document.documentElement;
  if (!window[KEY]) {
    const armed = () => Number(root.getAttribute(ARM)) > Date.now();
    const note = (how, url, name) => {
      if (!armed() || !url) return;
      let log = [];
      try {
        log = JSON.parse(root.getAttribute(LOG) || '[]');
      } catch {}
      let href;
      try {
        href = new URL(String(url), location.href).href;
      } catch {
        return;
      }
      if (log.length < 20) root.setAttribute(LOG, JSON.stringify([...log, { how, url: href, name: name || null }]));
    };
    const link = (el) => {
      if (!(el instanceof HTMLAnchorElement) || !el.href) return null;
      try {
        const u = new URL(el.href);
        if (el.hasAttribute('download') || u.protocol === 'blob:' || u.protocol === 'data:' || u.origin !== location.origin || /download|\/files?\//i.test(u.pathname)) return el;
      } catch {}
      return null;
    };
    const click = HTMLElement.prototype.click;
    HTMLElement.prototype.click = function () {
      const a = armed() && link(this);
      if (a) note('link click()', a.href, a.getAttribute('download'));
      return click.call(this);
    };
    const dispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (ev) {
      const a = ev?.type === 'click' && armed() && link(this);
      if (a) note('dispatched link click', a.href, a.getAttribute('download'));
      return dispatch.call(this, ev);
    };
    const open = window.open;
    window.open = function (url, ...rest) {
      if (url && armed()) note('window.open()', url);
      return open.call(this, url, ...rest);
    };
    const pick = (v, depth = 0) => {
      if (!v || typeof v !== 'object' || depth > 3) return null;
      for (const [k, x] of Object.entries(v)) if (typeof x === 'string' && /^(download_?url|signed_?url|url)$/i.test(k) && /^https:\/\//i.test(x)) return x;
      for (const x of Object.values(v)) {
        const u = pick(x, depth + 1);
        if (u) return u;
      }
      return null;
    };
    const fetch0 = window.fetch;
    if (typeof fetch0 === 'function') {
      window.fetch = function (...args) {
        const p = fetch0.apply(this ?? window, args);
        if (armed()) {
          p.then((res) => {
            if (!/download/i.test(res.url) || !/json/i.test(res.headers.get('content-type') || '')) return;
            res.clone().json().then((j) => {
              const u = pick(j);
              if (u) note('fetch answer', u, j?.file_name ?? j?.filename ?? null);
            }, () => {});
          }, () => {});
        }
        return p;
      };
    }
    Object.defineProperty(window, KEY, { value: true });
  }
  root.setAttribute(ARM, String(Date.now() + armMs));
  root.setAttribute(LOG, '[]');
  return { armed: true };
}

// Main world: the catcher's notes; with disarm, also stops it.
function readDownloadCatcher(disarm) {
  const root = document.documentElement;
  let log = [];
  try {
    log = JSON.parse(root.getAttribute('data-mcp-download-log') || '[]');
  } catch {}
  if (disarm) {
    root.removeAttribute('data-mcp-download-arm');
    root.removeAttribute('data-mcp-download-log');
  }
  return log;
}

async function caughtUrls(tabId, disarm = false) {
  const [res] = await exec(tabId, { world: 'MAIN', func: readDownloadCatcher, args: [disarm] }).catch(() => []);
  return Array.isArray(res?.result) ? res.result : [];
}

function pickCaughtUrl(calls, name) {
  const web = calls.filter((c) => /^https:\/\//i.test(c.url));
  return (web.find((c) => c.name && plainName(c.name) === plainName(name)) || web[0])?.url ?? null;
}

function notStarted(site, calls) {
  const seen = calls.length ? `; the page tried ${calls.map((c) => `${c.how} ${shortUrl(c.url)}`).join(', ')}` : '; the page opened no URL that could be fetched instead';
  return `the press started no download in Chrome${seen}. If the MCP tab asks to "download multiple files", allow it, or allow ${SITES[site].origin} under chrome://settings/content/automaticDownloads`;
}

// { site, cmd, args, name, timeout_ms?, native_ms?, start_ms?, prompt_ms? } → the finished download:
// { download_id, filename, bytes, mime, capture: "click" | "caught-url", from }. On failure the download is removed.
async function captureDownload({ site, cmd, args, name, ...opts }) {
  const api = downloadsApi();
  const t = { ...DOWNLOAD_DEFAULTS };
  for (const k of Object.keys(t)) if (Number(opts[k]) > 0) t[k] = Number(opts[k]);
  if (capture) throw bridgeError('DOWNLOAD_BUSY', 'another download_file is still running');
  const tab = await requireTab(site);
  // mine: downloads started here; dupes: the page's own downloads of the URL fetched here (both always removed unless
  // returned); extra: further site downloads during the capture, removed if they turn out to be this file again;
  // unnamed: downloads not yet attributable, decided once Chrome names them; sameUrl: downloads of the fetched URL
  // seen before chrome.downloads.download told its id.
  const cap = (capture = { id: null, how: null, fetching: null, armedAt: Date.now(), mine: new Set(), dupes: new Set(), extra: new Set(), unnamed: new Set(), sameUrl: new Set() });
  const take = (id) => {
    if (cap.id == null) [cap.id, cap.how] = [id, 'click'];
    else if (id !== cap.id) cap.extra.add(id);
  };
  const onCreated = (item) => {
    // A download this capture started itself is tracked by its id (Chrome 157 reports no byExtensionId this early).
    if (item.byExtensionId === chrome.runtime.id) return;
    if (cap.fetching && [item.url, item.finalUrl].includes(cap.fetching)) {
      if (!cap.mine.has(item.id)) (cap.mine.size ? cap.dupes : cap.sameUrl).add(item.id);
      return;
    }
    if (Date.parse(item.startTime) < cap.armedAt - 2_000) return;
    if (fromSite(site, item) || sameFile(item.filename, name)) take(item.id);
    else if (!item.filename) cap.unnamed.add(item.id);
  };
  const onChanged = (delta) => {
    if (!delta.filename?.current || !cap.unnamed.delete(delta.id)) return;
    if (sameFile(delta.filename.current, name)) take(delta.id);
  };
  api.onCreated.addListener(onCreated);
  api.onChanged.addListener(onChanged);
  let calls = [];
  try {
    await exec(tab.id, { world: 'MAIN', func: installDownloadCatcher, args: [t.start_ms + 5_000] }).catch(() => null);
    await runInPage(tab.id, cmd, args || {});
    const pressedAt = Date.now();
    for (let polledAt = 0; cap.id == null; await sleep(DOWNLOAD_POLL_MS)) {
      const waited = Date.now() - pressedAt;
      if (waited >= Math.min(t.native_ms, t.timeout_ms) && Date.now() - polledAt >= 1_000) {
        polledAt = Date.now();
        calls = await caughtUrls(tab.id);
        const url = pickCaughtUrl(calls, name);
        if (url && cap.id == null) {
          cap.fetching = url;
          const id = await api.download({ url, conflictAction: 'uniquify', saveAs: false }).catch((e) => {
            throw bridgeError('DOWNLOAD_FAILED', `could not download the URL the page opened (${shortUrl(url)}): ${e?.message || e}`);
          });
          cap.mine.add(id);
          for (const other of cap.sameUrl) if (other !== id) cap.dupes.add(other);
          if (cap.id == null || cap.id === id) [cap.id, cap.how] = [id, 'caught-url'];
          break;
        }
      }
      if (cap.id == null && waited >= Math.min(t.start_ms, t.timeout_ms)) throw bridgeError('DOWNLOAD_NOT_STARTED', notStarted(site, calls));
    }
    const deadline = cap.armedAt + t.timeout_ms;
    for (;; await sleep(DOWNLOAD_POLL_MS)) {
      const [item] = await api.search({ id: cap.id });
      if (!item) throw bridgeError('DOWNLOAD_FAILED', "the download vanished from Chrome's download list");
      const from = shortUrl(item.finalUrl || item.url);
      if (item.state === 'complete') {
        if (!item.filename || item.exists === false) throw bridgeError('DOWNLOAD_FAILED', 'Chrome finished the download but its file is gone');
        captured.set(item.id, setTimeout(() => discardDownload(item.id).catch(() => {}), DOWNLOAD_ORPHAN_MS));
        return { download_id: item.id, filename: item.filename, bytes: item.fileSize > 0 ? item.fileSize : item.bytesReceived, mime: item.mime || null, capture: cap.how, from };
      }
      // Cancelled before Chrome named it: only the Save dialog does that (headless Chrome cancels at once).
      if (item.state === 'interrupted' && item.error === 'USER_CANCELED' && !item.filename) {
        throw bridgeError('DOWNLOAD_PROMPTED', `Chrome asked where to save the file and the Save dialog was cancelled. ${ASK_WHERE}`);
      }
      if (item.state === 'interrupted') throw bridgeError('DOWNLOAD_FAILED', `Chrome interrupted the download from ${from} (${item.error || 'no reason given'})`);
      if (!item.filename && Date.now() - Date.parse(item.startTime) > t.prompt_ms) {
        throw bridgeError('DOWNLOAD_PROMPTED', `Chrome is asking where to save the file; the download was cancelled. ${ASK_WHERE} (close the Save dialog if it is still open)`);
      }
      if (Date.now() > deadline) {
        const danger = item.danger && !['safe', 'accepted'].includes(item.danger) ? `; Chrome flags it as "${item.danger}" and waits for the user` : '';
        throw bridgeError(
          'DOWNLOAD_TIMEOUT',
          `the download from ${from} did not finish within ${t.timeout_ms / 1000}s (${item.bytesReceived} of ${item.totalBytes > 0 ? item.totalBytes : '?'} bytes${danger}); it was cancelled and its partial file removed`,
        );
      }
    }
  } catch (e) {
    if (cap.id != null) await discardDownload(cap.id).catch(() => {});
    throw e;
  } finally {
    api.onCreated.removeListener(onCreated);
    api.onChanged.removeListener(onChanged);
    await caughtUrls(tab.id, true);
    for (const id of [...cap.mine, ...cap.dupes]) if (!captured.has(id)) await discardDownload(id).catch(() => {});
    for (const id of cap.extra) {
      const [item] = await api.search({ id }).catch(() => []);
      if (item && sameFile(item.filename, name)) await discardDownload(id).catch(() => {});
    }
    capture = null;
  }
}

// Deletes the file of one of this extension's downloads (cancelling it first if unfinished, which deletes the
// partial file) and erases it from Chrome's download list. Returns { removed, erased, file }.
async function discardDownload(id) {
  const api = downloadsApi();
  clearTimeout(captured.get(id));
  captured.delete(id);
  const [item] = await api.search({ id });
  if (!item) return { removed: true, erased: false, file: null };
  let left = false;
  if (item.state === 'complete') {
    if (item.exists) {
      await api.removeFile(id).catch(async () => {
        left = !!(await api.search({ id }))[0]?.exists;
      });
    }
  } else {
    await api.cancel(id).catch(() => {});
  }
  await api.erase({ id }).catch(() => {});
  return { removed: !left, erased: true, file: item.filename || null };
}

async function handleRequest({ id, method, params }) {
  try {
    const fn = METHODS[method];
    if (!fn) throw bridgeError('UNKNOWN_METHOD', `unknown bridge method: ${method}`);
    send({ type: 'response', id, ok: true, result: await fn(params || {}) });
  } catch (e) {
    send({ type: 'response', id, ok: false, error: { code: e.code || 'EXTENSION_ERROR', message: String(e?.message || e) } });
  }
}

// ---------------------------------------------------------------- dedicated tabs

function forgetTab(site) {
  if (tabs[site].id != null) send({ type: 'event', event: 'tab_closed', site, tabId: tabs[site].id });
  tabs[site] = { id: null, mark: null };
}

async function getTab(site) {
  siteConfig(site);
  if (tabs[site].id == null) return null;
  try {
    return await chrome.tabs.get(tabs[site].id);
  } catch {
    forgetTab(site);
    return null;
  }
}

async function requireTab(site) {
  const tab = await getTab(site);
  if (!tab) throw bridgeError('NO_MCP_TAB', `no dedicated ${site} tab yet — call open_conversation first`);
  if (!isSiteUrl(site, tab.url || tab.pendingUrl)) {
    throw bridgeError('MCP_TAB_OFF_SITE', `the ${site} MCP tab has left ${SITES[site].origin} — call open_conversation`);
  }
  return tab;
}

function scriptError(e) {
  const message = String(e?.message || e);
  if (/No tab with id/i.test(message)) return bridgeError('NO_MCP_TAB', 'the MCP tab no longer exists — call open_conversation');
  if (/Cannot access|permission/i.test(message)) return bridgeError('MCP_TAB_OFF_SITE', message);
  return bridgeError('PAGE_UNAVAILABLE', `the page is not scriptable right now (${message})`);
}

async function exec(tabId, details) {
  try {
    return await chrome.scripting.executeScript({ target: { tabId }, ...details });
  } catch (e) {
    throw scriptError(e);
  }
}

async function inject(tabId) {
  const mark = Object.values(tabs).find((t) => t.id === tabId)?.mark ?? null;
  await exec(tabId, { files: ['content.js'] });
  await exec(tabId, {
    func: (instance, mark) => {
      globalThis.__mcpBridge.instance = instance;
      globalThis.__mcpBridge.tabMark = mark;
    },
    args: [INSTANCE, mark],
  });
}

async function runInPage(tabId, cmd, args = {}) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const [res] = await exec(tabId, {
      func: (instance, cmd, args) => {
        const bridge = globalThis.__mcpBridge;
        return bridge && bridge.instance === instance ? bridge.handle(cmd, args) : { reinject: true };
      },
      args: [INSTANCE, cmd, args],
    });
    const out = res?.result;
    if (out?.reinject) {
      await inject(tabId);
      continue;
    }
    if (!out) throw bridgeError('PAGE_UNAVAILABLE', 'no result from the page (navigation in progress?)');
    if (!out.ok) throw bridgeError(out.error.code, out.error.message);
    return out.result;
  }
  throw bridgeError('PAGE_UNAVAILABLE', 'could not inject content.js into the MCP tab');
}

function sameTarget(site, href, target) {
  try {
    const want = conversationIdOf(site, target);
    if (want) return conversationIdOf(site, href) === want;
    return new URL(href).pathname.replace(/\/+$/, '') === new URL(target).pathname.replace(/\/+$/, '');
  } catch {
    return false;
  }
}

async function waitForReady(site, tabId, target, navigated, timeoutMs = 60_000) {
  const start = Date.now();
  let composerSince = null;
  let last = null;
  await sleep(500);
  while (Date.now() - start < timeoutMs) {
    const tab = await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw bridgeError('NO_MCP_TAB', 'the MCP tab was closed while loading');
    if (tab.status === 'complete' && tab.url && !isSiteUrl(site, tab.url)) {
      const { hostname, origin } = new URL(tab.url);
      throw bridgeError(
        SITES[site].loginHost.test(hostname) ? 'NOT_LOGGED_IN' : 'MCP_TAB_OFF_SITE',
        `the ${site} MCP tab ended up on ${origin} — log in to ${SITES[site].origin} in this Chrome profile`,
      );
    }
    if (tab.status === 'complete' && (navigated() || sameTarget(site, tab.url, target))) {
      last = await runInPage(tabId, 'ready').catch(() => null);
      if (last?.login_required) {
        throw bridgeError('NOT_LOGGED_IN', `${site} shows a sign-in prompt — log in to ${SITES[site].origin} in this Chrome profile first`);
      }
      if (last?.composer) {
        composerSince ??= Date.now();
        // Conversation pages render their messages a moment after the composer appears.
        if (!last.conversation_id || last.messages > 0 || Date.now() - composerSince > 10_000) {
          return { url: last.href, conversation_id: last.conversation_id, tab_id: tabId };
        }
      }
    }
    await sleep(400);
  }
  throw bridgeError('PAGE_NOT_READY', `${site} did not become ready within ${timeoutMs / 1000}s${last ? ` (title: ${last.title})` : ''}`);
}

async function openConversation({ site, url }) {
  siteConfig(site);
  if (!isSiteUrl(site, url)) throw bridgeError('INVALID_ARGUMENT', `only ${SITES[site].origin}/ URLs can be opened for ${site}`);
  const existing = await getTab(site);
  if (!existing) {
    // Opened in the background so the user's current tab keeps focus.
    const tab = await chrome.tabs.create({ url, active: false });
    tabs[site] = { id: tab.id, mark: crypto.randomUUID() };
    chrome.tabs.update(tab.id, { autoDiscardable: false }).catch(() => {});
    send({ type: 'event', event: 'tab_bound', site, tabId: tab.id, mark: tabs[site].mark });
    return waitForReady(site, tab.id, url, () => true);
  }
  let navigated = false;
  const onUpdated = (id, info) => {
    if (id === existing.id && info.status === 'loading') navigated = true;
  };
  chrome.tabs.onUpdated.addListener(onUpdated);
  try {
    await chrome.tabs.update(existing.id, { url, autoDiscardable: false });
    return await waitForReady(site, existing.id, url, () => navigated);
  } finally {
    chrome.tabs.onUpdated.removeListener(onUpdated);
  }
}

async function tabStatus({ site }) {
  const tab = await getTab(site);
  if (!tab) return { state: 'idle', conversation_id: null, chars: 0, uploading: false, mcp_tab_open: false };
  if (!isSiteUrl(site, tab.url)) throw bridgeError('MCP_TAB_OFF_SITE', `the ${site} MCP tab has left ${SITES[site].origin} — call open_conversation`);
  try {
    return { ...(await runInPage(tab.id, 'status')), mcp_tab_open: true };
  } catch (e) {
    // Only a page that is mid-navigation gets the placeholder; tab.status alone is unreliable
    // (in-app route changes flip it to "loading" while a reply is generating).
    if (e.code !== 'PAGE_UNAVAILABLE') throw e;
    return { state: 'idle', conversation_id: conversationIdOf(site, tab.url), chars: 0, uploading: false, mcp_tab_open: true, page_loading: true };
  }
}

// ---------------------------------------------------------------- bringing a tab forward (show_tab)
//
// Gemini holds a clicked Send until its tab is visible (Chat and Task mode alike; seen 2026-11-21 going out 11 h
// later, once the user looked at the tab) and renders no attachment previews while hidden. show_tab makes the
// dedicated tab the active tab of its window, restores the window if minimized, focuses it, and then polls the page
// (content.js "visibility") until it reports itself visible. Only when the page says it is hidden: a visible tab is
// left exactly as it is. Needs no permission beyond "tabs".

const SHOW_TAB_MS = 3_000; // how long the page gets to report itself visible after being brought forward
const SHOW_POLL_MS = 150;

const pageVisibility = (tabId) => runInPage(tabId, 'visibility').catch(() => null);

function hiddenReason({ activated, focused, window_state: state }, vis, errors) {
  let why;
  if (!vis) why = 'the page did not answer (still loading?)';
  else if (!activated) why = 'Chrome did not make it the active tab of its window';
  else if (state === 'minimized') why = 'its window is still minimized';
  else if (!focused) {
    why = 'Chrome could not bring its window to the front — another app is in front and the OS refused the focus change (macOS may), or the window is on another desktop / Space';
  } else {
    why = "its window is active and focused, yet Chrome still reports the page hidden — the window is probably covered by another app's window, on another desktop / Space, or the screen is locked or asleep";
  }
  return errors.length ? `${why} (${errors.join('; ')})` : why;
}

// { site, timeout_ms? } → { tab_hidden, was_hidden, activated, focused, window_state, reason? }: activated = the MCP
// tab is the active tab of its window, focused = that window is Chrome's focused window, reason = why the page still
// reports itself hidden.
async function showTab({ site, timeout_ms: timeoutMs }) {
  const tab = await requireTab(site);
  const wait = Number(timeoutMs) > 0 ? Number(timeoutMs) : SHOW_TAB_MS;
  const windowOf = (t) => (t.windowId == null ? Promise.resolve(null) : chrome.windows.get(t.windowId).catch(() => null));
  let win = await windowOf(tab);
  const before = await pageVisibility(tab.id);
  if (before && !before.tab_hidden) {
    return { tab_hidden: false, was_hidden: false, activated: !!tab.active, focused: !!win?.focused, window_state: win?.state ?? null };
  }
  const errors = [];
  const note = (what) => (e) => errors.push(`${what}: ${e?.message || e}`);
  if (!tab.active) await chrome.tabs.update(tab.id, { active: true }).catch(note('activating the tab'));
  if (tab.windowId != null) {
    // "normal" restores a minimized window; focused cannot be combined with "minimized".
    await chrome.windows.update(tab.windowId, { focused: true, ...(win?.state === 'minimized' && { state: 'normal' }) }).catch(note('focusing its window'));
  }
  let vis = null;
  for (const end = Date.now() + wait; ; await sleep(SHOW_POLL_MS)) {
    vis = await pageVisibility(tab.id);
    if ((vis && !vis.tab_hidden) || Date.now() >= end) break;
  }
  const now = (await chrome.tabs.get(tab.id).catch(() => null)) || tab;
  win = await windowOf(now);
  const out = { tab_hidden: !vis || !!vis.tab_hidden, was_hidden: true, activated: !!now.active, focused: !!win?.focused, window_state: win?.state ?? null };
  if (out.tab_hidden) out.reason = hiddenReason(out, vis, errors);
  return out;
}

// ---------------------------------------------------------------- lifecycle

chrome.tabs.onRemoved.addListener((tabId) => {
  for (const site of Object.keys(tabs)) if (tabs[site].id === tabId) forgetTab(site);
});
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === RECONNECT_ALARM) connect();
});
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
chrome.alarms.get(RECONNECT_ALARM).then((alarm) => {
  if (!alarm) chrome.alarms.create(RECONNECT_ALARM, { periodInMinutes: 0.5 });
});
connect();
