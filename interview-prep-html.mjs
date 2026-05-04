#!/usr/bin/env node
// interview-prep-html.mjs
//
// Render interview/interview-prep-{company}[-round-N].md as a self-contained
// classy HTML page, with the same visual style as the original static design.
//
// Usage:
//   node interview-prep-html.mjs <path-to-md>
//
// Output: same path with .md → .html

import fs from 'node:fs';
import path from 'node:path';

// ────────────────────────────────────────────────────────────────────────────
// CLI
// ────────────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error('Usage: node interview-prep-html.mjs <path-to-md>');
  process.exit(1);
}
const mdPath = args[0];
if (!fs.existsSync(mdPath)) {
  console.error(`File not found: ${mdPath}`);
  process.exit(1);
}
if (!mdPath.endsWith('.md')) {
  console.error('Expected a .md file path.');
  process.exit(1);
}

const md = fs.readFileSync(mdPath, 'utf8');
const htmlPath = mdPath.replace(/\.md$/, '.html');

// ────────────────────────────────────────────────────────────────────────────
// Inline transforms
// ────────────────────────────────────────────────────────────────────────────

const escapeHtml = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

// Convert inline markdown: chips first, then code, bold, italic.
function inline(s) {
  if (s == null) return '';
  let out = escapeHtml(s);
  // `[CV: ...]` chips
  out = out.replace(/`\[CV:\s*([^\]]+)\]`/g, (_m, p) => `<span class="chip cv">CV: ${p.trim()}</span>`);
  // `[Story S#]` chips (S# may be followed by extra text inside brackets)
  out = out.replace(/`\[Story\s+(S\d+)(?:[^\]]*)?\]`/g, (_m, p) => `<span class="chip story">Story ${p}</span>`);
  // Plain backticks
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  // Bold
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic with underscores (avoid mid-word)
  out = out.replace(/(^|[\s(\[>])_([^_\n]+)_(?=[\s).,;:!?\]<]|$)/g, '$1<em>$2</em>');
  return out;
}

// Wrap each filename in <code> for the Sources line.
function renderSources(s) {
  return s
    .split(/\s*·\s*/)
    .map((t) => `<code>${escapeHtml(t.trim())}</code>`)
    .join(' · ');
}

// ────────────────────────────────────────────────────────────────────────────
// Parsing
// ────────────────────────────────────────────────────────────────────────────

function parseDoc(text) {
  const titleMatch = text.match(/^# Interview Prep — (.+?)$/m);
  const titleLine = titleMatch ? titleMatch[1].trim() : '';
  let company = titleLine;
  let roundLabel = '';
  const roundMatch = titleLine.match(/^(.+?)\s*·\s*Round\s+(\d+)\s*$/);
  if (roundMatch) {
    company = roundMatch[1].trim();
    roundLabel = `Round ${roundMatch[2]}`;
  } else {
    roundLabel = 'Round 1';
  }

  const grab = (key) => {
    const m = text.match(new RegExp(`^\\*\\*${key}:\\*\\*\\s*(.+)$`, 'm'));
    return m ? m[1].trim() : '';
  };
  const candidate = grab('Candidate');
  const role = grab('Role');
  const generated = grab('Generated');
  const sources = grab('Sources');

  // Split into ## sections
  const sectionBlocks = text.split(/^## /m).slice(1);
  const sections = sectionBlocks.map((block) => {
    const nl = block.indexOf('\n');
    const heading = block.slice(0, nl).trim();
    const body = block.slice(nl + 1).replace(/\n*---\n*/g, '\n').trim();
    return { heading, body };
  });

  return { company, roundLabel, candidate, role, generated, sources, sections };
}

// Parse a markdown table into { headers, rows }.
function parseTable(body) {
  const lines = body.trim().split('\n').filter((l) => l.trim().startsWith('|'));
  if (lines.length < 2) return { headers: [], rows: [] };
  const splitRow = (l) =>
    l
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
  const headers = splitRow(lines[0]);
  const rows = lines.slice(2).map(splitRow);
  return { headers, rows };
}

// Parse a list of `### {ID}{num}. {question}` blocks.
function parseQuestionBlocks(body, idPrefix) {
  const re = new RegExp(`^### (${idPrefix}\\d+)\\.\\s+(.+)$`, 'gm');
  const out = [];
  const matches = [...body.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    out.push({
      id: m[1],
      question: m[2].trim(),
      block: body.slice(start, end).trim(),
    });
  }
  return out;
}

// Pull a `- **Label:** rest...` line out of a block; returns the value or ''.
function pullField(block, label) {
  const re = new RegExp(`^- \\*\\*${label}:\\*\\*\\s*(.+(?:\\n  .+)*)`, 'm');
  const m = block.match(re);
  return m ? m[1].replace(/\n  /g, ' ').trim() : '';
}

// Pull all sub-bullets that follow a `- **Label:**` line.
function pullSubBullets(block, label) {
  const lines = block.split('\n');
  let started = false;
  const bullets = [];
  for (const line of lines) {
    if (!started) {
      if (new RegExp(`^- \\*\\*${label}:\\*\\*`).test(line)) started = true;
      continue;
    }
    if (/^- \*\*[^*]+:\*\*/.test(line)) break; // next label
    if (/^\s{2,}- /.test(line)) {
      bullets.push(line.replace(/^\s{2,}- /, '').trim());
    } else if (/^- /.test(line) && !/^- \*\*/.test(line)) {
      // bare sibling bullet, treat as same level
      bullets.push(line.replace(/^- /, '').trim());
    }
  }
  return bullets;
}

// ────────────────────────────────────────────────────────────────────────────
// Section renderers
// ────────────────────────────────────────────────────────────────────────────

function renderSnapshot(body) {
  // Top-level bullets: - **Label:** content (possibly with numbered sub-list)
  const items = [];
  const lines = body.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const m = line.match(/^- \*\*([^*]+):\*\*\s*(.*)$/);
    if (!m) { i++; continue; }
    const label = m[1].trim();
    let content = m[2].trim();
    const subBullets = [];
    let j = i + 1;
    while (j < lines.length && /^\s{2,}\d+\.\s+/.test(lines[j])) {
      subBullets.push(lines[j].replace(/^\s{2,}\d+\.\s+/, '').trim());
      j++;
    }
    items.push({ label, content, subBullets });
    i = j;
  }

  return `
  <ul class="snapshot">
${items.map((it) => `    <li>
      <div class="label">${escapeHtml(it.label)}</div>
${it.subBullets.length
        ? `      <ol>
${it.subBullets.map((b) => `        <li>${inline(b)}</li>`).join('\n')}
      </ol>`
        : `      ${inline(it.content)}`}
    </li>`).join('\n')}
  </ul>`;
}

function renderPitch(body) {
  // ### 60-second version
  // {prose}
  const blocks = [];
  const re = /^### (\d+)-second version\s*(.*)$/gm;
  const matches = [...body.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const m = matches[i];
    const start = m.index + m[0].length;
    const end = i + 1 < matches.length ? matches[i + 1].index : body.length;
    const prose = body.slice(start, end).trim();
    const seconds = m[1];
    const suffix = m[2].trim(); // e.g. "_(round 1 only)_"
    const isRound1Only = /round\s*1\s*only/i.test(suffix);
    blocks.push({ seconds, prose, isRound1Only });
  }
  return blocks
    .map(
      (b) => `
  <div class="pitch-block${b.isRound1Only ? ' long' : ''}">
    <h3><span>Pitch</span> <span class="duration">${b.seconds}-second version</span>${b.isRound1Only ? ' <span class="badge-round1">round 1 only</span>' : ''}</h3>
    <p>${inline(b.prose)}</p>
  </div>`,
    )
    .join('\n');
}

function strengthPill(text) {
  const t = text.trim().toLowerCase();
  if (t.includes('strong')) return `<span class="pill strong">Strong</span>`;
  if (t.includes('partial')) return `<span class="pill partial">Partial</span>`;
  if (t.includes('gap')) return `<span class="pill gap">Gap</span>`;
  return escapeHtml(text);
}

function renderMapping(body) {
  // Table + trailing italic summary line
  const tableEnd = body.lastIndexOf('|');
  const tablePart = body.slice(0, body.indexOf('\n', tableEnd) === -1 ? body.length : body.indexOf('\n', tableEnd) + 1);
  const { rows } = parseTable(tablePart);
  const summaryMatch = body.match(/^_(.+)_$/m);
  const summary = summaryMatch ? summaryMatch[1] : '';
  return `
  <table>
    <thead>
      <tr><th class="requirement">JD Requirement</th><th class="evidence">CV Evidence</th><th class="strength">Strength</th></tr>
    </thead>
    <tbody>
${rows.map((r) => `      <tr><td>${inline(r[0] || '')}</td><td>${inline(r[1] || '')}</td><td>${strengthPill(r[2] || '')}</td></tr>`).join('\n')}
    </tbody>
  </table>
${summary ? `  <div class="mapping-summary">${inline(summary)}</div>` : ''}`;
}

function renderPlanTable(body, klass) {
  const { headers, rows } = parseTable(body);
  return `
  <table${klass ? ` class="${klass}"` : ''}>
    <thead>
      <tr>${headers.map((h) => `<th>${inline(h)}</th>`).join('')}</tr>
    </thead>
    <tbody>
${rows.map((r) => `      <tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('\n')}
    </tbody>
  </table>`;
}

function renderTechnical(body) {
  const qs = parseQuestionBlocks(body, 'T');
  return qs
    .map((q) => {
      const source = pullField(q.block, 'Source');
      const bullets = pullSubBullets(q.block, 'Strong answer \\(highlights\\)');
      return `
  <article class="qa">
    <h3><span class="qid">${q.id}</span>${inline(q.question)}</h3>
    ${source ? `<div class="source"><span class="label">Source</span>${inline(source)}</div>` : ''}
    <div class="answer-label">Strong answer · highlights</div>
    <ul>
${bullets.map((b) => `      <li>${inline(b)}</li>`).join('\n')}
    </ul>
  </article>`;
    })
    .join('\n');
}

function renderBehavioral(body) {
  const qs = parseQuestionBlocks(body, 'B');
  return qs
    .map((q) => {
      const source = pullField(q.block, 'Source');
      const story = pullField(q.block, 'Story to tell');
      const why = pullField(q.block, 'Why this story');
      const watch = pullField(q.block, 'Watch-out');
      return `
  <article class="qa">
    <h3><span class="qid">${q.id}</span>${inline(q.question)}</h3>
    ${source ? `<div class="source"><span class="label">Source</span>${inline(source)}</div>` : ''}
    <dl class="meta-row">
      ${story ? `<dt>Story to tell</dt><dd>${inline(story)}</dd>` : ''}
      ${why ? `<dt>Why this story</dt><dd>${inline(why)}</dd>` : ''}
    </dl>
    ${watch ? `<div class="watch-out">${inline(watch)}</div>` : ''}
  </article>`;
    })
    .join('\n');
}

function renderRoleSpecific(body) {
  const qs = parseQuestionBlocks(body, 'R');
  return qs
    .map((q) => {
      const why = pullField(q.block, "Why they're asking");
      // Best-angle bullets (excluding Risk-to-avoid which we extract separately)
      const allBullets = pullSubBullets(q.block, "Candidate's best angle");
      const riskIdx = allBullets.findIndex((b) => /^\*\*Risk to avoid:\*\*/.test(b));
      const bullets = riskIdx >= 0 ? allBullets.slice(0, riskIdx) : allBullets;
      const risk = riskIdx >= 0
        ? allBullets[riskIdx].replace(/^\*\*Risk to avoid:\*\*\s*/, '')
        : '';
      return `
  <article class="qa">
    <h3><span class="qid">${q.id}</span>${inline(q.question)}</h3>
    ${why ? `<div class="source"><span class="label">Why asking</span>${inline(why)}</div>` : ''}
    <div class="answer-label">Candidate's best angle</div>
    <ul>
${bullets.map((b) => `      <li>${inline(b)}</li>`).join('\n')}
    </ul>
    ${risk ? `<div class="risk">${inline(risk)}</div>` : ''}
  </article>`;
    })
    .join('\n');
}

function renderRedFlags(body) {
  const qs = parseQuestionBlocks(body, 'F');
  return qs
    .map((q) => {
      const likely = pullField(q.block, 'Likely question');
      const allBullets = pullSubBullets(q.block, 'Strong answer \\(highlights\\)');
      const dontIdx = allBullets.findIndex((b) => /^\*\*Don't say:\*\*/.test(b));
      const bullets = dontIdx >= 0 ? allBullets.slice(0, dontIdx) : allBullets;
      const dontSay = dontIdx >= 0
        ? allBullets[dontIdx].replace(/^\*\*Don't say:\*\*\s*/, '')
        : '';
      return `
  <article class="flag">
    <h3><span class="qid">${q.id}</span>${inline(q.question)}</h3>
    ${likely ? `<div class="question"><span class="label">Likely question</span>${inline(likely)}</div>` : ''}
    <ul>
${bullets.map((b) => `      <li>${inline(b)}</li>`).join('\n')}
    </ul>
    ${dontSay ? `<div class="dont-say">${inline(dontSay)}</div>` : ''}
  </article>`;
    })
    .join('\n');
}

function renderCompensation(body) {
  // - **Label:** value
  const items = [];
  const re = /^- \*\*([^*]+):\*\*\s*(.+)$/gm;
  for (const m of body.matchAll(re)) {
    items.push({ label: m[1].trim(), value: m[2].trim() });
  }
  // Trailing italic note (matches `_..._` block, possibly multiline within underscores)
  const noteMatch = body.match(/^_(.+?)_\s*$/ms);
  const note = noteMatch ? noteMatch[1].trim() : '';

  const renderValue = (label, value) => {
    if (/^Anchor$/i.test(label)) {
      // Pull leading $-amount as the anchor display
      const m = value.match(/^(\$[\d.,KMm]+(?:K|M)?)\s*(.*)$/);
      if (m) {
        const tail = m[2].replace(/^[ —·-]+/, '').trim();
        return `<span class="anchor">${escapeHtml(m[1])}</span>${tail ? ` ${inline(tail)}` : ''}`;
      }
    }
    return inline(value);
  };

  const cls = (label) =>
    /script|deflection/i.test(label) ? ' class="script"' : '';

  return `
  <dl class="comp-grid">
${items.map((it) => `    <dt>${inline(it.label)}</dt>\n    <dd${cls(it.label)}>${renderValue(it.label, it.value)}</dd>`).join('\n')}
  </dl>
${note ? `  <div class="comp-note">${inline(note)}</div>` : ''}`;
}

function renderClosing(body) {
  // Two clusters: **Smart questions:** ... bullets, then **Reverse red-flag questions:** ... bullets
  const collect = (label) => {
    const re = new RegExp(`\\*\\*${label}:\\*\\*\\s*\\n([\\s\\S]+?)(?=\\n\\*\\*|$)`, 'm');
    const m = body.match(re);
    if (!m) return [];
    return m[1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.startsWith('- '))
      .map((l) => l.replace(/^- /, ''));
  };
  const smart = collect('Smart questions');
  const reverse = collect('Reverse red-flag questions');
  return `
  <div class="qask-grid">
    <div class="smart">
      <h3>Smart questions</h3>
      <ul>
${smart.map((q) => `        <li>${inline(q)}</li>`).join('\n')}
      </ul>
    </div>
    <div class="reverse">
      <h3>Reverse red-flag questions</h3>
      <ul>
${reverse.map((q) => `        <li>${inline(q)}</li>`).join('\n')}
      </ul>
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────────────────
// Section dispatch
// ────────────────────────────────────────────────────────────────────────────

const SECTION_MAP = [
  { match: /^Snapshot$/i, num: '00', anchor: 'snapshot', title: 'Snapshot', render: renderSnapshot },
  { match: /^1\.\s*Tell Me About Yourself$/i, num: '01', anchor: 'pitch', title: 'Tell Me About Yourself', render: renderPitch },
  { match: /^2\.\s*JD ?[→\-]+? ?CV Mapping$/i, num: '02', anchor: 'mapping', title: 'JD → CV Mapping', render: renderMapping },
  { match: /^3\.\s*30-?60-?90 Day Plan$/i, num: '03', anchor: 'plan', title: '30-60-90 Day Plan', render: (b) => renderPlanTable(b, 'plan') },
  { match: /^4\.\s*Likely Panel Map$/i, num: '04', anchor: 'panel', title: 'Likely Panel Map', render: (b) => renderPlanTable(b, '') },
  { match: /^5\.\s*Technical Questions$/i, num: '05', anchor: 'technical', title: 'Technical Questions', render: renderTechnical },
  { match: /^6\.\s*Behavioral Questions$/i, num: '06', anchor: 'behavioral', title: 'Behavioral Questions', render: renderBehavioral },
  { match: /^7\.\s*Role-Specific Questions$/i, num: '07', anchor: 'role', title: 'Role-Specific Questions', render: renderRoleSpecific },
  { match: /^8\.\s*Background Red Flags$/i, num: '08', anchor: 'redflags', title: 'Background Red Flags', render: renderRedFlags },
  { match: /^9\.\s*Compensation Prep$/i, num: '09', anchor: 'comp', title: 'Compensation Prep', render: renderCompensation },
  { match: /^10\.\s*Questions YOU Should Ask$/i, num: '10', anchor: 'ask', title: 'Questions YOU Should Ask', render: renderClosing },
];

// ────────────────────────────────────────────────────────────────────────────
// Stylesheet (kept verbatim from the static design)
// ────────────────────────────────────────────────────────────────────────────

const CSS = `
  :root {
    --ink:        #1a1815;
    --ink-soft:   #4a443d;
    --ink-faint:  #7a7268;
    --bg:         #faf7f1;
    --bg-soft:    #f3ede2;
    --rule:       #d9d2c2;
    --accent:     #6b1f1a;
    --accent-soft:#9a3a32;
    --gold:       #8a6f1d;
    --moss:       #4f5e44;
    --warn:       #8a3a14;
    --warn-bg:    #f7ece2;
    --good:       #3a5a3a;
    --good-bg:    #ebf0e6;
    --partial:    #806510;
    --partial-bg: #f7f0d8;
  }
  *,*::before,*::after { box-sizing: border-box; }
  html { scroll-behavior: smooth; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--ink);
    font-family: 'Iowan Old Style', 'Palatino Linotype', Palatino, Georgia, 'Times New Roman', serif;
    font-size: 17px;
    line-height: 1.55;
    -webkit-font-smoothing: antialiased;
    text-rendering: optimizeLegibility;
  }
  .page {
    max-width: 1180px;
    margin: 0 auto;
    padding: 56px 48px 96px;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 240px;
    column-gap: 56px;
  }
  main { grid-column: 1; min-width: 0; }
  aside.toc {
    grid-column: 2;
    align-self: start;
    position: sticky;
    top: 32px;
    font-size: 13px;
    line-height: 1.5;
    border-left: 1px solid var(--rule);
    padding: 4px 0 4px 20px;
  }
  aside.toc .toc-label {
    font-family: 'Inter', system-ui, -apple-system, 'Segoe UI', sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    font-size: 11px;
    color: var(--ink-faint);
    margin-bottom: 14px;
    font-weight: 600;
  }
  aside.toc ol { list-style: none; padding: 0; margin: 0; counter-reset: toc; }
  aside.toc li { counter-increment: toc; margin-bottom: 8px; }
  aside.toc a {
    color: var(--ink-soft);
    text-decoration: none;
    display: block;
    padding: 2px 0;
    border-bottom: 1px solid transparent;
    transition: color .15s, border-color .15s;
  }
  aside.toc a::before {
    content: counter(toc, decimal-leading-zero) " · ";
    color: var(--ink-faint);
    font-variant-numeric: tabular-nums;
  }
  aside.toc a:hover { color: var(--accent); border-bottom-color: var(--accent); }

  header.cover { border-top: 4px solid var(--accent); padding-top: 28px; margin-bottom: 40px; }
  header.cover .eyebrow {
    font-family: 'Inter', system-ui, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.22em;
    font-size: 11px;
    color: var(--accent);
    font-weight: 600;
    margin-bottom: 14px;
  }
  header.cover h1 {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 44px;
    font-weight: 600;
    line-height: 1.1;
    margin: 0 0 8px;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  header.cover h1 .ampersand { color: var(--accent); font-style: italic; font-weight: 400; }
  header.cover .role { font-size: 19px; color: var(--ink-soft); font-style: italic; margin: 6px 0 22px; }
  header.cover dl.meta {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 18px;
    row-gap: 4px;
    font-size: 14px;
    margin: 0;
    color: var(--ink-soft);
  }
  header.cover dl.meta dt {
    font-family: 'Inter', system-ui, sans-serif;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    font-size: 10.5px;
    color: var(--ink-faint);
    align-self: center;
    font-weight: 600;
  }
  header.cover dl.meta dd { margin: 0; }
  header.cover dl.meta dd code {
    font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
    font-size: 12.5px;
    color: var(--ink-soft);
    background: var(--bg-soft);
    padding: 1px 6px;
    border-radius: 3px;
  }

  section { margin: 48px 0; scroll-margin-top: 24px; }
  section > h2 {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.22em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 6px;
  }
  section > h2 .num { color: var(--ink-faint); font-variant-numeric: tabular-nums; margin-right: 8px; }
  section > .title {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 30px;
    font-weight: 600;
    line-height: 1.15;
    margin: 0 0 22px;
    letter-spacing: -0.005em;
    border-bottom: 1px solid var(--rule);
    padding-bottom: 14px;
  }

  ul.snapshot { list-style: none; padding: 0; margin: 0; }
  ul.snapshot > li { padding: 14px 0; border-bottom: 1px solid var(--rule); }
  ul.snapshot > li:last-child { border-bottom: 0; }
  ul.snapshot .label {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-faint);
    font-weight: 600;
    margin-bottom: 4px;
  }
  ul.snapshot ol {
    margin: 8px 0 0 0;
    padding-left: 22px;
    counter-reset: proof;
    list-style: none;
  }
  ul.snapshot ol li {
    counter-increment: proof;
    position: relative;
    padding-left: 0;
    margin-bottom: 8px;
  }
  ul.snapshot ol li::before {
    content: counter(proof);
    position: absolute;
    left: -22px;
    top: 0;
    color: var(--accent);
    font-variant-numeric: tabular-nums;
    font-weight: 600;
    font-size: 14px;
  }

  .pitch-block { margin-bottom: 28px; }
  .pitch-block h3 {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 13px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
    color: var(--accent);
    margin: 0 0 8px;
    display: flex;
    align-items: baseline;
    gap: 12px;
  }
  .pitch-block h3 .duration {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 22px;
    font-weight: 400;
    text-transform: none;
    letter-spacing: -0.01em;
    color: var(--ink);
  }
  .pitch-block h3 .badge-round1 {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 10px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--ink-faint);
    border: 1px solid var(--rule);
    padding: 2px 8px;
    border-radius: 999px;
    font-weight: 500;
  }
  .pitch-block p {
    font-size: 17.5px;
    line-height: 1.65;
    color: var(--ink);
    margin: 0;
    text-align: justify;
    hyphens: auto;
  }
  .pitch-block.long {
    border-left: 3px solid var(--bg-soft);
    padding-left: 22px;
  }

  table { border-collapse: collapse; width: 100%; font-size: 14.5px; line-height: 1.5; margin: 8px 0 14px; }
  th, td { text-align: left; padding: 12px 14px; vertical-align: top; border-bottom: 1px solid var(--rule); }
  th {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.12em;
    color: var(--ink-faint);
    font-weight: 600;
    border-bottom: 2px solid var(--ink-soft);
    background: transparent;
  }
  tbody tr:nth-child(even) { background: var(--bg-soft); }
  tbody tr:last-child td { border-bottom: 1px solid var(--ink-soft); }
  td.requirement { width: 32%; }
  td.evidence { width: 53%; }
  td.strength { width: 15%; }
  .pill {
    display: inline-block;
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    padding: 3px 10px;
    border-radius: 999px;
    line-height: 1.5;
  }
  .pill.strong  { background: var(--good-bg); color: var(--good); }
  .pill.partial { background: var(--partial-bg); color: var(--partial); }
  .pill.gap     { background: var(--warn-bg); color: var(--warn); }

  .mapping-summary {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12.5px;
    color: var(--ink-faint);
    margin-top: 14px;
    padding-top: 10px;
    border-top: 1px solid var(--rule);
    font-style: italic;
  }

  table.plan th { text-align: center; }
  table.plan td { width: 33.33%; font-size: 14px; }
  table.plan td:not(:last-child) { border-right: 1px solid var(--rule); }

  article.qa {
    margin: 0 0 28px;
    padding: 22px 24px;
    background: var(--bg);
    border: 1px solid var(--rule);
    border-radius: 4px;
    border-left: 3px solid var(--accent);
  }
  article.qa h3 {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.35;
    margin: 0 0 14px;
    color: var(--ink);
  }
  article.qa h3 .qid {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    color: var(--accent);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    margin-right: 12px;
    vertical-align: 1px;
  }
  article.qa .source {
    font-size: 14px;
    color: var(--ink-soft);
    border-left: 2px solid var(--gold);
    padding: 2px 0 2px 14px;
    margin: 0 0 14px;
    font-style: italic;
  }
  article.qa .source .label {
    font-family: 'Inter', system-ui, sans-serif;
    font-style: normal;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--gold);
    font-weight: 700;
    margin-right: 8px;
  }
  article.qa .answer-label {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-faint);
    font-weight: 600;
    margin: 12px 0 8px;
  }
  article.qa ul { margin: 0; padding-left: 22px; }
  article.qa ul li { margin-bottom: 6px; }
  article.qa .meta-row {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 14px;
    row-gap: 6px;
    margin: 14px 0 0;
    font-size: 14.5px;
  }
  article.qa .meta-row dt {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-faint);
    font-weight: 600;
    align-self: baseline;
    padding-top: 2px;
  }
  article.qa .meta-row dd { margin: 0; }
  article.qa .watch-out,
  article.qa .dont-say,
  article.qa .risk {
    margin-top: 12px;
    padding: 8px 12px;
    background: var(--warn-bg);
    border-left: 3px solid var(--warn);
    border-radius: 0 3px 3px 0;
    font-size: 14px;
    color: var(--ink);
  }
  article.qa .watch-out::before,
  article.qa .dont-say::before,
  article.qa .risk::before {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--warn);
    font-weight: 700;
    margin-right: 8px;
  }
  article.qa .watch-out::before { content: "Watch-out:"; }
  article.qa .dont-say::before  { content: "Don't say:"; }
  article.qa .risk::before      { content: "Risk to avoid:"; }

  .chip {
    display: inline-block;
    font-family: 'SF Mono', 'JetBrains Mono', Menlo, Consolas, monospace;
    font-size: 11.5px;
    padding: 1px 7px;
    border-radius: 3px;
    line-height: 1.6;
    white-space: nowrap;
    vertical-align: 1px;
  }
  .chip.cv    { background: #ece4d2; color: #5a4717; border: 1px solid #d8c89a; }
  .chip.story { background: #e0e8df; color: #3a5135; border: 1px solid #b9c9b3; }

  article.flag {
    margin: 0 0 24px;
    padding: 22px 24px;
    background: var(--warn-bg);
    border-radius: 4px;
    border-left: 3px solid var(--warn);
  }
  article.flag h3 {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 19px;
    font-weight: 600;
    line-height: 1.35;
    margin: 0 0 12px;
    color: var(--warn);
  }
  article.flag h3 .qid {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    color: var(--warn);
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    margin-right: 12px;
    vertical-align: 1px;
  }
  article.flag .question {
    font-style: italic;
    color: var(--ink-soft);
    font-size: 15px;
    margin: 0 0 12px;
  }
  article.flag .question .label {
    font-family: 'Inter', system-ui, sans-serif;
    font-style: normal;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--warn);
    font-weight: 700;
    margin-right: 8px;
  }
  article.flag ul { margin: 0 0 0 22px; padding: 0; }
  article.flag ul li { margin-bottom: 6px; }
  article.flag .dont-say {
    margin-top: 12px;
    padding: 8px 12px;
    background: rgba(255,255,255,0.5);
    border-left: 3px solid var(--warn);
    border-radius: 0 3px 3px 0;
    font-size: 14px;
  }
  article.flag .dont-say::before {
    content: "Don't say:";
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 10.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--warn);
    font-weight: 700;
    margin-right: 8px;
  }

  .comp-grid {
    display: grid;
    grid-template-columns: max-content 1fr;
    column-gap: 24px;
    row-gap: 14px;
    padding: 22px 24px;
    background: var(--bg-soft);
    border-radius: 4px;
    border-left: 3px solid var(--gold);
  }
  .comp-grid dt {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--gold);
    font-weight: 700;
    align-self: baseline;
    padding-top: 2px;
  }
  .comp-grid dd { margin: 0; font-size: 15px; }
  .comp-grid dd .anchor {
    font-family: 'Iowan Old Style', Palatino, Georgia, serif;
    font-size: 26px;
    font-weight: 600;
    color: var(--accent);
    letter-spacing: -0.01em;
  }
  .comp-grid dd.script { font-style: italic; color: var(--ink-soft); }
  .comp-note {
    font-size: 13px;
    color: var(--ink-faint);
    font-style: italic;
    margin-top: 14px;
    padding: 10px 14px;
    border-top: 1px dashed var(--rule);
  }

  .qask-grid { display: grid; grid-template-columns: 1fr 1fr; column-gap: 32px; }
  .qask-grid h3 {
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 12px;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.16em;
    color: var(--accent);
    margin: 0 0 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--rule);
  }
  .qask-grid .reverse h3 { color: var(--warn); }
  .qask-grid ul { padding-left: 22px; margin: 0; }
  .qask-grid ul li { margin-bottom: 10px; line-height: 1.5; font-size: 15px; }
  .qask-grid ul li::marker { color: var(--ink-faint); }

  footer.colophon {
    margin-top: 96px;
    padding-top: 24px;
    border-top: 1px solid var(--rule);
    font-family: 'Inter', system-ui, sans-serif;
    font-size: 11.5px;
    text-transform: uppercase;
    letter-spacing: 0.14em;
    color: var(--ink-faint);
    text-align: center;
  }

  @media (max-width: 900px) {
    .page { grid-template-columns: 1fr; padding: 32px 24px 64px; column-gap: 0; }
    aside.toc { display: none; }
    header.cover h1 { font-size: 32px; }
    .qask-grid { grid-template-columns: 1fr; row-gap: 32px; }
  }

  @media print {
    :root { --bg: #fff; --bg-soft: #f5f1e8; }
    body { font-size: 11pt; line-height: 1.45; }
    .page { display: block; padding: 0; max-width: none; }
    aside.toc { display: none; }
    header.cover { padding-top: 0; border-top-width: 3px; margin-bottom: 24pt; }
    header.cover h1 { font-size: 26pt; }
    section { page-break-inside: auto; margin: 24pt 0; }
    section > .title { page-break-after: avoid; }
    article.qa, article.flag {
      page-break-inside: avoid;
      box-shadow: none;
      border: 1px solid #ccc;
      background: #fff;
    }
    article.flag { background: #fbf3eb; }
    .pitch-block { page-break-inside: avoid; }
    a { color: var(--ink); text-decoration: none; }
    footer.colophon { margin-top: 48pt; }
  }
`;

// ────────────────────────────────────────────────────────────────────────────
// Build HTML
// ────────────────────────────────────────────────────────────────────────────

const doc = parseDoc(md);

// Build sections: dispatch each parsed section to its renderer, fall back to
// raw escaped text if no match.
const renderedSections = [];
const tocItems = [];

for (const sec of doc.sections) {
  const route = SECTION_MAP.find((r) => r.match.test(sec.heading));
  if (!route) continue;
  const inner = route.render(sec.body) || '';
  renderedSections.push(`
<section id="${route.anchor}">
  <h2><span class="num">${route.num}</span>${escapeHtml(route.title)}</h2>
  ${route.anchor === 'snapshot' ? '' : `<div class="title">${escapeHtml(route.title)}</div>`}
  ${inner}
</section>`);
  if (route.anchor !== 'snapshot') tocItems.push({ anchor: route.anchor, title: route.title });
}

// Cover header
const titleHtml = doc.company.replace(/\s+&\s+/, ' <span class="ampersand">&amp;</span> ');
const titleWithCandidate = `${titleHtml} <span class="ampersand">&amp;</span> ${escapeHtml(doc.candidate)}`;
const eyebrow = `Interview Preparation${doc.roundLabel ? ` · ${doc.roundLabel}` : ''}`;

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Interview Prep — ${escapeHtml(doc.company)} · ${escapeHtml(doc.candidate)}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
<main>

<header class="cover">
  <div class="eyebrow">${escapeHtml(eyebrow)}</div>
  <h1>${escapeHtml(doc.company)} <span class="ampersand">&amp;</span> ${escapeHtml(doc.candidate)}</h1>
  <div class="role">${inline(doc.role)}</div>
  <dl class="meta">
    <dt>Generated</dt><dd>${escapeHtml(doc.generated)}</dd>
    <dt>Sources</dt><dd>${renderSources(doc.sources)}</dd>
  </dl>
</header>
${renderedSections.join('\n')}

<footer class="colophon">Prepared ${escapeHtml(doc.generated)} · ${escapeHtml(doc.roundLabel)} · ${escapeHtml(doc.company)} · ${escapeHtml(doc.role.replace(/\s*\(.*\)\s*$/, ''))}</footer>

</main>

<aside class="toc" aria-label="Table of contents">
  <div class="toc-label">Contents</div>
  <ol>
${tocItems.map((t) => `    <li><a href="#${t.anchor}">${escapeHtml(t.title)}</a></li>`).join('\n')}
  </ol>
</aside>

</div>
</body>
</html>
`;

fs.writeFileSync(htmlPath, html);
console.log(`Wrote ${htmlPath}`);
