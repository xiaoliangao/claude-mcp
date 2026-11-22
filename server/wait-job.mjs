#!/usr/bin/env node
// Blocks until a reply job of the chatgpt-web MCP server finishes, prints its status as one line of
// JSON and exits. Meant to be started by the MCP client as a background task (Claude Code: Bash with
// run_in_background), which wakes the client when it exits — instead of a get_job call every 45 s.
// It only reads the server's status file (.jobs/<job_id>.json, metadata only); the reply itself is
// fetched afterwards with get_job or read from save_to.
//
// Exit codes: 0 done · 1 job failed · 2 unknown job or server gone · 3 timed out · 4 the MCP tab was moved to another
// conversation (status "tab_moved": the reply is not lost — open_conversation on the printed conversation_id, then
// get_latest_reply; never send again) · 64 bad usage
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const JOBS_DIR = process.env.CHATGPT_BRIDGE_JOBS_DIR || path.join(HERE, '.jobs');
const POLL_MS = 3_000;
const STALE_MS = 90_000; // the server refreshes a running job's file every 10 s

const args = process.argv.slice(2);
const id = args.find((a, i) => !a.startsWith('--') && !args[i - 1]?.startsWith('--'));
const opt = (name, def) => {
  const i = args.indexOf(`--${name}`);
  const v = i >= 0 ? Number(args[i + 1]) : def;
  return Number.isFinite(v) && v > 0 ? v : def;
};
if (!/^job_[0-9a-f]{12}$/.test(id ?? '')) {
  console.error('usage: wait-job.mjs <job_id> [--timeout-minutes 240] [--grace-seconds 30]');
  process.exit(64);
}
const file = path.join(JOBS_DIR, `${id}.json`);
const deadline = Date.now() + opt('timeout-minutes', 240) * 60_000;
const graceUntil = Date.now() + opt('grace-seconds', 30) * 1000; // the server writes the file right after creating the job

function exit(code, data) {
  console.log(JSON.stringify(data));
  process.exit(code);
}

for (;;) {
  const job = await fs.readFile(file, 'utf8').then(JSON.parse, () => null);
  if (job?.status === 'done') exit(0, job);
  if (job?.status === 'error' && job.error?.tab_moved) exit(4, { ...job, status: 'tab_moved' });
  if (job?.status === 'error') exit(1, job);
  if (!job && Date.now() > graceUntil) {
    exit(2, { job_id: id, status: 'unknown', error: { code: 'JOB_NOT_FOUND', message: 'no status file — unknown job_id, or it expired' } });
  }
  if (job && Date.now() - job.updated_at > STALE_MS) {
    exit(2, { ...job, status: 'orphaned', error: { code: 'SERVER_GONE', message: 'the MCP server stopped updating this job (restarted or exited); call get_status' } });
  }
  if (Date.now() > deadline) exit(3, { ...(job ?? { job_id: id }), status: 'timeout' });
  await new Promise((resolve) => setTimeout(resolve, POLL_MS));
}
