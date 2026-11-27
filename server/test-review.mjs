import assert from 'node:assert/strict';
import test from 'node:test';
import { runReview } from './review.mjs';

const options = { files: ['/brief.md'], prompt: 'Review the brief', out: '/reply.md' };
const done = { complete: true, saved_to: options.out, chars: 100 };

test('submit once with required model and chat, then wait for the same job', async () => {
  const calls = [];
  const replies = { open_conversation: {}, select_model: { model: 'Pro' }, upload_files: {},
    send_message: { sent: true, confirmed: true, conversation_id: 'example-id' },
    get_latest_reply: { complete: false, state: 'still_running', job_id: 'job-1' }, get_job: done };
  const call = async (name,args) => { calls.push([name,args]); return replies[name]; };
  assert.deepEqual(await runReview(call, options, () => {}), done);
  assert.deepEqual(calls.map(([name]) => name), Object.keys(replies));
  assert.deepEqual(calls[3][1], {text: options.prompt, expect_conversation_id: 'new', expect_model: 'Pro'});
  assert.equal(calls[4][1].expect_conversation_id, 'example-id');
  assert.equal(calls[5][1].job_id, 'job-1');
});

test('resume only reads the requested chat', async () => {
  const calls = [];
  const call = async (name,args) => {
    calls.push(name);
    if (name === 'open_conversation') return { conversation_id: 'abc' };
    assert.equal(args.expect_conversation_id, 'abc');
    return done;
  };
  await runReview(call, {...options,resume:'https://chatgpt.com/c/abc'}, () => {});
  assert.deepEqual(calls,['open_conversation','get_latest_reply']);
});

test('unverified model or wrong conversation prevents further actions', async () => {
  const call = async name => {
    if (name === 'open_conversation') return {};
    if (name === 'select_model') return { model: 'Thinking' };
    assert.fail(name);
  };
  await assert.rejects(runReview(call, options, () => {}), /Pro selection/);
  await assert.rejects(runReview(call, {...options,resume:'https://chatgpt.com/c/abc'}, () => {}), /did not open/);
});
