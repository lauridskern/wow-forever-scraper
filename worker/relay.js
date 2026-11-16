/**
 * Wowhead relay for Cloudflare Workers.
 *
 * Forwards a request to a wowhead.com URL from Cloudflare's egress IPs, so
 * per-IP rate limits on our machine's IP stop mattering. Browser-shaped headers
 * and the aws-waf-token cookie come from the caller and are forwarded verbatim.
 *
 * Usage:  https://<worker>.workers.dev/?url=https%3A%2F%2Fwww.wowhead.com%2F...
 * Only wowhead.com targets are allowed, so this can't be abused as an open proxy.
 */
export default {
  async fetch(request) {
    const url = new URL(request.url);
    const target = url.searchParams.get('url') ?? '';
    if (!/^https:\/\/(www\.)?wowhead\.com\//.test(target)) {
      return new Response('missing or disallowed ?url=', { status: 400 });
    }
    // Forward the caller's browser-shaped headers; drop hop-by-hop ones.
    const forward = new Headers();
    for (const h of ['user-agent', 'accept', 'accept-language', 'cookie', 'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'upgrade-insecure-requests']) {
      const v = request.headers.get(h);
      if (v) forward.set(h, v);
    }
    return fetch(target, { headers: forward, redirect: 'follow' });
  },
};
