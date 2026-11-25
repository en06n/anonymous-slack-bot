import { waitUntil } from '@vercel/functions';
import { createHandler } from '../src/handler.js';
import { publishImage } from '../src/image.js';
import { slackClient } from '../src/slack.js';

const token = process.env.SLACK_BOT_TOKEN ?? '';
const slack = slackClient(token);

export const POST = createHandler(process.env, slack, async ({ channel, thread }, text, image) => {
  if (image) {
    await publishImage(slack, token, image, channel, thread, text);
    return;
  }
  await slack('chat.postMessage', {
    channel, text, thread_ts: thread, mrkdwn: false, unfurl_links: false, unfurl_media: false,
  });
}, waitUntil);
