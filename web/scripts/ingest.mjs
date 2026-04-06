// Ingest hackathon data from Luma + DoraHacks + GitHub Issues + scraper JSON
// and upsert into Supabase. Designed to run from a GitHub Action on a cron.
//
// Required env:
//   SUPABASE_URL                  - Project URL (https://xxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY     - Service role key (write access, server-only)
//
// Optional env:
//   GITHUB_TOKEN                  - To bypass GitHub API rate limits
//   SCRAPER_JSON_PATH             - Defaults to ../src/data/hackathons.json (relative to this file)

import { createClient } from "@supabase/supabase-js";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ---------- Config ----------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

const SCRAPER_JSON_PATH =
  process.env.SCRAPER_JSON_PATH ||
  resolve(__dirname, "..", "src", "data", "hackathons.json");

const GITHUB_REPO = "ainponce/hackathones";

const LUMA_SEED_SLUGS = [
  // Argentina
  "4uq8yejo", "6kluo21l", "e12138qh", "m1vu0bde", "uds2l1td",
  // Colombia
  "hackavax", "fizpni10",
  // Mexico
  "3rpalo5b",
  // LATAM / virtual
  "do4zysjd", "xrhqzya0", "bp630aaz",
  // USA
  "miami-hackathon", "genaihack", "arkusAI", "hackathon-6-25",
  // Brasil
  "6s3u6xwc",
];

const AMERICAS_COUNTRIES = [
  "argentina", "brasil", "brazil", "chile", "colombia", "mexico", "méxico",
  "peru", "perú", "uruguay", "paraguay", "ecuador", "bolivia", "venezuela",
  "costa rica", "panama", "panamá", "guatemala", "honduras", "el salvador",
  "nicaragua", "cuba", "dominican republic", "república dominicana",
  "united states", "estados unidos", "usa", "canada", "canadá",
];

const DORAHACKS_HEADERS = {
  Accept: "*/*",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  Referer: "https://dorahacks.io/hackathon",
  "sec-ch-ua":
    '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

const GITHUB_HEADERS = {
  Accept: "application/vnd.github.v3+json",
  "User-Agent": "hackathones-ingest",
  ...(process.env.GITHUB_TOKEN
    ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` }
    : {}),
};

const today = new Date().toISOString().slice(0, 10);

// ---------- Helpers ----------

function isAmericas(geo, eventName) {
  const country = (geo?.country || "").toLowerCase();
  if (AMERICAS_COUNTRIES.some((c) => country.includes(c))) return true;
  const combined = `${eventName} ${geo?.city || ""} ${geo?.region || ""}`.toLowerCase();
  return AMERICAS_COUNTRIES.some((c) => combined.includes(c)) ||
    /latam|latinoamerica|latin america/.test(combined);
}

function normalizeCountry(geo) {
  const raw = (geo?.country || "").toLowerCase();
  const map = {
    argentina: "Argentina", brazil: "Brasil", brasil: "Brasil",
    chile: "Chile", colombia: "Colombia", mexico: "Mexico",
    "méxico": "Mexico", peru: "Peru", "perú": "Peru",
    uruguay: "Uruguay", paraguay: "Paraguay", ecuador: "Ecuador",
    bolivia: "Bolivia", venezuela: "Venezuela", "costa rica": "Costa Rica",
    panama: "Panama", "panamá": "Panama", guatemala: "Guatemala",
    "united states": "USA", "estados unidos": "USA", canada: "Canada",
    "canadá": "Canada", cuba: "Cuba",
  };
  for (const [key, val] of Object.entries(map)) {
    if (raw.includes(key)) return val;
  }
  return geo?.country || null;
}

function normalizeCity(geo) {
  const city = geo?.city || "";
  if (/^[A-Z]\d{4}/.test(city)) {
    const region = geo?.region || "";
    if (region.toLowerCase().includes("buenos aires")) return "Buenos Aires";
    return null;
  }
  return city || null;
}

function normalize(s) {
  return (s || "")
    .toLowerCase()
    .normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function wordSet(s) {
  return new Set(normalize(s).split(" ").filter((w) => w.length > 2));
}

function nameSimilarity(a, b) {
  const setA = wordSet(a);
  const setB = wordSet(b);
  if (setA.size === 0 || setB.size === 0) return 0;
  let common = 0;
  for (const w of setA) if (setB.has(w)) common++;
  return common / Math.max(setA.size, setB.size);
}

function datesClose(a, b) {
  if (!a.date_start || !b.date_start) return true;
  const diff = Math.abs(
    new Date(a.date_start).getTime() - new Date(b.date_start).getTime()
  );
  return diff <= 3 * 86400000;
}

function isDuplicate(event, existing) {
  return existing.some(
    (e) =>
      e.slug === event.slug ||
      (nameSimilarity(e.name, event.name) >= 0.5 && datesClose(e, event))
  );
}

function normalizeType(t) {
  if (!t) return null;
  const v = t.toLowerCase();
  if (v === "presencial" || v === "online" || v === "hibrido") return v;
  if (v === "irl") return "presencial";
  if (v === "virtual" || v === "remote") return "online";
  if (v === "hybrid") return "hibrido";
  return null;
}

// Map a GitHub issue's labels to a hackathons/lfg_posts status.
// `rejected` label wins over `approved`; absence of both → `pending`.
function statusFromLabels(labels) {
  const names = (labels || []).map((l) => (l?.name || "").toLowerCase());
  if (names.includes("rejected")) return "rejected";
  if (names.includes("approved")) return "approved";
  return "pending";
}

// ---------- Sources ----------

async function fetchLumaEvents() {
  const results = await Promise.all(
    LUMA_SEED_SLUGS.map(async (slug) => {
      try {
        const res = await fetch(`https://api.lu.ma/url?url=${slug}`);
        if (!res.ok) return null;
        const data = await res.json();
        const event = data?.data?.event;
        if (!event?.name) return null;
        const geo = event.geo_address_info || {};
        const isOnline =
          event.location_type === "online" || event.location_type === "zoom";
        if (!isOnline && !isAmericas(geo, event.name)) return null;
        const endDate = event.end_at
          ? event.end_at.slice(0, 10)
          : event.start_at?.slice(0, 10);
        if (endDate && endDate < today) return null;
        const locType = event.location_type === "offline" ? "presencial"
          : isOnline ? "online" : null;
        return {
          slug: `luma-${slug}`,
          name: event.name,
          date_start: event.start_at ? event.start_at.slice(0, 10) : null,
          date_end: event.end_at ? event.end_at.slice(0, 10) : null,
          country: isOnline ? "Online" : normalizeCountry(geo),
          city: normalizeCity(geo),
          location: geo.address || null,
          url: `https://lu.ma/${slug}`,
          source: "luma",
          type: locType,
          tags: [],
          description: "",
          status: "approved",
        };
      } catch {
        return null;
      }
    })
  );
  return results.filter(Boolean);
}

async function fetchDoraHacksEvents() {
  const events = [];
  const pageSize = 200;
  try {
    const firstRes = await fetch(
      `https://dorahacks.io/api/hackathon/?page=1&page_size=${pageSize}`,
      { headers: DORAHACKS_HEADERS }
    );
    if (!firstRes.ok) return events;
    const firstData = await firstRes.json();
    const totalPages = Math.ceil((firstData.count || 0) / pageSize);

    const pagePromises = [Promise.resolve(firstData)];
    for (let page = 2; page <= totalPages; page++) {
      pagePromises.push(
        fetch(
          `https://dorahacks.io/api/hackathon/?page=${page}&page_size=${pageSize}`,
          { headers: DORAHACKS_HEADERS }
        )
          .then((r) => (r.ok ? r.json() : { results: [] }))
          .catch(() => ({ results: [] }))
      );
    }
    const pages = await Promise.all(pagePromises);
    const allResults = pages.flatMap((p) => p.results || []);

    for (const h of allResults) {
      if (!h.visible || h.archived) continue;
      const endDate = h.end_time
        ? new Date(h.end_time * 1000).toISOString().slice(0, 10)
        : null;
      if (endDate && endDate < today) continue;
      const isVirtual = h.participation_form === "Virtual";
      const isIRL = h.participation_form === "IRL";
      if (isIRL) {
        const searchText = `${h.title} ${h.venue_address || ""} ${h.venue_name || ""}`.toLowerCase();
        if (!AMERICAS_COUNTRIES.some((c) => searchText.includes(c))) continue;
      }
      const rawDesc = (h.description || "")
        .replace(/!\[.*?\]\(.*?\)/g, "")
        .replace(/\[([^\]]*)\]\(.*?\)/g, "$1")
        .replace(/#{1,6}\s+/g, "")
        .replace(/\*\*([^*]*)\*\*/g, "$1")
        .replace(/[*_~`]/g, "")
        .replace(/<[^>]+>/g, "")
        .replace(/\n{2,}/g, " ")
        .trim()
        .slice(0, 300);
      const tags = h.field
        ? h.field.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
        : [];
      events.push({
        slug: `dorahacks-${h.id}`,
        name: h.title,
        date_start: h.start_time
          ? new Date(h.start_time * 1000).toISOString().slice(0, 10)
          : null,
        date_end: endDate,
        country: isVirtual ? "Online" : null,
        city: null,
        location:
          [h.venue_name, h.venue_address].filter(Boolean).join(", ") || null,
        url: `https://dorahacks.io/hackathon/${h.uname || h.id}`,
        source: "dorahacks",
        type: isIRL ? "presencial" : isVirtual ? "online" : null,
        tags,
        description: rawDesc,
        status: "approved",
      });
    }
  } catch (e) {
    console.warn("DoraHacks fetch failed:", e.message);
  }
  return events;
}

async function fetchGitHubIssues() {
  // Fetch once, parse both [hackathon] and [lfg] entries. Also track the
  // slugs/source_keys we saw so the caller can soft-delete anything in DB
  // that's no longer present (i.e. the issue was closed / deleted).
  try {
    const res = await fetch(
      `https://api.github.com/repos/${GITHUB_REPO}/issues?state=open&per_page=100`,
      { headers: GITHUB_HEADERS }
    );
    if (!res.ok)
      return {
        hackathons: [],
        lfg: [],
        seenHackSlugs: new Set(),
        seenLfgSourceKeys: new Set(),
      };
    const issues = await res.json();
    const hackathons = [];
    const lfg = [];
    const seenHackSlugs = new Set();
    const seenLfgSourceKeys = new Set();

    for (const issue of issues) {
      if (issue.pull_request) continue;
      const title = issue.title || "";
      const body = issue.body || "";
      const issueStatus = statusFromLabels(issue.labels);

      const boldField = (label) => {
        const m = body.match(new RegExp(`\\*\\*${label}\\*\\*:\\s*(.+)`, "i"));
        return m ? m[1].trim() : null;
      };
      const formField = (label) => {
        const m = body.match(
          new RegExp(`###\\s*${label}\\s*\\n+([^#\\n][^\\n]*)`, "i")
        );
        return m ? m[1].trim() || null : null;
      };
      const field = (boldLabel, formLabel) =>
        boldField(boldLabel) || formField(formLabel || boldLabel) || null;

      const lower = title.toLowerCase();
      if (lower.startsWith("[hackathon]")) {
        seenHackSlugs.add(`gh-${issue.number}`);
        let date_start = null;
        let date_end = null;
        const fechaRaw = boldField("Fecha");
        if (fechaRaw) {
          const dates = fechaRaw.match(/\d{4}-\d{2}-\d{2}/g) || [];
          date_start = dates[0] || null;
          date_end = dates[1] || date_start;
        } else {
          const startRaw = formField("Fecha inicio");
          const endRaw = formField("Fecha fin");
          date_start = startRaw?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
          date_end =
            endRaw?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || date_start;
        }
        if (date_end && date_end < today) continue;

        const tagsRaw = field("Tags");
        const tags = tagsRaw
          ? tagsRaw.split(/,\s*/).map((t) => t.trim()).filter(Boolean)
          : [];
        const descMatch = body.match(/###\s*Descripcion\s*\n+([\s\S]*?)$/i);
        const description = descMatch ? descMatch[1].trim().slice(0, 300) : "";

        hackathons.push({
          slug: `gh-${issue.number}`,
          name: title.replace(/^\[hackathon\]\s*/i, "").trim(),
          date_start,
          date_end,
          country: field("Pais"),
          city: field("Ciudad"),
          location: field("Lugar"),
          url: field("URL", "URL del evento"),
          source: "comunidad",
          type: normalizeType(field("Tipo")),
          tags,
          description,
          status: issueStatus,
        });
      } else if (lower.startsWith("[lfg]")) {
        seenLfgSourceKeys.add(`gh-${issue.number}`);
        const handle =
          field("Handle", "Tu nombre o alias") ||
          title.replace(/^\[lfg\]\s*/i, "").trim();
        const skillsRaw = field("Skills", "Skills (separados por coma)");
        const skills = skillsRaw
          ? skillsRaw.split(/,\s*/).map((s) => s.trim()).filter(Boolean)
          : [];
        const hackathon = field("Hackathon") || "";
        const contact =
          field("Contacto", "Contacto (twitter, discord, telegram, email)") ||
          "";
        const message = (field("Mensaje", "Mensaje (opcional)") || "").slice(
          0,
          200
        );
        if (!hackathon) continue;
        lfg.push({
          source_key: `gh-${issue.number}`,
          handle,
          skills,
          hackathon_name: hackathon,
          contact,
          message,
          status: issueStatus,
        });
      }
    }
    return { hackathons, lfg, seenHackSlugs, seenLfgSourceKeys };
  } catch (e) {
    console.warn("GitHub fetch failed:", e.message);
    return {
      hackathons: [],
      lfg: [],
      seenHackSlugs: new Set(),
      seenLfgSourceKeys: new Set(),
    };
  }
}

async function loadScraperJson() {
  try {
    const raw = await readFile(SCRAPER_JSON_PATH, "utf8");
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return data
      .filter((h) => {
        const endDate = h.date_end || h.date_start;
        return !endDate || endDate >= today;
      })
      .map((h) => ({
        slug: h.id?.startsWith("x-") ? h.id : `x-${h.id || h.name}`,
        name: h.name,
        date_start: h.date_start || null,
        date_end: h.date_end || null,
        country: h.country || null,
        city: h.city || null,
        location: h.location || null,
        url: h.url || null,
        source: "x",
        type: normalizeType(h.type),
        tags: Array.isArray(h.tags) ? h.tags : [],
        description: h.description || "",
        status: "approved",
      }));
  } catch (e) {
    console.warn(`Could not read ${SCRAPER_JSON_PATH}: ${e.message}`);
    return [];
  }
}

// ---------- Main ----------

async function main() {
  console.log("[ingest] starting…");
  const t0 = Date.now();

  const [scraperEvents, lumaEvents, doraEvents, ghResult] = await Promise.all([
    loadScraperJson(),
    fetchLumaEvents(),
    fetchDoraHacksEvents(),
    fetchGitHubIssues(),
  ]);

  console.log(
    `[ingest] fetched: scraper=${scraperEvents.length} luma=${lumaEvents.length} dora=${doraEvents.length} gh=${ghResult.hackathons.length} lfg=${ghResult.lfg.length} (${Date.now() - t0}ms)`
  );

  // Dedup priority: comunidad > scraper > luma > dorahacks
  const merged = [];
  for (const e of [
    ...ghResult.hackathons,
    ...scraperEvents,
    ...lumaEvents,
    ...doraEvents,
  ]) {
    if (!isDuplicate(e, merged)) merged.push(e);
  }

  const rows = merged.map((e) => ({
    slug: e.slug,
    name: e.name,
    date_start: e.date_start,
    date_end: e.date_end,
    country: e.country,
    city: e.city,
    location: e.location,
    url: e.url,
    source: e.source,
    type: normalizeType(e.type),
    tags: e.tags || [],
    description: e.description || null,
    status: e.status || "approved",
    updated_at: new Date().toISOString(),
  }));

  console.log(`[ingest] upserting ${rows.length} hackathons…`);
  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false },
  });

  const { error: hError } = await supabase
    .from("hackathons")
    .upsert(rows, { onConflict: "slug" });
  if (hError) {
    console.error("[ingest] hackathons upsert failed:", hError.message);
    process.exit(1);
  }

  // Soft-delete: any comunidad hackathon in DB that we didn't see in the
  // current GitHub fetch (= the issue was closed or deleted). Mark as
  // rejected so it disappears from the home but stays auditable.
  const { data: existingComunidad, error: hSelectError } = await supabase
    .from("hackathons")
    .select("slug")
    .eq("source", "comunidad");
  if (hSelectError) {
    console.warn(
      "[ingest] could not load existing comunidad slugs:",
      hSelectError.message
    );
  } else {
    const disappeared = (existingComunidad || [])
      .map((r) => r.slug)
      .filter((s) => !ghResult.seenHackSlugs.has(s));
    if (disappeared.length) {
      console.log(
        `[ingest] soft-deleting ${disappeared.length} disappeared comunidad hackathons`
      );
      const { error: hSoftError } = await supabase
        .from("hackathons")
        .update({
          status: "rejected",
          updated_at: new Date().toISOString(),
        })
        .in("slug", disappeared);
      if (hSoftError) {
        console.warn(
          "[ingest] comunidad soft-delete failed:",
          hSoftError.message
        );
      }
    }
  }

  if (ghResult.lfg.length > 0) {
    const lfgRows = ghResult.lfg.map((p) => ({
      source_key: p.source_key,
      handle: p.handle,
      skills: p.skills,
      hackathon_name: p.hackathon_name,
      contact: p.contact,
      message: p.message,
      status: p.status || "approved",
    }));
    console.log(`[ingest] upserting ${lfgRows.length} lfg posts…`);
    const { error: lError } = await supabase
      .from("lfg_posts")
      .upsert(lfgRows, { onConflict: "source_key" });
    if (lError) {
      console.error("[ingest] lfg upsert failed:", lError.message);
      process.exit(1);
    }
  }

  // Soft-delete lfg_posts whose source_key disappeared from the open issues.
  const { data: existingLfg, error: lSelectError } = await supabase
    .from("lfg_posts")
    .select("source_key")
    .not("source_key", "is", null);
  if (lSelectError) {
    console.warn(
      "[ingest] could not load existing lfg source_keys:",
      lSelectError.message
    );
  } else {
    const disappearedLfg = (existingLfg || [])
      .map((r) => r.source_key)
      .filter((s) => s && !ghResult.seenLfgSourceKeys.has(s));
    if (disappearedLfg.length) {
      console.log(
        `[ingest] soft-deleting ${disappearedLfg.length} disappeared lfg posts`
      );
      const { error: lSoftError } = await supabase
        .from("lfg_posts")
        .update({ status: "rejected" })
        .in("source_key", disappearedLfg);
      if (lSoftError) {
        console.warn("[ingest] lfg soft-delete failed:", lSoftError.message);
      }
    }
  }

  console.log(`[ingest] done in ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error("[ingest] fatal:", e);
  process.exit(1);
});
