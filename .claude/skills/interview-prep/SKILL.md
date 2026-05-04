---
name: interview-prep
description: Read cv.md, profile.yml, and a per-company JD file, then produce an interview prep report covering pitch, JD→CV mapping, 30-60-90 plan, panel map, technical / behavioral / role-specific / red-flag questions, and compensation prep. Maintains a reusable story bank derived from cv.md. Output saved to interview/interview-prep-{company}[-round-N].md.
---

# interview-prep — CV × JD interview question generator

**Argument:** `{{args}}` is whitespace-separated.

| Token | Meaning | Default |
|-------|---------|---------|
| `tokens[0]` | Company slug (lowercase, hyphenated). Example: `acme-corp`, `jpmorgan-chase`. | required |
| `round-N` (anywhere after slug) | Interview round number. Changes question mix. | `round-1` |

Examples:
- `/interview-prep acme-corp` → round 1, full report
- `/interview-prep acme-corp round-2` → round 2 (deeper, panel/skip-level mix)
- `/interview-prep jpmorgan-chase round-3` → round 3 (exec / strategy mix)

Slug + round determine:
- Input JD file: `job-description-{company}.md` (looked up in repo root, then `interview/`)
- Output file: `interview/interview-prep-{company}.md` for round 1,
  `interview/interview-prep-{company}-round-{N}.md` for round ≥ 2
- Story bank (shared across all companies): `interview/story-bank.md`

If `{{args}}` is empty, ask the user for the company slug and stop.

---

## Step 0 — Prerequisite check

Verify these exist. If any is missing, stop and tell the user what's needed.

1. `cv.md` → if missing: "Need cv.md before I can map proof points to questions."
2. `profile.yml` → if missing: "Need profile.yml. Copy from profile.example.yml."
3. JD file → look in this order, use the first hit:
   - `./job-description-{company}.md`
   - `./interview/job-description-{company}.md`
   If neither exists: "Need a JD file at `interview/job-description-{company}.md`. Paste the full JD there and rerun."
4. `interview/` directory → create if missing.

---

## Step 1 — Load inputs and prep story bank

### 1a. Read inputs

- `cv.md` — full text. Extract:
  - Roles + companies + dates (build a timeline)
  - Headline metrics / proof points (with year)
  - Technical stack (languages, frameworks, platforms, methodologies)
  - Education + certifications
  - Gaps ≥ 6 months between roles
  - Unusual transitions: industry pivots, role-type pivots (IC↔manager),
    short tenures < 18 months, sabbaticals, title regressions, geographic moves,
    long single-employer tenure (>10 yrs)
- `profile.yml` — parse YAML. Pull:
  - `candidate.full_name`, `candidate.location`
  - `target_roles.primary` and `secondary`
  - `target_archetypes`
  - `narrative.headline`, `narrative.superpowers`, `narrative.proof_points`
  - `scoring.candidate_digest`
  - `compensation.target_range`, `minimum_acceptable`, `currency`
- JD file — full text. Identify:
  - Role title and seniority
  - Stated must-haves (years, certifications, specific tech, scope cues)
  - Stated nice-to-haves
  - Domain / industry context
  - Team structure cues ("reporting to", "leading X", "matrix")
  - Behavioral hooks ("comfortable with ambiguity", "stakeholder management")
  - Geographic / hybrid expectations

### 1b. Build or refresh the story bank

Path: `interview/story-bank.md`. Refresh logic:

1. If file does not exist → generate.
2. If `cv.md` mtime > `story-bank.md` mtime → regenerate.
3. Otherwise → load and reuse.

When generating, extract 6–10 strong STAR stories from `cv.md`. Bias toward
stories that are:
- Quantified (a metric in the Result)
- Recent (last 5–7 years preferred)
- Diverse in archetype: leadership, conflict, failure/recovery, cross-functional,
  technical depth, ambiguity/0-to-1, scale/scope, stakeholder management

Story bank format (overwrite the file each refresh):

```markdown
# Story Bank — {profile.candidate.full_name}

_Source: cv.md (refreshed {YYYY-MM-DD}). Reference stories by ID across all interview-prep reports._

## S1 — {short title, ≤ 8 words}
- **Archetype tags:** {leadership, conflict, …}
- **Situation:** {1 line}
- **Task:** {1 line}
- **Action:** {1–2 lines}
- **Result:** {1 line with metric} `[CV: project / year]`
- **Best for questions about:** {comma-separated themes}

## S2 — …
```

Stories are referenced from the company-specific report by ID (e.g. `[Story S3]`)
so the same proof point isn't re-derived for every company.

### 1c. Parse round number

Split `{{args}}` on whitespace. First token = `slug`. Scan remaining tokens for
`round-N` (regex `^round-\d+$`); if found, `round = N`, else `round = 1`.

---

## Step 2 — Generate the report content

The report has a fixed section order. Round number changes emphasis, not order.

### Round-by-round emphasis

| Section | Round 1 (recruiter + HM) | Round 2 (panel) | Round ≥ 3 (skip / exec) |
|---------|--------------------------|-----------------|--------------------------|
| Pitch | Full 60/90/120 versions | 60s only | 60s only |
| JD→CV Mapping | Full table | Full table | Full table |
| 30-60-90 | High-level | Detailed, w/ stakeholders | Strategy + business outcomes |
| Panel Map | Full | Full | Full |
| Technical | Foundational + 1-2 deep | Heavy system/architecture deep-dive, 1 scenario case | Lighter — strategy/portfolio level |
| Behavioral | Standard set | Cross-functional + conflict + stakeholder | Leadership scale, board/exec influence, org design |
| Role-Specific | Standard | Deeper "what would you do if…" scenarios | Strategic / industry-trend / vision |
| Red Flags | Same | Same (deeper probes possible) | Same |
| Compensation | Recruiter-screen script | Hold the line | Final-stage anchoring |
| Closing | Questions for HM | Questions for peers/team | Questions for skip/exec |

### Section content rules

#### Pitch (Tell me about yourself)
Generate 60s, 90s, and 120s versions (round 1 only — others get 60s only).
Each is plain prose, derived from `narrative.headline` + the top 3 proof points
that map to JD must-haves. Word counts: 60s ≈ 150 words, 90s ≈ 220, 120s ≈ 290.
End each version with a one-sentence bridge to "and that's why I'm interested
in {Company}'s {role} role."

#### JD → CV Mapping Table
One row per JD must-have (and key nice-to-haves). Three columns:
| JD Requirement | CV Evidence | Strength |
| (quote ≤ 20 words) | (project + metric + year, max 2 lines) | `Strong` / `Partial` / `Gap` |

Rules:
- Every "Strong" must cite a concrete cv.md proof point.
- "Partial" means adjacent experience — note the gap in 5–8 words.
- "Gap" rows automatically feed Section D (Red Flags). Do NOT paper over.

#### 30-60-90 Day Plan
Three-column table. Anchored to JD priorities + a Listen / Learn / Deliver arc.

| Days 1–30 (Listen) | Days 31–60 (Learn) | Days 61–90 (Deliver) |
| 4–5 bullets | 4–5 bullets | 4–5 bullets |

Each bullet should reference a JD priority where possible. Round 1: outcomes-only.
Round 2: add stakeholder names/roles ("1:1s with VP Eng, Head of Product, …").
Round ≥ 3: add measurable business outcomes (revenue, cost, timeline targets).

#### Likely Panel Map
Table of typical rounds for this seniority/archetype. Use this scaffold and
tailor to the JD's hiring style if cues are present:

| Round | Interviewer | Question types | Lean on |
|-------|-------------|----------------|---------|
| Recruiter screen | Recruiter | Background, comp, motivation | Pitch + Compensation script |
| Hiring manager | HM | Role fit, team fit, scope match | Mapping table + 30-60-90 |
| Panel | Peers / cross-func | Technical depth, collaboration | Technical + Behavioral |
| Skip-level | HM's manager | Strategic thinking, judgment | Role-Specific (strategy) |
| Exec / final | VP / C-level | Vision, leadership scale, culture | Pitch + Closing questions |

#### A. Technical Questions
5–8 questions. Each:
- **Question**
- **Source** — quoted JD or CV line, 5–15 words
- **Strong answer (highlights):** 3–6 bullets, each anchored with `[CV: project / metric / year]` or `[Story S#]`. No proof, no bullet.

#### B. Behavioral Questions
5–8 questions. Each:
- **Question**
- **Source** — JD signal or `Standard behavioral — universally asked`
- **Story to tell:** `[Story S#]` from the bank — name the story by ID and a 1-line situation reminder
- **Why this story:** 1 line — which dimension this story showcases
- **Watch-out:** 1 line — what to compress/omit so the answer fits 90s

#### C. Role-Specific Questions
5–8 questions. Each:
- **Question**
- **Why they're asking:** quoted JD requirement → what they're probing
- **Candidate's best angle:** 2–4 bullets with proof refs + **Risk to avoid:** one line

#### D. Background Red Flags
Auto-detect from cv.md + profile.yml signals AND from `Gap` rows in the
JD→CV Mapping Table. Each:
- **The flag** — one line
- **Likely question** — how they'll phrase it
- **Strong answer (highlights):** 3–4 bullets — framing, truthful narrative, **Don't say:** one line

If none → `_None detected — clean trajectory and no JD gaps._`

#### Compensation Prep
Read `compensation.target_range`, `minimum_acceptable`, `currency` from profile.yml.
If any is missing, note `_set in profile.yml to populate this section._` and skip.

Generate:
- **Anchor number:** the top of `target_range` (interviewers anchor on the first number you say)
- **Recruiter-screen script:** 2–3 sentence response to "what are you looking for?" that names the range without committing
- **Deflection (if asked too early):** 1–2 sentence script
- **Floor:** `minimum_acceptable` — internal-only reminder; never disclose
- **Total comp framing:** prompt to ask about base / bonus / equity / sign-on / refresh / benefits before agreeing to anything

Round 3+: also add a 1-line "anchoring at final stage" reminder — be specific,
cite a competing offer if real, otherwise cite market data.

#### Closing — questions YOU should ask
Two clusters:

**Smart questions (mix archetypes):**
- One on the team's biggest current challenge
- One on how success is measured in the first 6 months
- One on decision-making / stakeholder dynamics specific to this JD
- One on technical debt / state of the system to inherit
- One on growth / promotion path

**Reverse red-flag questions (probe for bad-role signals):**
- Why is this role open? (backfill vs. new headcount vs. reorg)
- What happened to the last person in this seat?
- Recent re-orgs in the last 12 months?
- How is scope shared with {adjacent role mentioned in JD}?
- What does turnover look like on this team in the last year?

5–7 from each cluster. One line each, no commentary.

---

## Step 3 — Assemble the report

Use this exact section order. Render to a single markdown file.

```markdown
# Interview Prep — {Company}{ · Round {N} if N>1}

**Candidate:** {profile.candidate.full_name}
**Role:** {role title from JD}
**Generated:** {YYYY-MM-DD}
**Sources:** cv.md · profile.yml · job-description-{company}.md · interview/story-bank.md

---

## Snapshot

- **JD must-haves:** {comma-separated, ≤ 6 items}
- **Candidate archetypes:** {profile.target_archetypes}
- **Headline framing:** {profile.narrative.headline}
- **Top 3 proof points to lean on (JD-relevant):** {3 strongest, with metrics}

---

## 1. Tell Me About Yourself

### 60-second version
{prose}

### 90-second version  _(round 1 only)_
{prose}

### 120-second version  _(round 1 only)_
{prose}

---

## 2. JD → CV Mapping

| JD Requirement | CV Evidence | Strength |
|----------------|-------------|----------|
| … | … | Strong / Partial / Gap |

_{N} Strong · {N} Partial · {N} Gap. Gaps surfaced as red flags in §7._

---

## 3. 30-60-90 Day Plan

| Days 1–30 (Listen) | Days 31–60 (Learn) | Days 61–90 (Deliver) |
|-------------------|--------------------|----------------------|
| … | … | … |

---

## 4. Likely Panel Map

| Round | Interviewer | Question types | Lean on |
|-------|-------------|----------------|---------|
| … | … | … | … |

---

## 5. Technical Questions

### T1. {question}
- **Source:** "{quoted}"
- **Strong answer (highlights):**
  - … `[CV: …]` or `[Story S#]`

…

---

## 6. Behavioral Questions

### B1. {question}
- **Source:** {…}
- **Story to tell:** [Story S#] — {1-line situation}
- **Why this story:** {1 line}
- **Watch-out:** {1 line}

…

---

## 7. Role-Specific Questions

### R1. {question}
- **Why they're asking:** "{quoted JD line}" → {probe}
- **Candidate's best angle:**
  - … `[CV: …]`
  - **Risk to avoid:** {1 line}

…

---

## 8. Background Red Flags

### F1. {flag}
- **Likely question:** "{phrasing}"
- **Strong answer (highlights):**
  - {framing}
  - {truthful narrative}
  - **Don't say:** {1 line}

…  _or_  `_None detected — clean trajectory and no JD gaps._`

---

## 9. Compensation Prep

- **Anchor:** {top of target_range}
- **Recruiter-screen script:** "{script}"
- **Deflection (early-stage):** "{script}"
- **Floor (internal):** {minimum_acceptable}
- **Total comp framing:** {1–2 lines}

---

## 10. Questions YOU Should Ask

**Smart questions:**
- …

**Reverse red-flag questions:**
- …
```

---

## Step 4 — Write files

1. Ensure `interview/` exists.
2. If story bank was (re)generated, write `interview/story-bank.md`.
3. Write the assembled report to:
   - `interview/interview-prep-{company}.md` (round 1)
   - `interview/interview-prep-{company}-round-{N}.md` (round ≥ 2)
4. If the output file already exists, ask before overwriting:
   "`{path}` already exists. Overwrite, or save as `{path-stem}-{YYYY-MM-DD}.md`?"
5. Render the HTML companion automatically:

   ```
   Bash: node interview-prep-html.mjs <path-to-md>
   ```

   This invokes `interview-prep-html.mjs` (in repo root). It parses the
   just-written markdown and writes a styled, print-friendly HTML view to
   the matching `.html` path next to the `.md`. The HTML is a derivative —
   the markdown remains the source of truth.

   If the command exits non-zero (e.g., parser hits an unexpected section),
   log the error and continue. The markdown is already on disk and is the
   primary artifact.

---

## Step 5 — Post-run summary

Print a compact summary. Example:

```
Interview prep ready — Acme Corp · round 2
━━━━━━━━━━━━━━━━━━━━━━━━━━━━
Pitch:           60s only (round 2)
JD→CV mapping:   8 reqs — 5 Strong · 2 Partial · 1 Gap
30-60-90 plan:   detailed (stakeholders included)
Panel map:       5 rounds
Technical:       7 questions
Behavioral:      6 questions (linked to story bank)
Role-specific:   6 questions
Red flags:       2 flags (1 from JD-gap, 1 from CV transition)
Compensation:    populated from profile.yml
Story bank:      reused (cv.md unchanged since 2026-04-15)
Output (md):     interview/interview-prep-acme-corp-round-2.md
Output (html):   interview/interview-prep-acme-corp-round-2.html
```

Do NOT dump the report into the conversation. The file is the artifact.

---

## Quality bar

- Every Strong-Answer bullet that claims experience MUST cite a `[CV: …]`
  proof point or `[Story S#]`. No proof → drop the bullet, do not fabricate.
- Every JD must-have must appear as a row in the Mapping Table — no skipping
  the awkward ones.
- Mapping Table `Gap` rows MUST appear as a Red Flag in §8 with a prepared
  answer. Don't quietly hide them.
- Compensation section is silent if `profile.yml` lacks the data — never invent
  numbers.
- Story bank is the canonical source for behavioral stories — Section 6 should
  reference IDs, not re-narrate stories inline.
- Stay terse. Bullets, not paragraphs. Candidate reads this minutes before
  walking in.

## Error handling

- JD file not found → stop, instruct user where to put it.
- cv.md or profile.yml missing → stop, instruct user.
- YAML parse error in profile.yml → stop, surface the line number.
- Story bank generation fails → continue, write report inline-narrated, and warn user.
- Output directory write fails → stop, surface the OS error.
