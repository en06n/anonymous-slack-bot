import sharp from 'sharp';
import { slackClient, slackFileUrl } from './slack.js';

const maxBytes = 8 * 1024 * 1024;

async function downloadImage(url: URL, token: string, request: typeof fetch) {
  const response = await request(url, {
    headers: { authorization: `Bearer ${token}` },
    redirect: 'error',
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok || !response.body) throw new Error('file download');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error('file size');
      chunks.push(value);
    }
    return Buffer.concat(chunks);
  } finally {
    await reader.cancel();
  }
}

export async function cleanImage(input: Buffer) {
  const image = sharp(input, { limitInputPixels: 16_000_000 });
  const metadata = await image.metadata();
  if (!['jpeg', 'png'].includes(metadata.format ?? '') || (metadata.pages ?? 1) > 1) {
    throw new Error('file format');
  }
  return image.autoOrient().resize(1600, 1600, { fit: 'inside', withoutEnlargement: true })
    .png().toBuffer();
}

export async function publishImage(
  slack: ReturnType<typeof slackClient>, token: string, fileId: string,
  channel: string, thread: string | undefined, text: string, request = fetch,
) {
  const { file } = await slack('files.info', { file: fileId });
  if (!Number.isSafeInteger(file?.size) || file.size < 1 || file.size > maxBytes) {
    throw new Error('file size');
  }
  const source = slackFileUrl(file.url_private_download, 'files.slack.com');
  const input = await downloadImage(source, token, request);
  const bytes = await cleanImage(input);
  const { upload_url, file_id } = await slack('files.getUploadURLExternal', {
    filename: 'anonymous-image.png', length: bytes.length,
  });
  const upload = await request(slackFileUrl(upload_url, 'files.slack.com'), {
    method: 'POST',
    body: new Uint8Array(bytes),
    headers: { 'content-type': 'application/octet-stream' },
    redirect: 'error',
    signal: AbortSignal.timeout(8000),
  });
  if (!upload.ok) throw new Error('file upload');
  await slack('files.completeUploadExternal', {
    files: [{ id: file_id, title: '匿名画像' }],
    channel_id: channel,
    thread_ts: thread,
    initial_comment: text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;') || undefined,
  });
}
