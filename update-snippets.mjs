import { readFileSync, writeFileSync } from 'fs';

const TSV = 'data/jobscan-new.tsv';
const HIST = 'data/scan-history.tsv';

const NTAM_SNIPPET = "The Global Director for NTAM Tech serves as the primary executive leader responsible for defining and executing an integrated technology strategy and roadmap that delivers a distinctive, transparent, cost-effective, and resilient platform in support of NTAM's client, product, and partner priorities. This role oversees multiple technology functions, provides leadership to senior managers and teams, and owns the performance, development, and organizational health of the Business Unit's technology organizations. Required: 20+ years leading enterprise-scale CIO or Head of Technology roles in financial services. Management consulting background strongly preferred. Board and management committee representation experience. Engagement with audit, external auditors, and global regulators. Track record overseeing technology contractors and service providers. Asset management domain expertise. AI implementation and scaling within investments businesses. Salary $240-350K. Chicago, IL hybrid.";

const EXPIRED_URLS = new Set([
  'https://www.mondelezinternational.com/careers/jobs/job?jobid=r-155604&jobtitle=cs&l%20projects%20and%20digital%20lead',
  'https://careers.united.com/us/en/job/HSC00001050/Manager-IT-Applications-Development',
]);

const NTAM_URL = 'https://ntrs.wd1.myworkdayjobs.com/en-US/northerntrust/job/Chicago-IL/Global-Director---NTAM-Technology_R153269';

// Update jobscan-new.tsv
const lines = readFileSync(TSV, 'utf-8').split('\n').filter(Boolean);
const header = lines[0];
const rows = lines.slice(1).map(l => l.split('\t')).map(p => { while (p.length < 8) p.push(''); return p; });

const kept = [];
for (const r of rows) {
  if (EXPIRED_URLS.has(r[0])) continue; // drop expired
  if (r[0] === NTAM_URL) {
    r[5] = NTAM_SNIPPET.replace(/\s+/g, ' ').slice(0, 1000);
  }
  kept.push(r);
}
writeFileSync(TSV, header + '\n' + kept.map(r => r.join('\t')).join('\n') + '\n', 'utf-8');

// Update scan-history.tsv: mark expired and update strong NTAM row
const histLines = readFileSync(HIST, 'utf-8').split('\n');
for (let i = 1; i < histLines.length; i++) {
  if (!histLines[i]) continue;
  const cols = histLines[i].split('\t');
  while (cols.length < 9) cols.push('');
  if (EXPIRED_URLS.has(cols[0])) {
    cols[6] = 'skipped_expired';
    cols[8] = 'liveness check: page no longer available';
    histLines[i] = cols.join('\t');
  }
}
writeFileSync(HIST, histLines.join('\n'), 'utf-8');

console.log(`Kept ${kept.length} rows; expired ${EXPIRED_URLS.size}; NTAM snippet populated.`);
