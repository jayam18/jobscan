#!/usr/bin/env node

/**
 * scan.mjs — Zero-token portal scanner for JobScan
 *
 * Fetches Greenhouse, Ashby, Lever, and Workday APIs directly, applies title +
 * location filters from portals.yml, deduplicates against scan-history.tsv,
 * and writes new offers (with JD snippets when available) to
 * data/jobscan-new.tsv for the scoring step to consume.
 *
 * Zero Claude API tokens — pure HTTP + JSON.
 *
 * Usage:
 *   node scan.mjs                  # scan all enabled companies
 *   node scan.mjs --dry-run        # preview without writing files
 *   node scan.mjs --company Cohere # scan a single company
 */

import { readFileSync, writeFileSync, appendFileSync, existsSync, mkdirSync, rmSync, renameSync } from 'fs';
import yaml from 'js-yaml';
import { titleFilter, locationFilter } from './filter-core.mjs';
const parseYaml = yaml.load;

// ── Config ──────────────────────────────────────────────────────────

const PORTALS_PATH = 'portals.yml';
const SCAN_HISTORY_PATH = 'data/scan-history.tsv';
const CANDIDATES_PATH = 'data/jobscan-new.tsv';
const CANDIDATES_HEADER = 'url\ttitle\tcompany\tlocation\tsource\tjd_snippet\tcls\tcls_note\n';
const RENDERED_HTML_PATH = 'data/jobscan-out.html';

mkdirSync('data', { recursive: true });

const CONCURRENCY = 10;
const FETCH_TIMEOUT_MS = 10_000;
const JD_SNIPPET_CHARS = 1000;

// ── API detection ───────────────────────────────────────────────────

function detectApi(company) {
  const isWorkday = company.api_provider === 'workday'
    || (company.api && /\.myworkdayjobs\.com\/wday\/cxs\//.test(company.api));
  if (isWorkday && company.api) {
    return { type: 'workday', url: company.api, url_prefix: company.url_prefix || '' };
  }

  if (company.api_provider === 'smartrecruiters' && company.api) {
    return { type: 'smartrecruiters', url: company.api };
  }

  if (company.api && company.api.includes('greenhouse')) {
    return { type: 'greenhouse', url: company.api };
  }

  const url = company.careers_url || '';

  const ashbyMatch = url.match(/jobs\.ashbyhq\.com\/([^/?#]+)/);
  if (ashbyMatch) {
    return {
      type: 'ashby',
      url: `https://api.ashbyhq.com/posting-api/job-board/${ashbyMatch[1]}?includeCompensation=true`,
    };
  }

  const leverMatch = url.match(/jobs\.lever\.co\/([^/?#]+)/);
  if (leverMatch) {
    return {
      type: 'lever',
      url: `https://api.lever.co/v0/postings/${leverMatch[1]}`,
    };
  }

  const ghEuMatch = url.match(/job-boards(?:\.eu)?\.greenhouse\.io\/([^/?#]+)/);
  if (ghEuMatch && !company.api) {
    return {
      type: 'greenhouse',
      url: `https://boards-api.greenhouse.io/v1/boards/${ghEuMatch[1]}/jobs`,
    };
  }

  return null;
}

// ── API parsers ─────────────────────────────────────────────────────
// Each parser returns: { title, url, company, location, jd_snippet }

function stripHtml(html = '') {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
}

function snippet(text = '') {
  return stripHtml(text).slice(0, JD_SNIPPET_CHARS);
}

function parseGreenhouse(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.absolute_url || '',
    company: companyName,
    location: j.location?.name || '',
    // Greenhouse list endpoint rarely includes content — leave blank; skill may fetch later
    jd_snippet: snippet(j.content || ''),
  }));
}

function parseAshby(json, companyName) {
  const jobs = json.jobs || [];
  return jobs.map(j => ({
    title: j.title || '',
    url: j.jobUrl || '',
    company: companyName,
    location: j.location || '',
    jd_snippet: snippet(j.descriptionHtml || j.descriptionPlain || ''),
  }));
}

function parseLever(json, companyName) {
  if (!Array.isArray(json)) return [];
  return json.map(j => ({
    title: j.text || '',
    url: j.hostedUrl || '',
    company: companyName,
    location: j.categories?.location || '',
    jd_snippet: snippet(j.descriptionPlain || j.description || ''),
  }));
}

function parseSmartRecruiters(json, companyName) {
  const jobs = json.content || [];
  return jobs.map(j => ({
    title: j.name || '',
    url: j.ref || '',
    company: companyName,
    location: [j.location?.city, j.location?.region].filter(Boolean).join(', '),
    jd_snippet: '',
  }));
}

function parseWorkday(json, companyName, urlPrefix) {
  const postings = json.jobPostings || [];
  return postings.map(j => {
    const path = j.externalPath || '';
    const url = urlPrefix && path ? `${urlPrefix.replace(/\/$/, '')}${path}` : '';
    return {
      title: j.title || '',
      url,
      company: companyName,
      location: j.locationsText || '',
      jd_snippet: '', // Workday list doesn't include description; skill may fetch per-job
    };
  }).filter(j => j.url);
}

const PARSERS = { greenhouse: parseGreenhouse, ashby: parseAshby, lever: parseLever, workday: parseWorkday, smartrecruiters: parseSmartRecruiters };

// ── Fetch with timeout ──────────────────────────────────────────────

async function fetchJson(url, { method = 'GET', body = null } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const opts = { signal: controller.signal, method, headers: { 'Accept': 'application/json' } };
    if (body) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(body);
    }
    const res = await fetch(url, opts);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchSmartRecruitersAll(url, limit = 100) {
  const all = [];
  let offset = 0;
  while (true) {
    const pageUrl = `${url}?offset=${offset}&limit=${limit}`;
    const json = await fetchJson(pageUrl);
    const batch = json.content || [];
    all.push(...batch);
    const total = json.totalFound || 0;
    offset += batch.length;
    if (batch.length < limit || offset >= total || offset >= 2000) break;
  }
  return { content: all };
}

async function fetchWorkdayAll(url, limit = 20) {
  const all = [];
  let offset = 0;
  while (true) {
    const json = await fetchJson(url, { method: 'POST', body: { appliedFacets: {}, limit, offset, searchText: '' } });
    const batch = json.jobPostings || [];
    all.push(...batch);
    const total = typeof json.total === 'number' ? json.total : null;
    offset += batch.length;
    if (batch.length < limit) break;
    if (total !== null && offset >= total) break;
    if (offset >= 500) break;
  }
  return { jobPostings: all };
}

// ── Filters ─────────────────────────────────────────────────────────
// Filters are now imported from filter-core.mjs

// ── Dedup ───────────────────────────────────────────────────────────

function loadSeenUrls() {
  const seen = new Set();
  if (existsSync(SCAN_HISTORY_PATH)) {
    const lines = readFileSync(SCAN_HISTORY_PATH, 'utf-8').split('\n');
    for (const line of lines.slice(1)) {
      const url = line.split('\t')[0];
      if (url) seen.add(url);
    }
  }
  return seen;
}

// ── Writers ─────────────────────────────────────────────────────────

function ensureCandidatesHeader() {
  if (!existsSync(CANDIDATES_PATH)) {
    writeFileSync(CANDIDATES_PATH, CANDIDATES_HEADER, 'utf-8');
  }
}

function appendCandidates(offers) {
  ensureCandidatesHeader();
  if (offers.length === 0) return;
  const rows = offers.map(o => [
    o.url,
    o.title.replace(/\t/g, ' '),
    o.company.replace(/\t/g, ' '),
    (o.location || '').replace(/\t/g, ' '),
    o.source,
    (o.jd_snippet || '').replace(/\t/g, ' ').replace(/\n/g, ' '),
    '',
    '',
  ].join('\t')).join('\n') + '\n';
  appendFileSync(CANDIDATES_PATH, rows, 'utf-8');
}

function appendToScanHistory(offers, date) {
  if (!existsSync(SCAN_HISTORY_PATH)) {
    writeFileSync(
      SCAN_HISTORY_PATH,
      'url\tfirst_seen\tportal\ttitle\tcompany\tlocation\tstatus\tscore\trationale\n',
      'utf-8'
    );
  }
  const lines = offers.map(o => [
    o.url,
    date,
    o.source,
    o.title.replace(/\t/g, ' '),
    o.company.replace(/\t/g, ' '),
    (o.location || '').replace(/\t/g, ' '),
    'discovered',
    '',
    '',
  ].join('\t')).join('\n') + '\n';
  appendFileSync(SCAN_HISTORY_PATH, lines, 'utf-8');
}

// ── Concurrency ─────────────────────────────────────────────────────

async function parallelFetch(tasks, limit) {
  const results = [];
  let i = 0;
  async function next() {
    while (i < tasks.length) {
      const task = tasks[i++];
      results.push(await task());
    }
  }
  const workers = Array.from({ length: Math.min(limit, tasks.length) }, () => next());
  await Promise.all(workers);
  return results;
}

// ── Main ────────────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes('--dry-run');
  const companyFlag = args.indexOf('--company');
  const filterCompany = companyFlag !== -1 ? args[companyFlag + 1]?.toLowerCase() : null;
  const sizeFlag = args.indexOf('--size');
  const filterSize = sizeFlag !== -1 ? args[sizeFlag + 1]?.toLowerCase() : null;

  if (!existsSync(PORTALS_PATH)) {
    console.error('Error: portals.yml not found. Copy portals.example.yml → portals.yml first.');
    process.exit(1);
  }

  // Invalidate yesterday's rendered HTML so a downstream emailer cannot pick
  // up stale content during the race window before today's section + HTML are
  // (re)generated at the end of the run.
  if (!dryRun && existsSync(RENDERED_HTML_PATH)) {
    rmSync(RENDERED_HTML_PATH, { force: true });
    console.log(`Invalidated stale ${RENDERED_HTML_PATH} (will be regenerated by notify.mjs --html)`);
  }

  // Pipeline-level clear: scan.mjs is the L2 entry point for the full
  // pipeline and runs before scan-spa.mjs (L1). Clearing here once means
  // both scripts can safely append without clobbering each other.
  if (!dryRun && existsSync(CANDIDATES_PATH)) {
    rmSync(CANDIDATES_PATH, { force: true });
    console.log(`Cleared previous ${CANDIDATES_PATH} for fresh discovery run`);
  }

  // Archive previous jobscan-out.md by renaming it to its dated section header.
  const MD_OUT_PATH = 'data/jobscan-out.md';
  if (!dryRun && existsSync(MD_OUT_PATH)) {
    const mdContent = readFileSync(MD_OUT_PATH, 'utf-8');
    const dateMatch = mdContent.match(/^## (\d{4}-\d{2}-\d{2})/m);
    if (dateMatch) {
      const archiveDate = dateMatch[1];
      mkdirSync('data/archive', { recursive: true });
      const archivePath = `data/archive/jobscan-out-${archiveDate}.md`;
      renameSync(MD_OUT_PATH, archivePath);
      console.log(`Archived ${MD_OUT_PATH} → ${archivePath}`);
    }
  }

  const config = parseYaml(readFileSync(PORTALS_PATH, 'utf-8'));
  const companies = config.tracked_companies || [];
  const titleFilterConfig = config.title_filter;
  const locationFilterConfig = config.location_filter;

  const targets = companies
    .filter(c => c.enabled !== false)
    .filter(c => !filterCompany || c.name.toLowerCase().includes(filterCompany))
    .filter(c => !filterSize || (c.size || '').toLowerCase() === filterSize)
    .map(c => ({ ...c, _api: detectApi(c) }))
    .filter(c => c._api !== null);

  const skippedCount = companies.filter(c => c.enabled !== false).length - targets.length;

  console.log(`Scanning ${targets.length} companies via API (${skippedCount} skipped — no API detected)`);
  if (dryRun) console.log('(dry run — no files will be written)\n');

  const seenUrls = loadSeenUrls();
  const date = new Date().toISOString().slice(0, 10);
  let totalFound = 0;
  let totalFilteredTitle = 0;
  let totalFilteredLocation = 0;
  let totalDupes = 0;
  const newOffers = [];
  const errors = [];

  const tasks = targets.map(company => async () => {
    const { type, url, url_prefix } = company._api;
    try {
      const json = type === 'workday' ? await fetchWorkdayAll(url)
        : type === 'smartrecruiters' ? await fetchSmartRecruitersAll(url)
        : await fetchJson(url);
      const jobs = type === 'workday'
        ? PARSERS[type](json, company.name, url_prefix)
        : PARSERS[type](json, company.name);
      totalFound += jobs.length;

      for (const job of jobs) {
        if (!titleFilter(job.title, titleFilterConfig)) { totalFilteredTitle++; continue; }
        if (!locationFilter(job.location, locationFilterConfig)) { totalFilteredLocation++; continue; }
        if (seenUrls.has(job.url)) { totalDupes++; continue; }
        seenUrls.add(job.url);
        newOffers.push({ ...job, source: `${type}-api` });
      }
    } catch (err) {
      errors.push({ company: company.name, error: err.message });
    }
  });

  await parallelFetch(tasks, CONCURRENCY);

  if (!dryRun) {
    appendCandidates(newOffers);
    if (newOffers.length > 0) appendToScanHistory(newOffers, date);
  }

  console.log(`\n${'━'.repeat(45)}`);
  console.log(`JobScan Discovery — ${date}`);
  console.log(`${'━'.repeat(45)}`);
  console.log(`Companies scanned:     ${targets.length}`);
  console.log(`Total jobs found:      ${totalFound}`);
  console.log(`Filtered by title:     ${totalFilteredTitle}`);
  console.log(`Filtered by location:  ${totalFilteredLocation}`);
  console.log(`Duplicates:            ${totalDupes}`);
  console.log(`New candidates:        ${newOffers.length}`);

  if (errors.length > 0) {
    console.log(`\nErrors (${errors.length}):`);
    for (const e of errors) console.log(`  ✗ ${e.company}: ${e.error}`);
  }

  if (newOffers.length > 0 && !dryRun) {
    console.log(`\nWrote ${newOffers.length} candidates → ${CANDIDATES_PATH}`);
    console.log(`Appended to ${SCAN_HISTORY_PATH}`);
  } else if (newOffers.length > 0 && dryRun) {
    console.log('\n(dry run — run without --dry-run to save)');
  }

  console.log(`\n→ ${newOffers.length} candidates ready for scoring.`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
