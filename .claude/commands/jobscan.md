---
description: Scan job portals and rank listings by CV relevancy
---

# /jobscan

Invoke the `jobscan` skill.

**Arguments:**
- (none) → full pipeline: discover → filter → dedup → score → write output
- `discover` → discovery + filter only, no scoring
- `score` → score whatever is in `data/jobscan-new.tsv` and write output

Read `.claude/skills/jobscan/SKILL.md` and execute the instructions matching
the argument. If no argument is passed, run the full pipeline.

Pass `{{args}}` to the skill as the mode selector.
