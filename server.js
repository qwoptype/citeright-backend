import express from "express";
import cors from "cors";
import * as cheerio from "cheerio";
import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";

const app = express();
const PORT = Number(process.env.PORT || 3000);
const allowedOrigins = (process.env.FRONTEND_ORIGIN || "")
  .split(",").map((s) => s.trim()).filter(Boolean);

app.disable("x-powered-by");
app.use(express.json({ limit: "20kb" }));

app.use(cors({
  origin(origin, callback) {
    // Requests with no Origin are useful for health checks and command-line clients.
    // Browser pages with an Origin must match the configured list exactly.
    if (!origin || allowedOrigins.includes(origin)) return callback(null, true);
    return callback(new Error("This website origin is not allowed by the backend CORS settings."));
  },
  methods: ["GET", "POST", "OPTIONS"],
  allowedHeaders: ["Content-Type", "Accept"],
  maxAge: 86400
}));

app.get("/", (_req, res) => {
  res.type("text").send("CiteRight API is running. Use /api/healthz.");
});

app.get("/api/healthz", (_req, res) => {
  res.json({ status: "ok" });
});

function isPublicIp(address) {
  try {
    let parsed = ipaddr.parse(address);
    if (parsed.kind() === "ipv6" && parsed.isIPv4MappedAddress()) {
      parsed = parsed.toIPv4Address();
    }
    return parsed.range() === "unicast";
  } catch {
    return false;
  }
}

async function validatePublicUrl(raw) {
  let url;
  try { url = new URL(raw); } catch { throw new Error("Enter a valid webpage URL."); }
  if (!["http:", "https:"].includes(url.protocol)) {
    throw new Error("Only HTTP and HTTPS source URLs are supported.");
  }
  if (url.username || url.password) throw new Error("URLs containing usernames or passwords are not allowed.");
  if (url.port && !["80", "443"].includes(url.port)) {
    throw new Error("Nonstandard ports are not allowed.");
  }
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local")) {
    throw new Error("Local-network URLs are not allowed.");
  }

  let addresses;
  if (ipaddr.isValid(host)) {
    addresses = [host];
  } else {
    try {
      addresses = (await dns.lookup(host, { all: true, verbatim: true })).map((x) => x.address);
    } catch {
      throw new Error("The source website hostname could not be resolved.");
    }
  }
  if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
    throw new Error("This URL does not point to a public internet address.");
  }
  return url;
}

async function safeFetch(rawUrl) {
  let current = rawUrl;
  for (let hop = 0; hop <= 4; hop++) {
    const url = await validatePublicUrl(current);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    let response;
    try {
      response = await fetch(url, {
        method: "GET",
        redirect: "manual",
        signal: controller.signal,
        headers: {
          "User-Agent": "CiteRight/1.0 (citation metadata lookup)",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.5"
        }
      });
    } catch (error) {
      if (error.name === "AbortError") throw new Error("The source website took too long to respond.");
      throw new Error("Could not retrieve that webpage. The site may block automated requests.");
    } finally {
      clearTimeout(timer);
    }

    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location) throw new Error("The source website returned an invalid redirect.");
      if (hop === 4) throw new Error("The source website redirected too many times.");
      current = new URL(location, url).href;
      continue;
    }
    if (!response.ok) throw new Error(`The source website returned HTTP ${response.status}.`);
    const type = (response.headers.get("content-type") || "").toLowerCase();
    if (!type.includes("text/html") && !type.includes("application/xhtml+xml") && !type.includes("text/plain")) {
      throw new Error("This source does not appear to be an HTML webpage. Try the article's landing page instead of a PDF download.");
    }

    const declaredLength = Number(response.headers.get("content-length") || 0);
    if (declaredLength > 2_000_000) throw new Error("The source webpage is too large to process.");
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 2_000_000) {
        await reader.cancel();
        throw new Error("The source webpage is too large to process.");
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    return { html: new TextDecoder("utf-8").decode(bytes), finalUrl: url.href };
  }
  throw new Error("Could not follow the source website redirect.");
}

function clean(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function meta($, names) {
  for (const name of names) {
    const value = $(`meta[name="${name}" i]`).attr("content")
      || $(`meta[property="${name}" i]`).attr("content")
      || $(`meta[itemprop="${name}" i]`).attr("content");
    if (clean(value)) return clean(value);
  }
  return "";
}

function dateFromPage($) {
  return meta($, [
    "citation_publication_date", "citation_date", "article:published_time",
    "datePublished", "date", "DC.Date", "dc.date"
  ]);
}

function authorsFromPage($) {
  const collected = [];
  for (const selector of [
    'meta[name="citation_author"]',
    'meta[name="author"]',
    'meta[property="article:author"]',
    'meta[name="dc.creator"]',
    'meta[name="DC.Creator"]'
  ]) {
    $(selector).each((_i, el) => {
      const value = clean($(el).attr("content"));
      if (value && !collected.includes(value)) collected.push(value);
    });
  }
  if (!collected.length) {
    const jsonLd = $('script[type="application/ld+json"]').toArray();
    for (const script of jsonLd) {
      try {
        const parsed = JSON.parse($(script).contents().text());
        const nodes = Array.isArray(parsed) ? parsed : [parsed];
        for (const node of nodes) {
          const author = node?.author;
          for (const person of (Array.isArray(author) ? author : author ? [author] : [])) {
            const name = clean(typeof person === "string" ? person : person.name);
            if (name && !collected.includes(name)) collected.push(name);
          }
        }
      } catch {}
      if (collected.length) break;
    }
  }
  return collected.slice(0, 20);
}

async function crossrefLookup(doi) {
  const endpoint = "https://api.crossref.org/works/" + encodeURIComponent(doi);
  const response = await fetch(endpoint, {
    headers: { "User-Agent": "CiteRight/1.0 (citation metadata lookup)" },
    signal: AbortSignal.timeout(8000)
  });
  if (!response.ok) return null;
  const json = await response.json();
  const item = json?.message;
  if (!item) return null;
  const dateParts = item.published?.["date-parts"]?.[0]
    || item["published-print"]?.["date-parts"]?.[0]
    || item["published-online"]?.["date-parts"]?.[0]
    || item.created?.["date-parts"]?.[0];
  const authors = (item.author || []).map((a) => {
    if (a.name) return clean(a.name);
    return [clean(a.family), clean(a.given)].filter(Boolean).join(", ");
  }).filter(Boolean);
  return {
    title: clean(Array.isArray(item.title) ? item.title[0] : item.title),
    authors,
    publishedDate: dateParts?.length ? dateParts.map(String).join("-") : "",
    siteName: clean(item["container-title"]?.[0] || item.publisher || ""),
    canonicalUrl: item.URL || ""
  };
}

function findDoi(value) {
  const decoded = String(value || "").replace(/&amp;/g, "&");
  const match = decoded.match(/(?:doi\s*:\s*|doi\.org\/)(10\.\d{4,9}\/[^\s"'<>]+)/i);
  return match ? match[1].replace(/[.,;)\]]+$/, "") : "";
}

app.post("/api/metadata", async (req, res) => {
  try {
    const inputUrl = req.body?.url;
    if (typeof inputUrl !== "string" || inputUrl.length > 2048) {
      return res.status(400).json({ error: "Send a source URL in the request body." });
    }

    const firstUrl = await validatePublicUrl(inputUrl);
    const { html, finalUrl } = await safeFetch(firstUrl.href);
    const $ = cheerio.load(html);

    const canonicalHref = $('link[rel="canonical"]').attr("href");
    const canonicalUrl = canonicalHref ? new URL(canonicalHref, finalUrl).href : finalUrl;
    const title = meta($, [
      "citation_title", "og:title", "twitter:title", "headline", "DC.title", "dc.title"
    ]) || clean($("title").first().text()) || clean($("h1").first().text());

    let authors = authorsFromPage($);
    let publishedDate = dateFromPage($);
    let siteName = meta($, ["og:site_name", "application-name", "publisher", "DC.publisher", "dc.publisher"]);
    if (!siteName) {
      try { siteName = new URL(finalUrl).hostname.replace(/^www\./, ""); } catch {}
    }

    const doi = findDoi(finalUrl + " " + html);
    if (doi) {
      try {
        const scholarly = await crossrefLookup(doi);
        if (scholarly) {
          return res.json({
            title: scholarly.title || title,
            authors: scholarly.authors.length ? scholarly.authors : authors,
            publishedDate: scholarly.publishedDate || publishedDate,
            siteName: scholarly.siteName || siteName,
            canonicalUrl: scholarly.canonicalUrl || canonicalUrl,
            missingFields: [
              !(scholarly.title || title) && "title",
              !(scholarly.authors.length || authors.length) && "authors",
              !(scholarly.publishedDate || publishedDate) && "publication date"
            ].filter(Boolean)
          });
        }
      } catch {}
    }

    return res.json({
      title,
      authors,
      publishedDate,
      siteName,
      canonicalUrl,
      missingFields: [
        !title && "title",
        !authors.length && "authors",
        !publishedDate && "publication date"
      ].filter(Boolean)
    });
  } catch (error) {
    const message = error?.message || "Metadata lookup failed.";
    const clientError = /valid webpage|Only HTTP|usernames or passwords|Nonstandard ports|Local-network|public internet|hostname could not be resolved|does not point|does not appear to be an HTML|too large|redirected too many/i.test(message);
    res.status(clientError ? 400 : 502).json({ error: message });
  }
});

app.use((error, _req, res, _next) => {
  const message = error?.message || "Request failed.";
  const isCors = message.includes("origin is not allowed");
  res.status(isCors ? 403 : 400).json({ error: message });
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`CiteRight API listening on port ${PORT}`);
});
