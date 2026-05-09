#!/usr/bin/env node
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Auto-load .env from cwd or repo root if present. Existing process.env values
// take precedence over .env (so shell exports always win). Skips quietly if the
// file is missing or unreadable — .env is optional.
function loadDotEnv() {
  const candidates = [path.join(process.cwd(), '.env'), path.join(__dirname, '.env')];
  for (const file of candidates) {
    if (!fs.existsSync(file)) continue;
    let content;
    try { content = fs.readFileSync(file, 'utf-8'); } catch { continue; }
    for (const rawLine of content.split('\n')) {
      const line = rawLine.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let value = line.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) ||
          (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      if (!(key in process.env)) process.env[key] = value;
    }
    break; // first found wins
  }
}
loadDotEnv();

const isDryRun = process.argv.includes('--dry-run');
const isHtmlOnly = process.argv.includes('--html');

const RESEND_API_KEY = process.env.RESEND_API;
const SENDER_EMAIL = process.env.SENDER_EMAIL;
const DEFAULT_RECIPIENT_EMAIL = process.env.DEFAULT_RECIPIENT_EMAIL;

// Recipient resolution order: --to-multiple= > --to= > DEFAULT_RECIPIENT_EMAIL env var > [] (no recipient)
const toArg = process.argv.find(a => a.startsWith('--to='))?.slice(5);
const toMultipleArg = process.argv.find(a => a.startsWith('--to-multiple='))?.slice(14);
const RECIPIENT_EMAILS = toMultipleArg
  ? toMultipleArg.split(',').map(e => e.trim())
  : (toArg ? [toArg] : (DEFAULT_RECIPIENT_EMAIL ? DEFAULT_RECIPIENT_EMAIL.split(',').map(e => e.trim()) : []));

// Read candidate's first name from profile.yml for use in the email subject.
// Returns null if profile.yml is missing or full_name can't be parsed —
// callers fall back to a name-less subject.
function loadCandidateFirstName() {
  const file = path.join(__dirname, 'profile.yml');
  if (!fs.existsSync(file)) return null;
  let content;
  try { content = fs.readFileSync(file, 'utf-8'); } catch { return null; }
  // Minimal regex parse — avoids adding a YAML dep just for one field.
  // Match `full_name: "..."` or `full_name: ...` under a top-level `candidate:` key.
  const m = content.match(/^candidate:\s*\n(?:[ \t]+[^\n]*\n)*?[ \t]+full_name:\s*['"]?([^'"\n]+?)['"]?\s*$/m);
  if (!m) return null;
  const fullName = m[1].trim();
  if (!fullName) return null;
  return fullName.split(/\s+/)[0]; // first token
}

// ── Section helpers ────────────────────────────────────────────────────────

function escapeHTML(str) {
  const map = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  return (str || '').replace(/[&<>"']/g, m => map[m]);
}

// Pull today's section out of jobscan-out.md
function extractTodaySection(content, date) {
  const startIdx = content.indexOf(`## ${date}`);
  if (startIdx === -1) return null;
  const rest = content.substring(startIdx + 4);
  const next = rest.match(/\n## /);
  const endIdx = next ? startIdx + 4 + next.index : content.length;
  return content.substring(startIdx, endIdx);
}

// Parse `## YYYY-MM-DD — N discovered/new candidates ..., classified N (strong: X, plausible: Y, skip: Z), N scored`
function parseHeaderStats(section) {
  const headerLine = section.split('\n')[0] || '';
  const stats = { discovered: 0, strong: 0, plausible: 0, skip: 0, scored: 0 };

  const discMatch = headerLine.match(/(\d+)\s+(?:discovered|new candidates)/i);
  if (discMatch) stats.discovered = parseInt(discMatch[1], 10);

  const strongMatch = headerLine.match(/strong:\s*(\d+)/i);
  if (strongMatch) stats.strong = parseInt(strongMatch[1], 10);

  const plausibleMatch = headerLine.match(/plausible:\s*(\d+)/i);
  if (plausibleMatch) stats.plausible = parseInt(plausibleMatch[1], 10);

  const skipMatch = headerLine.match(/skip:\s*(\d+)/i);
  if (skipMatch) stats.skip = parseInt(skipMatch[1], 10);

  const scoredMatch = headerLine.match(/,\s*(\d+)\s+scored/i);
  if (scoredMatch) stats.scored = parseInt(scoredMatch[1], 10);

  return stats;
}

// Slice a tier section between `### TierName` and the next `### ` or end.
function sliceTier(section, tierName) {
  const headerRe = new RegExp(`###\\s+${tierName.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}[^\\n]*\\n`);
  const m = section.match(headerRe);
  if (!m) return null;
  const start = m.index + m[0].length;
  const rest = section.slice(start);
  const next = rest.match(/\n###\s/);
  const end = next ? start + next.index : section.length;
  return section.slice(start, end);
}

// Parse the FIRST pipe-table found in the given block. Returns rows as { col1, col2, ... } using header names.
function parseTable(block) {
  if (!block) return [];
  const lines = block.split('\n');
  const rows = [];
  let header = null;
  let inTable = false;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('|')) {
      if (inTable) break; // table ended
      continue;
    }
    const cells = trimmed.split('|').slice(1, -1).map(c => c.trim());
    if (!header) {
      header = cells;
      inTable = true;
      continue;
    }
    if (cells.every(c => /^-+$/.test(c.replace(/:/g, '')))) continue; // separator row
    const row = {};
    header.forEach((h, i) => { row[h] = cells[i] || ''; });
    rows.push(row);
  }
  return rows;
}

function normalizeJob(row) {
  return {
    company: row['Company'] || '',
    role: row['Role'] || '',
    url: row['URL'] || '',
    location: row['Location Preference'] || row['Location'] || '',
    score: row['Score'] || '',
    classifierNote: row['Classifier Note'] || '',
  };
}

// Parse Match/Gap bullet list under a tier (lines starting with `- **Company / Role** — Match: ... Gap: ...`)
function parseMatchGapNotes(block) {
  if (!block) return [];
  const notes = [];
  const re = /^-\s+\*\*([^*]+?)\s*\/\s*([^*]+?)\*\*\s*[—-]+\s*Match:\s*(.+?)\s*Gap:\s*(.+?)$/gm;
  let m;
  while ((m = re.exec(block)) !== null) {
    notes.push({
      company: m[1].trim(),
      role: m[2].trim(),
      match: m[3].trim(),
      gap: m[4].trim(),
    });
  }
  return notes;
}

// Pull "Scored (<3.0):" and "Plausible (unscored …)" sub-tables out of the Low Fit block.
function parseLowFitBlock(block) {
  if (!block) return { scored: [], plausible: [] };

  const scoredHeader = block.match(/\*\*Scored\s*\([^)]*\):\*\*/);
  const plausHeader = block.match(/\*\*Plausible[^*]*:\*\*/);

  const scoredStart = scoredHeader ? scoredHeader.index + scoredHeader[0].length : -1;
  const plausStart = plausHeader ? plausHeader.index + plausHeader[0].length : -1;

  let scoredBlock = '';
  let plausibleBlock = '';
  if (scoredStart !== -1) {
    const scoredEnd = plausHeader ? plausHeader.index : block.length;
    scoredBlock = block.slice(scoredStart, scoredEnd);
  }
  if (plausStart !== -1) {
    plausibleBlock = block.slice(plausStart);
  }

  return {
    scored: parseTable(scoredBlock).map(normalizeJob),
    plausible: parseTable(plausibleBlock).map(normalizeJob),
  };
}

// ── Email body assembly ────────────────────────────────────────────────────

function buildScoredTable(jobs, palette) {
  if (jobs.length === 0) return '';
  const rows = jobs.map((j, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    return `    <tr style="background-color:${bg};">
      <td style="padding:8px 10px;border:1px solid #e2e8f0;font-weight:600;">${escapeHTML(j.company)}</td>
      <td style="padding:8px 10px;border:1px solid #e2e8f0;">${escapeHTML(j.role)}</td>
      <td style="padding:8px 10px;border:1px solid #e2e8f0;color:#475569;">${escapeHTML(j.location)}</td>
      <td style="padding:8px 10px;border:1px solid #e2e8f0;text-align:center;font-weight:700;color:${palette.score};">${escapeHTML(j.score)}</td>
      <td style="padding:8px 10px;border:1px solid #e2e8f0;"><a href="${escapeHTML(j.url)}" style="color:#2563eb;text-decoration:none;">View →</a></td>
    </tr>`;
  }).join('\n');

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:13px;line-height:1.45;margin-bottom:16px;">
  <thead><tr style="background-color:${palette.headerBg};color:#ffffff;text-align:left;">
    <th style="padding:8px 10px;border:1px solid ${palette.headerBg};">Company</th>
    <th style="padding:8px 10px;border:1px solid ${palette.headerBg};">Role</th>
    <th style="padding:8px 10px;border:1px solid ${palette.headerBg};">Location</th>
    <th style="padding:8px 10px;border:1px solid ${palette.headerBg};text-align:center;">Score</th>
    <th style="padding:8px 10px;border:1px solid ${palette.headerBg};">Link</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function buildPlausibleTable(jobs) {
  if (jobs.length === 0) return '';
  const rows = jobs.map((j, i) => {
    const bg = i % 2 === 0 ? '#ffffff' : '#f8fafc';
    return `    <tr style="background-color:${bg};">
      <td style="padding:7px 9px;border:1px solid #e2e8f0;font-weight:600;">${escapeHTML(j.company)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;">${escapeHTML(j.role)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;color:#475569;">${escapeHTML(j.location)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;color:#64748b;font-style:italic;">${escapeHTML(j.classifierNote)}</td>
      <td style="padding:7px 9px;border:1px solid #e2e8f0;"><a href="${escapeHTML(j.url)}" style="color:#2563eb;text-decoration:none;">View →</a></td>
    </tr>`;
  }).join('\n');

  return `
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border-collapse:collapse;font-size:12px;line-height:1.45;margin-bottom:16px;">
  <thead><tr style="background-color:#475569;color:#ffffff;text-align:left;">
    <th style="padding:7px 9px;border:1px solid #475569;">Company</th>
    <th style="padding:7px 9px;border:1px solid #475569;">Role</th>
    <th style="padding:7px 9px;border:1px solid #475569;">Location</th>
    <th style="padding:7px 9px;border:1px solid #475569;">Classifier Note</th>
    <th style="padding:7px 9px;border:1px solid #475569;">Link</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
</table>`;
}

function buildMatchGapBlock(notes) {
  if (notes.length === 0) return '';
  const items = notes.map(n => `  <div style="font-size:12px;line-height:1.5;color:#1f2937;margin-bottom:8px;"><strong>${escapeHTML(n.company)} / ${escapeHTML(n.role)}</strong><br><span style="color:#166534;">Match:</span> ${escapeHTML(n.match)}<br><span style="color:#9a3412;">Gap:</span> ${escapeHTML(n.gap)}</div>`).join('\n');
  return `
<div style="margin:12px 0 20px 0;padding:14px 16px;background-color:#f0fdf4;border-left:4px solid #16a34a;border-radius:4px;">
  <div style="font-size:13px;font-weight:600;color:#14532d;margin-bottom:8px;">High Fit — Match / Gap notes</div>
${items}
</div>`;
}

function buildEmail(date, stats, highFit, mediumFit, lowFit, plausible, matchGapNotes) {
  const palettes = {
    high:   { headerBg: '#15803d', accent: '#16a34a', score: '#16a34a' },
    medium: { headerBg: '#a16207', accent: '#ca8a04', score: '#ca8a04' },
    low:    { headerBg: '#991b1b', accent: '#dc2626', score: '#dc2626' },
  };

  const highSection = highFit.length > 0
    ? `<h2 style="font-size:16px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid ${palettes.high.accent};padding-bottom:6px;">High Fit (≥ 4.0)</h2>
        ${buildScoredTable(highFit, palettes.high)}
        ${buildMatchGapBlock(matchGapNotes)}`
    : '';

  const mediumSection = mediumFit.length > 0
    ? `<h2 style="font-size:16px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid ${palettes.medium.accent};padding-bottom:6px;">Medium Fit (3.0 – 3.9)</h2>
        ${buildScoredTable(mediumFit, palettes.medium)}`
    : '';

  const lowSection = lowFit.length > 0
    ? `<h2 style="font-size:16px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid ${palettes.low.accent};padding-bottom:6px;">Low Fit (&lt; 3.0)</h2>
        ${buildScoredTable(lowFit, palettes.low)}`
    : '';

  const plausibleSection = plausible.length > 0
    ? `<h2 style="font-size:16px;margin:24px 0 8px 0;color:#0f172a;border-bottom:2px solid #475569;padding-bottom:6px;">Plausible — Unscored (${plausible.length})</h2>
        <p style="margin:0 0 8px 0;font-size:12px;color:#64748b;font-style:italic;">Flagged by the title classifier as worth a manual skim. No LLM scoring tokens were spent on these — the title alone wasn't enough signal.</p>
        ${buildPlausibleTable(plausible)}`
    : '';

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>JobScan Results — ${date}</title>
</head>
<body style="margin:0;padding:0;background-color:#f4f6f8;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#1f2937;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f6f8;padding:24px 0;">
  <tr><td align="center">
    <table role="presentation" width="760" cellpadding="0" cellspacing="0" style="max-width:760px;background-color:#ffffff;border:1px solid #e5e7eb;border-radius:8px;overflow:hidden;">
      <tr><td style="padding:24px 28px;background-color:#0f172a;color:#ffffff;">
        <div style="font-size:13px;letter-spacing:1.4px;text-transform:uppercase;color:#94a3b8;">JobScan Triage</div>
        <div style="font-size:22px;font-weight:600;margin-top:4px;">Results — ${date}</div>
        <div style="font-size:13px;color:#cbd5f5;margin-top:4px;">Portal scan + CV×JD relevancy scoring</div>
      </td></tr>

      <tr><td style="padding:24px 28px;">
        <p style="margin:0 0 12px 0;font-size:14px;line-height:1.55;">Today's pipeline finished end-to-end. Headline numbers:</p>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="margin:8px 0 18px 0;border-collapse:collapse;">
          <tr><td style="padding:12px 14px;background-color:#f8fafc;border:1px solid #e2e8f0;border-radius:6px;font-size:13px;line-height:1.7;">
            <strong>Discovered:</strong> ${stats.discovered} listings<br>
            <strong>Classified:</strong> ${stats.strong} strong (scored) · ${stats.plausible} plausible (flagged) · ${stats.skip} skip<br>
            <strong>Scored:</strong> High Fit ${highFit.length} · Medium Fit ${mediumFit.length} · Low Fit ${lowFit.length}<br>
            <strong>Plausible (unscored):</strong> ${plausible.length}
          </td></tr>
        </table>

        ${highSection}
        ${mediumSection}
        ${lowSection}
        ${plausibleSection}

      </td></tr>

      <tr><td style="padding:18px 28px;background-color:#f8fafc;border-top:1px solid #e2e8f0;font-size:11px;color:#64748b;line-height:1.5;">
        Automated notification from <strong>JobScan</strong> (CV×JD relevancy scoring).<br>
        Source of truth: <code>data/jobscan-out.md</code> in your local repo.<br>
        Generated locally on your machine — no telemetry.
      </td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;
}

// ── Top-level: build and (optionally) send ────────────────────────────────

function generateEmailContent() {
  const dateArg = process.argv.find(a => a.startsWith('--date='))?.slice(7);
  const today = dateArg || new Date().toISOString().split('T')[0];

  // Try jobscan-out.md first (current results), then archive (dated results)
  let outFile = path.join(__dirname, 'data', 'jobscan-out.md');
  let content;

  if (fs.existsSync(outFile)) {
    content = fs.readFileSync(outFile, 'utf-8');
  } else {
    // Fall back to archived dated file
    const archivedFile = path.join(__dirname, 'data', 'archive', `jobscan-out-${today}.md`);
    if (fs.existsSync(archivedFile)) {
      outFile = archivedFile;
      content = fs.readFileSync(archivedFile, 'utf-8');
    } else {
      return { success: false, error: `Not found: ${outFile} or ${archivedFile}` };
    }
  }
  const section = extractTodaySection(content, today);
  if (!section) {
    return { success: false, error: `No results section for ${today} found in ${outFile}` };
  }

  const stats = parseHeaderStats(section);
  const highBlock = sliceTier(section, 'High Fit');
  const mediumBlock = sliceTier(section, 'Medium Fit');
  const lowBlock = sliceTier(section, 'Low Fit');

  const highFit = parseTable(highBlock).map(normalizeJob);
  const mediumFit = parseTable(mediumBlock).map(normalizeJob);
  const matchGapNotes = parseMatchGapNotes(highBlock || '');
  const { scored: lowFit, plausible } = parseLowFitBlock(lowBlock || '');

  const body = buildEmail(today, stats, highFit, mediumFit, lowFit, plausible, matchGapNotes);
  return { success: true, body, date: today, stats, highFit, mediumFit, lowFit, plausible };
}

function subjectLine(date) {
  const firstName = loadCandidateFirstName();
  return firstName
    ? `JobScan Results for ${firstName} — ${date}`
    : `JobScan Results — ${date}`;
}

async function sendViaResend(htmlBody, date, recipients) {
  if (!RESEND_API_KEY) return { success: false, error: 'RESEND_API not set (see .env.example)' };
  if (!SENDER_EMAIL) return { success: false, error: 'SENDER_EMAIL not set (see .env.example)' };

  const results = [];
  for (const email of recipients) {
    try {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: SENDER_EMAIL,
          to: email,
          subject: subjectLine(date),
          html: htmlBody,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        results.push({ email, success: false, error: `Resend API error: ${data.message || response.statusText}` });
      } else {
        results.push({ email, success: true, messageId: data.id });
      }
    } catch (error) {
      results.push({ email, success: false, error: `Failed to send email: ${error.message}` });
    }
  }

  const allSuccessful = results.every(r => r.success);
  return { success: allSuccessful, results };
}

const result = generateEmailContent();
if (!result.success) {
  // Today's section is missing — remove any stale rendered HTML so a
  // downstream emailer (e.g. Postman) cannot pick up yesterday's file and
  // send it as if it were today's results.
  const stalePath = path.join(__dirname, 'data', 'jobscan-out.html');
  if (fs.existsSync(stalePath)) {
    fs.rmSync(stalePath, { force: true });
    console.error(`Removed stale ${stalePath} to prevent send of previous-day data.`);
  }
  console.error(`Error: ${result.error}`);
  process.exit(1);
}

if (isHtmlOnly) {
  const htmlPath = path.join(__dirname, 'data', 'jobscan-out.html');
  fs.writeFileSync(htmlPath, result.body);
  console.log(`HTML written to ${htmlPath}`);
  console.log(`High Fit ${result.highFit.length} · Medium Fit ${result.mediumFit.length} · Low Fit ${result.lowFit.length} · Plausible ${result.plausible.length}`);
} else if (isDryRun) {
  const previewPath = path.join(__dirname, 'data', `jobscan-email-${result.date}.preview.html`);
  fs.writeFileSync(previewPath, result.body);
  console.log('════════════════════════════════════════════════════');
  console.log(`DRY RUN — Preview written to ${previewPath}`);
  console.log(`Recipients (when sent): ${RECIPIENT_EMAILS.length ? RECIPIENT_EMAILS.join(', ') : '(none — pass --to= or set DEFAULT_RECIPIENT_EMAIL in .env before sending)'}`);
  console.log(`High Fit ${result.highFit.length} · Medium Fit ${result.mediumFit.length} · Low Fit ${result.lowFit.length} · Plausible ${result.plausible.length}`);
  console.log('════════════════════════════════════════════════════');
  console.log('To send: node notify.mjs');
} else {
  if (RECIPIENT_EMAILS.length === 0) {
    console.error('No recipient specified.');
    console.error('  Pass --to=<email>, --to-multiple=<a@b.com,c@d.com>, or set DEFAULT_RECIPIENT_EMAIL in .env (see .env.example).');
    console.error('  HTML-only render (no email):     node notify.mjs --html');
    console.error('  Preview without sending:         node notify.mjs --dry-run --to=<email>');
    process.exit(1);
  }
  const sendResult = await sendViaResend(result.body, result.date, RECIPIENT_EMAILS);
  if (sendResult.success) {
    console.log('✅ Emails sent successfully via Resend');
    for (const r of sendResult.results) {
      if (r.success) {
        console.log(`📧 ${r.email} — Message ID: ${r.messageId}`);
      } else {
        console.log(`❌ ${r.email} — ${r.error}`);
      }
    }
    console.log(`From: ${SENDER_EMAIL}`);
  } else {
    console.error(`❌ Failed to send emails`);
    if (sendResult.error) console.error(`  ${sendResult.error}`);
    for (const r of sendResult.results || []) {
      if (!r.success) {
        console.error(`  ${r.email}: ${r.error}`);
      }
    }
    process.exit(1);
  }
}
