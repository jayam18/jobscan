---
description: One-shot setup — infer profile.yml and portals.yml from your CV
---

# /jobscan-bootstrap

Invoke the `jobscan-bootstrap` skill to set up this repo for first use.

**What it does:**
- Acquires your CV (`cv.md`) — uses an existing one if present, else prompts you to paste sections.
- Generates `profile.yml` from your CV (full name, contact info, target roles, archetypes, candidate digest, narrative).
- Generates `portals.yml` from your CV + an inline list of companies you paste in. Auto-detects ATS (Greenhouse / Ashby / Lever / Workday) from each careers URL; stubs Playwright entries with TODO selectors for the rest.
- Initializes `data/scan-history.tsv`.
- Runs `node doctor.mjs` to verify setup.

**Re-run safe:** if `profile.yml` / `portals.yml` already exist, the skill diffs the new draft against the existing file and asks before overwriting.

**Arguments:** none.

Read `.claude/skills/jobscan-bootstrap/SKILL.md` and execute the steps in order.
