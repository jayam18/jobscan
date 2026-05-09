---
name: jobscan
description: Scan tracked job portals, filter by title/location, and score each survivor 1-5 against the user's CV and target profile. Output lands in data/jobscan-out.md ranked for triage.
---

# jobscan — Portal scan + CV×JD relevancy scoring

**Modes** (select via `{{args}}`):

| Arg | Behavior |
|-----|----------|
| (empty) | **Full pipeline** — discover → filter → dedup → score → write output |
| `discover` | Discovery + filters only; writes `data/jobscan-new.tsv`, skips scoring |
| `score` | Score only — reads existing `data/jobscan-new.tsv` and writes output |
| `major` | Full pipeline — only companies with `size: major` |
| `minor` | Full pipeline — only companies with `size: minor` |
| `small` | Full pipeline — only companies with `size: small` |

Size modes pass `--size <arg>` to both `scan.mjs` and `scan-spa.mjs`.

### Optional recipient email

`{{args}}` may also include a recipient email address (any token matching
`[^@\s]+@[^@\s]+\.[^@\s]+`). If present, after Step 5 renders the HTML
companion, also send the same HTML body via `node notify.mjs --to=<email>`.
If absent, no email is sent — only the markdown and HTML files are produced.

Strip the email token before parsing the mode arg so `discover`, `major`,
etc. still resolve correctly when an email is included alongside.
---

## Step 0 — Prerequisite check

Verify these files exist. If any is missing, enter onboarding before continuing.

1. `cv.md` → if missing, ask: "Paste your CV, share a LinkedIn URL, or describe your experience — I'll create cv.md." Then build it.
2. `profile.yml` → if missing, copy from `profile.example.yml` and collect: full_name, email, location, target_roles.primary, target_archetypes. Save.
3. `portals.yml` → if missing, copy from `portals.example.yml` and offer: "Want me to tune `title_filter.positive` based on your target roles?"
4. `data/scan-history.tsv` → if missing, create with header: `url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscore\trationale`
5. `node_modules/js-yaml` → if missing, tell the user: "Run `npm install` once, then rerun `/jobscan`."

## Step 1 — Candidate digest

Read `profile.yml`. If `scoring.candidate_digest` is empty or whitespace-only:

1. Read `cv.md`.
2. Generate a 3-5 sentence digest covering: years of experience, primary
   domains, 2-3 strongest proof points, current career positioning.
3. Show the draft to the user and ask: "Save this to profile.yml? You can edit it first."
4. On confirm, persist the digest using a **targeted Edit** — do NOT rewrite
   the whole YAML file. Two safe patterns:
   - If `profile.yml` contains `candidate_digest: ""` → Edit replaces the
     empty string with a single-line YAML-quoted string: `candidate_digest: "Your 3-5 sentence digest here."`
   - If `profile.yml` contains a block-literal `candidate_digest: |` with
     placeholder content → replace that block with:
     ```
     candidate_digest: |
       Line 1 of digest.
       Line 2 of digest.
     ```
   - If neither pattern matches, STOP. Show the user the generated digest and
     ask them to paste it into `profile.yml` themselves. Do not attempt a
     structural YAML rewrite.

Cache the digest + `target_archetypes` + `deal_breakers` in memory for the whole run.

---

## Step 2 — Discovery (skip if mode == `score`)

Run all three levels additively. Dedup happens after merge.

### L2 — Zero-token API scan (fastest, run first)

```
Bash: node scan.mjs [--size major|minor|small]
```

`scan.mjs` reads `portals.yml`, hits each company's ATS API (Greenhouse, Ashby,
Lever, Workday), applies title + location filters, dedups against
`scan-history.tsv`, and writes survivors to `data/jobscan-new.tsv` with JD
snippets when the API returns them.

If Node is unavailable or the script errors, fall through to L1 Playwright for
ALL tracked companies (slower, higher token cost).

### L1 — Playwright on careers_url (SPA companies)

```
Bash: node scan-spa.mjs [--size major|minor|small]
```

`scan-spa.mjs` reads `portals.yml`, launches headless Chromium
sequentially for each company with `scan_method: playwright` AND an
`spa:` selector block, extracts job listings via CSS selectors, applies
`title_filter` + `location_filter`, dedups against
`scan-history.tsv`, and appends survivors to `data/jobscan-new.tsv`
with `source = playwright`, `cls = ""`, `cls_note = ""`.

**Current SPA list (maintained in `portals.yml`):**

- McDonald's (HQ)
- United Airlines
- Boeing
- JPMorgan Chase
- HCSC
- AbbVie
- Walgreens Boots Alliance
- Amazon

Companies with `scan_method: playwright` but **no** `spa:` block are
logged and skipped — not an error. Selectors are tuned site-by-site as
needed. Template:

```yaml
spa:
  wait_selector: "<CSS selector that exists once job results render>"
  job_card_selector: "<repeating job card element>"
  title_selector: "<within a card, title element>"
  url_selector: "<within a card, anchor whose href becomes job URL>"
  location_selector: "<within a card, location element — optional>"
```

If Playwright is not installed, the script exits with a pointer to
`npm install && npx playwright install chromium`. Run `node doctor.mjs`
to verify setup.

For one-off debugging of a single SPA page, the
`mcp__claude-in-chrome__*` tools remain available but are no longer
part of the scripted discovery flow.

### L3 — WebSearch (broad discovery)

For each enabled query in `portals.yml.search_queries`:

1. `WebSearch` with the query string
2. Parse results: extract `{title, company, url}` using patterns in the query
   notes (most use `"Title @ Company"` or `"Title at Company"` format)
3. Apply `title_filter`, dedup against `scan-history.tsv`
4. Append survivors to `data/jobscan-new.tsv` with `source=websearch` and
   `jd_snippet=""`

### Liveness check for L3 results (sequential, never parallel)

WebSearch results can be months stale. Before scoring, verify each L3 URL:

1. `mcp__claude-in-chrome__navigate` to the URL
2. `mcp__claude-in-chrome__read_page` — capture up to `scoring.jd_snippet_chars`
   of the description
3. Classify:
   - **Active**: title + description + visible Apply/Submit element → keep,
     fill `jd_snippet` in TSV
   - **Expired**: URL ends with `?error=true`, or page contains "no longer
     available", "position has been filled", "page not found", or only nav
     chrome — drop from TSV, mark in scan-history.tsv as `status=skipped_expired`

If `navigate` errors (timeout, 403), mark `skipped_expired` and continue.

---

## Step 3 — JD snippet top-up (before scoring)

For any row in `data/jobscan-new.tsv` where **`cls == "strong"`** AND
`jd_snippet` is empty:

1. If the count of missing snippets ≤ 10: fetch each via
   `mcp__claude-in-chrome__navigate` + `read_page`, truncate to
   `scoring.jd_snippet_chars`, update TSV.
2. If > 10: use `WebFetch` in parallel batches (faster, still acceptable for
   scoring signal). Only fall back to Playwright for URLs that WebFetch fails
   on.

Rows that still have no snippet after top-up are scored title-only and
flagged in their rationale ("JD unavailable").

**Workday tenant shortcut:** For URLs matching
`{tenant}.wd{N}.myworkdayjobs.com/.../job/...`, prefer the detail API
(`/wday/cxs/{tenant}/{site}/job/{path}`) — it returns structured JD text
and avoids the SPA-render cost.

Rows with `cls != "strong"` are skipped here. `plausible` rows never get
their JD fetched; `skip` rows are dropped before this step.

---

## Step 3.5 — Classify titles (LLM hybrid filter)

**Purpose:** Divide surviving titles into `strong` (score them),
`plausible` (flag for manual skim, do not score), and `skip` (drop).
Runs once per `/jobscan` invocation. Idempotent — rows with non-empty
`cls` are skipped.

**When:** Between discovery (Step 2) and JD snippet top-up (Step 3).
(Step 3 below is narrowed in this spec to only act on `cls=="strong"`
rows.)

### Procedure

1. Read `data/jobscan-new.tsv`. Collect the index of every row where
   `cls` is empty. If none, skip to Step 3.
2. Split those rows into batches of up to 30.
3. For each batch, issue ONE LLM reasoning pass with this prompt:

```
Classify each job title for fit with the following candidate and target roles.
Output strict JSON only — no prose, no fences.

CANDIDATE DIGEST:
{profile.scoring.candidate_digest}

TARGET ARCHETYPES (strong fit targets):
{target_archetypes, one per line}

CLASSIFICATION RUBRIC:
- "strong"     — Title clearly matches an IT delivery / portfolio / program /
                 PMO / digital transformation / Director-level IT leadership
                 role. Seniority AND domain both align.
- "plausible"  — Seniority word present (Director, Senior Manager, VP,
                 Head of) but domain is adjacent (e.g. product, analytics,
                 operations). Worth a human skim, but do not spend scoring
                 tokens.
- "skip"       — Wrong domain entirely (banking front-office, audit,
                 accounting, clinical, events, customer support, sales,
                 actuarial, quality/compliance for non-IT, etc.) OR
                 below-target seniority (Associate, Coordinator, Specialist
                 without leadership scope).

TITLES:
[1] "<title>" @ <company> — <location>
[2] "<title>" @ <company> — <location>
...

Output:
[
  {"i": 1, "cls": "strong",    "why": "≤ 8 words"},
  {"i": 2, "cls": "skip",      "why": "..."},
  ...
]
```

4. Parse the JSON response. If the first character isn't `[` or parsing
   fails, strip fences/prose and retry once with this stricter reminder
   appended to the prompt:

```
IMPORTANT: Your previous response was unparseable. Output ONLY the JSON
array, nothing else. First character `[`, last character `]`.
```

5. If parsing still fails, mark every row in that batch as
   `cls = "plausible"` with `cls_note = "classifier parse error"` and
   continue. Do not block the run.

6. Validate each returned `cls` value. Any value not in
   {`strong`, `plausible`, `skip`} is coerced to `plausible`.

7. Truncate `why` to 80 characters.

8. Write results back to `data/jobscan-new.tsv`:
   - Update columns `cls` (col 7) and `cls_note` (col 8) for each row.
   - If a row has only 6 columns (legacy), pad to 8 before writing.

9. Mirror into `data/scan-history.tsv`: for each row, find by URL, update
   `status` to `classified_strong` / `classified_plausible` /
   `classified_skip`, and set `rationale` to the `cls_note`
   (plausible/skip only). For `classified_strong` rows, leave `rationale`
   empty until scoring completes.

### After classification

Emit a one-line console summary:

```
Classified {N} titles — strong: {S}, plausible: {P}, skip: {K}
```

Downstream steps only consume `cls == "strong"` rows.

---

## Step 4 — Score (skip if mode == `discover`)

Read `data/jobscan-new.tsv` into memory and keep only rows where
`cls == "strong"`. If none, skip to Step 5 (no output) — but still render
the Plausible sub-table if any `cls == "plausible"` rows exist.

### Apply score cap

Sort survivors by a rough title-heuristic (count of positive keywords matched,
boost for `seniority_boost` hits). Keep top `scoring.score_cap` (default 50).
Drop the rest with a one-line note to the user.

Plausible rows (`cls == "plausible"`) are NOT scored, NOT batched, and NOT
sent to the LLM at Step 4. They pass through to Step 5 unchanged and are
rendered in the Plausible sub-table.

### Batch scoring

Process in chunks of `scoring.score_batch_size` (default 5). For each batch,
issue ONE LLM reasoning pass with this structure:

```
You are scoring job listings for CV×JD fit.

CANDIDATE DIGEST:
{profile.scoring.candidate_digest}

TARGET ARCHETYPES: {target_archetypes, comma-separated}
DEAL-BREAKERS (cap score at 2.0 if triggered):
  locations: {deal_breakers.locations}
  stacks:    {deal_breakers.stacks}

RUBRIC (one decimal, 1.0–5.0):
  5.0  Perfect — title, seniority, archetype, domain all match; JD names CV skills
  4.0  Strong — archetype match, seniority close, 1-2 mitigable gaps
  3.0  Plausible — adjacent archetype or level mismatch; skills transferable
  2.0  Weak — significant gaps; narrative reinvention needed
  1.0  No fit — fundamentally wrong role/level/stack
Weight: title/meta ~40%, JD snippet ~60%.

OFFERS:
[1] title: "..." | company: "..." | location: "..." | jd_snippet: "..."
[2] ...
[5] ...

Output RAW JSON ONLY. No prose, no markdown code fences, no ```json wrapper,
no leading/trailing text. The first character of your response must be `[`
and the last character must be `]`. Exact shape:
[
  {"i": 1, "score": 4.2, "match": "one sentence", "gap": "one sentence"},
  {"i": 2, "score": 2.8, "match": "...", "gap": "..."},
  ...
]
```

Parse the JSON response. If the response starts with ` ``` ` or contains
non-JSON prose, strip the fences/prose and try again. If parsing fails after
one retry with a stricter reminder, mark those offers as `score=null,
rationale="scoring error"` and move on — don't block the whole run.

### Merge scores back

For each scored offer, write score + rationale back to:
- In-memory list (for output generation)
- `scan-history.tsv` — find the row by URL, update `status=scored`, fill
  `score` and `rationale` columns

---

## Step 5 — Write output

### Build new dated section

Each tier is rendered as a Markdown table. Columns are fixed:

| Company | Role | URL | Location Preference | Score |

- **Company** — `{company}`
- **Role** — `{title}`
- **URL** — raw `{url}` (no markdown link wrapping — easier to copy/paste)
- **Location Preference** — `{location}` as returned by the source (e.g.
  "Chicago, IL", "Remote", "Richardson, TX; Chicago, IL"). If empty, render
  `—`.
- **Score** — one decimal (e.g. `4.2`)

Template:

```markdown
## {YYYY-MM-DD} — {N_discovered} discovered, classified (strong: {N_strong}, plausible: {N_plausible}, skip: {N_skip}), {N_scored} scored

<!--
Header-line contract (parsed by notify.mjs).
- {N_discovered} = total candidates that survived title + location filters and dedup.
  This is the same number that gets classified.
- The literal tokens "discovered", "strong:", "plausible:", "skip:", and "scored"
  must appear exactly as shown — notify.mjs uses regex match on each.
- Additional notes (sources, error counts, etc.) belong in body text below the
  header, not on the header line itself.
-->


### High Fit (≥{score_threshold_high})

| Company | Role | URL | Location Preference | Score |
|---------|------|-----|---------------------|-------|
| {company} | {title} | {url} | {location} | {score} |
| ...     | ...  | ... | ...                 | ...   |

_Match/gap rationales (for High Fit only, one per row):_
- **{company} / {title}** — Match: {match sentence}. Gap: {gap sentence}.

### Medium Fit ({score_threshold_medium}–{score_threshold_high - 0.1})

| Company | Role | URL | Location Preference | Score |
|---------|------|-----|---------------------|-------|
| ...     | ...  | ... | ...                 | ...   |

### Low Fit (<{score_threshold_medium})

<details>
<summary>{N_low_scored} scored + {N_plausible} plausible offers (collapsed)</summary>

**Scored (<{score_threshold_medium}):**

| Company | Role | URL | Location Preference | Score |
|---------|------|-----|---------------------|-------|
| {company} | {title} | {url} | {location} | {score} |
| ...     | ...  | ... | ...                 | ...   |

**Plausible (unscored — classifier flagged as maybe-worth-skim, no LLM scoring spent):**

| Company | Role | URL | Location Preference | Classifier Note |
|---------|------|-----|---------------------|-----------------|
| {company} | {title} | {url} | {location} | {cls_note} |
| ...     | ...  | ...                          | ...         | ...             |

</details>
```

Rules:
- Within each tier, sort by score descending. Ties broken by company name.
- Within the Plausible sub-table, sort by company name (no score to sort on).
- If a tier is empty, write `_None this scan._` below the tier heading
  instead of an empty table.
- If `N_plausible == 0`, omit the Plausible sub-heading and sub-table
  entirely. Render only the Scored sub-table inside the `<details>` block.
- If both Scored-Low and Plausible are empty, render `_None this scan._`
  under the Low Fit heading and omit the `<details>` block.
- Escape any `|` characters inside cell values as `\|` so the table parses
  correctly.
- If `location` is empty, render `—`.
- Keep Match/Gap rationales only for the High Fit tier — Medium, Low, and
  Plausible stay table-only to keep the file skimmable.

### Prepend to jobscan-out.md

1. Read existing `data/jobscan-out.md`.
2. Locate the insertion point — immediately after the `# JobScan Results`
   header and the boilerplate intro paragraph, before any existing `## YYYY-MM-DD`
   section.
3. Insert the new section with a trailing `---` separator.
4. Write back.

If the file is empty or has only the placeholder intro, replace the "_No scans
run yet_" line with the new section.

### Render HTML companion

After `data/jobscan-out.md` is written, render the same day's section as a
standalone HTML file by running:

```
Bash: node notify.mjs --html
```

This invokes `notify.mjs`'s parser in HTML-only mode (no email sent). It reads
the just-written today's section from `data/jobscan-out.md` and writes
`data/jobscan-out.html` — a styled, email-safe HTML view of the same triage
report. Overwrites any prior file at that path.

If the command exits non-zero (e.g., today's section not found), log the error
and continue. The markdown remains the source of truth; HTML is a derivative.

### Send email (only if recipient was passed in args)

If `{{args}}` contained an email token, send the same HTML body via Resend:

```
Bash: node notify.mjs --to=<email>
```

This requires `RESEND_API` and `RESEND_FROM` env vars. If either is missing,
the script exits non-zero — surface that error to the user but do not fail
the run; the HTML and markdown outputs are already on disk.

If no email was passed, skip this step entirely.

### Post-run summary (to user, in the conversation)

Print a compact summary:

```
JobScan complete — 2026-05-01
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Discovered:  {N_total}
Filtered:    {N_after_base_filter} (location + hard negatives)
Classified:  {N_after_base_filter}
  → Strong:    {N_strong} (scored)
  → Plausible: {N_plausible} (flagged, not scored)
  → Skip:      {N_skip} (dropped)
Scored:      {N_strong}
  High Fit:    {N_high} (≥{score_threshold_high})
  Medium Fit:  {N_med} (≥{score_threshold_medium})
  Low Fit:     {N_low} (<{score_threshold_medium})
```

If scoring errors occurred, list them (max 5).

---

## Cost guardrails

- `scoring.score_cap` caps LLM calls per scan (default 50 offers ÷ 5 per batch
  = 10 LLM calls max).
- L3 WebSearch liveness is sequential — kept small because it spawns Playwright.
- JD snippet top-up prefers WebFetch over Playwright when > 10 rows need it.
- Re-scans are cheap: `scan-history.tsv` dedup means previously-seen URLs never
  reach scoring again.

## Error handling

- `scan.mjs` errors → log and fall through to L1 Playwright.
- Playwright fails on a URL → skip that URL, log, continue.
- Scoring batch parse fails twice → mark offers scoring-errored, continue.
- `profile.yml` or `cv.md` missing mid-run → stop and ask the user.

## Appendix — scan-history.tsv columns

| Column | Meaning |
|--------|---------|
| url | Job URL (unique key for dedup) |
| first_seen | ISO date of first discovery |
| portal | Source: `greenhouse-api`, `ashby-api`, `lever-api`, `workday-api`, `playwright`, `websearch` |
| title | Raw job title |
| company | Company name |
| location | Location string from source |
| status | `discovered` / `classified_strong` / `classified_plausible` / `classified_skip` / `scored` / `skipped_title` / `skipped_dup` / `skipped_expired` / `scoring_error` |
| score | 1.0-5.0 once scored, empty otherwise |
| rationale | `cls_note` for classified_plausible / classified_skip rows; `match \| gap` summary for scored rows; empty otherwise |

## Appendix — jobscan-new.tsv columns

| Column | Meaning |
|--------|---------|
| url | Job URL |
| title | Raw job title |
| company | Company name |
| location | Location string from source |
| source | `greenhouse-api`, `ashby-api`, `lever-api`, `workday-api`, `playwright`, `websearch` |
| jd_snippet | Up to `scoring.jd_snippet_chars` of JD text. Populated only for `cls == "strong"` rows during Step 3 top-up. |
| cls | Classifier label: `strong` / `plausible` / `skip`. Empty if classifier hasn't run on this row yet. |
| cls_note | ≤ 80-char `why` from the classifier. Empty if cls is empty. |

Legacy 6-column rows (pre-classifier) are still valid input. Readers must
pad missing columns with empty strings on read.
