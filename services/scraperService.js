const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const { EMBEDDING_DIM } = require("./embeddingService");
const { qdrantClient } = require("../config/db");
const { processPageForIngestion } = require("./ingestionService");
const Document = require("../models/Document");

const MAX_CRAWL_PAGES = 500;
const PAGE_CONCURRENCY = 5; // pages scraped in parallel per batch

// ─── Per-Bot Collection Naming ────────────────────────────────────────────────

function getCollectionName(botId) {
  return `bot_${botId.toString()}`;
}

// ─── Link Discovery Utilities ────────────────────────────────────────────────

function collectInternalLinks($, baseUrl, limit = 30) {
  const base = new URL(baseUrl);
  const links = new Set();
  $("a[href]").each((_, el) => {
    try {
      const href = $(el).attr("href");
      const resolved = new URL(href, baseUrl);
      if (resolved.hostname === base.hostname) {
        resolved.hash = "";
        resolved.search = "";
        links.add(resolved.toString());
      }
    } catch (_) {}
  });
  return [...links].slice(0, limit);
}

// ─── Sitemap Discovery ────────────────────────────────────────────────────────

async function fetchSitemapXml(sitemapUrl, origin, depth = 0) {
  if (depth > 1) return [];
  try {
    const res = await axios.get(sitemapUrl, {
      timeout: 10_000,
      headers: {
        "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)",
        Accept: "application/xml, text/xml, */*",
      },
    });

    const $ = cheerio.load(res.data, { xmlMode: true });
    const urls = [];

    const childLocs = $("sitemapindex sitemap loc").toArray();
    if (childLocs.length > 0) {
      for (const el of childLocs.slice(0, 10)) {
        const childUrl = $(el).text().trim();
        const childUrls = await fetchSitemapXml(childUrl, origin, depth + 1);
        urls.push(...childUrls);
        if (urls.length >= MAX_CRAWL_PAGES * 2) break;
      }
      return urls;
    }

    $("urlset url loc").each((_, el) => {
      const loc = $(el).text().trim();
      try {
        if (new URL(loc).hostname === new URL(origin).hostname) {
          urls.push(loc);
        }
      } catch (_) {}
    });

    return urls;
  } catch (_) {
    return [];
  }
}

async function discoverSitemapUrls(rootUrl) {
  const base = new URL(rootUrl);
  const origin = `${base.protocol}//${base.hostname}`;

  for (const path of [
    "/sitemap.xml",
    "/sitemap_index.xml",
    "/xmlsitemap.php",
  ]) {
    const urls = await fetchSitemapXml(`${origin}${path}`, origin);
    if (urls.length > 0) {
      console.log(
        `🗺️  Sitemap found: ${origin}${path} (${urls.length} raw URLs)`,
      );
      return urls;
    }
  }

  try {
    const robotsRes = await axios.get(`${origin}/robots.txt`, {
      timeout: 8_000,
      headers: { "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)" },
    });
    const sitemapLines = robotsRes.data
      .split("\n")
      .map((line) => line.match(/^Sitemap:\s*(.+)/i)?.[1]?.trim())
      .filter(Boolean);

    for (const sitemapUrl of sitemapLines) {
      const urls = await fetchSitemapXml(sitemapUrl, origin);
      if (urls.length > 0) {
        console.log(
          `🗺️  Sitemap via robots.txt: ${sitemapUrl} (${urls.length} raw URLs)`,
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
    if (existingSize && existingSize !== EMBEDDING_DIM) {
      console.warn(
        `⚠️  Collection "${collectionName}" has wrong dimension (${existingSize} ≠ ${EMBEDDING_DIM}). Recreating...`,
      );
      await qdrantClient.deleteCollection(collectionName);
      exists = false;
    } else {
      console.log(
        `✅ Collection "${collectionName}" verified (dim=${EMBEDDING_DIM})`,
      );
    }
  } catch (e) {
    const msg = e.message || "";
    if (!msg.toLowerCase().includes("not found") && !msg.includes("404"))
      throw e;
  }

  if (!exists) {
    console.log(
      `🔧 Creating Qdrant collection "${collectionName}" (dim=${EMBEDDING_DIM}, SQ8 int8 Quantization)...`,
    );
    await qdrantClient.createCollection(collectionName, {
      vectors: { size: EMBEDDING_DIM, distance: "Cosine" },
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

// ─── Main Ingestion Pipeline Orchestrator ─────────────────────────────────────

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

  urlQueue = [...new Set(urlQueue)].slice(0, MAX_CRAWL_PAGES);
  console.log(
    `📋 Queued ${urlQueue.length} URLs to process through RAG Ingestion Pipeline`,
  );

  // Stage 2: Batch Scraping & Ingestion Processing
  const allPoints = [];
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
          contextualSummary,
          parentCount,
          childCount,
          metrics,
        } = pageRes;

        if (pagesScraped === 0 && pageTitle) {
          businessName = pageTitle.replace(/\s*[-|–]\s*.+$/, "").trim();
        }

        allPoints.push(...points);
        pagesScraped++;

        // Log document completion in MongoDB
        await Document.findOneAndUpdate(
          { botId, url },
          {
            status: "completed",
            contextualSummary,
            qualityMetrics: metrics,
            chunksCount: { parentChunks: parentCount, childChunks: childCount },
            scrapedAt: new Date(),
          },
          { upsert: true },
        );

        console.log(
          `✅ [${pagesScraped}/${urlQueue.length}] ${url} — ${points.length} child points (${parentCount} parent chunks)`,
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

  if (allPoints.length === 0) {
    throw new Error(
      "No valid content could be extracted or passed quality gates from the provided URL(s)",
    );
  }

  // Stage 3: Single-Transaction Batch Upsert to Qdrant Multi-Tenant Storage
  const UPSERT_BATCH = 100;
  for (let i = 0; i < allPoints.length; i += UPSERT_BATCH) {
    await qdrantClient.upsert(collectionName, {
      points: allPoints.slice(i, i + UPSERT_BATCH),
    });
  }

  console.log(
    `✅ Successfully upserted ${allPoints.length} points to Qdrant collection "${collectionName}"`,
  );
  return {
    success: true,
    chunksCount: allPoints.length,
    pagesScraped,
    businessName,
  };
}

module.exports = { scrapeAndStore, deleteCollection, getCollectionName };
