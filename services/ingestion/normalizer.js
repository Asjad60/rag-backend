const cheerio = require('cheerio');
const { URL } = require('url');
const crypto = require('crypto');

/**
 * Checks if input text is HTML content using precise HTML tag patterns.
 * Prevents false positives on Markdown files containing URLs (<http...>) or emails (<user@domain>).
 *
 * @param {string} input
 * @returns {boolean}
 */
function isHtmlInput(input) {
  if (typeof input !== 'string' || !input.trim()) return false;
  return /<\s*(?:!DOCTYPE|html|body|div|p|span|table|h[1-6]|ul|ol|li|section|article|header|footer|script|style|main|nav|aside|form|blockquote|pre|code)\b/i.test(input);
}

/**
 * Safely parses a URL string with base fallback to handle relative paths (/contact, products/item).
 *
 * @param {string} urlString
 * @returns {{ path: string, host: string, fullUrl: string }}
 */
function safeParseUrl(urlString) {
  if (!urlString || typeof urlString !== 'string') {
    return { path: '', host: '', fullUrl: '' };
  }
  try {
    const parsed = new URL(urlString, 'http://localhost');
    return {
      path: parsed.pathname.toLowerCase(),
      host: parsed.hostname === 'localhost' ? '' : parsed.hostname.toLowerCase(),
      fullUrl: parsed.href,
    };
  } catch (_) {
    return { path: urlString.toLowerCase(), host: '', fullUrl: urlString };
  }
}

/**
 * Detects page type based on URL path, JSON-LD schema types, page meta tags, and body text signals.
 *
 * @param {string} urlString - Page URL or relative path
 * @param {object} $ - Cheerio root object (optional)
 * @param {string[]} jsonLdTypes - List of schema types detected in JSON-LD (optional)
 * @returns {string}
 */
function detectPageType(urlString = '', $ = null, jsonLdTypes = []) {
  const { path } = safeParseUrl(urlString);

  // 1. JSON-LD Schema Type Signals (Highest Confidence)
  const schemaTypes = jsonLdTypes.map(t => String(t).toLowerCase());
  if (schemaTypes.some(t => ['product', 'individualproduct', 'someproduct'].includes(t))) return 'product_page';
  if (schemaTypes.some(t => ['faqpage'].includes(t))) return 'faq_page';
  if (schemaTypes.some(t => ['contactpage', 'localbusiness'].includes(t))) return 'contact_page';
  if (schemaTypes.some(t => ['aboutpage'].includes(t))) return 'about_page';
  if (schemaTypes.some(t => ['service'].includes(t))) return 'service_page';
  if (schemaTypes.some(t => ['article', 'blogposting', 'newsarticle'].includes(t))) return 'blog_page';

  // 2. URL Path Pattern Signals
  if (/contact|reach-us|get-in-touch|support|contact-us|location|locations|branches/.test(path)) return 'contact_page';
  if (/about|company|team|who-we-are|our-story|mission|vision|history|leadership/.test(path)) return 'about_page';
  if (/product|products|shop|store|catalog|item|sku|cart|buy|\/p\/|\/dp\/|\/pd\/|collection|collections/.test(path)) return 'product_page';
  if (/service|services|solution|solutions|offering|offerings/.test(path)) return 'service_page';
  if (/faq|faqs|help|knowledge|knowledgebase|support-faq/.test(path)) return 'faq_page';
  if (/blog|blogs|article|articles|news|post|posts/.test(path)) return 'blog_page';
  if (/pricing|plans|price|prices|subscription|rates/.test(path)) return 'pricing_page';
  if (path === '/' || path === '' || path === '/index.html' || path === '/index.php') return 'homepage';

  // 3. HTML Meta & Body Signals (if Cheerio instance available)
  if ($) {
    try {
      const ogType = ($('meta[property="og:type"]').attr('content') || '').toLowerCase();
      if (ogType.includes('product')) return 'product_page';
      if (ogType.includes('article')) return 'blog_page';

      const pageTitle = $('title').text().toLowerCase();
      if (/contact us|get in touch/.test(pageTitle)) return 'contact_page';
      if (/frequently asked questions|faq/.test(pageTitle)) return 'faq_page';
      if (/about us|who we are/.test(pageTitle)) return 'about_page';
      if (/pricing|plans/.test(pageTitle)) return 'pricing_page';

      const bodyText = $('body').text().toLowerCase();
      if (/\b(add to cart|buy now|in stock|out of stock|sku:|item #|msrp:|add to bag|checkout)\b/.test(bodyText)) return 'product_page';
      if (/frequently asked questions|f\.a\.q\.|faq/.test(bodyText)) return 'faq_page';
      if (/about us|our mission|who we are/.test(bodyText)) return 'about_page';
      if (/contact us|get in touch|send us a message|reach out to us/.test(bodyText) && /contact|reach-us|get-in-touch|support|location/.test(path)) return 'contact_page';
    } catch (_) {}
  }

  return 'general_page';
}

/**
 * Extracts contact emails and phones, inspecting mailto/tel links and body text regex.
 * Filters out false positive date formats (e.g., 2026-07-26) and IP addresses.
 *
 * @param {object} $ - Cheerio root object
 * @param {string} rawText - Optional plain text fallback
 * @returns {{ emails: string[], phones: string[] }}
 */
function extractContactInfo($ = null, rawText = '') {
  const emails = new Set();
  const phones = new Set();

  if ($) {
    // Extract from mailto: links
    $('a[href^="mailto:"]').each((_, el) => {
      const mail = ($(el).attr('href') || '').replace(/^mailto:/i, '').split('?')[0].trim();
      if (mail && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(mail)) emails.add(mail);
    });

    // Extract from tel: links
    $('a[href^="tel:"]').each((_, el) => {
      const phone = ($(el).attr('href') || '').replace(/^tel:/i, '').trim();
      if (phone) phones.add(phone);
    });
  }

  const textToScan = $ ? $('body').text() : rawText;

  // Regex for emails
  const emailMatches = textToScan.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  emailMatches.forEach(e => emails.add(e.trim()));

  // Regex for phones with strict validation
  const phoneMatches = textToScan.match(/(?:\+?\d{1,3}[-.\s]?)?\(?\d{2,4}\)?[-.\s]?\d{3,4}[-.\s]?\d{3,4}/g) || [];
  phoneMatches.forEach(p => {
    const trimmed = p.trim();
    // Exclude dates (YYYY-MM-DD or YYYY/MM/DD), IP addresses, and overly short/long digit counts
    const digitsOnly = trimmed.replace(/\D/g, '');
    if (digitsOnly.length >= 7 && digitsOnly.length <= 15) {
      if (!/^\d{4}[-/]\d{2}[-/]\d{2}$/.test(trimmed) && !/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(trimmed)) {
        phones.add(trimmed);
      }
    }
  });

  return {
    emails: [...emails].slice(0, 5),
    phones: [...phones].slice(0, 5),
  };
}

/**
 * Extracts and converts JSON-LD structured data (<script type="application/ld+json">)
 * into clean natural-language text lines and collects detected schema types.
 *
 * @param {object} $ - Cheerio root object
 * @returns {{ text: string, detectedTypes: string[] }}
 */
function extractJsonLd($) {
  const lines = [];
  const detectedTypes = [];

  $('script[type="application/ld+json"]').each((_, el) => {
    let data;
    try {
      const rawJson = $(el).html() || '';
      data = JSON.parse(rawJson);
    } catch (_) {
      return; // Skip malformed blocks
    }

    const nodes = Array.isArray(data['@graph'])
      ? data['@graph']
      : Array.isArray(data)
        ? data
        : [data];

    nodes.forEach(node => {
      if (!node || typeof node !== 'object') return;

      const rawType = node['@type'];
      const types = (Array.isArray(rawType) ? rawType : [rawType])
        .filter(Boolean)
        .map(t => String(t).toLowerCase());

      detectedTypes.push(...types);

      const matchesType = (...targets) => types.some(t => targets.includes(t) || targets.some(target => t.includes(target)));

      // ── Product ─────────────────────────────────────────────────────────────
      if (matchesType('product', 'individualproduct', 'someproduct')) {
        if (node.name) lines.push(`Product: ${node.name}`);
        if (node.description) lines.push(`Description: ${node.description}`);
        if (node.sku) lines.push(`SKU: ${node.sku}`);
        if (node.mpn) lines.push(`MPN: ${node.mpn}`);
        
        if (typeof node.brand === 'string') lines.push(`Brand: ${node.brand}`);
        else if (node.brand?.name) lines.push(`Brand: ${node.brand.name}`);

        const offers = node.offers
          ? (Array.isArray(node.offers) ? node.offers : [node.offers])
          : [];

        offers.forEach(offer => {
          if (!offer || typeof offer !== 'object') return;
          if (offer.price != null && offer.priceCurrency) {
            lines.push(`Price: ${offer.priceCurrency} ${offer.price}`);
          } else if (offer.price != null) {
            lines.push(`Price: ${offer.price}`);
          }

          if (offer.lowPrice != null && offer.highPrice != null && offer.priceCurrency) {
            lines.push(`Price Range: ${offer.priceCurrency} ${offer.lowPrice} – ${offer.priceCurrency} ${offer.highPrice}`);
          }

          if (offer.availability) {
            const avail = String(offer.availability).replace(/.*\//, '');
            lines.push(`Availability: ${avail}`);
          }
          if (offer.priceValidUntil) lines.push(`Price Valid Until: ${offer.priceValidUntil}`);
        });

        if (node.aggregateRating) {
          const r = node.aggregateRating;
          if (r.ratingValue) lines.push(`Rating: ${r.ratingValue}${r.bestRating ? `/${r.bestRating}` : ''} (${r.reviewCount || r.ratingCount || '?'} reviews)`);
        }
      }

      // ── Service ─────────────────────────────────────────────────────────────
      else if (matchesType('service')) {
        if (node.name) lines.push(`Service: ${node.name}`);
        if (node.description) lines.push(`Description: ${node.description}`);
        if (node.offers) {
          const serviceOffers = Array.isArray(node.offers) ? node.offers : [node.offers];
          serviceOffers.forEach(offer => {
            if (offer.price != null && offer.priceCurrency) {
              lines.push(`Price: ${offer.priceCurrency} ${offer.price}`);
            } else if (offer.price != null) {
              lines.push(`Price: ${offer.price}`);
            }
          });
        }
        if (node.areaServed) lines.push(`Area Served: ${typeof node.areaServed === 'string' ? node.areaServed : JSON.stringify(node.areaServed)}`);
        if (node.serviceType) lines.push(`Service Type: ${node.serviceType}`);
      }

      // ── LocalBusiness / Organization / Store / Restaurant / Hotel ────────────
      else if (matchesType('localbusiness', 'organization', 'store', 'restaurant', 'hotel', 'medicalbusiness', 'business')) {
        if (node.name) lines.push(`Business Name: ${node.name}`);
        if (node.telephone) lines.push(`Phone: ${node.telephone}`);
        if (node.email) lines.push(`Email: ${node.email}`);
        if (node.url) lines.push(`Website: ${node.url}`);
        if (node.address) {
          if (typeof node.address === 'string') {
            lines.push(`Address: ${node.address}`);
          } else if (typeof node.address === 'object') {
            const a = node.address;
            const addrParts = [a.streetAddress, a.addressLocality, a.addressRegion, a.postalCode, a.addressCountry].filter(Boolean);
            if (addrParts.length) lines.push(`Address: ${addrParts.join(', ')}`);
          }
        }
        if (node.openingHours) {
          const oh = Array.isArray(node.openingHours) ? node.openingHours.join(', ') : node.openingHours;
          lines.push(`Opening Hours: ${oh}`);
        } else if (node.openingHoursSpecification) {
          const specs = Array.isArray(node.openingHoursSpecification) ? node.openingHoursSpecification : [node.openingHoursSpecification];
          const formattedOh = specs.map(s => {
            const days = Array.isArray(s.dayOfWeek) ? s.dayOfWeek.join('-') : s.dayOfWeek || '';
            return `${days}: ${s.opens || ''}-${s.closes || ''}`;
          }).filter(Boolean).join(', ');
          if (formattedOh) lines.push(`Opening Hours: ${formattedOh}`);
        }
        if (node.priceRange) lines.push(`Price Range: ${node.priceRange}`);
        if (node.description) lines.push(`Description: ${node.description}`);
      }

      // ── FAQPage ─────────────────────────────────────────────────────────────
      else if (matchesType('faqpage')) {
        const entries = node.mainEntity
          ? (Array.isArray(node.mainEntity) ? node.mainEntity : [node.mainEntity])
          : [];
        entries.forEach(entry => {
          const question = entry.name || entry.question || '';
          let answer = entry.acceptedAnswer?.text || entry.acceptedAnswer?.name || '';
          if (answer && typeof answer === 'string') {
            answer = answer.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
          }
          if (question && answer) lines.push(`Q: ${question}\nA: ${answer}`);
        });
      }

      // ── Article / BlogPosting / NewsArticle ─────────────────────────────────
      else if (matchesType('article', 'blogposting', 'newsarticle')) {
        if (node.headline || node.name) lines.push(`Article: ${node.headline || node.name}`);
        if (node.description) lines.push(`Description: ${node.description}`);
        if (node.author) {
          const authorName = typeof node.author === 'string' ? node.author : node.author.name || '';
          if (authorName) lines.push(`Author: ${authorName}`);
        }
        if (node.datePublished) lines.push(`Date Published: ${node.datePublished}`);
      }
    });
  });

  return {
    text: lines.join('\n').trim(),
    detectedTypes: [...new Set(detectedTypes)],
  };
}

/**
 * Recursive DOM Tree Walker that converts HTML elements to clean Markdown.
 * Preserves semantic structure, headings, links, lists, tables with header delimiters,
 * image alt text, definition lists, and price attributes.
 *
 * @param {string} html - HTML string
 * @param {string} baseUrl - Base URL for resolving relative links
 * @returns {string} Clean Markdown text
 */
function convertHtmlToCleanMarkdown(html, baseUrl = '') {
  if (!html || typeof html !== 'string') return '';

  const $ = cheerio.load(html);

  // 1. Remove non-content / noise elements (script, style, noscript, iframe, svg, cookie popups)
  $('script, style, noscript, iframe, svg, [class*="cookie"], [class*="popup"], [role="alert"]').remove();

  const MAX_RECURSION_DEPTH = 80;

  function walk(node, depth = 0) {
    if (!node || depth > MAX_RECURSION_DEPTH) return '';

    if (node.type === 'text') {
      return node.data;
    }

    if (node.type !== 'tag') {
      return '';
    }

    const tagName = node.tagName.toLowerCase();
    const className = ($(node).attr('class') || '').toLowerCase();
    const idName = ($(node).attr('id') || '').toLowerCase();

    // ── Table Handling with Header Delimiters (| --- | --- |) & Pipe Escaping ─
    if (tagName === 'table') {
      const rows = [];
      $(node).find('tr').each((rIdx, trEl) => {
        const cells = [];
        $(trEl).find('th, td').each((_, cellEl) => {
          const cellText = (walk(cellEl, depth + 1) || '').replace(/\s+/g, ' ').replace(/\|/g, '\\|').trim();
          cells.push(cellText);
        });
        if (cells.length > 0) {
          rows.push(`| ${cells.join(' | ')} |`);
          if (rIdx === 0) {
            const delimiter = `| ${cells.map(() => '---').join(' | ')} |`;
            rows.push(delimiter);
          }
        }
      });
      return rows.length ? `\n\n${rows.join('\n')}\n\n` : '';
    }

    // Leaf / inline element price check
    const isLeafOrInline = !['div', 'section', 'article', 'main', 'table', 'tbody', 'thead', 'form'].includes(tagName);

    // Strikethrough / Compare At Prices (<del>, <s>, <strike>, compare/was/old/original)
    const isStrikethrough = ['del', 's', 'strike'].includes(tagName) || (isLeafOrInline && /\b(compare-price|was-price|old-price|original-price|strikethrough|strike)\b/i.test(`${className} ${idName}`));
    
    // Sale / Current Price Tags on leaf elements
    const isCurrentPrice = isLeafOrInline && /\b(current-price|sale-price|now-price|offer-price|price-new|final-price|special-price|regular-price|price--regular)\b/i.test(`${className} ${idName}`);

    // Check inline attributes for price content (<meta itemprop="price" content="...">)
    const metaPrice = $(node).attr('itemprop') === 'price' || $(node).attr('data-price')
      ? ($(node).attr('content') || $(node).attr('data-price') || '').trim()
      : '';

    // Process children recursively
    const childTexts = (node.children || []).map(c => walk(c, depth + 1)).join('');

    if (metaPrice) {
      return ` Price: ${metaPrice} `;
    }

    if (isStrikethrough) {
      const strikethroughText = childTexts.replace(/\s+/g, ' ').trim();
      if (strikethroughText && strikethroughText.length < 50) {
        return ` (Original Price: ${strikethroughText}) `;
      }
    }

    if (isCurrentPrice) {
      const priceText = childTexts.replace(/\s+/g, ' ').trim();
      if (priceText && priceText.length < 50) {
        return ` Price: ${priceText} `;
      }
    }

    // Headings (h1 - h6)
    if (/^h[1-6]$/.test(tagName)) {
      const level = parseInt(tagName.replace('h', '')) || 2;
      const hashes = '#'.repeat(level);
      const cleanHText = childTexts.replace(/\s+/g, ' ').trim();
      return cleanHText ? `\n\n${hashes} ${cleanHText}\n\n` : '';
    }

    // Links (a)
    if (tagName === 'a') {
      const href = ($(node).attr('href') || '').trim();
      const linkText = childTexts.replace(/\s+/g, ' ').trim();

      if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
        return linkText ? ` ${linkText} ` : '';
      }

      try {
        const absoluteUrl = baseUrl ? new URL(href, baseUrl).toString() : href;
        return linkText ? ` [${linkText}](${absoluteUrl}) ` : ` ${href} `;
      } catch (_) {
        return linkText ? ` ${linkText} ` : '';
      }
    }

    // Images (img) - Preserve Alt Text
    if (tagName === 'img') {
      const alt = ($(node).attr('alt') || $(node).attr('title') || '').replace(/\s+/g, ' ').trim();
      const src = ($(node).attr('src') || '').trim();
      if (alt) {
        try {
          const absoluteSrc = baseUrl && src ? new URL(src, baseUrl).toString() : src;
          return ` ![${alt}](${absoluteSrc || '#'}) `;
        } catch (_) {
          return ` ![${alt}](#) `;
        }
      }
      return '';
    }

    // Definition Lists (dt, dd)
    if (tagName === 'dt') {
      const dtText = childTexts.replace(/\s+/g, ' ').trim();
      return dtText ? `\n**${dtText}**: ` : '';
    }
    if (tagName === 'dd') {
      const ddText = childTexts.replace(/\s+/g, ' ').trim();
      return ddText ? `${ddText}\n` : '';
    }

    // List Items (li)
    if (tagName === 'li') {
      const liText = childTexts.replace(/\s+/g, ' ').trim();
      return liText ? `\n- ${liText}` : '';
    }

    // Block Elements
    if (['p', 'div', 'section', 'article', 'blockquote', 'main', 'figure', 'ul', 'ol', 'form'].includes(tagName)) {
      const blockText = childTexts.trim();
      return blockText ? `\n${blockText}\n` : '';
    }

    // Line Breaks (br)
    if (tagName === 'br') {
      return '\n';
    }

    return childTexts;
  }

  const rawMarkdown = walk($('body')[0] || $.root()[0]);

  // Clean lines: strip excessive empty lines without deleting consecutive identical content lines
  const rawLines = rawMarkdown.split('\n').map(l => l.replace(/[ \t]+/g, ' ').trim());
  const cleanLines = [];
  let prevLine = '';

  for (const line of rawLines) {
    if (!line) {
      if (prevLine !== '') {
        cleanLines.push('');
        prevLine = '';
      }
      continue;
    }
    // Collapse repeating identical headers only
    if (line.startsWith('#') && line === prevLine) {
      continue;
    }
    cleanLines.push(line);
    prevLine = line;
  }

  return cleanLines.join('\n').trim();
}

/**
 * Stage B: Page Normalization & Metadata Extraction.
 * Standardizes HTML or Markdown into structured text, headers, metrics, and metadata.
 *
 * @param {string|any} input - Raw HTML or Markdown content
 * @param {string} pageUrl   - Page URL or relative path
 * @returns {object} Normalized page data
 */
function normalizePage(input, pageUrl = '') {
  const safeInput = typeof input === 'string' ? input : String(input || '');
  const isHtml = isHtmlInput(safeInput);

  let pageTitle = '';
  let pageType = 'general_page';
  let contactInfo = { emails: [], phones: [] };
  let rawText = '';
  let headers = [];
  let tableCount = 0;
  let codeBlockCount = 0;

  if (isHtml) {
    const $ = cheerio.load(safeInput);

    // Extract JSON-LD structured data first
    const jsonLdResult = extractJsonLd($);

    // Title extraction
    pageTitle = $('title').text().trim();
    if (!pageTitle && pageUrl) {
      const { host, path } = safeParseUrl(pageUrl);
      pageTitle = host || path || 'Untitled Page';
    }

    // Page type detection with JSON-LD signals
    pageType = detectPageType(pageUrl, $, jsonLdResult.detectedTypes);

    // Contact info extraction
    contactInfo = extractContactInfo($, safeInput);

    tableCount = $('table').length;
    codeBlockCount = $('pre, code').length;

    $('h1, h2, h3, h4, h5, h6').each((_, el) => {
      const tag = el.tagName.toLowerCase();
      const text = $(el).text().trim();
      if (text) headers.push({ level: tag, text });
    });

    rawText = convertHtmlToCleanMarkdown(safeInput, pageUrl);

    // Prepend JSON-LD structured data to rawText for high-priority vector index chunking
    if (jsonLdResult.text) {
      rawText = `## Structured Data (JSON-LD)\n${jsonLdResult.text}\n\n${rawText}`;
    }
  } else {
    // Input is raw markdown / plain text
    rawText = safeInput.trim();

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
    if (titleMatch) {
      pageTitle = titleMatch[1].trim();
    } else if (pageUrl) {
      const { host, path } = safeParseUrl(pageUrl);
      pageTitle = host || path || 'Untitled Page';
    }

    contactInfo = extractContactInfo(null, rawText);
    pageType = detectPageType(pageUrl, null, []);
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

module.exports = {
  normalizePage,
  detectPageType,
  isHtmlInput,
  extractContactInfo,
  extractJsonLd,
  convertHtmlToCleanMarkdown,
};
