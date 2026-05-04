# JobScan

Discover job listings across tracked companies, filter by title/location, and rank survivors 1-5 by CV×JD fit. A standalone Claude Code project.

Zero-token discovery via direct ATS APIs (Greenhouse, Ashby, Lever, Workday) + one LLM call per batch of 5 offers for scoring. Output: ranked markdown, styled HTML, and (optionally) email.

---

## What it does

- **3-tier discovery:** L2 ATS APIs (zero-token, fastest) → L1 Playwright (SPA careers pages) → L3 WebSearch (broad discovery).
- **Filter:** title keywords + location, dedup against persistent history.
- **Classify:** LLM hybrid title classifier splits survivors into `strong` (score them), `plausible` (flag for skim), `skip` (drop).
- **Score:** 1.0–5.0 CV×JD relevancy, batched 5 offers per LLM call. Cap of 50 per scan keeps cost bounded.
- **Output:** dated section prepended to `data/jobscan-out.md`, with HTML companion at `data/jobscan-out.html`. Optional email via Resend.

---

## Quick start

```bash
git clone <this-repo> myjobscan && cd myjobscan
npm install
```

Open the repo in Claude Code, then:

```
/jobscan-bootstrap     # one-shot setup; infers config from your CV
/jobscan               # first scan
```

That's it. The bootstrap walks you through CV ingestion, profile generation, and tracked-company configuration in one flow.

---

## Setup (detailed)

### Prerequisites

- **Node.js 18+** (uses native `fetch`)
- **Claude Code** (skills + slash commands)
- *Optional:* `claude-in-chrome` MCP server — needed for L1 SPA scanning + L3 WebSearch URL liveness checks. Without it, those tiers fall back to `WebFetch` (works for static pages, less reliable on SPAs like Workday/Ashby renders). The L2 API tier (which catches most listings) works regardless.
- *Optional:* Playwright with Chromium — `npx playwright install chromium`. Only needed if you want `scan-spa.mjs` for SPA fallback when MCP isn't available.
- *Optional:* [Resend](https://resend.com) account — for email notifications (free tier sufficient).

### Bootstrap walkthrough (`/jobscan-bootstrap`)

The bootstrap skill runs through six steps. You don't need to read this if you just run the command — it'll prompt you. This is for those who want to know what's coming.

**Step 1 — Acquire `cv.md`.** If `cv.md` already exists in the repo root, it's used as-is. Otherwise the skill prompts you:

> Paste your CV. I'll ask for these six sections:
> Professional Summary, Core Competencies, Areas of Expertise, Notable Accomplishments, Education and Certifications, Experience.

You can paste the whole CV at once or section-by-section.

**Step 2 — Confirm Node + deps.** Runs `node --version` and `npm install` if needed.

**Step 3 — Generate `profile.yml`.** Reads your `cv.md` and infers:

- `candidate.full_name`, `email`, `location`, `linkedin`, `github`, `portfolio_url`
- `target_roles.primary` (3-5 titles from your latest roles)
- `target_archetypes` (1-3 from a fixed enum)
- `narrative.headline`, `superpowers`, `proof_points`
- `scoring.candidate_digest` (3-5 sentence "who I am" used as scoring context)

Shows you the draft. You approve, edit inline, or paste a corrected version. The bootstrap writes the file only after you approve.

**Step 4 — Generate `portals.yml`.** Auto-derives `title_filter.positive` and `seniority_boost` from your CV. Then asks:

> Which companies do you want to track? Paste names + careers URLs.

Each careers URL you paste is auto-classified:

- **L2 (auto-handled):** matches a known ATS pattern (Greenhouse, Ashby, Lever, Workday) → written as a clean entry, no extra config.
- **L1 (needs tuning):** anything else → written with `scan_method: playwright` and TODO selectors. You'll need to find the right CSS selectors using DevTools (see §"Tuning L1 companies" below). Until you do, the scan logs and skips that company; L3 WebSearch may still surface its listings.

You can also type `skip` (keep example's starter list of 10 companies) or `none` (empty list).

**Step 5 — Initialize `data/scan-history.tsv`.** Empty file with header columns.

**Step 6 — Doctor + done.** Runs `node doctor.mjs` to verify everything is wired up. Prints summary.

**Re-run safe:** `/jobscan-bootstrap` can be re-run after CV edits to refresh derived fields. It diffs against existing files and asks before overwriting any section.

### Manual setup (alternative)

If you'd rather configure by hand:

```bash
cp profile.example.yml profile.yml    # then edit
cp portals.example.yml portals.yml    # then edit
cp cv.example.md cv.md                # then replace with your CV
mkdir -p data
printf "url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscore\trationale\n" > data/scan-history.tsv
node doctor.mjs                       # verify
```

The `/jobscan` skill also has a built-in onboarding path that catches missing files at runtime, so you can start with just `cv.md` and let the skill prompt you for the rest.

---

## Usage

### Commands

| Command | Behavior |
|---------|----------|
| `/jobscan-bootstrap` | First-time setup; re-run after CV updates |
| `/jobscan` | Full pipeline (discover → filter → classify → score → write output) |
| `/jobscan discover` | Discovery + filters only; nothing scored |
| `/jobscan score` | Score whatever is currently in `data/jobscan-new.tsv` |
| `/jobscan major` | Full pipeline; only companies with `size: major` |
| `/jobscan minor` | Full pipeline; only companies with `size: minor` |
| `/jobscan small` | Full pipeline; only companies with `size: small` |
| `/jobscan you@example.com` | Full pipeline + email results to `you@example.com` |
| `/interview-prep <slug>` | Generate interview brief for a company (requires `interview/job-description-<slug>.md`) |
| `/interview-prep <slug> round-N` | Round-N variant (different question mix) |

### Output

Each `/jobscan` run prepends a new dated section to `data/jobscan-out.md`:

```markdown
## 2026-04-23 — 87 scanned, 62 filtered, 18 dupes, 7 scored

### High Fit (≥4.0)
| Company | Role | URL | Location Preference | Score |
| Anthropic | Staff AI Engineer | https://... | Remote (US) | 4.8 |

_Match/gap rationales (for High Fit only):_
- **Anthropic / Staff AI Engineer** — Match: LLMOps + agentic track... Gap: No Rust experience.

### Medium Fit (3.0–3.9)
...

### Low Fit (<3.0)
<details>...collapsed scored + plausible sub-tables...</details>
```

A styled HTML companion is also written to `data/jobscan-out.html` (no email needed).

---

## Configuration

### `profile.yml`

| Field | Purpose |
|-------|---------|
| `candidate.*` | Your contact info (used in the email footer) |
| `target_roles.primary` / `secondary` | Roles you're optimizing for; included as scoring context |
| `target_archetypes` | Bias scoring toward these (e.g., `llmops`, `solution-architect`) |
| `deal_breakers` | If a JD matches any, the score is capped at 2.0 |
| `narrative.*` | Free-form headline / superpowers / proof points (scoring context) |
| `scoring.candidate_digest` | 3-5 sentence "who I am" sent with every score request. Auto-generated by `/jobscan-bootstrap` or by the first `/jobscan` run if blank. |
| `scoring.score_threshold_high` / `_medium` | Tier cutoffs (defaults 4.0 / 3.0) |
| `scoring.score_cap` | Max offers scored per scan (default 50; runaway-cost guard) |
| `scoring.score_batch_size` | Offers per LLM call (default 5; lower = more reliable parsing) |
| `scoring.jd_snippet_chars` | How much JD body to send to scorer (default 1000) |
| `compensation.*` | Optional; informs scoring rationale |

### `portals.yml`

| Field | Purpose |
|-------|---------|
| `title_filter.positive` | At least one must match (substring, case-insensitive) |
| `title_filter.negative` | None may match |
| `title_filter.seniority_boost` | Bonus weight if matched (used in score-cap selection) |
| `location_filter.positive` / `negative` | Location filter (empty location strings are kept) |
| `tracked_companies[]` | List of `{name, careers_url, enabled, [scan_method, spa, size]}` |
| `search_queries[]` | L3 WebSearch queries (`{name, query, enabled}`) |

### Scoring rubric

| Score | Meaning |
|-------|---------|
| 5.0   | Perfect — title, seniority, archetype, domain all match; JD names CV skills |
| 4.0   | Strong — archetype match, seniority close, 1-2 mitigable gaps |
| 3.0   | Plausible — adjacent archetype or level mismatch; skills transferable |
| 2.0   | Weak — significant gaps; narrative reinvention needed |
| 1.0   | No fit — fundamentally wrong role/level/stack |

Weight: title/meta ~40%, JD snippet ~60%.

### Tuning L1 (Playwright) companies

When `/jobscan-bootstrap` encounters a careers URL that doesn't match a known ATS pattern, it writes the entry with `scan_method: playwright` and a TODO comment for the selectors. To make scanning work for that company:

1. Open the careers page in Chrome with DevTools.
2. Find one job listing and inspect its DOM. You need five CSS selectors:
   - `wait_selector` — something that's only present once jobs are rendered (e.g., `[data-testid="job-list"]`).
   - `job_card_selector` — the repeating element that wraps each job listing (e.g., `[role="listitem"]`).
   - `title_selector` — within a card, the title element (e.g., `h3`, `a > span`).
   - `url_selector` — within a card, the anchor whose `href` is the job URL (e.g., `a[href*="/jobs/"]`).
   - `location_selector` — within a card, location element (optional; e.g., `[data-field="location"]`).
3. Paste them under `spa:` in `portals.yml` (uncomment the block) and re-run `/jobscan`.

Worked example for a hypothetical SPA:

```yaml
- name: "Example Co"
  careers_url: "https://example.com/careers"
  enabled: true
  scan_method: playwright
  spa:
    wait_selector: '[data-testid="job-results"]'
    job_card_selector: '[data-testid="job-card"]'
    title_selector: 'h3'
    url_selector: 'a[href*="/careers/"]'
    location_selector: '[data-field="location"]'
```

If you can't find selectors that work, leave the entry stubbed — L3 WebSearch (`site:example.com "<role keyword>"`) often surfaces the listings anyway.

---

## Email notifications (optional)

JobScan can send a styled HTML email summary of each scan via [Resend](https://resend.com).

### Setup

1. Sign up for Resend (free tier supports plenty of emails).
2. Create an API key.
3. Verify a sending domain (or use Resend's test sender for development).
4. Set environment variables:
   ```bash
   export RESEND_API="re_..."
   export RESEND_FROM="alerts@yourdomain.com"
   export RESEND_TO="you@gmail.com"   # default recipient (optional)
   ```
5. Run:
   ```bash
   /jobscan you@example.com   # invoke and email
   # or, after a /jobscan run:
   node notify.mjs --to=you@example.com
   ```

### Useful flags

```bash
node notify.mjs --html             # render data/jobscan-out.html only (no email)
node notify.mjs --dry-run --to=... # preview email without sending
node notify.mjs --to=...           # send single recipient
node notify.mjs --to-multiple=a@b.com,c@d.com   # multiple recipients
```

If `RESEND_API` / `RESEND_FROM` are unset, the script exits with a friendly error. The `--html` rendering works regardless of email setup — the HTML companion is written every `/jobscan` run automatically.

---

## How it works

### Discovery: 3 tiers

All three run additively. Dedup happens after merge against `data/scan-history.tsv`.

- **L2 — `node scan.mjs`** (zero-token, fastest). Hits Greenhouse / Ashby / Lever / Workday APIs directly. Auto-detects ATS from the careers URL. Most listings come from this tier.
- **L1 — `node scan-spa.mjs`** (Playwright on SPA careers pages). Reads `spa:` selector blocks from `portals.yml`. Sequential headless Chromium. Falls back to `WebFetch` if Playwright isn't installed.
- **L3 — WebSearch** (broad discovery). Issues `site:` queries from `portals.yml.search_queries`. Liveness-checks each URL via `claude-in-chrome` MCP (or `WebFetch`) before scoring.

### Classification → scoring

Two-stage LLM pipeline keeps cost bounded:

1. **Classify titles** (`strong` / `plausible` / `skip`). Batches of 30 titles per LLM call. Plausible rows are flagged but not scored — they appear in a sub-table for manual skim.
2. **Score `strong` rows** (1.0–5.0, one decimal). Batches of 5 per LLM call. Capped at 50 per scan.

Total LLM calls per scan: ~`ceil(N_titles/30) + ceil(N_strong/5)`. With 100 titles and 20 strong, that's ~8 calls.

### State: `data/scan-history.tsv`

Long-term dedup log. Every URL ever seen is recorded. Once scored, a URL never re-appears in scoring — even across many runs. This is what makes re-scans cheap.

Columns: `url first_seen portal title company location status score rationale`

---

## Troubleshooting

### `npm run doctor`

Runs all setup checks. Surfaces missing files, malformed YAML, missing `node_modules`, missing `data/` directory, etc. Run this first when something's wrong.

### Common issues

- **"Cannot find module 'js-yaml'"** → run `npm install`.
- **"No section for 2026-XX-XX in jobscan-out.md"** when sending email → run `/jobscan` first to produce today's section.
- **L1 / L3 fail with timeouts** → install `claude-in-chrome` MCP, or fall back to L2-only by leaving `scan_method: playwright` companies disabled.
- **`profile.yml` parse error** → run `node doctor.mjs` for the line number; verify YAML indentation.
- **Workday URLs return empty** → some tenants block public APIs. The script tries `/wday/cxs/{tenant}/{site}` first; if that fails, try L1 with `spa:` selectors as fallback.

---

## Privacy

- All your data — `cv.md`, `profile.yml`, `portals.yml`, `data/`, `interview/` — is gitignored. Nothing in this repo's `.git` will leak personal data.
- Network calls leave your machine for: ATS APIs (public endpoints), WebSearch (Anthropic), LLM scoring (Anthropic), and Resend (only if you wire up email).
- No telemetry. No analytics. No background processes.

---

## License

MIT. See [LICENSE](./LICENSE).
