const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const { EMBEDDING_DIM } = require("./embeddingService");
const { qdrantClient } = require("../config/db");
const { processPageForIngestion } = require("./ingestionService");
const Document = require("../models/Document");

const MAX_CRAWL_PAGES = 500;
const PAGE_CONCURRENCY = 1; // pages scraped in parallel per batch

// ─── Per-Bot Collection Naming ────────────────────────────────────────────────

function getCollectionName(botId) {
  return `bot_${botId.toString()}`;
}

// ─── Link Discovery Utilities ────────────────────────────────────────────────

const NON_HTML_EXTENSIONS = /\.(pdf|png|jpe?g|webp|gif|svg|ico|bmp|tiff|avif|mp4|webm|avi|mov|mkv|mp3|wav|ogg|flac|m4a|zip|tar|gz|rar|7z|exe|dmg|apk|iso|bin|css|js|mjs|json|xml|rss|atom|woff2?|ttf|eot|otf)$/i;

const IGNORED_PATH_PATTERNS = [
  /\/cdn-cgi\//i,
  /\/wp-content\/uploads\//i,
  /\/assets\/(?:images|img|css|js|fonts)\//i,
];

function isCrawlableWebpageUrl(urlString) {
  if (!urlString || typeof urlString !== "string") return false;
  if (!/^https?:\/\//i.test(urlString)) return false;

  try {
    const parsed = new URL(urlString);
    const pathname = parsed.pathname.toLowerCase();

    // Reject non-HTML extensions (images, pdfs, media, docs, archives, etc.)
    if (NON_HTML_EXTENSIONS.test(pathname)) {
      return false;
    }

    // Reject cdn-cgi email-protection and static asset folders
    for (const pattern of IGNORED_PATH_PATTERNS) {
      if (pattern.test(pathname)) {
        return false;
      }
    }

    return true;
  } catch (_) {
    return false;
  }
}

function isSameDomain(url1, url2) {
  try {
    const host1 = new URL(url1).hostname.replace(/^www\./i, "").toLowerCase();
    const host2 = new URL(url2).hostname.replace(/^www\./i, "").toLowerCase();
    return host1 === host2;
  } catch (_) {
    return false;
  }
}

function collectInternalLinks($, baseUrl, limit = 50) {
  const links = new Set();
  $("a[href]").each((_, el) => {
    try {
      const href = $(el).attr("href");
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) {
        return;
      }
      const resolved = new URL(href, baseUrl);
      resolved.hash = "";
      resolved.search = "";
      const resolvedUrl = resolved.toString();

      if (isSameDomain(resolvedUrl, baseUrl) && isCrawlableWebpageUrl(resolvedUrl)) {
        links.add(resolvedUrl);
      }
    } catch (_) {}
  });
  return [...links].slice(0, limit);
}

// ─── Sitemap Discovery ────────────────────────────────────────────────────────

async function fetchSitemapXml(sitemapUrl, origin, depth = 0) {
  if (depth > 2) return [];
  try {
    const res = await axios.get(sitemapUrl, {
      timeout: 12_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
        Accept: "application/xml, text/xml, application/xhtml+xml, */*",
      },
    });

    const xmlContent = typeof res.data === "string" ? res.data : String(res.data || "");
    const urls = new Set();
    const childSitemaps = new Set();

    // 1. Cheerio Parse
    try {
      const $ = cheerio.load(xmlContent, { xmlMode: true });

      $("sitemapindex sitemap loc, sitemap loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc) childSitemaps.add(loc);
      });

      $("urlset url loc, url loc").each((_, el) => {
        const loc = $(el).text().trim();
        if (loc && isSameDomain(loc, origin) && isCrawlableWebpageUrl(loc)) {
          urls.add(loc);
        }
      });
    } catch (_) {}

    // 2. Regex Fallback for loc tags
    const locMatches = xmlContent.matchAll(/<loc>(?:<!\[CDATA\[)?(https?:\/\/[^\s\]<]+)(?:\]\]>)?<\/loc>/gi);
    for (const match of locMatches) {
      const loc = match[1].trim();
      if (!loc) continue;

      if (loc.endsWith(".xml") || loc.includes("sitemap")) {
        if (!loc.startsWith(sitemapUrl)) childSitemaps.add(loc);
      } else if (isSameDomain(loc, origin) && isCrawlableWebpageUrl(loc)) {
        urls.add(loc);
      }
    }

    // Process nested child sitemaps
    if (childSitemaps.size > 0 && depth < 2) {
      const childArray = [...childSitemaps].slice(0, 15);
      for (const childUrl of childArray) {
        const childExtracted = await fetchSitemapXml(childUrl, origin, depth + 1);
        childExtracted.forEach((u) => {
          if (isCrawlableWebpageUrl(u)) urls.add(u);
        });
        if (urls.size >= MAX_CRAWL_PAGES * 2) break;
      }
    }

    return [...urls];
  } catch (err) {
    console.warn(`⚠️ Could not fetch sitemap ${sitemapUrl}: ${err.message}`);
    return [];
  }
}

async function discoverSitemapUrls(rootUrl) {
  const base = new URL(rootUrl);
  const origin = `${base.protocol}//${base.hostname}`;

  for (const path of [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/sitemap-index.xml",
    "/xmlsitemap.php",
  ]) {
    const urls = await fetchSitemapXml(`${origin}${path}`, origin);
    if (urls.length > 0) {
      console.log(
        `🗺️  Sitemap found: ${origin}${path} (${urls.length} URLs extracted)`,
      );
      return urls;
    }
  }

  try {
    const robotsRes = await axios.get(`${origin}/robots.txt`, {
      timeout: 8_000,
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36",
      },
    });
    const sitemapLines = robotsRes.data
      .split("\n")
      .map((line) => line.match(/^Sitemap:\s*(.+)/i)?.[1]?.trim())
      .filter(Boolean);

    for (const sitemapUrl of sitemapLines) {
      const urls = await fetchSitemapXml(sitemapUrl, origin);
      if (urls.length > 0) {
        console.log(
          `🗺️  Sitemap via robots.txt: ${sitemapUrl} (${urls.length} URLs extracted)`,
        );
        return urls;
      }
    }
  } catch (_) {}

  console.log("ℹ️  No sitemap found — will fall back to homepage link crawl");
  return [];
}

// ─── Qdrant Multi-Tenant Collection Management ───────────────────────────────

/**
 * Ensures Qdrant collection exists with SQ8 int8 scalar quantization
 * and multi-tenant HNSW payload indexing (user_id tenant index).
 */
async function ensureCollection(collectionName) {
  let exists = false;
  try {
    const info = await qdrantClient.getCollection(collectionName);
    exists = true;
    const existingSize = info.config?.params?.vectors?.size;
    const hasSparse = !!info.config?.sparse_vectors?.sparse_vector;
    if ((existingSize && existingSize !== EMBEDDING_DIM) || !hasSparse) {
      console.warn(
        `⚠️  Collection "${collectionName}" missing sparse vectors index or dimension mismatch. Recreating...`,
      );
      await qdrantClient.deleteCollection(collectionName);
      exists = false;
    } else {
      console.log(
        `✅ Collection "${collectionName}" verified (dim=${EMBEDDING_DIM}, sparse_vector enabled)`,
      );
    }
  } catch (e) {
    const msg = e.message || "";
    if (!msg.toLowerCase().includes("not found") && !msg.includes("404"))
      throw e;
  }

  if (!exists) {
    console.log(
      `🔧 Creating Qdrant collection "${collectionName}" (dim=${EMBEDDING_DIM}, Sparse BM25 Index, SQ8 int8 Quantization)...`,
    );
    await qdrantClient.createCollection(collectionName, {
      vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
      sparse_vectors: {
        sparse_vector: {
          modifier: "idf",
        },
      },
      quantization_config: {
        scalar: {
          type: "int8",
          quantile: 0.99,
          always_ram: true,
        },
      },
    });

    // Multi-tenant HNSW payload index on user_id
    try {
      await qdrantClient.createPayloadIndex(collectionName, {
        field_name: "user_id",
        field_schema: {
          type: "keyword",
          is_tenant: true,
        },
      });
    } catch (_) {}

    // Indexed payload fields
    try {
      await qdrantClient.createPayloadIndex(collectionName, {
        field_name: "pageType",
        field_schema: "keyword",
      });
    } catch (_) {}

    console.log(
      `✅ Qdrant Multi-Tenant collection "${collectionName}" created with SQ8 int8 scalar quantization`,
    );
  }
}

async function deleteCollection(botId) {
  const collectionName = getCollectionName(botId);

  // Delete Qdrant collection
  try {
    await qdrantClient.deleteCollection(collectionName);
    console.log(`🗑️  Collection "${collectionName}" deleted`);
  } catch (e) {
    const msg = e.message || "";
    if (msg.toLowerCase().includes("not found") || msg.includes("404")) {
      console.log(
        `ℹ️  Collection "${collectionName}" did not exist — nothing to delete`,
      );
    } else {
      throw e;
    }
  }
}

async function fetchAndIngestPage(url, botId = null) {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)",
      Accept: "text/html",
    },
    timeout: 15_000,
  });

  const rawHtml = response.data;
  return await processPageForIngestion(rawHtml, url, { botId });
}

// ─── Main Ingestion Pipeline Orchestrator ────────────────────────────────────

async function scrapeAndStore(botId, rootUrl) {
  const collectionName = getCollectionName(botId);
  await ensureCollection(collectionName);

  // Stage 1: URL Discovery
  let urlQueue = await discoverSitemapUrls(rootUrl);
  const usedSitemap = urlQueue.length > 0;

  if (!usedSitemap) {
    console.log("🔗 Discovering URLs via homepage link crawl...");
    try {
      const homeRes = await axios.get(rootUrl, {
        headers: {
          "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)",
          Accept: "text/html",
        },
        timeout: 15_000,
      });
      const $raw = cheerio.load(homeRes.data);
      $raw("script, style, noscript, iframe").remove();
      const internalLinks = collectInternalLinks(
        $raw,
        rootUrl,
        MAX_CRAWL_PAGES,
      );
      urlQueue = [...new Set([rootUrl, ...internalLinks])];
      console.log(`🔗 Discovered ${urlQueue.length} URLs from homepage`);
    } catch (err) {
      console.warn("⚠️  Homepage link discovery failed:", err.message);
      urlQueue = [rootUrl];
    }
  }

  urlQueue = [...new Set(urlQueue)].filter(isCrawlableWebpageUrl).slice(0, MAX_CRAWL_PAGES);
  console.log(
    `📋 Queued ${urlQueue.length} URLs | Native BM25 Ingestion Pipeline`,
  );

  // Stage 2: Batch Scraping & Ingestion
  let totalPointsCount = 0;
  let pagesScraped = 0;
  let businessName = "";
  const visited = new Set();

  for (
    let i = 0;
    i < urlQueue.length && pagesScraped < MAX_CRAWL_PAGES;
    i += PAGE_CONCURRENCY
  ) {
    const batch = urlQueue
      .slice(i, i + PAGE_CONCURRENCY)
      .filter((u) => !visited.has(u));
    if (!batch.length) continue;
    batch.forEach((u) => visited.add(u));

    const results = await Promise.allSettled(
      batch.map((url) => fetchAndIngestPage(url, botId)),
    );

    for (let j = 0; j < results.length; j++) {
      const url = batch[j];
      const result = results[j];

      if (result.status === "fulfilled" && result.value) {
        const pageRes = result.value;

        if (pageRes.skipped) {
          console.log(
            `⏩ [Skipped Page] ${url} — Reason: ${pageRes.skipReason}`,
          );
          await Document.findOneAndUpdate(
            { botId, url },
            {
              status: "skipped",
              skipReason: pageRes.skipReason,
              qualityMetrics: pageRes.metrics,
              scrapedAt: new Date(),
            },
            { upsert: true },
          );
          pagesScraped++;
          continue;
        }

        const {
          points,
          pageTitle,
          pageType,
          normalizedText,
          contextualSummary,
          parentCount,
          childCount,
          metrics,
        } = pageRes;

        if (pagesScraped === 0 && pageTitle) {
          businessName = pageTitle.replace(/\s*[-|–]\s*.+$/, "").trim();
        }

        // Stage 3: Immediate per-page flush to Qdrant (prevents RAM bloat)
        if (points && points.length > 0) {
          const UPSERT_BATCH = 100;
          for (let k = 0; k < points.length; k += UPSERT_BATCH) {
            await qdrantClient.upsert(collectionName, {
              points: points.slice(k, k + UPSERT_BATCH),
            });
          }
          totalPointsCount += points.length;
        }

        pagesScraped++;

        await Document.findOneAndUpdate(
          { botId, url },
          {
            status: "completed",
            pageType,
            contextualSummary,
            normalizedText,
            qualityMetrics: metrics,
            chunksCount: { parentChunks: parentCount, childChunks: childCount },
            scrapedAt: new Date(),
          },
          { upsert: true },
        );

        console.log(
          `✅ [${pagesScraped}/${urlQueue.length}] ${url} — ${points.length} child points (${parentCount} parent chunks) [flushed to Qdrant]`,
        );
      } else {
        console.warn(
          `⚠️  [${pagesScraped + 1}/${urlQueue.length}] Ingestion Failed: ${url} — ${result.reason?.message}`,
        );
        await Document.findOneAndUpdate(
          { botId, url },
          { status: "failed", scrapedAt: new Date() },
          { upsert: true },
        );
        pagesScraped++;
      }
    }
  }

  if (totalPointsCount === 0) {
    throw new Error(
      "No valid content could be extracted or passed quality gates from the provided URL(s)",
    );
  }

  console.log(
    `✅ Successfully upserted total ${totalPointsCount} points across ${pagesScraped} pages to Qdrant collection "${collectionName}"`,
  );
  return {
    success: true,
    chunksCount: totalPointsCount,
    pagesScraped,
    businessName,
  };
}

module.exports = { scrapeAndStore, deleteCollection, getCollectionName };
