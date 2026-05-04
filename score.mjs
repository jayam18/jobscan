#!/usr/bin/env node
// score.mjs — Title classification + LLM scoring + output generation

import fs from 'fs';
import yaml from 'js-yaml';
import { Anthropic } from '@anthropic-ai/sdk';

// Load config
const profile = yaml.load(fs.readFileSync('profile.yml', 'utf-8'));
const cv = fs.readFileSync('cv.md', 'utf-8');

const candidate = profile.scoring.candidate_digest;
const targetArchetypes = profile.target_archetypes || [];
const dealBreakers = profile.deal_breakers || {};
const scoreThresholds = {
  high: profile.scoring.score_threshold_high || 4.0,
  medium: profile.scoring.score_threshold_medium || 3.0,
};
const scoreCap = profile.scoring.score_cap || 50;
const batchSize = profile.scoring.score_batch_size || 5;

const client = new Anthropic();

// Parse TSV
function readTsv(path) {
  const lines = fs.readFileSync(path, 'utf-8').split('\n').filter(l => l.trim());
  if (lines.length < 2) return [];
  const header = lines[0].split('\t');
  return lines.slice(1).map(line => {
    const parts = line.split('\t');
    return {
      url: parts[0] || '',
      title: parts[1] || '',
      company: parts[2] || '',
      location: parts[3] || '',
      source: parts[4] || '',
      jd_snippet: parts[5] || '',
      cls: parts[6] || '',
      cls_note: parts[7] || '',
    };
  });
}

// Write TSV
function writeTsv(path, rows) {
  const header = ['url', 'title', 'company', 'location', 'source', 'jd_snippet', 'cls', 'cls_note'];
  const lines = [header.join('\t')];
  for (const row of rows) {
    const values = [
      row.url || '',
      row.title || '',
      row.company || '',
      row.location || '',
      row.source || '',
      row.jd_snippet || '',
      row.cls || '',
      row.cls_note || '',
    ];
    lines.push(values.join('\t'));
  }
  fs.writeFileSync(path, lines.join('\n') + '\n');
}

// Classify titles
async function classifyTitles(candidates) {
  const unclassified = candidates.filter(c => !c.cls);
  if (unclassified.length === 0) {
    console.log('All candidates already classified.');
    return candidates;
  }

  console.log(`Classifying ${unclassified.length} titles...`);

  const batches = [];
  for (let i = 0; i < unclassified.length; i += 30) {
    batches.push(unclassified.slice(i, i + 30));
  }

  const results = [...candidates];
  for (const batch of batches) {
    const prompt = `Classify each job title for fit with the following candidate and target roles.
Output strict JSON only — no prose, no markdown code fences.

CANDIDATE DIGEST:
${candidate}

TARGET ARCHETYPES (strong fit targets):
${targetArchetypes.join('\n')}

CLASSIFICATION RUBRIC:
- "strong"     — Title clearly matches an IT Director / VP of IT / Digital Transformation / Senior Manager IT level role. Seniority AND domain both align.
- "plausible"  — Seniority word present but domain is adjacent (e.g. program/projects related, program management). Worth a human skim, but do not spend scoring tokens.
- "skip"       — Wrong domain entirely (frontend engineering, sales, audit, operations) OR below-target seniority.

TITLES:
${batch.map((c, i) => `[${i + 1}] "${c.title}" @ ${c.company} — ${c.location}`).join('\n')}

Output:
[
  {"i": 1, "cls": "strong",    "why": "≤8 words"},
  {"i": 2, "cls": "skip",      "why": "..."},
  ...
]`;

    let response;
    try {
      const msg = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 1024,
        messages: [{ role: 'user', content: prompt }],
      });
      response = msg.content[0].type === 'text' ? msg.content[0].text : '';
    } catch (e) {
      console.error('Classification LLM error:', e.message);
      return candidates; // Fallback: don't classify
    }

    let classified;
    try {
      classified = JSON.parse(response);
    } catch {
      console.warn('Classification JSON parse failed, retrying...');
      try {
        const cleanResponse = response.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
        classified = JSON.parse(cleanResponse);
      } catch {
        console.warn('Second parse failed, marking batch as plausible');
        batch.forEach(c => {
          const idx = results.findIndex(r => r.url === c.url);
          if (idx >= 0) {
            results[idx].cls = 'plausible';
            results[idx].cls_note = 'classifier parse error';
          }
        });
        continue;
      }
    }

    for (const item of classified) {
      const candidate = batch[item.i - 1];
      const idx = results.findIndex(r => r.url === candidate.url);
      if (idx >= 0) {
        results[idx].cls = item.cls || 'plausible';
        results[idx].cls_note = (item.why || '').substring(0, 80);
      }
    }
  }

  return results;
}

// Score candidates
async function scoreCandidates(candidates) {
  const strong = candidates.filter(c => c.cls === 'strong');
  if (strong.length === 0) {
    console.log('No strong candidates to score.');
    return candidates;
  }

  const toScore = strong.slice(0, scoreCap);
  console.log(`Scoring ${toScore.length} strong candidates...`);

  const batches = [];
  for (let i = 0; i < toScore.length; i += batchSize) {
    batches.push(toScore.slice(i, i + batchSize));
  }

  const results = [...candidates];
  for (const batch of batches) {
    const offers = batch.map((c, i) => ({
      i: i + 1,
      title: c.title,
      company: c.company,
      location: c.location,
      jd_snippet: c.jd_snippet || '(No snippet)',
    }));

    const prompt = `You are scoring job listings for CV×JD fit.

CANDIDATE DIGEST:
${candidate}

TARGET ARCHETYPES: ${targetArchetypes.join(', ')}
DEAL-BREAKERS (cap score at 2.0 if triggered):
  locations: ${dealBreakers.locations?.join(', ') || 'none'}
  stacks: ${dealBreakers.stacks?.join(', ') || 'none'}

RUBRIC (one decimal, 1.0–5.0):
  5.0  Perfect — title, seniority, archetype all match
  4.0  Strong — archetype match, seniority close, 1-2 mitigable gaps
  3.0  Plausible — adjacent archetype or level mismatch
  2.0  Weak — significant gaps
  1.0  No fit — fundamentally wrong role/level/domain

OFFERS:
${offers.map(o => `[${o.i}] title: "${o.title}" | company: "${o.company}" | location: "${o.location}" | jd: "${o.jd_snippet.substring(0, 200)}..."`).join('\n')}

Output RAW JSON ONLY. No markdown, no prose. First char `[`, last char `]`:
[
  {"i": 1, "score": 4.2, "match": "one sentence", "gap": "one sentence"},
  ...
]`;

    let response;
    try {
      const msg = await client.messages.create({
        model: 'claude-opus-4-7',
        max_tokens: 2048,
        messages: [{ role: 'user', content: prompt }],
      });
      response = msg.content[0].type === 'text' ? msg.content[0].text : '';
    } catch (e) {
      console.error('Scoring LLM error:', e.message);
      batch.forEach(c => {
        const idx = results.findIndex(r => r.url === c.url);
        if (idx >= 0) {
          results[idx].score = null;
          results[idx].rationale = 'scoring error';
        }
      });
      continue;
    }

    let scored;
    try {
      scored = JSON.parse(response);
    } catch {
      const cleanResponse = response.replace(/^```json?\n?/, '').replace(/\n?```$/, '').trim();
      try {
        scored = JSON.parse(cleanResponse);
      } catch {
        console.warn('Scoring JSON parse failed for batch');
        batch.forEach(c => {
          const idx = results.findIndex(r => r.url === c.url);
          if (idx >= 0) {
            results[idx].score = null;
            results[idx].rationale = 'scoring parse error';
          }
        });
        continue;
      }
    }

    for (const item of scored) {
      const candidate = batch[item.i - 1];
      const idx = results.findIndex(r => r.url === candidate.url);
      if (idx >= 0) {
        results[idx].score = item.score || null;
        results[idx].match = item.match || '';
        results[idx].gap = item.gap || '';
        results[idx].rationale = `Match: ${item.match}. Gap: ${item.gap}.`;
      }
    }
  }

  return results;
}

// Generate output
function generateOutput(candidates) {
  const scored = candidates.filter(c => typeof c.score === 'number');
  const plausible = candidates.filter(c => c.cls === 'plausible');

  const high = scored.filter(c => c.score >= scoreThresholds.high).sort((a, b) => b.score - a.score);
  const medium = scored.filter(c => c.score >= scoreThresholds.medium && c.score < scoreThresholds.high).sort((a, b) => b.score - a.score);
  const low = scored.filter(c => c.score < scoreThresholds.medium).sort((a, b) => b.score - a.score);

  const now = new Date().toISOString().split('T')[0];
  const summary = `## ${now} — ${candidates.length} scanned, ${candidates.length} classified, ${scored.length} scored

### High Fit (≥${scoreThresholds.high})

${
  high.length > 0
    ? `| Company | Role | URL | Location | Score |
|---------|------|-----|----------|-------|
${high.map(c => `| ${c.company} | ${c.title} | ${c.url} | ${c.location || '—'} | ${c.score} |`).join('\n')}`
    : '_None this scan._'
}

_Rationales (High Fit only):_
${high.map(c => `- **${c.company} / ${c.title}** — ${c.rationale}`).join('\n')}

### Medium Fit (${scoreThresholds.medium}–${scoreThresholds.high - 0.1})

${
  medium.length > 0
    ? `| Company | Role | URL | Location | Score |
|---------|------|-----|----------|-------|
${medium.map(c => `| ${c.company} | ${c.title} | ${c.url} | ${c.location || '—'} | ${c.score} |`).join('\n')}`
    : '_None this scan._'
}

### Low Fit (<${scoreThresholds.medium})

${
  low.length === 0 && plausible.length === 0
    ? '_None this scan._'
    : `<details>
<summary>${low.length} scored + ${plausible.length} plausible (collapsed)</summary>

**Scored (<${scoreThresholds.medium}):**

${
  low.length > 0
    ? `| Company | Role | URL | Location | Score |
|---------|------|-----|----------|-------|
${low.map(c => `| ${c.company} | ${c.title} | ${c.url} | ${c.location || '—'} | ${c.score} |`).join('\n')}`
    : '_None._'
}

**Plausible (unscored):**

${
  plausible.length > 0
    ? `| Company | Role | URL | Location |
|---------|------|-----|----------|
${plausible.map(c => `| ${c.company} | ${c.title} | ${c.url} | ${c.location || '—'} |`).join('\n')}`
    : '_None._'
}

</details>`
}`;

  return summary;
}

// Main
async function main() {
  let candidates = readTsv('data/jobscan-new.tsv');
  console.log(`Loaded ${candidates.length} candidates from jobscan-new.tsv`);

  candidates = await classifyTitles(candidates);
  writeTsv('data/jobscan-new.tsv', candidates);

  candidates = await scoreCandidates(candidates);
  writeTsv('data/jobscan-new.tsv', candidates);

  const output = generateOutput(candidates);
  const fullOutput = `# JobScan Results

Job listings ranked by CV×JD fit. High Fit (≥4.0) gets rationale; Medium and Low Fit collapsed for scanning.

---

${output}`;

  if (!fs.existsSync('data/jobscan-out.md')) {
    fs.writeFileSync('data/jobscan-out.md', fullOutput);
  } else {
    const existing = fs.readFileSync('data/jobscan-out.md', 'utf-8');
    const parts = existing.split('\n---\n');
    const newContent = parts[0] + '\n---\n' + output;
    fs.writeFileSync('data/jobscan-out.md', newContent);
  }

  console.log('✓ Output written to data/jobscan-out.md');
}

main().catch(console.error);
