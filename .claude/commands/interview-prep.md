---
description: Generate an interview prep report (pitch, JD→CV mapping, 30-60-90, panel map, questions, comp prep) for a specific company and round
---

# /interview-prep

Invoke the `interview-prep` skill.

**Arguments:** `{company-slug} [round-N]`

- `company-slug` — required. Lowercase, hyphenated. Examples: `acme-corp`, `jpmorgan-chase`.
- `round-N` — optional. Defaults to `round-1`. Higher rounds change the question
  mix (deeper technical, panel/skip-level emphasis, exec strategy).

Examples:
- `/interview-prep acme-corp`
- `/interview-prep acme-corp round-2`
- `/interview-prep jpmorgan-chase round-3`

Inputs:
- `cv.md`
- `profile.yml`
- `job-description-{company}.md` (in repo root or `interview/`)

Output:
- `interview/interview-prep-{company}.md` (round 1)
- `interview/interview-prep-{company}-round-{N}.md` (round ≥ 2)
- `interview/story-bank.md` (shared, regenerated when `cv.md` changes)

Read `.claude/skills/interview-prep/SKILL.md` and execute the instructions.
Pass `{{args}}` through. If no slug is provided, ask the user for one and stop.
