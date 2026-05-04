#!/usr/bin/env node
import fs from 'fs';

const tsvPath = 'data/jobscan-new.tsv';
const histPath = 'data/scan-history.tsv';
const cls = JSON.parse(fs.readFileSync('data/classifications.json', 'utf8'));

const lines = fs.readFileSync(tsvPath, 'utf8').split('\n');
const header = lines[0].split('\t');
// Ensure header has cls and cls_note
let needHeader = false;
if (!header.includes('cls')) { header.push('cls'); needHeader = true; }
if (!header.includes('cls_note')) { header.push('cls_note'); needHeader = true; }

const out = [header.join('\t')];
let strong = 0, plausible = 0, skip = 0;
const updates = []; // {url, status}

for (let i = 1; i < lines.length; i++) {
  const line = lines[i];
  if (!line.trim()) continue;
  const cols = line.split('\t');
  while (cols.length < 8) cols.push('');
  const url = cols[0];
  const c = cls[url];
  if (c) {
    cols[6] = c.cls;
    cols[7] = c.why.slice(0, 80);
    if (c.cls === 'strong') strong++;
    else if (c.cls === 'plausible') plausible++;
    else skip++;
    updates.push({ url, cls: c.cls, why: c.why.slice(0, 80) });
  } else {
    cols[6] = cols[6] || 'plausible';
    cols[7] = cols[7] || 'unclassified default';
    plausible++;
    updates.push({ url, cls: 'plausible', why: 'unclassified default' });
  }
  out.push(cols.join('\t'));
}

fs.writeFileSync(tsvPath, out.join('\n') + '\n');

// Update scan-history.tsv
const histLines = fs.readFileSync(histPath, 'utf8').split('\n');
const histHeader = histLines[0];
const histCols = histHeader.split('\t');
const urlIdx = histCols.indexOf('url');
const statusIdx = histCols.indexOf('status');
const ratIdx = histCols.indexOf('rationale');

const updMap = new Map(updates.map(u => [u.url, u]));
const newHist = [histHeader];
for (let i = 1; i < histLines.length; i++) {
  const line = histLines[i];
  if (!line.trim()) { newHist.push(line); continue; }
  const c = line.split('\t');
  while (c.length < histCols.length) c.push('');
  const u = updMap.get(c[urlIdx]);
  if (u && c[statusIdx] === 'discovered') {
    c[statusIdx] = `classified_${u.cls}`;
    if (u.cls !== 'strong') c[ratIdx] = u.why;
  }
  newHist.push(c.join('\t'));
}
fs.writeFileSync(histPath, newHist.join('\n'));

console.log(`Classified ${updates.length} titles — strong: ${strong}, plausible: ${plausible}, skip: ${skip}`);
