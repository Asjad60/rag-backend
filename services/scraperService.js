const axios = require('axios');
const cheerio = require('cheerio');
const { URL } = require('url');
const { v4: uuidv4 } = require('uuid');
const { RecursiveCharacterTextSplitter } = require('@langchain/textsplitters');
const { generateEmbeddings, EMBEDDING_DIM } = require('./embeddingService');
const { qdrantClient } = require('../config/db');

const COLLECTION_NAME = 'documents';
const MAX_CRAWL_PAGES = 15; // Max pages to crawl per domain

// ─── Utilities ────────────────────────────────────────────────────────────────

/**
 * Detects the page type based on the URL path and page content.
 */
function detectPageType(urlString, $) {
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

  // Fallback: check content signals
  if (/contact us|get in touch|send us a message/.test(bodyText)) return 'contact_page';
  if (/frequently asked questions|faq/.test(bodyText)) return 'faq_page';
  return 'general_page';
}

/**
 * Extracts contact information from the page (email, phone, address).
 */
function extractContactInfo($) {
  const bodyText = $('body').text();
  const emailMatches = bodyText.match(/[a-zA-Z0-9._%+\-]+@[a-zA-Z0-9.\-]+\.[a-zA-Z]{2,}/g) || [];
  const phoneMatches = bodyText.match(/(\+?\d[\d\s\-().]{7,}\d)/g) || [];

  return {
    emails: [...new Set(emailMatches)].slice(0, 5),
    phones: [...new Set(phoneMatches.map(p => p.trim()))].slice(0, 5),
  };
}

/**
 * Extracts clean, structured text from a Cheerio-loaded page.
 */
function extractPageText($) {
  $('script, style, noscript, iframe, svg, nav, footer, [class*="cookie"], [class*="popup"]').remove();

  let rawText = '';
  // Walk headings, paragraphs, list items, table cells
  $('h1, h2, h3, h4, h5, h6').each((_, el) => {
    rawText += `\n## ${$(el).text().trim()}\n`;
  });
  $('p, li, td, th, blockquote, figcaption, address, dt, dd').each((_, el) => {
    const t = $(el).text().trim();
    if (t.length > 20) rawText += t + '\n';
  });

  if (!rawText.trim()) {
    rawText = $('body').text().replace(/\s+/g, ' ').trim();
  }
  return rawText.trim();
}

/**
 * Collects internal links from a page, up to `limit`.
 */
function collectInternalLinks($, baseUrl, limit = 20) {
  const base = new URL(baseUrl);
  const links = new Set();
  $('a[href]').each((_, el) => {
    try {
      const href = $(el).attr('href');
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname === base.hostname) {
        resolved.hash = '';
        resolved.search = ''; // ignore query params for dedup
        links.add(resolved.toString());
      }
    } catch (_) { /* invalid URL */ }
  });
  return [...links].slice(0, limit);
}

// ─── Qdrant Collection Setup ──────────────────────────────────────────────────

async function ensureCollection() {
  let collectionExists = false;
  try {
    const info = await qdrantClient.getCollection(COLLECTION_NAME);
    collectionExists = true;
    // Check if existing collection has the wrong vector size
    const existingSize = info.config?.params?.vectors?.size;
    if (existingSize && existingSize !== EMBEDDING_DIM) {
      console.warn(
        `⚠️  Qdrant collection "${COLLECTION_NAME}" has dimension ${existingSize} but we need ${EMBEDDING_DIM}. ` +
        `Deleting and recreating...`
      );
      await qdrantClient.deleteCollection(COLLECTION_NAME);
      collectionExists = false;
    } else {
      console.log(`✅ Qdrant collection "${COLLECTION_NAME}" verified (dim=${EMBEDDING_DIM})`);
    }
  } catch (e) {
    // "Not Found" / "Not found" / 404 all mean the collection doesn't exist yet — that's fine
    const msg = e.message || '';
    if (!msg.toLowerCase().includes('not found') && !msg.includes('404')) {
      console.error('Unexpected Qdrant error in getCollection:', msg);
      throw e;
    }
    collectionExists = false;
  }

  if (!collectionExists) {
    // Create fresh collection with correct 1536-dim
    console.log(`🔧 Creating Qdrant collection "${COLLECTION_NAME}" (dim=${EMBEDDING_DIM})...`);
    await qdrantClient.createCollection(COLLECTION_NAME, {
      vectors: { size: EMBEDDING_DIM, distance: 'Cosine' },
    });
    await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'botId',
      field_schema: 'keyword',
    });
    await qdrantClient.createPayloadIndex(COLLECTION_NAME, {
      field_name: 'pageType',
      field_schema: 'keyword',
    });
    console.log(`✅ Qdrant collection "${COLLECTION_NAME}" created (dim=${EMBEDDING_DIM})`);
  }
}

// ─── Scrape a Single Page ─────────────────────────────────────────────────────

async function scrapePage(url) {
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (compatible; RAGBot/1.0)',
      Accept: 'text/html',
    },
    timeout: 15000,
  });
  const $ = cheerio.load(response.data);
  const pageTitle = $('title').text().trim() || new URL(url).hostname;
  const pageType = detectPageType(url, $);
  const contactInfo = extractContactInfo($);
  const rawText = extractPageText($);
  return { $, pageTitle, pageType, contactInfo, rawText };
}

// ─── Main Export ──────────────────────────────────────────────────────────────

/**
 * Scrapes a URL (and crawls child pages on the same domain), chunks the text,
 * embeds each chunk with 1536-dim OpenAI vectors, and upserts to Qdrant.
 *
 * @param {string} botId  - MongoDB bot ID
 * @param {string} rootUrl - The root URL to start crawling from
 * @returns {Promise<{ success: boolean, chunksCount: number, pagesScraped: number, businessName: string }>}
 */
async function scrapeAndStore(botId, rootUrl) {
  await ensureCollection();

  const visited = new Set();
  const queue = [rootUrl];
  const points = [];
  let pagesScraped = 0;
  let businessName = '';

  const splitter = new RecursiveCharacterTextSplitter({
    chunkSize: 800,
    chunkOverlap: 150,
  });

  while (queue.length > 0 && pagesScraped < MAX_CRAWL_PAGES) {
    const url = queue.shift();
    if (visited.has(url)) continue;
    visited.add(url);

    try {
      console.log(`🕷️  Scraping [${pagesScraped + 1}/${MAX_CRAWL_PAGES}]: ${url}`);
      const { $, pageTitle, pageType, contactInfo, rawText } = await scrapePage(url);

      // Auto-extract business name from homepage
      if (pagesScraped === 0) {
        businessName = pageTitle.replace(/\s*[-|–]\s*.+$/, '').trim(); // strip tagline
      }

      if (!rawText.trim()) {
        console.warn(`  ↳ No text found, skipping`);
        pagesScraped++;
        continue;
      }

      // Queue internal links from first page only (avoids explosion)
      if (pagesScraped === 0) {
        const internalLinks = collectInternalLinks($, url, MAX_CRAWL_PAGES - 1);
        for (const link of internalLinks) {
          if (!visited.has(link)) queue.push(link);
        }
      }

      // Chunk the text
      const docChunks = await splitter.createDocuments([rawText]);

      // Build contact info summary string to prepend to contact pages
      let contactSummary = '';
      if (contactInfo.emails.length || contactInfo.phones.length) {
        contactSummary =
          `Contact Information:\n` +
          (contactInfo.emails.length ? `Emails: ${contactInfo.emails.join(', ')}\n` : '') +
          (contactInfo.phones.length ? `Phone numbers: ${contactInfo.phones.join(', ')}\n` : '');
      }

      // Embed chunks in batches of 5 to stay within rate limits
      const BATCH_SIZE = 5;
      for (let i = 0; i < docChunks.length; i += BATCH_SIZE) {
        const batch = docChunks.slice(i, i + BATCH_SIZE);
        const batchPoints = await Promise.all(
          batch.map(async (doc) => {
            const chunkText = doc.pageContent;
            // Prepend contact summary to every chunk of a contact page so retrieval is reliable
            const textToEmbed =
              pageType === 'contact_page' && contactSummary
                ? `${contactSummary}\n${chunkText}`
                : chunkText;

            const vector = await generateEmbeddings(textToEmbed);
            return {
              id: uuidv4(),
              vector,
              payload: {
                botId: botId.toString(),
                url,
                pageTitle,
                pageType,
                contactEmails: contactInfo.emails,
                contactPhones: contactInfo.phones,
                text: textToEmbed,
              },
            };
          })
        );
        points.push(...batchPoints);
        // Small delay to respect rate limits
        if (i + BATCH_SIZE < docChunks.length) {
          await new Promise(r => setTimeout(r, 300));
        }
      }

      pagesScraped++;
    } catch (err) {
      console.error(`  ↳ Error scraping ${url}:`, err.message);
      pagesScraped++;
    }
  }

  if (points.length === 0) {
    throw new Error('No content could be extracted from the provided URL(s)');
  }

  // Upsert all points in batches of 100
  const UPSERT_BATCH = 100;
  for (let i = 0; i < points.length; i += UPSERT_BATCH) {
    await qdrantClient.upsert(COLLECTION_NAME, { points: points.slice(i, i + UPSERT_BATCH) });
  }

  console.log(`✅ Stored ${points.length} chunks from ${pagesScraped} pages for bot ${botId}`);
  return { success: true, chunksCount: points.length, pagesScraped, businessName };
}

module.exports = { scrapeAndStore };
