// filter-core.mjs — shared title/location filters for scan.mjs + scan-spa.mjs

/**
 * titleFilter(title, cfg): returns true if title passes the filter.
 * Rule: at least 1 positive keyword matches (or positives is empty) AND 0 negative keywords match.
 * Both positive and negative keywords use case-insensitive substring matching.
 */
export function titleFilter(title, cfg) {
  if (!title) return false;
  const lower = title.toLowerCase();
  const positives = (cfg?.positive || []).map(k => k.toLowerCase());
  const negatives = (cfg?.negative || []).map(k => k.toLowerCase());

  const hasPositive = positives.length === 0 || positives.some(k => lower.includes(k));
  const hasNegative = negatives.some(k => lower.includes(k));

  return hasPositive && !hasNegative;
}

/**
 * locationFilter(location, cfg): returns true if location passes the filter.
 * Rule: empty location → kept. Any negative match → removed (word-boundary, case-insensitive).
 * If positives non-empty → at least one must match (word-boundary, case-insensitive).
 */
export function locationFilter(location, cfg) {
  const loc = location || '';
  if (!loc.trim()) return true;

  const positives = cfg?.positive || [];
  const negatives = cfg?.negative || [];

  const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const buildMatcher = (keywords) => {
    if (!keywords || keywords.length === 0) return null;
    const pattern = new RegExp('\\b(' + keywords.map(k => escapeRegex(k)).join('|') + ')\\b', 'i');
    return (location) => pattern.test(location || '');
  };

  const matchPositive = buildMatcher(positives);
  const matchNegative = buildMatcher(negatives);

  if (matchNegative && matchNegative(loc)) return false;
  if (matchPositive && !matchPositive(loc)) return false;

  return true;
}
