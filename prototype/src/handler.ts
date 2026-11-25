import { SlackApiError, slackClient, verifySignature } from './slack.js';

type Destination = { channel: string; thread?: string };
type Publish = (destination: Destination, text: string, image?: string) => Promise<void>;

const validId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Z][A-Z0-9]+$/.test(value);
const validTs = (value: unknown): value is string =>
  typeof value === 'string' && /^\d+\.\d{6}$/.test(value);
const ids = (value = '') => new Set(value.split(',').map(id => id.trim()).filter(Boolean));
const reply = (text: string) => Response.json({ response_type: 'ephemeral', text });

function modal(destination: Destination, initialText: string) {
  return {
    type: 'modal',
    callback_id: 'anonymous_post',
    private_metadata: JSON.stringify(destination),
    title: { type: 'plain_text', text: destination.thread ? '匿名返信' : '匿名投稿' },
    submit: { type: 'plain_text', text: '送信' },
    blocks: [
      {
        type: 'input', block_id: 'body', optional: true,
        label: { type: 'plain_text', text: '本文' },
        element: { type: 'plain_text_input', action_id: 'text', multiline: true,
          max_length: 2000, initial_value: initialText || undefined },
      },
      {
        type: 'input', block_id: 'image', optional: true,
        label: { type: 'plain_text', text: '画像（任意）' },
        hint: { type: 'plain_text', text: 'JPEG / PNG 1枚、8 MBまで。画像に写る個人情報に注意してください。' },
        element: { type: 'file_input', action_id: 'file', filetypes: ['jpg', 'jpeg', 'png'], max_files: 1 },
      },
    ],
  };
}

export function createHandler(
  env: NodeJS.ProcessEnv,
  slack: ReturnType<typeof slackClient>,
  publish: Publish,
  defer: (work: Promise<void>) => void,
) {
  const { SLACK_SIGNING_SECRET: secret, SLACK_TEAM_ID: teamId, SLACK_APP_ID: appId } = env;
  const blocked = ids(env.SLACK_BLOCKED_USER_IDS);
  const denied = ids(env.SLACK_DENIED_CHANNEL_IDS);
  const allowed = ids(env.SLACK_ALLOWED_CHANNEL_IDS);

  return async (request: Request) => {
    const received = Date.now();
    if (!secret || !teamId || !appId || !allowed.size || !env.SLACK_BOT_TOKEN) {
      return new Response(null, { status: 503 });
    }
    const raw = new Uint8Array(await request.arrayBuffer());
    if (!verifySignature(request.headers, raw, secret)) return new Response(null, { status: 401 });
    const form = new URLSearchParams(new TextDecoder().decode(raw));
    const encoded = form.get('payload');
    let destination: Destination;
    let trigger: string | undefined;
    let user: string;
    let body: unknown;
    let fileList: unknown;
    let submission = false;
    try {
      const payload = encoded === null ? Object.fromEntries(form) : JSON.parse(encoded);
      const messageShortcut = encoded !== null && payload.type === 'message_action';
      // Slack's message shortcut payload can omit api_app_id. The signing secret is app-specific.
      const appMatches = payload.api_app_id === appId || (messageShortcut && payload.api_app_id === undefined);
      if ((encoded === null ? payload.team_id : payload.team?.id) !== teamId || !appMatches) {
        return new Response(null, { status: 403 });
      }
      user = encoded === null ? payload.user_id : payload.user?.id;
      if (encoded === null && payload.command === '/ano') {
        destination = { channel: payload.channel_id };
        trigger = payload.trigger_id;
        body = payload.text;
      } else if (encoded !== null && payload.type === 'message_action' &&
                 payload.callback_id === 'anonymous_reply') {
        destination = { channel: payload.channel?.id, thread: payload.message?.thread_ts ?? payload.message?.ts };
        if (!validTs(destination.thread)) return new Response(null, { status: 400 });
        trigger = payload.trigger_id;
      } else if (encoded !== null && payload.type === 'view_submission' &&
                 payload.view?.callback_id === 'anonymous_post') {
        submission = true;
        destination = JSON.parse(payload.view.private_metadata);
        body = payload.view.state?.values?.body?.text?.value;
        fileList = payload.view.state?.values?.image?.file?.files;
      } else {
        return new Response(null, { status: 400 });
      }
      if (!validId(user) || !validId(destination.channel) ||
          (destination.thread !== undefined && !validTs(destination.thread))) {
        return new Response(null, { status: 400 });
      }
    } catch {
      return new Response(null, { status: 400 });
    }

    const errors = (block: string, message: string) =>
      Response.json({ response_action: 'errors', errors: { [block]: message } });
    const restriction = blocked.has(user) ? 'あなたは匿名投稿を利用できません。' :
      denied.has(destination.channel) || !allowed.has(destination.channel) ?
        'このチャンネルでは匿名投稿を利用できません。' : undefined;
    if (restriction) {
      return submission ? errors('body', restriction) :
        encoded === null ? reply(restriction) : new Response(null, { status: 403 });
    }

    if (!submission) {
      if (typeof trigger !== 'string' || !trigger) return new Response(null, { status: 400 });
      // The trigger expires in three seconds. Start the API call immediately and bound the ACK wait.
      try {
        await slack('views.open', { trigger_id: trigger,
          view: modal(destination, typeof body === 'string' ? body.slice(0, 2000) : ''),
        }, Math.max(1, 2300 - (Date.now() - received)));
        return new Response();
      } catch {
        console.error('anonymous_slack_modal_failed');
        return encoded === null ? reply('モーダルを開けませんでした。再度お試しください。') :
          new Response(null, { status: 502 });
      }
    }

    const text = typeof body === 'string' ? body.trim() : '';
    const files = fileList ?? [];
    if (!Array.isArray(files) || files.length > 1 ||
        (files.length === 1 && !/^F[A-Z0-9]+$/.test(files[0]?.id ?? ''))) {
      return errors('image', '画像は1枚まで添付できます。');
    }
    const image = files[0]?.id;
    if (text.length > 2000 || (!text && !image)) {
      return errors('body', '本文（2,000文字以内）または画像を入力してください。');
    }
    defer(publish(destination, text, image).catch(async error => {
      const detail = error instanceof SlackApiError ? `${error.method}:${error.code}` : 'processing_failed';
      console.error('anonymous_slack_publish_failed', image ? 'image' : 'text', detail);
      try {
        await slack('chat.postEphemeral', {
          channel: destination.channel, user,
          text: '投稿結果を確認できませんでした。再送する前に投稿先を確認してください。',
        });
      } catch {
        console.error('anonymous_slack_notification_failed');
      }
    }));
    return new Response();
  };
}
