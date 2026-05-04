# JobScan — Portal Scanner with CV×JD Relevancy Scoring

## What this repo does

Discovers job listings across configured company career pages and ATS APIs,
filters by title/location, then scores each survivor 1-5 against your CV and
target profile. Output lands in `data/jobscan-out.md` ranked for triage so you
can decide which listings deserve a full evaluation.

Zero-token discovery (via `scan.mjs`) + one LLM call per batch of 5 offers for
scoring.

## File layout

| File | Purpose | Who owns it |
|------|---------|-------------|
| `cv.md` | Your CV in markdown (canonical source) | You |
| `profile.yml` | Targeting config, candidate digest, score thresholds | You |
| `portals.yml` | Companies + title/location filters | You |
| `scan.mjs` | Zero-token API discovery (Node script) | System |
| `data/scan-history.tsv` | Long-term dedup + score log | System |
| `data/jobscan-new.tsv` | Ephemeral queue of offers to score (per run) | System |
| `data/jobscan-out.md` | Ranked results, newest dated section on top | System |
| `.claude/commands/jobscan.md` | `/jobscan` slash command | System |
| `.claude/skills/jobscan/SKILL.md` | Full skill logic | System |

## First-run check (IMPORTANT)

On session start, verify setup silently. Enter onboarding if anything is missing:

> **Tip for new users:** instead of manual setup, run `/jobscan-bootstrap` once. It infers `profile.yml` (and most of `portals.yml`) from your `cv.md`.

1. `cv.md` exists → else ask user to paste/describe CV and create it
2. `profile.yml` exists → else copy from `profile.example.yml` and collect:
   - `candidate.full_name`, `candidate.email`, `candidate.location`
   - `target_roles.primary` (list)
   - `target_archetypes` (list)
3. `portals.yml` exists → else copy from `portals.example.yml` and offer to
   customize `title_filter.positive` / `negative`
4. `profile.yml.scoring.candidate_digest` is blank → auto-generate a 3-5
   sentence digest from `cv.md` on first `/jobscan` run and ask user to review
5. `data/scan-history.tsv` exists → else create with header:
   `url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscore\trationale`
6. `npm install` has been run → check for `node_modules/js-yaml`; else prompt

## Commands

- `/jobscan-bootstrap` — first-time setup; auto-populates `profile.yml` and `portals.yml` from your `cv.md`. Re-run after CV changes.
- `/jobscan` — full pipeline: discover → filter → dedup → score → write output
- `/jobscan discover` — discovery + filter only (no scoring)
- `/jobscan score` — score only; reads from `data/jobscan-new.tsv`
- `node notify.mjs` — send a professional HTML email summary of today's scan results (requires `--to=<email>` or `DEFAULT_RECIPIENT_EMAIL` in `.env` — see `.env.example`)
- `node notify.mjs --to=<email>` — send to a specific recipient
- `node notify.mjs --dry-run` — preview email without sending (writes `data/jobscan-email-YYYY-MM-DD.preview.html`)
- `node notify.mjs --html` — render today's section as `data/jobscan-out.html` (no email; invoked automatically at end of `/jobscan`)

`/jobscan` also accepts an email token in its args (e.g. `/jobscan major you@example.com`); when present the skill runs `node notify.mjs --to=<email>` after rendering HTML.

### Email Format

Emails are formatted as professional HTML with inline CSS, structured as a triage report:
- **Header**: Date, scan summary stats (scanned, classified by tier, plausible count)
- **High Fit (≥4.0)**: Scored jobs with company, role, location, score, link
- **Medium Fit (3.0–3.9)**: Scored jobs with same columns
- **Low Fit (<3.0)**: Summary count + collapsed section
- **Plausible (unscored)**: Title-classifier-flagged listings with classifier notes
- **Footer**: Automated notification disclaimer

All sections use email-client-safe inline CSS with styled tables and color coding.

## Scoring contract

- Range: 1.0–5.0 with one decimal
- Weights: title/meta ~40%, JD snippet ~60%
- Batch: 5 offers per LLM call
- Cap: 50 offers scored per scan (configurable in `profile.yml`)
- Tiers in output:
  - High Fit (≥4.0)
  - Medium Fit (3.0–3.9)
  - Low Fit (<3.0) — always included, collapsed

## Stack

Node.js (for `scan.mjs`), Playwright via `mcp__claude-in-chrome__*`, WebSearch /
WebFetch, YAML configs, Markdown output.

## Prerequisite — claude-in-chrome MCP

L1 Playwright discovery and L3 liveness checks rely on the
`mcp__claude-in-chrome__*` tool family. The MCP server must be installed and
connected in the Claude Code session running `/jobscan`. If it is unavailable:

- L2 (zero-token API scan) still works — most listings come from this tier
- L1 and L3 fall back to `WebFetch`, which is less reliable on SPAs (Workday,
  Ashby renders, dynamic careers pages) but acceptable for static pages

If the MCP is absent, warn the user once at the start of the run and proceed
with the fallback path rather than aborting.

## Not in scope

This repo is deliberately minimal — no PDF generation, no tracker, no
negotiation scripts. It is a **triage tool**. For full evaluation, take a
high-fit listing to a dedicated evaluator.
