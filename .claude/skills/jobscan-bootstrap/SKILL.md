---
name: jobscan-bootstrap
description: One-shot setup for JobScan — acquires cv.md (or prompts user for sections), then auto-generates profile.yml and portals.yml from the CV, classifies each tracked company URL as L2 (known ATS) or L1 (Playwright), and initializes data/scan-history.tsv. Re-runnable; never silently overwrites existing files.
---

# jobscan-bootstrap — first-time setup

Run this once after cloning the repo. Re-run after major CV changes to refresh derived fields. Never silently overwrites — always shows a draft and asks for confirmation.

---

## Step 1 — Acquire `cv.md`

Check repo root for `cv.md`.

- **Exists, > 200 chars, and does NOT start with `# Jane Smith` or `# Your Name`** → use it. Read into memory and continue to Step 2.
- **Exists but is template / too short** → tell user: "Found `cv.md` but it looks like the template / unfilled. I'll prompt you for content next."
- **Missing** → prompt user.

### Prompt path

Tell the user:

> "I'll build `cv.md` by collecting six sections. You can paste a complete CV in one message and say 'use this' — I'll parse it. Otherwise I'll ask for each section in turn:
>
> 1. **Professional Summary** (3-5 sentences — your headline)
> 2. **Core Competencies** (skills bullet list)
> 3. **Areas of Expertise** (domains, technologies, methodologies)
> 4. **Notable Accomplishments** (proof points with hero metrics)
> 5. **Education and Certifications**
> 6. **Experience** (roles, companies, dates, accomplishments per role)
>
> Which mode do you prefer — 'one paste' or 'one section at a time'?"

If "one paste": user pastes full CV. Identify the six sections heuristically (case-insensitive heading match). If any section is missing, ask only for the missing ones.

If "one section at a time": prompt for each in order. Each response can be free-form text or markdown.

### Assemble `cv.md`

Use this template (matching the shape of `cv.example.md`):

```markdown
# {Full Name}

**Email:** {email} · **Location:** {location}
**LinkedIn:** {linkedin} · **GitHub:** {github}
**Portfolio:** {portfolio_url}

---

## Summary

{Professional Summary content}

---

## Core Competencies

{Core Competencies content as bullet list}

---

## Areas of Expertise

{Areas of Expertise content}

---

## Notable Accomplishments

{Notable Accomplishments content}

---

## Experience

{Experience content — preserve user's structure}

---

## Education

{Education and Certifications content}
```

If contact info (email/LinkedIn/GitHub/portfolio/location) wasn't in the user's paste, ask: "What's your name, email, location? (LinkedIn / GitHub / portfolio optional.)"

Show the assembled draft and ask: "Save this to `cv.md`? [y/n/edit]". On `y`, write file. On `edit`, accept inline edits and re-show. On `n`, abort and tell user to manually create `cv.md`.

---

## Step 2 — Confirm Node + dependencies

Run:

```
Bash: node --version
```

Expected: v18 or higher. If lower, tell user: "Node 18+ required — install from https://nodejs.org and re-run."

Check for `node_modules/`:

```
Bash: ls -d node_modules 2>/dev/null || echo MISSING
```

If `MISSING`, run:

```
Bash: npm install
```

Note Playwright is optional (only needed for L1 SPA scanning). Tell user: "If you want L1 Playwright scanning, run `npx playwright install chromium` separately. Skip this if you're only using L2 (ATS APIs) and L3 (WebSearch)."

---

## Step 3 — Generate `profile.yml`

Read `cv.md`. If `profile.yml` already exists, read it too — we'll diff at the end.

Issue ONE LLM reasoning pass that produces a YAML draft populating these fields. Use this prompt structure:

```
You are filling out a JobScan profile.yml from this CV. Output ONLY the YAML
content — no prose, no fences. Use the exact structure of profile.example.yml.

CV:
{cv.md content}

Required fields to populate:
  candidate.full_name           — from H1 heading or first line
  candidate.email               — from header lines (look for @)
  candidate.location            — from header lines
  candidate.linkedin            — from header lines (linkedin.com/in/...)
  candidate.github              — from header lines (github.com/...) — optional
  candidate.portfolio_url       — from header lines (https://...) — optional
  target_roles.primary          — 3-5 titles inferred from latest/most senior roles
  target_roles.secondary        — 2-3 adjacent titles inferred from skills
  target_archetypes             — 1-3 from this enum: fde, solution-architect, product-manager, llmops, agentic, transformation, backend, frontend, data, devops, it-director, program-manager
  narrative.headline            — one-line synthesis of CV summary
  narrative.superpowers         — 3-5 strongest themes/skills
  narrative.proof_points        — list of {name, hero_metric} from most-impressive accomplishments
  scoring.candidate_digest      — 3-5 sentence "who I am" paragraph for scoring context

Leave these as empty defaults from profile.example.yml:
  deal_breakers (locations, stacks, company_types — empty lists)
  compensation (target_range, currency, minimum_acceptable — empty strings)

Carry over these defaults from profile.example.yml unchanged:
  scoring.score_threshold_high: 4.0
  scoring.score_threshold_medium: 3.0
  scoring.score_cap: 50
  scoring.score_batch_size: 5
  scoring.jd_snippet_chars: 1000
```

Show the draft to the user. Ask:

> "Here's the proposed `profile.yml`. Want any changes? You can:
>  - say 'looks good' → I write it
>  - say 'change X to Y' → I'll edit and re-show
>  - paste a corrected YAML block → I'll use yours verbatim"

If `profile.yml` already exists, show a unified diff (`diff -u existing draft`) instead of the raw draft, and ask per top-level key (`candidate`, `target_roles`, `target_archetypes`, `narrative`, `scoring`): "Update? [y/n/skip]". Apply only approved sections.

On approval, write `profile.yml`.

---

## Step 4 — Generate `portals.yml`

Auto-derive these fields from the CV without asking the user:

| Field | Derivation |
|-------|------------|
| `title_filter.positive` | Skill keywords + role keywords from CV (e.g., latest titles + `## Skills` items + recurring nouns from accomplishments). 8-15 entries. |
| `title_filter.negative` | Carry over from `portals.example.yml` defaults: Intern, Junior, Contract, Temporary, .NET, Java, PHP, Android, iOS, Embedded, Firmware, Blockchain, Web3, Salesforce Admin |
| `title_filter.seniority_boost` | From CV's most senior titles. Common values: Staff, Principal, Lead, Director, Head of, VP |
| `location_filter.positive` | `["Remote"]` plus the country/region inferred from `candidate.location` (e.g., "United States" / "US" if location is a US city) |
| `location_filter.negative` | `[]` |
| `search_queries` | 2-3 ATS-scoped queries seeded with top role keywords, e.g., `site:jobs.ashbyhq.com "<top role>"` |

Then ask the user inline:

> "Which companies do you want to track? Paste names + careers URLs.
>
> Format options (any work):
>   - One per line: `Anthropic https://anthropic.com/jobs`
>   - Comma-separated: `Anthropic, https://anthropic.com/jobs; OpenAI, https://openai.com/careers`
>   - Just URLs (one per line): I'll fetch the company name from the URL host or page title.
>
> Or type 'skip' to use the example's 10-company starter list (you can edit later).
> Or type 'none' to leave `tracked_companies` empty (you'll add via portals.yml directly)."

### Per-URL ATS classification

For each provided URL, match against these patterns (case-insensitive, in order — first match wins):

| Pattern | ATS | Action |
|---------|-----|--------|
| `boards.greenhouse.io/<co>` or `job-boards.greenhouse.io/<co>` | Greenhouse | L2 (no extra config) |
| `jobs.ashbyhq.com/<co>` | Ashby | L2 (no extra config) |
| `jobs.lever.co/<co>` | Lever | L2 (no extra config) |
| `*.wd{N}.myworkdayjobs.com/...` (any subdomain matching `wd1`/`wd2`/`wd3`/`wd5`/`wd103`/...) | Workday | L2 (no extra config) |
| anything else | unknown | L1 — write `scan_method: playwright` with TODO selectors |

For **L2 matches**, write the entry as:

```yaml
- name: "{company name}"
  careers_url: "{url}"
  enabled: true
```

For **L1 (no L2 match)**, write the entry as:

```yaml
- name: "{company name}"
  careers_url: "{url}"
  enabled: true
  scan_method: playwright
  # TODO: tune these selectors by inspecting the careers page in DevTools
  # spa:
  #   wait_selector: "<CSS selector that exists once jobs render>"
  #   job_card_selector: "<repeating job card element>"
  #   title_selector: "<within a card, title element>"
  #   url_selector: "<within a card, anchor whose href is the job URL>"
  #   location_selector: "<within a card, location element — optional>"
```

### Skip / none paths

- `skip` → leave `tracked_companies` as the 10-company example list. Add a banner comment at top of `tracked_companies`:
  ```yaml
  # ── Tracked companies ─────────────────────────────────────────────────
  # NOTE: These are illustrative examples carried over from portals.example.yml.
  #       Replace with the companies you actually want to track.
  ```
- `none` → write `tracked_companies: []`

### Assemble and write

Build the full `portals.yml` matching the structure of `portals.example.yml`. Show the draft (or a per-section diff if `portals.yml` already exists) and ask: "Looks good? [y/n/edit]". On `y`, write file.

After writing, print summary:

```
Wrote portals.yml.
  L2 companies (auto-handled): {N_l2}    — [list names]
  L1 companies (need tuning):  {N_l1}    — [list names]
  search_queries:              {N_q}
  title_filter.positive:       {N_pos} keywords
```

If any L1 companies, also print:

```
Tuning required for {N_l1} L1 companies — see README §"Tuning L1 companies"
for how to find spa: selectors using DevTools.
```

---

## Step 5 — Initialize `data/scan-history.tsv`

```
Bash: mkdir -p data
```

Check if `data/scan-history.tsv` exists:

```
Bash: ls data/scan-history.tsv 2>/dev/null || echo MISSING
```

If `MISSING`, write the header:

```
Bash: printf "url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscore\trationale\n" > data/scan-history.tsv
```

If it already exists, leave it alone — it contains the user's prior scan state.

---

## Step 6 — Run doctor and finish

Run:

```
Bash: node doctor.mjs
```

If exit code 0 (all pass or warnings only), continue.
If exit code 1 (failures), surface the failures to the user verbatim and stop. Do not proceed to the success message — the user needs to fix something.

On success, print:

```
Bootstrap complete.

Next steps:
  /jobscan          — run your first scan
  /jobscan discover — discovery only (no scoring)
  /jobscan score    — score whatever's queued

Re-run /jobscan-bootstrap after editing cv.md to refresh derived fields
in profile.yml and portals.yml. The skill will diff and ask before
overwriting anything.
```

---

## Re-run safety summary

| File | First run | Re-run behavior |
|------|-----------|-----------------|
| `cv.md` | Created from prompt | If exists and non-template, used as-is; user is asked before re-prompting |
| `profile.yml` | Generated and written | Per-section diff with existing; user approves each section |
| `portals.yml` | Generated and written | Per-section diff with existing; user approves each section |
| `data/scan-history.tsv` | Created with header | Left untouched (contains user's scan state) |

The skill never silently overwrites a user-owned file.
