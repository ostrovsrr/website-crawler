#!/usr/bin/env node

import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";

const DEFAULTS = {
  out: "./crawler-output",
  maxPages: 300,
  maxDepth: 2,
  timeoutMs: 15000,
  sameHostOnly: true,
  includeQuery: false,
  politenessMs: 150,
};

const COLLECTION_PATH_HINTS = [
  "/collections/",
  "/collection/",
  "/category/",
  "/categories/",
  "/c/",
  "/shop/",
  "/departments/",
  "/department/",
  "/brands/",
  "/brand/",
  "/product-category/",
  "/catalog/",
];

const NON_COLLECTION_PATH_HINTS = [
  "/products/",
  "/product/",
  "/cart",
  "/checkout",
  "/account",
  "/login",
  "/register",
  "/search",
  "/blog",
  "/blogs",
  "/pages/",
  "/contact",
  "/about",
  "/policies",
];

main().catch((error) => {
  console.error(error?.stack || error);
  process.exit(1);
});

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.url) {
    printUsage();
    process.exit(1);
  }

  const startUrl = normalizeUrl(options.url, options);
  const origin = new URL(startUrl).origin;
  const startedAt = new Date().toISOString();

  await mkdir(options.out, { recursive: true });

  const discoveredFromSitemaps = await discoverFromSitemaps(origin, options);
  const crawlResults = await crawlHtmlPages(startUrl, discoveredFromSitemaps, options);
  const pagesByUrl = new Map();

  for (const sitemapPage of discoveredFromSitemaps) {
    pagesByUrl.set(sitemapPage.url, sitemapPage);
  }
  for (const crawledPage of crawlResults) {
    pagesByUrl.set(crawledPage.url, { ...pagesByUrl.get(crawledPage.url), ...crawledPage });
  }

  const allPages = [...pagesByUrl.values()].sort((a, b) => a.url.localeCompare(b.url));
  const collectionCandidates = allPages
    .map((page) => ({ ...page, collectionSignals: getCollectionSignals(page) }))
    .filter((page) => page.collectionSignals.length > 0)
    .sort((a, b) => b.collectionSignals.length - a.collectionSignals.length || a.url.localeCompare(b.url));

  const summary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    startUrl,
    totalPages: allPages.length,
    crawledHtmlPages: crawlResults.length,
    sitemapPages: discoveredFromSitemaps.length,
    collectionCandidates: collectionCandidates.length,
    options,
  };

  await writeJson(path.join(options.out, "all-pages.json"), allPages);
  await writeJson(path.join(options.out, "old-collections.json"), collectionCandidates);
  await writeJson(path.join(options.out, "crawl-summary.json"), summary);
  await writeFile(path.join(options.out, "old-collections.csv"), toCsv(collectionCandidates), "utf8");

  console.log(JSON.stringify(summary, null, 2));
}

function parseArgs(args) {
  const parsed = { ...DEFAULTS };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    const next = args[index + 1];
    if (arg === "--url") parsed.url = takeValue(arg, next, () => index++);
    else if (arg === "--out") parsed.out = takeValue(arg, next, () => index++);
    else if (arg === "--max-pages") parsed.maxPages = Number(takeValue(arg, next, () => index++));
    else if (arg === "--max-depth") parsed.maxDepth = Number(takeValue(arg, next, () => index++));
    else if (arg === "--timeout-ms") parsed.timeoutMs = Number(takeValue(arg, next, () => index++));
    else if (arg === "--include-query") parsed.includeQuery = true;
    else if (arg === "--allow-cross-host") parsed.sameHostOnly = false;
    else if (arg === "--help" || arg === "-h") {
      printUsage();
      process.exit(0);
    }
  }
  parsed.out = path.resolve(parsed.out);
  return parsed;
}

function takeValue(flag, value, advance) {
  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }
  advance();
  return value;
}

function printUsage() {
  console.log(`Usage:
  node ./src/crawl-old-site.mjs --url https://oldstore.example --out ./runs/oldstore

Flags:
  --max-pages 300
  --max-depth 2
  --include-query
  --allow-cross-host
  --timeout-ms 15000`);
}

async function discoverFromSitemaps(origin, options) {
  const queue = [`${origin}/sitemap.xml`];
  const seenSitemaps = new Set();
  const discovered = new Map();

  while (queue.length > 0 && seenSitemaps.size < 50) {
    const sitemapUrl = queue.shift();
    if (!sitemapUrl || seenSitemaps.has(sitemapUrl)) continue;
    seenSitemaps.add(sitemapUrl);

    const response = await fetchText(sitemapUrl, options);
    if (!response.ok) continue;

    const locs = [...response.text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)]
      .map((match) => decodeHtml(match[1].trim()))
      .filter(Boolean);

    for (const loc of locs) {
      const normalized = normalizeUrl(loc, options, origin);
      if (!normalized) continue;
      if (/\.xml(\?.*)?$/i.test(new URL(normalized).pathname)) {
        queue.push(normalized);
      } else {
        discovered.set(normalized, {
          url: normalized,
          path: pathWithOptionalQuery(normalized, options),
          discoveredFrom: ["sitemap"],
        });
      }
    }
  }

  return [...discovered.values()];
}

async function crawlHtmlPages(startUrl, seededPages, options) {
  const queue = [{ url: startUrl, depth: 0, from: "homepage" }];
  const seen = new Set();
  const pages = [];
  const startHost = new URL(startUrl).hostname;

  for (const page of seededPages.slice(0, Math.min(seededPages.length, 100))) {
    if (looksLikeCollectionPath(new URL(page.url).pathname)) {
      queue.push({ url: page.url, depth: 1, from: "sitemap-candidate" });
    }
  }

  while (queue.length > 0 && pages.length < options.maxPages) {
    const item = queue.shift();
    if (!item || seen.has(item.url)) continue;
    seen.add(item.url);

    const url = new URL(item.url);
    if (options.sameHostOnly && url.hostname !== startHost) continue;

    const response = await fetchText(item.url, options);
    if (!response.ok) {
      pages.push({
        url: item.url,
        path: pathWithOptionalQuery(item.url, options),
        statusCode: response.status,
        discoveredFrom: [item.from],
      });
      continue;
    }

    const contentType = response.headers.get("content-type") || "";
    if (!contentType.includes("text/html")) continue;

    const metadata = extractMetadata(response.text);
    const links = extractLinks(response.text, item.url, options)
      .filter((link) => !options.sameHostOnly || new URL(link).hostname === startHost);

    pages.push({
      url: item.url,
      path: pathWithOptionalQuery(item.url, options),
      statusCode: response.status,
      discoveredFrom: [item.from],
      depth: item.depth,
      ...metadata,
      linkCount: links.length,
    });

    if (item.depth < options.maxDepth) {
      for (const link of links) {
        if (!seen.has(link) && shouldCrawl(link)) {
          queue.push({ url: link, depth: item.depth + 1, from: "html-link" });
        }
      }
    }

    if (options.politenessMs > 0) {
      await delay(options.politenessMs);
    }
  }

  return pages;
}

async function fetchText(url, options) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      headers: {
        "user-agent": "CollectionRedirectMapper/0.1 (+Shopify migration URL inventory)",
        accept: "text/html,application/xml,text/xml,*/*",
      },
    });
    const text = await response.text();
    return { ok: response.ok, status: response.status, headers: response.headers, text };
  } catch (error) {
    return { ok: false, status: 0, headers: new Headers(), text: "", error: error.message };
  } finally {
    clearTimeout(timeout);
  }
}

function extractMetadata(html) {
  const title = firstMatch(html, /<title[^>]*>([\s\S]*?)<\/title>/i);
  const h1 = firstMatch(html, /<h1[^>]*>([\s\S]*?)<\/h1>/i);
  const canonicalUrl = firstMatch(html, /<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i)
    || firstMatch(html, /<link[^>]+href=["']([^"']+)["'][^>]+rel=["']canonical["']/i);
  const metaDescription = firstMatch(html, /<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)["']/i)
    || firstMatch(html, /<meta[^>]+content=["']([^"']*)["'][^>]+name=["']description["']/i);
  const breadcrumbText = extractBreadcrumbText(html);

  return {
    title: cleanText(title),
    h1: cleanText(h1),
    canonicalUrl: canonicalUrl ? decodeHtml(canonicalUrl) : undefined,
    metaDescription: cleanText(metaDescription),
    breadcrumbText,
  };
}

function extractLinks(html, baseUrl, options) {
  const links = new Set();
  const anchorMatches = html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>/gi);
  for (const match of anchorMatches) {
    const normalized = normalizeUrl(match[1], options, baseUrl);
    if (normalized) links.add(normalized);
  }
  return [...links];
}

function extractBreadcrumbText(html) {
  const breadcrumbBlocks = [
    ...html.matchAll(/<[^>]+(?:class|id)=["'][^"']*breadcrumb[^"']*["'][^>]*>([\s\S]{0,2000}?)<\/[^>]+>/gi),
    ...html.matchAll(/<script[^>]+type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ];
  const text = breadcrumbBlocks.map((match) => cleanText(match[1])).filter(Boolean).join(" > ");
  return text || undefined;
}

function getCollectionSignals(page) {
  const signals = [];
  const url = new URL(page.url);
  const pathname = url.pathname.toLowerCase();
  const title = `${page.title || ""} ${page.h1 || ""} ${page.breadcrumbText || ""}`.toLowerCase();

  if (looksLikeCollectionPath(pathname)) signals.push("collection-like path");
  if (/\b(collection|category|department|catalog|shop|brand|brands)\b/.test(title)) {
    signals.push("collection-like page text");
  }
  if (page.discoveredFrom?.includes("sitemap") && looksLikeCollectionPath(pathname)) {
    signals.push("sitemap collection candidate");
  }

  return signals;
}

function looksLikeCollectionPath(pathname) {
  const path = pathname.toLowerCase();
  if (NON_COLLECTION_PATH_HINTS.some((hint) => path.startsWith(hint))) return false;
  return COLLECTION_PATH_HINTS.some((hint) => path.includes(hint));
}

function shouldCrawl(url) {
  const pathname = new URL(url).pathname.toLowerCase();
  const fileLike = /\.(jpg|jpeg|png|gif|webp|svg|pdf|zip|css|js|ico|woff|woff2)$/i.test(pathname);
  if (fileLike) return false;
  return !NON_COLLECTION_PATH_HINTS.some((hint) => pathname.startsWith(hint));
}

function normalizeUrl(value, options, baseUrl) {
  try {
    if (/^(mailto|tel|sms|javascript):/i.test(value)) return undefined;
    const url = new URL(decodeHtml(value), baseUrl);
    url.hash = "";
    if (!options.includeQuery) url.search = "";
    if (url.protocol !== "http:" && url.protocol !== "https:") return undefined;
    return url.toString();
  } catch {
    return undefined;
  }
}

function pathWithOptionalQuery(url, options) {
  const parsed = new URL(url);
  return `${parsed.pathname}${options.includeQuery ? parsed.search : ""}`;
}

function firstMatch(value, regex) {
  const match = value.match(regex);
  return match ? match[1] : undefined;
}

function cleanText(value) {
  if (!value) return undefined;
  const cleaned = decodeHtml(value)
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || undefined;
}

function decodeHtml(value) {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, "\"")
    .replace(/&#39;/g, "'");
}

async function writeJson(filePath, value) {
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function toCsv(rows) {
  const columns = [
    "url",
    "path",
    "statusCode",
    "title",
    "h1",
    "canonicalUrl",
    "breadcrumbText",
    "collectionSignals",
  ];
  const lines = [columns.join(",")];
  for (const row of rows) {
    lines.push(columns.map((column) => csvEscape(formatCsvValue(row[column]))).join(","));
  }
  return `${lines.join("\n")}\n`;
}

function formatCsvValue(value) {
  if (Array.isArray(value)) return value.join("; ");
  return value ?? "";
}

function csvEscape(value) {
  const text = String(value);
  if (/[",\n\r]/.test(text)) return `"${text.replace(/"/g, "\"\"")}"`;
  return text;
}
