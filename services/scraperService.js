const axios = require("axios");
const cheerio = require("cheerio");
const { URL } = require("url");
const { EMBEDDING_DIM } = require("./embeddingService");
const { qdrantClient } = require("../config/db");
const { processPageForChunks, vectorizePageChunks } = require("./ingestionService");
const { CorpusStatsBuilder, saveTermStats, deleteTermStats } = require("./bm25StatsService");
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
        sparse_vector: {},
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
      console.log(`ℹ️  Collection "${collectionName}" did not exist — nothing to delete`);
    } else {
      throw e;
    }
  }

  // Delete BM25 corpus statistics and invalidate cache
  await deleteTermStats(botId);
  console.log(`🗑️  BM25 TermStats for bot=${botId} deleted`);
}

/**
 * Phase 1 helper: Fetch a page and process it through Stages B-H (no vectorization).
 * Returns chunk objects so the caller can build corpus statistics before vectorizing.
 */
async function fetchAndChunkPage(url, botId = null) {
  const response = await axios.get(url, {
    headers: {
      "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)",
      Accept: "text/html",
    },
    timeout: 15_000,
  });

  const rawHtml = response.data;
  return await processPageForChunks(rawHtml, url, { botId });
}

// ─── Main Ingestion Pipeline Orchestrator (Two-Phase BM25) ───────────────────

/**
 * Two-Phase RAG Ingestion Pipeline with True BM25:
 *
 * Phase 1 — Corpus Collection:
 *   Scrape all pages concurrently, normalize, quality-gate, and chunk.
 *   Accumulate term document frequencies (df) across ALL chunks using
 *   CorpusStatsBuilder. Save final corpus stats to MongoDB (TermStats).
 *
 * Phase 2 — Vectorization:
 *   Vectorize all collected chunks using the COMPLETE corpus statistics,
 *   so every IDF weight reflects the true corpus-wide term distribution.
 *   Batch-upsert resulting Qdrant points.
 *
 * This two-pass design is required for correct BM25 — IDF must be computed
 * after seeing all documents, not page by page.
 */
async function scrapeAndStore(botId, rootUrl) {
  const collectionName = getCollectionName(botId);
  await ensureCollection(collectionName);

  // ── URL Discovery ────────────────────────────────────────────────────────
  let urlQueue = await discoverSitemapUrls(rootUrl);
  const usedSitemap = urlQueue.length > 0;

  if (!usedSitemap) {
    console.log("🔗 Discovering URLs via homepage link crawl...");
    try {
      const homeRes = await axios.get(rootUrl, {
        headers: { "User-Agent": "Mozilla/5.0 (compatible; RAGBot/1.0)", Accept: "text/html" },
        timeout: 15_000,
      });
      const $raw = cheerio.load(homeRes.data);
      $raw("script, style, noscript, iframe").remove();
      const internalLinks = collectInternalLinks($raw, rootUrl, MAX_CRAWL_PAGES);
      urlQueue = [...new Set([rootUrl, ...internalLinks])];
      console.log(`🔗 Discovered ${urlQueue.length} URLs from homepage`);
    } catch (err) {
      console.warn("⚠️  Homepage link discovery failed:", err.message);
      urlQueue = [rootUrl];
    }
  }

  urlQueue = [...new Set(urlQueue)].slice(0, MAX_CRAWL_PAGES);
  console.log(`📋 Queued ${urlQueue.length} URLs | Two-Phase BM25 Ingestion Pipeline`);

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 1: Scrape all pages → collect chunks → build corpus statistics
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n📥 [Phase 1] Scraping & chunking all pages to build BM25 corpus statistics...`);

  const allPageResults  = [];  // { url, pageRes } — successful pages for Phase 2
  const statsBuilder    = new CorpusStatsBuilder();
  let pagesScraped      = 0;
  let businessName      = "";
  const visited         = new Set();

  for (
    let i = 0;
    i < urlQueue.length && pagesScraped < MAX_CRAWL_PAGES;
    i += PAGE_CONCURRENCY
  ) {
    const batch = urlQueue.slice(i, i + PAGE_CONCURRENCY).filter(u => !visited.has(u));
    if (!batch.length) continue;
    batch.forEach(u => visited.add(u));

    const results = await Promise.allSettled(
      batch.map(url => fetchAndChunkPage(url, botId)),
    );

    for (let j = 0; j < results.length; j++) {
      const url    = batch[j];
      const result = results[j];

      if (result.status === "fulfilled" && result.value) {
        const pageRes = result.value;

        if (pageRes.skipped) {
          console.log(`⏩ [Skipped] ${url} — ${pageRes.skipReason}`);
          await Document.findOneAndUpdate(
            { botId, url },
            { status: "skipped", skipReason: pageRes.skipReason, qualityMetrics: pageRes.metrics, scrapedAt: new Date() },
            { upsert: true },
          );
          pagesScraped++;
          continue;
        }

        // Capture business name from first successful page title
        if (allPageResults.length === 0 && pageRes.pageTitle) {
          businessName = pageRes.pageTitle.replace(/\s*[-|–]\s*.+$/, "").trim();
        }

        // Accumulate chunks into BM25 corpus stats builder
        statsBuilder.addChunks(pageRes.childChunks);
        allPageResults.push({ url, pageRes });
        pagesScraped++;

        console.log(`  📄 [${pagesScraped}/${urlQueue.length}] Chunked: ${url} — ${pageRes.childChunks.length} child chunks`);
      } else {
        console.warn(`  ⚠️  [${pagesScraped + 1}/${urlQueue.length}] Scrape failed: ${url} — ${result.reason?.message}`);
        await Document.findOneAndUpdate(
          { botId, url },
          { status: "failed", scrapedAt: new Date() },
          { upsert: true },
        );
        pagesScraped++;
      }
    }
  }

  if (allPageResults.length === 0) {
    throw new Error("No valid content could be extracted or passed quality gates from the provided URL(s)");
  }

  // ── Finalize & persist corpus statistics ─────────────────────────────────
  const corpusStats = statsBuilder.build();
  await saveTermStats(botId, corpusStats);

  const vocabSize  = Object.keys(corpusStats.termDf).length;
  const avgDocLen  = corpusStats.totalChunks > 0
    ? (corpusStats.totalTokens / corpusStats.totalChunks).toFixed(1)
    : '0';
  console.log(`\n📊 [BM25 Corpus Stats] N=${corpusStats.totalChunks} chunks | avgdl=${avgDocLen} tokens | vocab=${vocabSize} unique terms`);

  // ═══════════════════════════════════════════════════════════════════════
  // PHASE 2: Vectorize all chunks with true BM25 corpus statistics
  // ═══════════════════════════════════════════════════════════════════════
  console.log(`\n⚡ [Phase 2] Vectorizing ${allPageResults.length} pages with true BM25 IDF...`);

  const allPoints    = [];
  const batchOptions = { botId };

  for (const { url, pageRes } of allPageResults) {
    const points = await vectorizePageChunks(
      pageRes.childChunks,
      url,
      corpusStats,
      batchOptions,
    );
    allPoints.push(...points);

    // Log completed document to MongoDB with full chunk info
    await Document.findOneAndUpdate(
      { botId, url },
      {
        status:           "completed",
        pageType:         pageRes.pageType,
        contextualSummary: pageRes.contextualSummary,
        normalizedText:   pageRes.normalizedText,
        qualityMetrics:   pageRes.metrics,
        chunksCount:      { parentChunks: pageRes.parentChunks.length, childChunks: pageRes.childChunks.length },
        scrapedAt:        new Date(),
      },
      { upsert: true },
    );

    console.log(`  ✅ Vectorized: ${url} — ${points.length} BM25 Qdrant points`);
  }

  if (allPoints.length === 0) {
    throw new Error("Vectorization produced no valid Qdrant points.");
  }

  // ── Batch Upsert to Qdrant ────────────────────────────────────────────────
  const UPSERT_BATCH = 100;
  for (let i = 0; i < allPoints.length; i += UPSERT_BATCH) {
    await qdrantClient.upsert(collectionName, {
      points: allPoints.slice(i, i + UPSERT_BATCH),
    });
  }

  console.log(`\n✅ Upserted ${allPoints.length} true-BM25 points to Qdrant collection "${collectionName}"`);
  return {
    success:     true,
    chunksCount: allPoints.length,
    pagesScraped,
    businessName,
  };
}

module.exports = { scrapeAndStore, deleteCollection, getCollectionName };
