#!/usr/bin/env node

/**
 * scan-spa.mjs — Playwright-based SPA discovery scanner.
 *
 * Complements scan.mjs (API scanner). For each company in portals.yml with
 *   enabled: true
 *   scan_method: playwright
 *   spa: { wait_selector, job_card_selector, title_selector, url_selector, location_selector? }
 * launches headless Chromium, navigates to careers_url, waits for results
 * to hydrate, extracts job cards via CSS selectors, applies
 * title/location filters, dedups against scan-history.tsv, and appends
 * survivors to data/jobscan-new.tsv.
 *
 * Sequential only. No parallel page launches.
 */

import { chromium } from 'playwright';
import { readFile, appendFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import yaml from 'js-yaml';
import { titleFilter, locationFilter } from './filter-core.mjs';

const PORTALS_PATH = 'portals.yml';
const HISTORY_PATH = 'data/scan-history.tsv';
const NEW_PATH = 'data/jobscan-new.tsv';
const NAV_TIMEOUT = 20000;
const WAIT_TIMEOUT = 10000;
const HYDRATION_DELAY_MS = 2000;

async function loadPortals() {
  const text = await readFile(PORTALS_PATH, 'utf-8');
  return yaml.load(text);
}

async function loadHistoryUrls() {
  if (!existsSync(HISTORY_PATH)) return new Set();
  const text = await readFile(HISTORY_PATH, 'utf-8');
  const urls = new Set();
  for (const line of text.split('\n').slice(1)) {
    const url = line.split('\t')[0];
    if (url) urls.add(url);
  }
  return urls;
}

async function ensureNewHeader() {
  if (!existsSync(NEW_PATH)) {
    await writeFile(NEW_PATH, 'url\ttitle\tcompany\tlocation\tsource\tjd_snippet\tcls\tcls_note\n');
  }
}

function hasAllRequiredSelectors(spa) {
  return !!(
    spa &&
    spa.wait_selector &&
    spa.job_card_selector &&
    spa.title_selector &&
    spa.url_selector
  );
}

// Generic heuristic — used when spa.auto === true. Tries common careers-page
// DOM patterns in order; first to yield ≥ MIN_AUTO_CARDS real-looking cards
// wins. Accepts more noise than tuned selectors but needs zero configuration.
const AUTO_PATTERNS = [
  // Phenom (Abbott, Honeywell, many Fortune 500)
  { name: 'phenom',      card: '[data-ph-at-id="jobs-list-item"]', title: '[data-ph-at-id="job-link"]', url: '[data-ph-at-id="job-link"]', loc: '.job-location, [class*="location"]' },
  // TalentBrew (HCSC, Baxter, many healthcare)
  { name: 'talentbrew',  card: '#search-results li',               title: 'h2, h3',                     url: 'a[data-job-id], a[href*="/job/"]', loc: '.job-location, [class*="location"]' },
  // Attrax (AbbVie)
  { name: 'attrax',      card: '.attrax-vacancy-tile',             title: '.attrax-vacancy-tile__title', url: '.attrax-vacancy-tile__title', loc: '.attrax-vacancy-tile__location-freetext' },
  // Generic "job-card" class variants
  { name: 'job-card',    card: '[class*="job-card"], [class*="job-tile"], [class*="job-listing"]', title: 'h2, h3, [class*="title"]', url: 'a[href*="/job"]', loc: '[class*="location"]' },
  // Generic job anchor list
  { name: 'job-anchors', card: 'a[href*="/job/"], a[href*="/jobs/"], a[href*="/careers/"]', title: ':self', url: ':self', loc: null },
];
const MIN_AUTO_CARDS = 3;

async function scrapeCompany(page, company) {
  const { spa, careers_url, name } = company;

  const isAuto = spa && spa.auto === true && !hasAllRequiredSelectors(spa);

  if (!isAuto && !hasAllRequiredSelectors(spa)) {
    console.log(`${name}: no spa selectors configured — skipped`);
    return [];
  }

  // Auto mode uses a single page + pattern probe, no pagination
  if (isAuto) {
    try {
      await page.goto(careers_url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (err) {
      console.log(`${name}: navigation failed — ${err.message.split('\n')[0]}`);
      return [];
    }
    await page.waitForTimeout(HYDRATION_DELAY_MS);

    try {
      const { pattern, rows } = await page.evaluate(({ patterns, min }) => {
        const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
        for (const p of patterns) {
          const cards = Array.from(document.querySelectorAll(p.card));
          if (cards.length < min) continue;
          const rows = cards.map(card => {
            let titleEl, urlEl, locEl;
            if (p.title === ':self') titleEl = card; else titleEl = card.querySelector(p.title);
            if (p.url === ':self') urlEl = card; else urlEl = card.querySelector(p.url);
            locEl = p.loc ? card.querySelector(p.loc) : null;
            return {
              title: norm(titleEl?.innerText || titleEl?.textContent),
              url: (urlEl?.href) || '',
              location: norm(locEl?.innerText || locEl?.textContent),
            };
          }).filter(r => r.title && r.url);
          if (rows.length >= min) return { pattern: p.name, rows };
        }
        return { pattern: null, rows: [] };
      }, { patterns: AUTO_PATTERNS, min: MIN_AUTO_CARDS });

      if (!pattern) {
        console.log(`${name}: auto mode — no pattern matched, 0 cards`);
        return [];
      }
      console.log(`${name}: auto mode — matched ${pattern} pattern`);
      return rows;
    } catch (err) {
      console.log(`${name}: auto extraction failed — ${err.message.split('\n')[0]}`);
      return [];
    }
  }

  // Tuned mode: paginated explicit selectors
  const pagination = spa.pagination;
  const startPage = pagination?.start_page ?? 1;
  const maxPages = pagination?.max_pages ?? 1;
  const pageParam = pagination?.page_param;

  const allRaw = [];
  const seenUrls = new Set();

  for (let pageNum = startPage; pageNum <= startPage + maxPages - 1; pageNum++) {
    // Build URL for this page
    let url;
    if (pageNum === startPage) {
      url = careers_url;
    } else {
      if (!pageParam) break; // can't paginate without page_param
      const sep = careers_url.includes('?') ? '&' : '?';
      url = `${careers_url}${sep}${pageParam}=${pageNum}`;
    }

    try {
      await page.goto(url, { waitUntil: 'domcontentloaded', timeout: NAV_TIMEOUT });
    } catch (err) {
      console.log(`${name}: navigation to page ${pageNum} failed — ${err.message.split('\n')[0]}`);
      break;
    }

    await page.waitForSelector(spa.wait_selector, { timeout: WAIT_TIMEOUT }).catch(() => {});
    await page.waitForTimeout(HYDRATION_DELAY_MS);

    let pageRaw;
    try {
      pageRaw = await page.evaluate((sel) => {
        const cards = Array.from(document.querySelectorAll(sel.job_card_selector));
        return cards.map(card => {
          const titleEl = card.querySelector(sel.title_selector);
          const urlEl = card.querySelector(sel.url_selector);
          const locEl = sel.location_selector ? card.querySelector(sel.location_selector) : null;
          const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
          return {
            title: norm(titleEl?.innerText || titleEl?.textContent),
            url: urlEl?.href || '',
            location: norm(locEl?.innerText || locEl?.textContent),
          };
        });
      }, spa);
    } catch (err) {
      console.log(`${name}: extraction on page ${pageNum} failed — ${err.message.split('\n')[0]}`);
      break;
    }

    // Stop if page returned nothing
    if (pageRaw.length === 0) break;

    // Stop if all URLs were already seen (pagination wrapped / exhausted)
    const novel = pageRaw.filter(r => r.url && !seenUrls.has(r.url));
    if (novel.length === 0) break;

    for (const r of novel) seenUrls.add(r.url);
    allRaw.push(...novel);
  }

  return allRaw;
}

async function main() {
  const args = process.argv.slice(2);
  const sizeFlag = args.indexOf('--size');
  const filterSize = sizeFlag !== -1 ? args[sizeFlag + 1]?.toLowerCase() : null;

  const cfg = await loadPortals();
  const targets = (cfg.tracked_companies || []).filter(
    c => c.enabled && c.scan_method === 'playwright' && c.spa
  ).filter(c => !filterSize || (c.size || '').toLowerCase() === filterSize);

  if (targets.length === 0) {
    console.log('scan-spa: no SPA companies with spa: blocks configured — nothing to do');
    return;
  }

  const history = await loadHistoryUrls();
  await ensureNewHeader();

  let browser;
  try {
    browser = await chromium.launch({ headless: true });
  } catch (err) {
    console.error(`Chromium launch failed: ${err.message}`);
    console.error('Run: npm install && npx playwright install chromium');
    process.exit(1);
  }

  const page = await browser.newPage();
  page.setDefaultTimeout(NAV_TIMEOUT);

  const newTsvRows = [];
  const newHistoryRows = [];
  const today = new Date().toISOString().slice(0, 10);

  for (const company of targets) {
    const raw = await scrapeCompany(page, company);

    let kept = 0;
    for (const r of raw) {
      if (!r.url || !r.title) continue;
      if (history.has(r.url)) continue;
      // title + location filters apply per row, regardless of page
      if (!titleFilter(r.title, cfg.title_filter)) continue;
      if (!locationFilter(r.location, cfg.location_filter)) continue;

      newTsvRows.push([
        r.url, r.title, company.name, r.location,
        'playwright', '', '', ''
      ].join('\t'));
      newHistoryRows.push([
        r.url, today, 'playwright', r.title, company.name,
        r.location, 'discovered', '', ''
      ].join('\t'));
      history.add(r.url);
      kept++;
    }
    console.log(`${company.name}: ${raw.length} cards scraped, ${kept} new candidates`);
  }

  await browser.close();

  if (newTsvRows.length > 0) {
    await appendFile(NEW_PATH, newTsvRows.join('\n') + '\n');
    await appendFile(HISTORY_PATH, newHistoryRows.join('\n') + '\n');
  }

  console.log(`scan-spa complete — ${newTsvRows.length} new candidates across ${targets.length} companies`);
}

main().catch(err => {
  console.error('Fatal:', err.message);
  process.exit(1);
});
