/**
 * Route www.wowhead.com requests through the Cloudflare relay (worker/relay.js).
 *
 * The relay fetches from Cloudflare's egress IPs, so the per-IP limits Wowhead
 * puts on GitHub's datacenter IPs stop mattering. The shared key travels in a
 * header, never in the URL, so it can't end up in a log line.
 */
export const RELAY_KEY_HEADER = 'x-relay-key';

export interface RelayConfig {
  url: string;
  key: string;
}

/** The relay from WOWHEAD_WORKER_URL / WOWHEAD_WORKER_KEY, if both are set. */
export function relayFromEnv(env: NodeJS.ProcessEnv = process.env): RelayConfig | undefined {
  const url = env['WOWHEAD_WORKER_URL']?.trim();
  const key = env['WOWHEAD_WORKER_KEY']?.trim();
  return url && key ? { url, key } : undefined;
}

/**
 * A fetch that sends `https://www.wowhead.com/...` through the relay and
 * everything else (the tooltip service, sitemaps, token minting) directly.
 */
export function relayedFetch(relay: RelayConfig, base = 'https://www.wowhead.com', inner: typeof fetch = fetch): typeof fetch {
  return ((input: string | URL | Request, init: RequestInit = {}) => {
    const target = input instanceof Request ? input.url : String(input);
    if (!target.startsWith(`${base}/`)) return inner(input, init);
    const headers = new Headers(init.headers);
    headers.set(RELAY_KEY_HEADER, relay.key);
    return inner(`${relay.url}?url=${encodeURIComponent(target)}`, { ...init, method: 'GET', headers });
  }) as typeof fetch;
}
