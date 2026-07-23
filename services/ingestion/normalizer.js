const cheerio = require('cheerio');
const { URL } = require('url');
const crypto = require('crypto');

/**
 * Detects page type based on URL path and text signals.
 */
function detectPageType(urlString, $) {
  try {
    const path = new URL(urlString).pathname.toLowerCase();
    const bodyText = $('body').text().toLowerCase();

    if (/contact|reach-us|get-in-touch|support/.test(path)) return 'contact_page';
    if (/about|company|team|who-we-are|our-story/.test(path)) return 'about_page';
    if (/product|shop|store|catalog|item|sku/.test(path)) return 'product_page';
    if (/service|solution|offering/.test(path)) return 'service_page';
    if (/faq|help|knowledge|support/.test(path)) return 'faq_page';
    if (/blog|article|news|post/.test(path)) return 'blog_page';
    if (/pricing|plan|subscription/.test(path)) return 'pricing_page';
    if (path === '/' || path === '') return 'homepage';

    if (/contact us|get in touch|send us a message/.test(bodyText)) return 'contact_page';
    if (/frequently asked questions|faq/.test(bodyText)) return 'faq_page';
  } catch (_) {}
  return 'general_page';
}

/**
 * Extracts contact emails and phones.
 */
function extractContactInfo($) {
  const bodyText = $('body').text();
  const emailMatch = bodyText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  const phoneMatch = bodyText.match(/(\+?\d[\d\s\-().]{7,}\d)/g) || [];
  return {
    emails: [...new Set(emailMatch)].slice(0, 5),
    phones: [...new Set(phoneMatch.map(p => p.trim()))].slice(0, 5),
  };
}

/**
 * Stage B: Page Normalization & Metadata Extraction.
 * Standardizes HTML or Markdown into structured text, headers, and metadata.
 */
function normalizePage(input, pageUrl = '') {
  let isHtml = typeof input === 'string' && (input.includes('<html') || input.includes('<body') || input.includes('<div') || input.includes('<p>') || input.includes('<h'));
  let pageTitle = '';
  let pageType = 'general_page';
  let contactInfo = { emails: [], phones: [] };
  let rawText = '';
  let headers = [];
  let tableCount = 0;
  let codeBlockCount = 0;

  if (isHtml) {
    const $ = cheerio.load(input);

    pageTitle = $('title').text().trim();
    if (!pageTitle && pageUrl) {
      try { pageTitle = new URL(pageUrl).hostname; } catch (_) {}
    }
    pageType = detectPageType(pageUrl, $);
    contactInfo = extractContactInfo($);

    // Count tables and code blocks before cleanup
    tableCount = $('table').length;
    codeBlockCount = $('pre, code').length;

    // Preserve headings for structural outline
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim();
      if (text) headers.push({ level: tag, text });
    });

    // Remove noise elements
    $('script, style, noscript, iframe, svg, nav, footer, header, [class*="cookie"], [class*="popup"], [class*="breadcrumb"], [class*="sidebar"], [role="navigation"]').remove();

    // Preserve <a href> links as markdown before extracting text
    if (pageUrl) {
      $('a[href]').each((_, el) => {
        const $a = $(el);
        const href = ($a.attr('href') || '').trim();
        const linkText = $a.text().trim();

        if (!href || !linkText || linkText.length < 2 || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:') || href.startsWith('tel:')) {
          $a.replaceWith(linkText);
          return;
        }

        try {
          const absoluteUrl = new URL(href, pageUrl).toString();
          $a.replaceWith(`[${linkText}](${absoluteUrl})`);
        } catch (_) {
          $a.replaceWith(linkText);
        }
      });
    }

    // Build clean text with header markers
    let structuredText = '';
    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const hText = $(el).text().trim();
      if (hText) structuredText += `\n\n## ${hText}\n`;
    });

    $('p, li, td, th, blockquote, figcaption, address, dt, dd, pre, span, div, bdi, ins').each((_, el) => {
      const t = $(el).text().trim();
      const hasPriceOrLink = /[\$€£]|usd|price|cost|starting at|\b\d+(\.\d{2})?\b|\[.+\]\(.+\)/i.test(t);
      if (t.length > 15 || hasPriceOrLink) {
        structuredText += t + '\n';
      }
    });

    if (!structuredText.trim()) {
      structuredText = $('body').text().replace(/\s+/g, ' ').trim();
    }

    rawText = structuredText.trim();
  } else {
    // Input is raw markdown / plain text
    rawText = (input || '').trim();
    const lines = rawText.split('\n');
    lines.forEach(line => {
      const match = line.match(/^(#{1,6})\s+(.+)/);
      if (match) {
        headers.push({ level: `h${match[1].length}`, text: match[2].trim() });
      }
    });
    codeBlockCount = (rawText.match(/```/g) || []).length / 2;
    tableCount = (rawText.match(/\|[\s-]+\|/g) || []).length;

    const titleMatch = rawText.match(/^#\s+(.+)/m);
    if (titleMatch) pageTitle = titleMatch[1].trim();

    const emailMatch = rawText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
    const phoneMatch = rawText.match(/(\+?\d[\d\s\-().]{7,}\d)/g) || [];
    contactInfo = {
      emails: [...new Set(emailMatch)].slice(0, 5),
      phones: [...new Set(phoneMatch.map(p => p.trim()))].slice(0, 5),
    };
  }

  const wordCount = rawText.split(/\s+/).filter(Boolean).length;
  const cjkCount = (rawText.match(/[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7a3]/g) || []).length;
  const totalWords = wordCount + cjkCount;

  const contentHash = crypto.createHash('sha256').update(rawText).digest('hex');

  return {
    url: pageUrl,
    pageTitle: pageTitle || 'Untitled Page',
    pageType,
    contactInfo,
    rawText,
    headers,
    metrics: {
      wordCount: totalWords,
      tableCount,
      codeBlockCount,
      headersCount: headers.length,
    },
    contentHash,
  };
}

module.exports = { normalizePage, detectPageType };
