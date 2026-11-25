import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import test from 'node:test';
import sharp from 'sharp';
import { createHandler } from '../src/handler.js';
import { cleanImage, publishImage } from '../src/image.js';
import { slackClient, slackFileUrl, verifySignature } from '../src/slack.js';

const secret = 'unit-test-only';
function signed(raw: string, time = Math.floor(Date.now() / 1000), input = raw) {
  const signature = createHmac('sha256', secret).update(`v0:${time}:${input}`).digest('hex');
  return new Request('https://example.test/api/slack', {
    method: 'POST', body: raw,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      'x-slack-request-timestamp': String(time),
      'x-slack-signature': `v0=${signature}`,
    },
  });
}

const slash = 'command=%2Fano&team_id=T1&api_app_id=A1&channel_id=C1&user_id=U1&trigger_id=trigger&text=a+b%26c';
const envelope = { team: { id: 'T1' }, api_app_id: 'A1', user: { id: 'U1' } };
const interactive = (payload: object) => signed(new URLSearchParams({
  payload: JSON.stringify({ ...envelope, ...payload }),
}).toString());

function fixture(overrides: NodeJS.ProcessEnv = {}) {
  const calls: unknown[][] = [];
  const pending: Promise<void>[] = [];
  const handler = createHandler({
    SLACK_SIGNING_SECRET: secret, SLACK_TEAM_ID: 'T1', SLACK_APP_ID: 'A1', SLACK_BOT_TOKEN: 'test',
    SLACK_ALLOWED_CHANNEL_IDS: 'C1, C2', SLACK_DENIED_CHANNEL_IDS: 'C2', SLACK_BLOCKED_USER_IDS: 'U2',
    ...overrides,
  }, async (method, args) => { calls.push([method, args]); },
  async (...args) => { calls.push(args); }, work => { pending.push(work); });
  return { handler, calls, pending };
}

function submit(text: string, files: object[] = [], channel = 'C1') {
  return interactive({
    type: 'view_submission',
    view: {
      callback_id: 'anonymous_post',
      private_metadata: JSON.stringify({ channel, thread: '1234567890.123456' }),
      state: { values: { body: { text: { value: text } }, image: { file: { files } } } },
    },
  });
}

test('checks the exact raw bytes and rejects stale or future signatures', async () => {
  const { handler, calls } = fixture();
  const now = Math.floor(Date.now() / 1000);
  assert.equal((await handler(signed(slash, now, slash.replace('+', '%20')))).status, 401);
  assert.equal((await handler(signed(slash, now - 301))).status, 401);
  assert.equal((await handler(signed(slash, now + 301))).status, 401);
  assert.equal(verifySignature(new Headers(), Buffer.from(slash), secret), false);
  assert.deepEqual(calls, []);
});

test('/ano opens a modal with the original prefill and an optional single image', async () => {
  const { handler, calls } = fixture();
  assert.equal((await handler(signed(slash))).status, 200);
  const [method, args] = calls[0] as [string, { view: { blocks: Array<{
    optional: boolean; element: { initial_value?: string; max_files?: number };
  }> } }];
  assert.equal(method, 'views.open');
  assert.equal(args.view.blocks[0].element.initial_value, 'a b&c');
  assert.equal(args.view.blocks[1].optional, true);
  assert.equal(args.view.blocks[1].element.max_files, 1);
});

test('shortcut on a parent or reply targets the parent thread', async () => {
  for (const message of [
    { ts: '1234567890.123456' },
    { ts: '1234567890.654321', thread_ts: '1234567890.123456' },
  ]) {
    const { handler, calls } = fixture();
    const response = await handler(interactive({
      type: 'message_action', api_app_id: undefined, callback_id: 'anonymous_reply', trigger_id: 'trigger',
      channel: { id: 'C1' }, message,
    }));
    assert.equal(response.status, 200);
    const [, args] = calls[0] as [string, { view: { private_metadata: string } }];
    assert.deepEqual(JSON.parse(args.view.private_metadata), { channel: 'C1', thread: '1234567890.123456' });
  }
});

test('rejects unrelated app/workspace and preserves user and channel restrictions', async () => {
  const { handler, calls, pending } = fixture();
  assert.equal((await handler(signed(slash.replace('T1', 'T9')))).status, 403);
  assert.equal((await handler(signed(slash.replace('A1', 'A9')))).status, 403);
  for (const raw of [slash.replace('U1', 'U2'), slash.replace('C1', 'C2'), slash.replace('C1', 'C9')]) {
    assert.equal((await (await handler(signed(raw))).json()).response_type, 'ephemeral');
  }
  assert.equal((await (await handler(submit('hello', [], 'C2'))).json()).response_action, 'errors');
  assert.equal((await fixture({ SLACK_ALLOWED_CHANNEL_IDS: '' }).handler(signed(slash))).status, 503);
  assert.deepEqual(calls, []);
  assert.equal(pending.length, 0);
});

test('validates input and defers text-only, image-only, and combined posts', async () => {
  const { handler, calls, pending } = fixture();
  assert.equal((await (await handler(submit('  '))).json()).response_action, 'errors');
  assert.equal((await (await handler(submit('hello', [{ id: 'invalid' }]))).json()).response_action, 'errors');
  await handler(submit('hello'));
  await handler(submit('', [{ id: 'F123' }]));
  assert.equal((await handler(submit('hello', [{ id: 'F123' }]))).status, 200);
  assert.equal(pending.length, 3);
  await Promise.all(pending);
  const destination = { channel: 'C1', thread: '1234567890.123456' };
  assert.deepEqual(calls, [
    [destination, 'hello', undefined], [destination, '', 'F123'], [destination, 'hello', 'F123'],
  ]);
});

test('ACK does not wait for publication to finish', async () => {
  const pending: Promise<void>[] = [];
  let finish!: () => void;
  const job = new Promise<void>(resolve => { finish = resolve; });
  const handler = createHandler({
    SLACK_SIGNING_SECRET: secret, SLACK_TEAM_ID: 'T1', SLACK_APP_ID: 'A1',
    SLACK_BOT_TOKEN: 'test', SLACK_ALLOWED_CHANNEL_IDS: 'C1',
  }, async () => ({}), () => job, work => { pending.push(work); });
  try {
    assert.equal((await handler(submit('hello'))).status, 200);
    assert.equal(pending.length, 1);
  } finally {
    finish();
    await Promise.all(pending);
  }
});

test('strips JPEG metadata and rejects unsupported images and non-Slack URLs', async () => {
  const original = await sharp({
    create: { width: 3, height: 2, channels: 3, background: 'red' },
  }).jpeg().withMetadata({ orientation: 6 }).toBuffer();
  const metadata = await sharp(await cleanImage(original)).metadata();
  assert.equal(metadata.format, 'png');
  assert.equal(metadata.width, 2);
  assert.equal(metadata.exif, undefined);
  assert.equal(metadata.icc, undefined);
  await assert.rejects(cleanImage(Buffer.from('not an image')));
  const webp = await sharp(original).webp().toBuffer();
  await assert.rejects(cleanImage(webp));
  assert.throws(() => slackFileUrl('https://files.slack.com.example.org/private', 'files.slack.com'));
});

test('handles Slack HTTP 200 with ok:false as failure', async () => {
  const api = slackClient('test', async () => Response.json({ ok: false }));
  await assert.rejects(api('chat.postMessage', {}));
});

test('publishes a separately uploaded, sanitized image in the target thread', async () => {
  const original = await sharp({
    create: { width: 2, height: 2, channels: 3, background: 'red' },
  }).jpeg().withMetadata().toBuffer();
  const calls: unknown[][] = [];
  const api: ReturnType<typeof slackClient> = async (method, args) => {
    calls.push([method, args]);
    if (method === 'files.info') {
      return { file: { size: original.length, url_private_download: 'https://files.slack.com/original' } };
    }
    if (method === 'files.getUploadURLExternal') {
      return { upload_url: 'https://files.slack.com/new', file_id: 'FNEW' };
    }
    return {};
  };
  let length = 0;
  const request: typeof fetch = async (url, options) => {
    const authorization = new Headers(options?.headers).get('authorization');
    if (String(url).endsWith('/original')) {
      assert.equal(authorization, 'Bearer token');
      return new Response(new Uint8Array(original));
    }
    assert.equal(String(url), 'https://files.slack.com/new');
    assert.equal(authorization, null);
    const bytes = Buffer.from(options?.body as Uint8Array);
    length = bytes.length;
    const metadata = await sharp(bytes).metadata();
    assert.equal(metadata.format, 'png');
    assert.equal(metadata.exif, undefined);
    return new Response();
  };
  const thread = '1234567890.123456';
  await publishImage(api, 'token', 'FORIGINAL', 'C1', thread, 'hello <@U1>', request);
  assert.deepEqual(calls, [
    ['files.info', { file: 'FORIGINAL' }],
    ['files.getUploadURLExternal', { filename: 'anonymous-image.png', length }],
    ['files.completeUploadExternal', {
      files: [{ id: 'FNEW', title: '匿名画像' }], channel_id: 'C1', thread_ts: thread,
      initial_comment: 'hello &lt;@U1&gt;',
    }],
  ]);
});

test('uses the HTTP encoding required by Slack file endpoints', async () => {
  const calls: { url: URL; options?: RequestInit }[] = [];
  const api = slackClient('test', async (url, options) => {
    calls.push({ url: new URL(String(url)), options });
    return Response.json({ ok: true });
  });
  await api('files.info', { file: 'F123' });
  await api('files.getUploadURLExternal', { length: 42, filename: 'anonymous-image.png' });
  assert.equal(calls[0].options?.method, 'GET');
  assert.equal(calls[0].url.searchParams.get('file'), 'F123');
  assert.equal(calls[0].options?.body, undefined);
  assert.equal(calls[1].options?.method, 'POST');
  assert.equal(String(calls[1].options?.body), 'length=42&filename=anonymous-image.png');
});
