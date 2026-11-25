import { createHmac, timingSafeEqual } from 'node:crypto';

export function verifySignature(headers: Headers, raw: Uint8Array, secret: string, now = Date.now()) {
  const timestamp = headers.get('x-slack-request-timestamp') ?? '';
  const signature = headers.get('x-slack-signature') ?? '';
  if (!/^\d{10}$/.test(timestamp) || !/^v0=[a-f0-9]{64}$/.test(signature)) return false;
  if (Math.abs(now / 1000 - Number(timestamp)) > 300) return false;
  const expected = createHmac('sha256', secret).update(`v0:${timestamp}:`).update(raw).digest();
  return timingSafeEqual(expected, Buffer.from(signature.slice(3), 'hex'));
}

export function slackClient(token: string, request = fetch) {
  return async (method: string, args: object, timeout = 5000) => {
    const response = await request(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify(args),
      redirect: 'error',
      signal: AbortSignal.timeout(timeout),
    });
    if (!response.ok) throw new Error(method);
    const result = await response.json();
    if (result.ok !== true) throw new Error(method);
    return result;
  };
}

export function slackFileUrl(value: string, host: string) {
  const url = new URL(value);
  if (url.origin !== `https://${host}` || url.username || url.password) {
    throw new Error('unexpected file host');
  }
  return url;
}
