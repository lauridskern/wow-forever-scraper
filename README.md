# wow-forever-scraper

Scrapes the **[Wowhead WoW: Forever](https://www.wowhead.com/forever)** item database into a single dataset:

- **all 25,573 items** — name, quality, item level, required level, slot, stats, sources (via Wowhead's own item sitemap for completeness)
- **full drop tables** for every farmable item — NPC name + link, zones, **drop chance with sample sizes**, from each item page's `dropped-by` table
- outputs `data/items.json`, `data/items.csv`, `data/item-drops.jsonl`

Wowhead has no official API and rate-limits hard per IP, so this gets past the AWS WAF challenge by minting an `aws-waf-token` cookie with a local Chromium-family browser (Edge works), and — for anything beyond a home IP — routes page fetches through a tiny **Cloudflare Worker relay** (`worker/relay.js`) so every request exits from Cloudflare's IP pool. The token is not IP-bound (verified), so the minted cookie works across that pool.

## Scripts

```bash
npm ci && npm run build

# 1. All items via a verified partition tree over Wowhead's listings
node scripts/scrape-items.mjs

# 2. Merge the official Forever item sitemap (adds hidden items + slugs)
node scripts/merge-sitemap.mjs

# 3. Full drop tables for every farmable item (resumable, checkpoints per item)
node scripts/scrape-drops-worker.mjs
```

Steps 1–3 land `data/items.json` + `data/items.csv`. Reruns resume from the checkpoint and skip finished items.

## Daily CI

`.github/workflows/daily-scrape.yml` runs the whole pipeline on GitHub Actions (free for public repos), pushes the snapshot to a private data repo, and optionally pings an addon repo to rebuild. Set the secrets:

| Secret | Meaning |
|---|---|
| `WOWHEAD_WORKER_URL` / `WOWHEAD_WORKER_KEY` | your deployed relay (see `worker/relay.js`) |
| `DATA_REPO` | private repo receiving snapshots, e.g. `you/wow-forever-data` |
| `DATA_REPO_PAT` | fine-grained PAT, Contents read/write on that repo |
| `ADDON_REPO` | *(optional)* repo to `repository_dispatch` after each run |

## Local config

Copy `.env.example` to `.env`. Everything is optional; set `WOWHEAD_CHROME_PATH` if your browser isn't auto-detected (Edge works: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`).

## Requirements

Node 22+ (global `WebSocket`), a Chromium-family browser for the token mint, and a deployed relay worker for anything beyond modest home-IP volume. Respect Wowhead's terms — this is unofficial scraping, keep the volume polite.

Parser architecture originally from [AlvOps/wow-mcp-forever](https://github.com/AlvOps/wow-mcp-forever) (MIT); the MCP server layer was removed — this repo scrapes only.
