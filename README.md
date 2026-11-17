# wow-forever-scraper

Scrapes the **[Wowhead WoW: Forever](https://www.wowhead.com/forever)** database into a daily snapshot:

- **every item** (25,000+): name, quality, item level, required level, slot, stats, sell price, from Wowhead's item listing, with the official Forever item sitemap filling in what the listing hides
- **every way to get each item**, from its own Wowhead page: dropped by, sold by (price and stock), skinned from, pickpocketed from, mined, gathered, fished, contained in (chests, clams, lockboxes), disenchanted into, quest rewards, recipes. Every row with its chance, sample size and average stack. Nothing is cut short
- **every NPC those tables mention**: level, rank, type, family, zones and **spawn points**, already on the game's own map IDs
- the objects, quests, recipes and zones they point at

Wowhead has no official API and rate-limits hard per IP, so this gets past the AWS WAF challenge by minting an `aws-waf-token` cookie with a local Chromium-family browser (Edge works), and, for anything beyond a home IP, routes page fetches through a tiny **Cloudflare Worker relay** (`worker/relay.js`) so every request exits from Cloudflare's IP pool. The token is not IP-bound, so the minted cookie works across that pool.

## The snapshot

The daily CI run writes it to `data/` in a private data repo. Every `.jsonl` file is sorted by id with one record per line, so each day's commit is a readable diff of what changed. `manifest.json` says which file holds what and how rows are laid out.

| File | One line per | What it holds |
|---|---|---|
| `manifest.json` | | schema version, date, counts, the run's stats (pages read, carried over, failed), row formats, listing warnings |
| `items.jsonl` | item | the listing's fields: name, quality, item level, required level, slot, stats, sell price, how it's obtained; `origin: "sitemap"` when only the sitemap knows it |
| `item-pages.jsonl` | item | the date its page was read, `self` (name, quality, icon, item level, slot, vendor price, Wowhead's average buyout) and every source table: `droppedBy`, `soldBy`, `skinnedFrom`, `pickpocketedFrom`, `minedFrom`, `gatheredFrom`, `fishedIn`, `containedInObject`, `containedInItem`, `disenchant`, `rewardFrom`, `createdBy` |
| `npcs.jsonl` | NPC | name, levels, rank, type, family, reaction, zones, `spawns` by uiMapID |
| `objects.jsonl` | object | chests, herbs, veins: name, type, required skill, zones |
| `quests.jsonl`, `spells.jsonl` | quest, recipe | the quests and recipes the item pages point at |
| `zones.json` | | area id -> name and uiMapID |

Loot rows are `[id, chance %, samples, avg stack]` (stack only when it isn't 1). Chances keep 3 significant digits and sample counts over 100 keep 2, so a day of new kills on Wowhead doesn't rewrite every line.

## How a daily run works

1. **Listing** (`scrape-items.mjs`, ~15 min): a verified partition tree over Wowhead's item listing, which never shows more than 1,000 rows at a time.
2. **Sitemap** (`merge-sitemap.mjs`, 1 request): adds the items the listing misses or hides.
3. **Pages** (`scrape-pages.mjs`, ~30-60 min): the item and NPC pages that are due, through the relay.
   - **Items:** new ones right away. Drop tables every day, other sources every 3 days, and items with nothing every 14 days.
   - **NPCs:** every 7 days.
   - Budgets (`ITEM_PAGE_BUDGET`, `NPC_PAGE_BUDGET`) cap a run. Pages that fail are retried at the end with fewer workers.
4. **Build** (`build-snapshot.mjs`): today's pages, plus the previous snapshot's for every page that wasn't due or failed today. A failure costs a day of freshness, never the data.
5. **Check** (`check-snapshot.mjs`): nothing is committed if anything shrank beyond its allowance against the previous snapshot (items, pages, drop tables and rows, NPCs with spawns), if read pages stopped parsing (a Wowhead layout change), or if more than a quarter of the reads failed (a broken relay or token). The run then fails, and GitHub emails you.
6. **Commit and notify**: pushes the snapshot and pings the addon repo (`repository_dispatch: data-updated`).

## Running it yourself

```bash
npm ci
npm test                                         # builds, then the parser and snapshot tests

node scripts/scrape-items.mjs                    # -> data/items.json
node scripts/merge-sitemap.mjs                   # -> data/items.json (+ sitemap-only items)
node scripts/scrape-pages.mjs --prev <snapshot>  # -> data/pages/ (resumable the same day)
node scripts/build-snapshot.mjs --prev <snapshot> [--out <dir>]
node scripts/check-snapshot.mjs <dir>
```

`--prev` is a folder holding the previous snapshot (the data repo's `data/`). Without one, every page is due. From a home IP, keep the budgets and concurrency small (`ITEM_PAGE_BUDGET=50 CRAWL_CONCURRENCY=2`): Wowhead throttles one IP after a few dozen fast requests.

## Daily CI

`.github/workflows/daily-scrape.yml` runs it all on GitHub Actions (free for public repos). By hand (*Actions > daily-scrape > Run workflow*) it also takes page budgets, a dry run (build and check without committing) and a skip of the check, for a deliberate drop. Secrets:

| Secret | Meaning |
|---|---|
| `WOWHEAD_WORKER_URL` | the deployed relay's URL |
| `WOWHEAD_WORKER_KEY` | the relay's key: the same value as its `RELAY_KEY` secret, sent in the `x-relay-key` header |
| `DATA_REPO` | private repo receiving snapshots, e.g. `you/wow-forever-data` |
| `DATA_REPO_PAT` | fine-grained PAT: Contents read/write on that repo (and on `ADDON_REPO`, for the ping) |
| `ADDON_REPO` | *(optional)* repo to `repository_dispatch` after each commit |

GitHub disables scheduled workflows in public repos after 60 days without activity. Since this one commits elsewhere, its last step re-enables itself and adds an empty commit here if there was none for 45 days.

## The relay

`worker/relay.js` is a Cloudflare Worker. It forwards a `GET` for a `https://www.wowhead.com/forever/` page, and only when the `x-relay-key` header matches its `RELAY_KEY` secret. Deploy it as a module worker, add the secret (`wrangler secret put RELAY_KEY`, or *Settings > Variables and Secrets*), and put the worker's URL and the same key in the scraper's secrets.

## Local config

Copy `.env.example` to `.env`. Everything is optional; set `WOWHEAD_CHROME_PATH` if your browser isn't auto-detected (Edge works: `C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`).

## Requirements

Node 22+ (global `WebSocket`), a Chromium-family browser for the token mint, and a deployed relay worker for anything beyond modest home-IP volume. Respect Wowhead's terms: this is unofficial scraping, so keep the volume polite.

Parser architecture originally from [AlvOps/wow-mcp-forever](https://github.com/AlvOps/wow-mcp-forever) (MIT); the MCP server layer was removed, so this repo only scrapes.
