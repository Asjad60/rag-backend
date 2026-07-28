/**
 * Stage C & D: Quality Gates (Pass/Fail Checks).
 * Evaluates whether normalized text meets quality standards for RAG indexing.
 */

const SOFT_404_PATTERNS = [
  /404\s*-\s*page\s*not\s*found/i,
  /page\s*not\s*found/i,
  /403\s*forbidden/i,
  /access\s*denied/i,
  /500\s*internal\s*server\s*error/i,
  /service\s*unavailable/i,
  /the\s*requested\s*url\s*was\s*not\s*found/i,
  /this\s*domain\s*is\s*parked/i,
  /under\s*maintenance/i,
];

const EXCLUDED_URL_PATTERNS = [
  /sitemap/i,
  /\/cart/i,
  /\/checkout/i,
  /\/account/i,
  /\/login/i,
  /\/register/i,
  /\/search/i,
  /\/wishlist/i,
  /\/order/i,
];

function checkQualityGates(normalizedData) {
  const { rawText, metrics, pageTitle, url } = normalizedData;

  // 0. Excluded URL pattern check (sitemaps, cart, utility pages)
  if (url) {
    for (const pattern of EXCLUDED_URL_PATTERNS) {
      if (pattern.test(url)) {
        return {
          pass: false,
          reason: `Excluded utility or sitemap URL pattern (${pattern.toString()})`,
          metrics,
        };
      }
    }
  }

  // 1. Empty content check
  if (!rawText || !rawText.trim()) {
    return {
      pass: false,
      reason: 'Empty page body text',
      metrics,
    };
  }

  // 2. Minimum word count threshold
  if (metrics.wordCount < 30) {
    return {
      pass: false,
      reason: `Low word count (${metrics.wordCount} words < 30 threshold)`,
      metrics,
    };
  }

  // 3. Soft-404 & HTTP Error page detection
  const combinedStr = `${pageTitle}\n${rawText.slice(0, 1000)}`;
  for (const pattern of SOFT_404_PATTERNS) {
    if (pattern.test(combinedStr)) {
      return {
        pass: false,
        reason: `Soft-404 or HTTP error page detected (${pattern.toString()})`,
        metrics,
      };
    }
  }

  return {
    pass: true,
    reason: null,
    metrics,
  };
}

module.exports = { checkQualityGates };
