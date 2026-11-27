#!/usr/bin/env node
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport, getDefaultEnvironment } from '@modelcontextprotocol/sdk/client/stdio.js';

const usage = 'node server/review.mjs --out reply.md [--prompt TEXT] file [file ...]\n' +
  'node server/review.mjs --out reply.md --resume https://chatgpt.com/c/ID';
const server = fileURLToPath(new URL('server.mjs', import.meta.url));

export async function runReview(call, { files, prompt, resume, out }, log = console.error) {
  let id;
  if (resume) {
    const target = new URL(resume);
    const match = /^\/c\/([a-zA-Z0-9-]+)\/?$/.exec(target.pathname);
    if (target.origin !== 'https://chatgpt.com' || target.username || target.password || !match) {
      throw new Error('Expected a ChatGPT conversation URL (/c/ID).');
    }
    id = match[1];
    const opened = await call('open_conversation', { url_or_id: target.origin + '/c/' + id });
    if (opened.conversation_id !== id) throw new Error('Review chat did not open.');
  } else {
    const opened = await call('open_conversation', { url_or_id: 'https://chatgpt.com/' });
    if (opened.conversation_id) throw new Error('Expected a new chat.');
    const selected = await call('select_model', { model: 'Pro' });
    const pro = selected.models?.some(m => m.selected && /^pro$/i.test(m.label.trim()));
    if (!pro && !/^pro$/i.test(selected.model?.trim() ?? '')) {
      throw new Error('Pro selection was not confirmed. Nothing sent.');
    }
    await call('upload_files', { paths: files });
    log('Submitting once. If interrupted, use --resume with the conversation URL.');
    const sent = await call('send_message', { text: prompt, expect_conversation_id: 'new', expect_model: 'Pro' });
    id = sent.conversation_id;
    // The site may allocate its conversation ID after acknowledging the click.
    for (let i = 0; !id && i < 15; i++) {
      await delay(1000);
      const status = await call('get_status', {});
      if (status.page_stale) throw new Error('Tab moved after send. Resume the original chat.');
      if (status.last_send?.observed) id = status.conversation_id;
    }
    if (!id) throw new Error('Send attempted. Check the chat and use --resume; do not send again.');
  }
  log('Review chat: https://chatgpt.com/c/' + id);
  let result = await call('get_latest_reply', { expect_conversation_id: id, save_to: out, wait_seconds: 45 });
  while (!result.complete && result.state === 'still_running' && result.job_id) {
    result = await call('get_job', { job_id: result.job_id, wait_seconds: 45 });
  }
  if (!result.complete || !result.saved_to) throw new Error('Reply was not saved. Resume the review chat.');
  return result;
}

async function main() {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: {
    out: { type: 'string' }, resume: { type: 'string' }, prompt: { type: 'string' }, help: { type: 'boolean' }
  }});
  if (values.help) { console.log(usage); return; }
  if (!values.out || (values.resume ? positionals.length || values.prompt : !positionals.length)) throw new Error(usage);
  const files = positionals.map(f => path.resolve(f));
  const out = path.resolve(values.out);
  await access(path.dirname(out), constants.W_OK);
  for (const f of files) {
    if (!(await stat(f)).isFile()) throw new Error('Expected an attachment file: ' + f);
    await access(f, constants.R_OK);
  }
  const env = getDefaultEnvironment();
  for (const [k,v] of Object.entries(process.env)) if (k.startsWith('CHATGPT_BRIDGE_')) env[k] = v;
  const client = new Client({ name: 'pro-review-cli', version: '1.0' });
  const transport = new StdioClientTransport({ command: process.execPath, args: [server], env, stderr: 'inherit' });
  async function call(name, args) {
    const reply = await client.callTool({ name, arguments: { ...args, ...(name === 'get_job' ? {} : { site: 'chatgpt' }) } }, undefined, { timeout: 360_000 });
    const data = JSON.parse(reply.content[0].text);
    if (reply.isError) throw Object.assign(new Error(data.error.message), data.error);
    return data;
  }
  try {
    await client.connect(transport);
    const deadline = Date.now() + 40_000;
    for (;;) {
      try { await call('get_status', {}); break; }
      catch (e) {
        if (e.code !== 'EXTENSION_NOT_CONNECTED' || e.listen_code || Date.now() >= deadline) throw e;
        await delay(1500);
      }
    }
    const result = await runReview(call, { files, out, resume: values.resume,
      prompt: values.prompt ?? 'Please review the attached materials and answer the review questions in them.' });
    console.log(JSON.stringify(result));
  } finally { await client.close(); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
