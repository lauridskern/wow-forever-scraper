/**
 * Wowhead relay for Cloudflare Workers.
 *
 * Forwards a GET for a Wowhead Forever page from Cloudflare's egress IPs, so
 * the per-IP limits Wowhead puts on GitHub's datacenter IPs stop mattering.
 * Browser-shaped headers and the aws-waf-token cookie come from the caller and
 * are forwarded as they are.
 *
 *   GET https://<worker>.workers.dev/?url=https%3A%2F%2Fwww.wowhead.com%2Fforever%2Fitem%3D159
 *   x-relay-key: <the RELAY_KEY secret>
 *
 * Setup: deploy this file as a module worker and add the secret RELAY_KEY
 * (`wrangler secret put RELAY_KEY`, or Settings > Variables and Secrets in the
 * dashboard). The scraper sends the same value, from its WOWHEAD_WORKER_KEY
 * secret, in the x-relay-key header (never in the URL, so it stays out of logs).
 * Only https://www.wowhead.com/forever/ pages are relayed.
 */
const ALLOWED = /^https:\/\/www\.wowhead\.com\/forever\//;
const FORWARD = [
  'user-agent', 'accept', 'accept-language', 'cookie',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'upgrade-insecure-requests',
];

/** Constant-time comparison, so the key can't be guessed from response timing. */
function sameKey(given, expected) {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export default {
  async fetch(request, env) {
    if (!env.RELAY_KEY) return new Response('relay not configured (no RELAY_KEY secret)', { status: 500 });
    if (request.method !== 'GET') return new Response('GET only', { status: 405 });
    if (!sameKey(request.headers.get('x-relay-key') ?? '', env.RELAY_KEY)) {
      return new Response('forbidden', { status: 403 });
    }
    const target = new URL(request.url).searchParams.get('url') ?? '';
    if (!ALLOWED.test(target)) return new Response('missing or disallowed ?url=', { status: 400 });

    const headers = new Headers();
    for (const h of FORWARD) {
      const v = request.headers.get(h);
      if (v) headers.set(h, v);
    }
    const upstream = await fetch(target, { headers, redirect: 'follow', cf: { cacheTtl: 0 } });
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        'content-type': upstream.headers.get('content-type') ?? 'text/html',
        'x-relay-status': String(upstream.status),
      },
    });
  },
};
