// One-shot classifier — applies the jobscan rubric to data/jobscan-new.tsv
// in-place. Heuristic rules tuned to the candidate's IT-leadership target.
import { readFileSync, writeFileSync } from 'fs';

const TSV = 'data/jobscan-new.tsv';
const HIST = 'data/scan-history.tsv';

const lines = readFileSync(TSV, 'utf-8').split('\n').filter(Boolean);
const header = lines[0];
const rows = lines.slice(1).map(l => {
  const parts = l.split('\t');
  while (parts.length < 8) parts.push('');
  return parts;
});

// Hard skip patterns — clinical, blue-collar, sales, audit, non-IT engineering,
// non-job nav links from SPA scrapes.
const SKIP_RE = new RegExp([
  'nurse','patient care','physician','hospitalist','sonographer','paramedic',
  'pharmacist','pharmacy tech','dietitian','therapist','rehab','clinical pharm',
  'phlebotom','cardio(graph|logist|vascular| surger|-genetic)','anesthesi',
  'oncolog','radiolog','endocrin','obgyn','obstetric','gynecol','urolog',
  'pediatric','psychiatr','neurolog','transplant','surgery','surgical',
  'electrophysiology','interventional','transitional care','infirmary',
  'health unit coordinator','medical assistant','wait staff','food service',
  'food prep','food & nutrition','nutrition services','cook -','cook/food',
  'security officer','facilities engineer','facility maintenance','maintenance technician',
  'general maintenance','groundskeeper','janitor','custodian','wait staff',
  'community health','social worker','case manager','outcomes manager','outcomes research',
  'magnet program','program coordinator','genetic counselor','rehab nurse','nursing',
  'embryolog','andrologist','respirat','telemetry','ct technologist','ekg',
  'ic[uU]','perfusion','transplantation','hospitalist','emergency medicine',
  'reproductive endo','molecular technologist','surgical tech','speech pathologist',
  'occupational health','palliative','immediate care','endocrinology',
  'underwriting','underwriter','treasury','tax manager','tax-income','tax-',
  'cpa','audit','accountant','accounting$','reliability engineering','reliability',
  'reliability compliance','energy storage','electrical engineer','renewable training',
  'permitting','thermal project','manager - financial reporting','financial reporting',
  'category manager','revenue growth','revenue operations','revenue ops',
  'business development','client manager','account lead','account director',
  'key accounts','account executive','client director','solutions director',
  'tradeshow','event strategy','communications','contract manager','executive support',
  'admin & office','customer support','customer success','property manager',
  'facilities coordinator','assistant property','relocation','facilities compressor',
  'biologics','drug product','product cybersecurity','cybersecurity engineer',
  'product security','software engineer','quality engineer','principal engineer',
  'sr\\. engineer','sr engineer','senior engineer','interoperability',
  'molecular','biolog','chemist','laborator','radiologic',
  'managing engineer - security','it compliance auditor','compliance auditor',
  'spiritual care','child life','peer support',
  // SPA noise / non-job pages
  '^benefits$','^benefits ','flex - powering','privacy statement','labor condition',
  'deloitte us','assistance for people','university relations','student development',
  'military and veterans','search jobs','talent community','what we do','why cpa',
  'careers in','what it.s like','flexibility and mobility','early career',
  'mba and advanced','join our community','recruiting and hiring','recruiting process',
  'benefits & compensation','compensation','psych social',
].join('|'), 'i');

// Strong patterns — explicit IT leadership matches (Director/VP/Head of) AND
// clear IT/portfolio/PMO/digital/program/projects domain.
const STRONG_RE = new RegExp([
  'director.*(technology|it |digital|transformation|pmo|portfolio|program management)',
  '(vp|vice president|head of).*(it|technology|digital|pmo|portfolio|transformation|engineering|software|delivery)',
  '\\bcio\\b','\\bcto\\b',
  'manager.*it appl', 'it.*program', 'program management office',
  'projects? and digital','digital and projects','digital transformation',
  'enterprise pmo','head of pmo',
].join('|'), 'i');

// Plausible — has seniority word but adjacent domain or borderline.
const SENIOR_RE = /\b(director|senior manager|sr\.? manager|vp|vice president|head of|chief|principal|managing director|associate director)\b/i;
const PLAUSIBLE_DOMAIN_RE = /(program manager|product manager|technical program|software engineering|engineering|architect|portfolio|strategy|business operations|gtm enablement|enablement|operating system|data platform|cloud|ai |ml engineering|innovation|sa&i|business partner|key accounts? director|enterprise solutions|project controls|technology|technical)/i;

// Manual overrides (idx -> cls). 1-indexed against current TSV order.
const OVERRIDES = new Map([
  // Strong picks (override what regex might miss)
  [10, ['strong', 'Director, Technology — direct match for IT leadership target']],
  [333, ['strong', 'IT Applications Development manager — domain + seniority match']],
  [9, ['strong', 'Projects + Digital Lead — direct PMO/digital transformation match']],
  // Force skips on items that might slip through
  [12, ['skip', 'Global markets/commodities, not IT']],
  [22, ['skip', 'Communications, not IT']],
  [39, ['plausible', 'Director seniority but GTM enablement is sales-adjacent']],
  [32, ['skip', 'Strategy/BizOps, not IT delivery']],
  [34, ['skip', 'Strategic Planning, not IT']],
  [36, ['skip', 'Revenue ops, not IT']],
  [73, ['plausible', 'Associate Director Strategy & Corp Dev — seniority but corp dev not IT']],
  [76, ['plausible', 'Managing Director generic — domain unclear']],
  [30, ['plausible', 'Managing Director CRE — seniority but real estate domain']],
  [75, ['plausible', 'Director, SA&I — analytics-adjacent']],
  [50, ['plausible', 'Enterprise Solutions Director — sales/solutions, adjacent']],
  [57, ['plausible', 'Director Project Controls — projects but capital construction']],
  [60, ['plausible', 'Manager Software Engineering — adjacent IT delivery']],
  [62, ['plausible', 'Manager Software Engineering — adjacent IT delivery']],
  [61, ['plausible', 'Manager Product Support — adjacent ops/IT']],
  [66, ['plausible', 'Director AI & ML Engineering — engineering leadership, adjacent']],
  [332, ['plausible', 'Principal Developer-IT — IC role, below leadership target']],
  [334, ['plausible', 'Chief Architect — technical leadership, adjacent to IT director']],
  [40, ['plausible', 'Program Manager — generic, no IT signal in title']],
  [42, ['plausible', 'PM/Scrum Master — adjacent delivery role']],
  [43, ['plausible', 'Senior Product Manager — adjacent']],
  [44, ['plausible', 'Portfolio Specialist — portfolio keyword but specialist is below target']],
  [59, ['plausible', 'Senior PM Cloud Storage — adjacent IT/cloud']],
  [37, ['plausible', 'Principal PM Mortgage OS — adjacent operating-system delivery']],
  [38, ['plausible', 'Senior PM Data Platform — adjacent platform/IT']],
  [33, ['plausible', 'Senior TPM — adjacent IT delivery']],
  [1, ['plausible', 'Sr Manager Product Management (Technical) — adjacent IT/product']],
  [63, ['plausible', 'AI Product Manager — adjacent product/IT']],
  [35, ['plausible', 'Senior PM Accounting — adjacent IT/finance product']],
  // Cushman, JLL noise
  [41, ['skip', 'Procurement category manager']],
  [17, ['skip', 'Underwriting director']],
  [19, ['skip', 'Underwriting director']],
  [65, ['skip', 'Business development director']],
  [67, ['skip', 'Key Accounts director — sales']],
  [4, ['skip', 'Drug product development']],
]);

let strongN = 0, plausibleN = 0, skipN = 0;
for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const title = r[1] || '';
  const ord = i + 1;

  if (OVERRIDES.has(ord)) {
    const [cls, why] = OVERRIDES.get(ord);
    r[6] = cls; r[7] = why;
  } else if (SKIP_RE.test(title)) {
    r[6] = 'skip'; r[7] = 'wrong domain or below leadership scope';
  } else if (STRONG_RE.test(title)) {
    r[6] = 'strong'; r[7] = 'IT leadership keyword + seniority match';
  } else if (SENIOR_RE.test(title) && PLAUSIBLE_DOMAIN_RE.test(title)) {
    r[6] = 'plausible'; r[7] = 'seniority + adjacent domain';
  } else if (SENIOR_RE.test(title)) {
    r[6] = 'plausible'; r[7] = 'seniority word; domain unclear from title';
  } else {
    r[6] = 'skip'; r[7] = 'no leadership/IT signal in title';
  }

  if (r[6] === 'strong') strongN++;
  else if (r[6] === 'plausible') plausibleN++;
  else skipN++;
}

const out = header + '\n' + rows.map(r => r.join('\t')).join('\n') + '\n';
writeFileSync(TSV, out, 'utf-8');

// Mirror into scan-history.tsv: status += classified_<cls>, rationale = why for non-strong
const histLines = readFileSync(HIST, 'utf-8').split('\n');
const urlToRow = new Map(rows.map(r => [r[0], r]));
for (let i = 1; i < histLines.length; i++) {
  if (!histLines[i]) continue;
  const cols = histLines[i].split('\t');
  while (cols.length < 9) cols.push('');
  const url = cols[0];
  const r = urlToRow.get(url);
  if (!r) continue;
  cols[6] = `classified_${r[6]}`;
  if (r[6] !== 'strong') cols[8] = r[7];
  histLines[i] = cols.join('\t');
}
writeFileSync(HIST, histLines.join('\n'), 'utf-8');

console.log(`Classified ${rows.length} titles — strong: ${strongN}, plausible: ${plausibleN}, skip: ${skipN}`);
