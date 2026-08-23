/**
 * FORGE 2.0 — Slack notifications unit test.
 *
 * HOW TO RUN
 *     node --import tsx --test tests/slack-notifications.test.ts
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  getSlackConfig,
  notifyStart,
  notifyPromptPass,
  notifyPromptFail,
  notifyComplete,
  type SlackFetchLike,
} from '../src/notifications/slack.js';

test('getSlackConfig returns null when FORGE_SLACK_WEBHOOK is unset', () => {
  const config = getSlackConfig((n) => (n === 'OTHER_VAR' ? 'x' : undefined));
  assert.equal(config, null);
});

test('getSlackConfig returns the webhook URL when set', () => {
  const config = getSlackConfig((n) => (n === 'FORGE_SLACK_WEBHOOK' ? 'https://hooks.slack.test/abc' : undefined));
  assert.deepEqual(config, { webhookUrl: 'https://hooks.slack.test/abc' });
});

test('every notify function is a silent no-op when config is null', async () => {
  let called = false;
  const fetchImpl: SlackFetchLike = async () => {
    called = true;
    return { ok: true, status: 200 };
  };
  await notifyStart(null, 'proj', 3, { fetchImpl });
  await notifyPromptPass(null, 'proj', 'p1', 'Schema', 1000, { fetchImpl });
  await notifyPromptFail(null, 'proj', 'p1', 'Schema', 2, { fetchImpl });
  await notifyComplete(null, 'proj', 3, 0, [], 60000, 1.5, { fetchImpl });
  assert.equal(called, false, 'no webhook call should happen with a null config');
});

test('a network error is swallowed — never throws, never delivered', async () => {
  const fetchImpl: SlackFetchLike = async () => {
    throw new Error('ECONNRESET');
  };
  let delivered = 0;
  await assert.doesNotReject(() =>
    notifyPromptFail({ webhookUrl: 'https://hooks.slack.test/x' }, 'proj', 'p1', 'Schema', 1, {
      fetchImpl,
      log: () => {},
      onDelivered: () => delivered++,
    })
  );
  assert.equal(delivered, 0);
});

test('notifyPromptPass posts a green attachment and fires onDelivered on a 2xx response', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: SlackFetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  let delivered = 0;
  await notifyPromptPass(
    { webhookUrl: 'https://hooks.slack.test/x' },
    'proj',
    'p1',
    'Schema design',
    4200,
    { fetchImpl, onDelivered: () => delivered++ }
  );
  assert.equal(delivered, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.body.attachments[0].color, '#36a64f');
  assert.match(calls[0]?.body.attachments[0].title, /Schema design/);
});

test('notifyPromptFail posts a red attachment with retry count', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: SlackFetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  await notifyPromptFail({ webhookUrl: 'https://hooks.slack.test/x' }, 'proj', 'p2', 'API routes', 2, { fetchImpl });
  assert.equal(calls[0]?.body.attachments[0].color, '#e01e5a');
  const retriesField = calls[0]?.body.attachments[0].fields.find((f: any) => f.title === 'Retries');
  assert.equal(retriesField.value, '2');
});

test('notifyComplete is red when any prompt failed, green when all passed', async () => {
  const calls: Array<{ url: string; body: any }> = [];
  const fetchImpl: SlackFetchLike = async (url, init) => {
    calls.push({ url, body: JSON.parse(init.body) });
    return { ok: true, status: 200 };
  };
  const config = { webhookUrl: 'https://hooks.slack.test/x' };
  await notifyComplete(config, 'proj', 2, 1, ['p3'], 120000, 0.42, { fetchImpl });
  assert.equal(calls[0]?.body.attachments[0].color, '#e01e5a');

  await notifyComplete(config, 'proj', 3, 0, [], 60000, 0, { fetchImpl });
  assert.equal(calls[1]?.body.attachments[0].color, '#36a64f');
});
