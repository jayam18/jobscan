#!/usr/bin/env node
import fs from 'fs';

const scores = JSON.parse(fs.readFileSync('scores.json', 'utf8'));
const histPath = 'data/scan-history.tsv';
const histLines = fs.readFileSync(histPath, 'utf8').split('\n');
const histHeader = histLines[0];
const histCols = histHeader.split('\t');
const urlIdx = histCols.indexOf('url');
const statusIdx = histCols.indexOf('status');
const scoreIdx = histCols.indexOf('score');
const ratIdx = histCols.indexOf('rationale');

const sMap = new Map(scores.map(s => [s.url, s]));
const newHist = [histHeader];
for (let i = 1; i < histLines.length; i++) {
  const line = histLines[i];
  if (!line.trim()) { newHist.push(line); continue; }
  const c = line.split('\t');
  while (c.length < histCols.length) c.push('');
  const s = sMap.get(c[urlIdx]);
  if (s) {
    c[statusIdx] = 'scored';
    c[scoreIdx] = String(s.score.toFixed(1));
    c[ratIdx] = `${s.match} | ${s.gap}`;
  }
  newHist.push(c.join('\t'));
}
fs.writeFileSync(histPath, newHist.join('\n'));
console.log(`Updated scan-history.tsv with ${scores.length} scores`);
