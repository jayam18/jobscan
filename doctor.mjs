#!/usr/bin/env node

/**
 * doctor.mjs — Setup validation for JobScan
 *
 * Verifies that all prerequisites are in place before running /jobscan:
 *   - Node.js >= 18 (for native fetch)
 *   - npm install has been run (js-yaml present)
 *   - cv.md, profile.yml, portals.yml exist
 *   - YAML files parse and have required keys
 *   - data/ directory + scan-history.tsv header are valid
 *   - Skill + command wiring is in place
 *
 * Exits 0 on all pass (warnings allowed), 1 on any fail.
 *
 * Usage:
 *   node doctor.mjs
 *   npm run doctor
 */

import { existsSync, readFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = __dirname;

// ── ANSI (only on TTY) ──────────────────────────────────────────────
const tty = process.stdout.isTTY;
const green  = (s) => tty ? `\x1b[32m${s}\x1b[0m` : s;
const red    = (s) => tty ? `\x1b[31m${s}\x1b[0m` : s;
const yellow = (s) => tty ? `\x1b[33m${s}\x1b[0m` : s;
const dim    = (s) => tty ? `\x1b[2m${s}\x1b[0m` : s;
const bold   = (s) => tty ? `\x1b[1m${s}\x1b[0m` : s;

// ── Check helpers ───────────────────────────────────────────────────
// A check returns { status: 'pass' | 'warn' | 'fail', label, fix? }

function pass(label)        { return { status: 'pass', label }; }
function warn(label, fix)   { return { status: 'warn', label, fix }; }
function fail(label, fix)   { return { status: 'fail', label, fix }; }

// ── Checks ──────────────────────────────────────────────────────────

function checkNodeVersion() {
  const major = parseInt(process.versions.node.split('.')[0]);
  if (major >= 18) return pass(`Node.js >= 18 (v${process.versions.node})`);
  return fail(
    `Node.js >= 18 required (found v${process.versions.node})`,
    'Install Node.js 18+ from https://nodejs.org'
  );
}

function checkJsYaml() {
  if (existsSync(join(root, 'node_modules', 'js-yaml'))) {
    return pass('Dependencies installed (js-yaml)');
  }
  return fail('Dependencies not installed', 'Run: npm install');
}

function checkPlaywright() {
  if (existsSync(join(root, 'node_modules', 'playwright', 'package.json'))) {
    return pass('Playwright installed (for SPA scanning)');
  }
  return warn(
    'Playwright not installed — scan-spa.mjs will fail',
    'Run: npm install && npx playwright install chromium'
  );
}

function checkCv() {
  const path = join(root, 'cv.md');
  if (!existsSync(path)) {
    return fail(
      'cv.md not found',
      'Copy cv.example.md → cv.md and replace with your CV, or paste your CV in Claude Code and let /jobscan create it'
    );
  }
  const content = readFileSync(path, 'utf-8').trim();
  if (content.length < 200) {
    return warn(
      'cv.md exists but looks very short (<200 chars)',
      'A short CV may yield unreliable scores. Consider expanding it.'
    );
  }
  if (/^# (Jane Smith|Your Name)/i.test(content)) {
    return warn(
      'cv.md appears to still contain template content (Jane Smith / Your Name)',
      'Replace the template with your actual CV before running /jobscan'
    );
  }
  return pass(`cv.md found (${content.length} chars)`);
}

async function loadYaml(path) {
  if (!existsSync(path)) return { error: 'missing' };
  try {
    const yaml = (await import('js-yaml')).default;
    return { data: yaml.load(readFileSync(path, 'utf-8')) };
  } catch (err) {
    return { error: `parse: ${err.message}` };
  }
}

async function checkProfile() {
  const path = join(root, 'profile.yml');
  const { data, error } = await loadYaml(path);
  if (error === 'missing') {
    return fail('profile.yml not found', 'Run: cp profile.example.yml profile.yml — then edit with your data');
  }
  if (error) {
    return fail(`profile.yml exists but failed to parse (${error})`, 'Validate YAML syntax');
  }
  const missing = [];
  if (!data?.candidate?.full_name) missing.push('candidate.full_name');
  if (!data?.target_roles?.primary?.length) missing.push('target_roles.primary');
  if (!data?.target_archetypes?.length) missing.push('target_archetypes');
  if (!data?.scoring) missing.push('scoring');
  if (missing.length) {
    return fail(
      `profile.yml is missing required keys: ${missing.join(', ')}`,
      'Fill in these fields before running /jobscan'
    );
  }

  // Soft checks
  const digest = data.scoring.candidate_digest;
  if (!digest || !String(digest).trim()) {
    return warn(
      'profile.yml OK, but scoring.candidate_digest is empty',
      '/jobscan will auto-generate it from cv.md on first run (you will be asked to confirm)'
    );
  }

  const cap = data.scoring.score_cap;
  if (cap && cap > 200) {
    return warn(
      `profile.yml OK, but scoring.score_cap=${cap} is high — expect many LLM calls per scan`,
      'Consider lowering score_cap to 50-100'
    );
  }

  return pass('profile.yml valid and populated');
}

async function checkPortals() {
  const path = join(root, 'portals.yml');
  const { data, error } = await loadYaml(path);
  if (error === 'missing') {
    return fail('portals.yml not found', 'Run: cp portals.example.yml portals.yml — then customize title_filter and tracked_companies');
  }
  if (error) {
    return fail(`portals.yml exists but failed to parse (${error})`, 'Validate YAML syntax');
  }
  if (!Array.isArray(data?.tracked_companies)) {
    return fail('portals.yml is missing tracked_companies (list)', 'Add at least one company with name + careers_url');
  }
  const enabled = data.tracked_companies.filter(c => c.enabled !== false);
  if (enabled.length === 0) {
    return fail(
      'portals.yml has no enabled tracked_companies',
      'Enable at least one company (remove `enabled: false` or add new entries)'
    );
  }
  const missingUrl = enabled.filter(c => !c.careers_url);
  if (missingUrl.length) {
    return warn(
      `portals.yml: ${missingUrl.length} enabled companies missing careers_url`,
      `Add careers_url to: ${missingUrl.map(c => c.name || '?').join(', ')}`
    );
  }
  const positive = data.title_filter?.positive || [];
  if (positive.length === 0) {
    return warn(
      'portals.yml has no title_filter.positive keywords — EVERYTHING will match',
      'Add target role keywords to title_filter.positive'
    );
  }
  return pass(`portals.yml valid (${enabled.length} enabled companies, ${positive.length} positive keywords)`);
}

function checkDataDir() {
  if (!existsSync(join(root, 'data'))) {
    return fail('data/ directory missing', 'Run: mkdir data  (or it will be created on first /jobscan)');
  }
  return pass('data/ directory exists');
}

function checkScanHistory() {
  const path = join(root, 'data', 'scan-history.tsv');
  if (!existsSync(path)) {
    return warn(
      'data/scan-history.tsv missing',
      'Will be created on first scan. No action needed.'
    );
  }
  const first = readFileSync(path, 'utf-8').split('\n')[0];
  const expected = 'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscore\trationale';
  if (first !== expected) {
    return warn(
      'data/scan-history.tsv header does not match expected schema',
      `Expected: ${expected.replace(/\t/g, ' | ')}`
    );
  }
  return pass('data/scan-history.tsv header valid');
}

function checkSkillWiring() {
  const command = join(root, '.claude', 'commands', 'jobscan.md');
  const skill = join(root, '.claude', 'skills', 'jobscan', 'SKILL.md');
  const missing = [];
  if (!existsSync(command)) missing.push('.claude/commands/jobscan.md');
  if (!existsSync(skill)) missing.push('.claude/skills/jobscan/SKILL.md');
  if (missing.length) {
    return fail(
      `Skill/command wiring missing: ${missing.join(', ')}`,
      'Re-copy these files from the jobscan template'
    );
  }
  return pass('Claude Code skill + command wiring in place');
}

function checkScanScript() {
  if (!existsSync(join(root, 'scan.mjs'))) {
    return fail('scan.mjs missing', 'Re-copy scan.mjs from the jobscan template');
  }
  return pass('scan.mjs present');
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  console.log(bold('\nJobScan doctor'));
  console.log(dim('─'.repeat(50)));

  const checks = [
    checkNodeVersion(),
    checkJsYaml(),
    checkPlaywright(),
    checkDataDir(),
    checkScanScript(),
    checkSkillWiring(),
    checkCv(),
    await checkProfile(),
    await checkPortals(),
    checkScanHistory(),
  ];

  let failCount = 0;
  let warnCount = 0;

  for (const c of checks) {
    const icon = c.status === 'pass' ? green('✓')
               : c.status === 'warn' ? yellow('!')
               : red('✗');
    console.log(`  ${icon} ${c.label}`);
    if (c.fix && c.status !== 'pass') {
      const fixLines = Array.isArray(c.fix) ? c.fix : [c.fix];
      for (const line of fixLines) console.log(dim(`      → ${line}`));
    }
    if (c.status === 'fail') failCount++;
    if (c.status === 'warn') warnCount++;
  }

  console.log(dim('─'.repeat(50)));
  const total = checks.length;
  const passCount = total - failCount - warnCount;
  const summary = `${passCount}/${total} pass`
    + (warnCount ? `, ${yellow(warnCount + ' warn')}` : '')
    + (failCount ? `, ${red(failCount + ' fail')}` : '');
  console.log(`  ${summary}`);

  if (failCount > 0) {
    console.log(red('\n  JobScan is NOT ready. Fix the failures above, then re-run `npm run doctor`.\n'));
    process.exit(1);
  }
  if (warnCount > 0) {
    console.log(yellow('\n  JobScan is usable, but warnings may affect results.\n'));
    process.exit(0);
  }
  console.log(green('\n  All checks passed. Run /jobscan in Claude Code to get started.\n'));
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
