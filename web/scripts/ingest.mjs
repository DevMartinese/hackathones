// Ingest hackathon data from Luma + DoraHacks + Devpost + GitHub Issues and
// upsert into Supabase. Designed to run from a GitHub Action on a cron every
// 6h (see .github/workflows/ingest.yml). Also re-runs on-demand whenever a
// [hackathon]/[lfg] issue is opened, edited, closed, or (un)labeled so the
// community feed reflects triage decisions instantly.
//
// Required env:
//   SUPABASE_URL                  - Project URL (https://xxx.supabase.co)
//   SUPABASE_SERVICE_ROLE_KEY     - Service role key (write access, server-only)
//
// Optional env:
//   GITHUB_TOKEN                  - To bypass GitHub API rate limits

import { createClient } from "@supabase/supabase-js";

// ---------- Config ----------

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  process.exit(1);
}

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

// Devpost's `/api/hackathons` endpoint is public (no auth, no cookie), but it
// 403s if you hit it with a default Node fetch UA. The minimal set of headers
// below is enough to impersonate a real browser — matching what the hackathon
// listing page sends from Chrome. No personal session cookie required.
const DEVPOST_HEADERS = {
  Accept: "*/*",
  "Accept-Language": "en-US,en;q=0.9",
  "User-Agent":
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
  Referer: "https://devpost.com/hackathons",
  "sec-ch-ua":
    '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"macOS"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
};

// Cap Devpost pagination at 10 pages (400 events) as a safety net so a
// runaway `total_count` can't starve the job or trigger rate limits.
const DEVPOST_PER_PAGE = 40;
const DEVPOST_MAX_PAGES = 10;

// Same safety net for DoraHacks. page_size=200 × 10 = 2000 events/run.
const DORAHACKS_MAX_PAGES = 10;
// Delay between Devpost page fetches. Low enough to finish in a few seconds
// for typical `total_count` (~100–200), high enough that the AWS ALB in
// front of Devpost doesn't flag a burst as automated traffic.
const DEVPOST_PAGE_DELAY_MS = 1500;

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

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHttpUrl(str) {
  if (!str || typeof str !== "string") return false;
  try {
    return ["http:", "https:"].includes(new URL(str).protocol);
  } catch {
    return false;
  }
}

// Cap a tag/skill array: drop non-strings, truncate each item, and limit
// overall count. Protects the DB from a compromised or misbehaving source
// returning thousands of tags or multi-kilobyte strings.
function capArray(arr, maxItems = 20, maxLen = 50) {
  if (!Array.isArray(arr)) return [];
  return arr
    .filter((s) => typeof s === "string")
    .map((s) => s.slice(0, maxLen))
    .slice(0, maxItems);
}

function fetchWithTimeout(url, opts = {}, ms = 30000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), ms);
  return fetch(url, { ...opts, signal: controller.signal }).finally(() =>
    clearTimeout(id)
  );
}

// Devpost returns `submission_period_dates` as a human-readable string in
// one of four shapes observed in the live API response:
//   "Jul 01, 2026 - Jun 01, 2027"   // cross-year range (both halves carry a year)
//   "May 18 - Jun 15, 2026"         // cross-month range (single year at end)
//   "Apr 24 - 26, 2026"             // same-month range (second half is just a day)
//   "Dec 31, 2026"                  // single day
// No ISO alternative is exposed, so we parse the string back to start/end
// ISO dates. Patterns are tried most-specific first; anything that matches
// none returns { start: null, end: null } and the event still flows through
// with unknown dates (it just won't show up in the upcoming filter).
const DEVPOST_MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function _devpostToISO(year, monthName, day) {
  const m = DEVPOST_MONTHS[monthName.slice(0, 3).toLowerCase()];
  if (!m) return null;
  const d = parseInt(day, 10);
  if (isNaN(d) || d < 1 || d > 31) return null;
  return `${year}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
}

function parseDevpostDates(raw) {
  if (!raw || typeof raw !== "string") return { start: null, end: null };
  const s = raw.trim();

  // "Mon DD, YYYY - Mon DD, YYYY" (cross-year range — both halves carry a
  // year, e.g. "Jul 01, 2026 - Jun 01, 2027"). Tried first because it's the
  // only shape that has two separate years; otherwise the cross-month regex
  // below would swallow the first half and drop the second year.
  let m = s.match(
    /^(\w{3,})\s+(\d{1,2}),?\s+(\d{4})\s*[-–]\s*(\w{3,})\s+(\d{1,2}),?\s+(\d{4})$/
  );
  if (m) {
    return {
      start: _devpostToISO(m[3], m[1], m[2]),
      end: _devpostToISO(m[6], m[4], m[5]),
    };
  }

  // "Mon DD - Mon DD, YYYY" (cross-month range, single year at the end).
  m = s.match(
    /^(\w{3,})\s+(\d{1,2})\s*[-–]\s*(\w{3,})\s+(\d{1,2}),?\s+(\d{4})$/
  );
  if (m) {
    return {
      start: _devpostToISO(m[5], m[1], m[2]),
      end: _devpostToISO(m[5], m[3], m[4]),
    };
  }

  // "Mon DD - DD, YYYY" (same-month range — second half is just a day).
  m = s.match(/^(\w{3,})\s+(\d{1,2})\s*[-–]\s*(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    return {
      start: _devpostToISO(m[4], m[1], m[2]),
      end: _devpostToISO(m[4], m[1], m[3]),
    };
  }

  // "Mon DD, YYYY" (single day).
  m = s.match(/^(\w{3,})\s+(\d{1,2}),?\s+(\d{4})$/);
  if (m) {
    const iso = _devpostToISO(m[3], m[1], m[2]);
    return { start: iso, end: iso };
  }

  return { start: null, end: null };
}

// Best-effort country extraction from Devpost's free-text location string.
// Devpost doesn't return structured geo, just a venue name that may or may
// not end in a recognizable country. We check the lower-cased string against
// a curated list of country aliases that actually show up in hackathon data
// and return a normalized label; anything we don't recognize returns null
// and the event falls through with `country=null` (the venue still renders
// in the `location` field).
const DEVPOST_COUNTRY_MAP = [
  ["united states", "USA"], ["u.s.a", "USA"], [" usa", "USA"], ["usa ", "USA"], [", usa", "USA"],
  ["canada", "Canada"], ["canadá", "Canada"],
  ["mexico", "Mexico"], ["méxico", "Mexico"],
  ["brasil", "Brasil"], ["brazil", "Brasil"],
  ["argentina", "Argentina"], ["chile", "Chile"], ["colombia", "Colombia"],
  ["peru", "Peru"], ["uruguay", "Uruguay"],
  ["germany", "Germany"], ["deutschland", "Germany"],
  ["united kingdom", "UK"], [" uk", "UK"], [", uk", "UK"],
  ["france", "France"], ["spain", "Spain"], ["españa", "Spain"],
  ["italy", "Italy"], ["netherlands", "Netherlands"], ["belgium", "Belgium"],
  ["switzerland", "Switzerland"], ["ireland", "Ireland"], ["poland", "Poland"],
  ["portugal", "Portugal"], ["sweden", "Sweden"], ["norway", "Norway"],
  ["denmark", "Denmark"], ["finland", "Finland"], ["austria", "Austria"],
  ["india", "India"], ["nepal", "Nepal"], ["pakistan", "Pakistan"],
  ["bangladesh", "Bangladesh"], ["sri lanka", "Sri Lanka"],
  ["china", "China"], ["japan", "Japan"], ["south korea", "South Korea"],
  ["korea", "South Korea"], ["taiwan", "Taiwan"], ["hong kong", "Hong Kong"],
  ["singapore", "Singapore"], ["malaysia", "Malaysia"], ["indonesia", "Indonesia"],
  ["philippines", "Philippines"], ["vietnam", "Vietnam"], ["thailand", "Thailand"],
  ["australia", "Australia"], ["new zealand", "New Zealand"],
  ["turkey", "Turkey"], ["türkiye", "Turkey"],
  ["israel", "Israel"], ["united arab emirates", "UAE"], [" uae", "UAE"],
  ["saudi arabia", "Saudi Arabia"], ["egypt", "Egypt"],
  ["south africa", "South Africa"], ["nigeria", "Nigeria"], ["kenya", "Kenya"],
];

function extractDevpostCountry(location) {
  if (!location) return null;
  const l = ` ${location.toLowerCase()} `;
  for (const [needle, label] of DEVPOST_COUNTRY_MAP) {
    if (l.includes(needle)) return label;
  }
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
        const res = await fetchWithTimeout(`https://api.lu.ma/url?url=${slug}`);
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
    const firstRes = await fetchWithTimeout(
      `https://dorahacks.io/api/hackathon/?page=1&page_size=${pageSize}`,
      { headers: DORAHACKS_HEADERS }
    );
    if (!firstRes.ok) return events;
    const firstData = await firstRes.json();
    const totalPages = Math.min(
      DORAHACKS_MAX_PAGES,
      Math.max(1, Math.ceil((firstData.count || 0) / pageSize))
    );

    const pagePromises = [Promise.resolve(firstData)];
    for (let page = 2; page <= totalPages; page++) {
      pagePromises.push(
        fetchWithTimeout(
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
      const tags = capArray(
        h.field
          ? h.field.split(",").map((t) => t.trim().toLowerCase()).filter(Boolean)
          : []
      );
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

async function fetchDevpostEvents() {
  // Devpost's public `/api/hackathons` endpoint paginates via `?page=N` and
  // reports `meta.total_count`. We fetch page 1 up-front to learn how many
  // pages exist, then walk the rest sequentially with a small delay between
  // requests so the AWS ALB in front of Devpost doesn't flag the burst. The
  // sequential + delay pattern is intentional: parallelizing all pages at
  // once works today but raises the profile of the job and risks future
  // rate-limiting, and cron-every-6h doesn't need the latency win.
  const events = [];
  let allHackathons = [];

  try {
    const buildUrl = (page) =>
      `https://devpost.com/api/hackathons?status=upcoming&per_page=${DEVPOST_PER_PAGE}&page=${page}`;

    const first = await fetchWithTimeout(buildUrl(1), { headers: DEVPOST_HEADERS });
    if (!first.ok) {
      console.warn(`[devpost] page 1 failed: ${first.status}`);
      return events;
    }
    const firstJson = await first.json();
    const totalCount = firstJson?.meta?.total_count || 0;
    const totalPages = Math.min(
      DEVPOST_MAX_PAGES,
      Math.max(1, Math.ceil(totalCount / DEVPOST_PER_PAGE))
    );
    allHackathons = Array.isArray(firstJson?.hackathons)
      ? [...firstJson.hackathons]
      : [];

    for (let page = 2; page <= totalPages; page++) {
      await sleep(DEVPOST_PAGE_DELAY_MS);
      try {
        const res = await fetchWithTimeout(buildUrl(page), { headers: DEVPOST_HEADERS });
        if (!res.ok) {
          console.warn(`[devpost] page ${page} failed: ${res.status}`);
          break;
        }
        const json = await res.json();
        if (Array.isArray(json?.hackathons)) {
          allHackathons.push(...json.hackathons);
        }
      } catch (e) {
        console.warn(`[devpost] page ${page} error: ${e.message}`);
        break;
      }
    }
  } catch (e) {
    console.warn("[devpost] fetch failed:", e.message);
    return events;
  }

  for (const h of allHackathons) {
    if (!h || !h.id || !h.title) continue;

    const { start, end } = parseDevpostDates(h.submission_period_dates || "");
    // Skip events whose end date (or start, if no end) is already in the
    // past. Devpost sometimes returns events with `status=upcoming` that
    // just finished — defensive filter.
    const endForFilter = end || start;
    if (endForFilter && endForFilter < today) continue;

    const loc = h.displayed_location || {};
    const locText = (loc.location || "").trim();
    const lowerLoc = locText.toLowerCase();
    // Devpost uses two icons: "globe" for fully online, "map-marker-alt"
    // for physical or hybrid. A venue string like "TWA Hotel + Online" or
    // "South SF Conference Center + Online" means hybrid.
    const isOnline =
      loc.icon === "globe" || lowerLoc === "online" || lowerLoc === "";
    const isHybrid =
      !isOnline && /\+\s*online|online\s*\+/i.test(locText);
    let type;
    if (isOnline) type = "online";
    else if (isHybrid) type = "hibrido";
    else type = "presencial";

    const country = isOnline ? "Online" : extractDevpostCountry(locText);

    const tags = capArray(
      Array.isArray(h.themes)
        ? h.themes
            .map((t) => (t?.name || "").toLowerCase().trim())
            .filter(Boolean)
        : []
    );

    // Devpost wraps currency values in an HTML `<span>` like
    // `$<span data-currency-value>20,000</span>`. Strip tags for a clean
    // plain-text fragment suitable for the description line.
    const prizeClean = (h.prize_amount || "")
      .replace(/<[^>]+>/g, "")
      .replace(/\s+/g, " ")
      .trim();

    const descParts = [];
    if (h.organization_name) descParts.push(`by ${h.organization_name}`);
    if (prizeClean && !/\$?0$/.test(prizeClean)) {
      descParts.push(`prize ${prizeClean}`);
    }
    if (typeof h.registrations_count === "number" && h.registrations_count > 0) {
      descParts.push(`${h.registrations_count} registered`);
    }
    const description = descParts.join(" · ").slice(0, 300);

    events.push({
      slug: `devpost-${h.id}`,
      name: h.title,
      date_start: start,
      date_end: end,
      country,
      city: null,
      location: isOnline ? null : locText || null,
      url: isHttpUrl(h.url) ? h.url : null,
      source: "devpost",
      type,
      tags,
      description,
      status: "approved",
    });
  }

  return events;
}

async function fetchGitHubIssues() {
  // Fetch all open issues, paginating via the Link header, then parse both
  // [hackathon] and [lfg] entries. Also track the slugs/source_keys we saw
  // so the caller can soft-delete anything in DB that's no longer present
  // (i.e. the issue was closed / deleted).
  //
  // Cap at 10 pages (1000 issues) as a safety net — if the repo ever holds
  // more than that, switch to a search-based API rather than paging the
  // whole issue list.
  const GITHUB_MAX_PAGES = 10;
  try {
    const allIssues = [];
    let url =
      `https://api.github.com/repos/${GITHUB_REPO}/issues?state=open&per_page=100`;
    for (let page = 0; page < GITHUB_MAX_PAGES && url; page++) {
      const res = await fetchWithTimeout(url, { headers: GITHUB_HEADERS });
      if (!res.ok) {
        return {
          hackathons: [],
          lfg: [],
          seenHackSlugs: new Set(),
          seenLfgSourceKeys: new Set(),
          fetchSucceeded: false,
        };
      }
      const pageIssues = await res.json();
      if (!Array.isArray(pageIssues)) break;
      allIssues.push(...pageIssues);
      // GitHub returns e.g. `<https://.../issues?page=2>; rel="next", <...>; rel="last"`
      const linkHeader = res.headers.get("link") || "";
      const nextMatch = linkHeader.match(/<([^>]+)>;\s*rel="next"/);
      url = nextMatch ? nextMatch[1] : null;
    }
    const issues = allIssues;
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

      // Labels are looked up in English first (what the post-i18n terminal
      // emits) and fall back to Spanish so we keep parsing issues that were
      // opened before the i18n refactor.
      const bilingualField = (en, es, enForm, esForm) =>
        field(en, enForm) || field(es, esForm);

      const lower = title.toLowerCase();
      if (lower.startsWith("[hackathon]")) {
        seenHackSlugs.add(`gh-${issue.number}`);
        let date_start = null;
        let date_end = null;
        const dateRaw = boldField("Date") || boldField("Fecha");
        if (dateRaw) {
          const dates = dateRaw.match(/\d{4}-\d{2}-\d{2}/g) || [];
          date_start = dates[0] || null;
          date_end = dates[1] || date_start;
        } else {
          const startRaw = formField("Start date") || formField("Fecha inicio");
          const endRaw = formField("End date") || formField("Fecha fin");
          date_start = startRaw?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || null;
          date_end =
            endRaw?.match(/\d{4}-\d{2}-\d{2}/)?.[0] || date_start;
        }
        // Defensive: if the issue body has a typo where date_end < date_start
        // (e.g. "2026-04-24 - 2026-04-03"), assume it's a single-day or
        // mistyped end date and fall back to date_start instead of silently
        // dropping the event for being "in the past".
        if (date_start && date_end && date_end < date_start) {
          date_end = date_start;
        }
        if (date_end && date_end < today) continue;

        const tagsRaw = field("Tags");
        const tags = capArray(
          tagsRaw
            ? tagsRaw.split(/,\s*/).map((t) => t.trim()).filter(Boolean)
            : []
        );
        const descMatch = body.match(/###\s*(?:Description|Descripcion)\s*\n+([\s\S]*?)$/i);
        const description = descMatch ? descMatch[1].trim().slice(0, 300) : "";

        const rawUrl = bilingualField("URL", "URL", "Event URL", "URL del evento");
        hackathons.push({
          slug: `gh-${issue.number}`,
          name: title.replace(/^\[hackathon\]\s*/i, "").trim().slice(0, 200),
          date_start,
          date_end,
          country: (bilingualField("Country", "Pais") || "").slice(0, 100) || null,
          city: (bilingualField("City", "Ciudad") || "").slice(0, 100) || null,
          location: (bilingualField("Venue", "Lugar") || "").slice(0, 200) || null,
          url: isHttpUrl(rawUrl) ? rawUrl : null,
          source: "comunidad",
          type: normalizeType(bilingualField("Type", "Tipo")),
          tags,
          description,
          status: issueStatus,
        });
      } else if (lower.startsWith("[lfg]")) {
        seenLfgSourceKeys.add(`gh-${issue.number}`);
        const handle = (
          field("Handle", "Your name or handle") ||
          field("Handle", "Tu nombre o alias") ||
          title.replace(/^\[lfg\]\s*/i, "").trim()
        ).slice(0, 100);
        const skillsRaw =
          field("Skills", "Skills (comma-separated)") ||
          field("Skills", "Skills (separados por coma)");
        const skills = capArray(
          skillsRaw
            ? skillsRaw.split(/,\s*/).map((s) => s.trim()).filter(Boolean)
            : []
        );
        const hackathon = field("Hackathon") || "";
        const contact = (
          field("Contact", "Contact (twitter, discord, telegram, email)") ||
          field("Contacto", "Contacto (twitter, discord, telegram, email)") ||
          ""
        ).slice(0, 200);
        const message = (
          field("Message", "Message (optional)") ||
          field("Mensaje", "Mensaje (opcional)") ||
          ""
        ).slice(0, 200);
        if (!hackathon) continue;
        lfg.push({
          source_key: `gh-${issue.number}`,
          handle,
          skills,
          hackathon_name: hackathon.slice(0, 200),
          contact,
          message,
          status: issueStatus,
        });
      }
    }
    return { hackathons, lfg, seenHackSlugs, seenLfgSourceKeys, fetchSucceeded: true };
  } catch (e) {
    console.warn("GitHub fetch failed:", e.message);
    return {
      hackathons: [],
      lfg: [],
      seenHackSlugs: new Set(),
      seenLfgSourceKeys: new Set(),
      fetchSucceeded: false,
    };
  }
}

// ---------- Main ----------

async function main() {
  console.log("[ingest] starting…");
  const t0 = Date.now();

  const [lumaEvents, doraEvents, devpostEvents, ghResult] = await Promise.all([
    fetchLumaEvents(),
    fetchDoraHacksEvents(),
    fetchDevpostEvents(),
    fetchGitHubIssues(),
  ]);

  console.log(
    `[ingest] fetched: luma=${lumaEvents.length} dora=${doraEvents.length} devpost=${devpostEvents.length} gh=${ghResult.hackathons.length} lfg=${ghResult.lfg.length} (${Date.now() - t0}ms)`
  );

  // Dedup priority: comunidad > luma > dorahacks > devpost. Community
  // submissions win because a human reviewer curated them; structured sources
  // are preferred over raw APIs when they carry the same event.
  const merged = [];
  for (const e of [
    ...ghResult.hackathons,
    ...lumaEvents,
    ...doraEvents,
    ...devpostEvents,
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
  //
  // Skip when the GitHub fetch failed — otherwise a transient outage would
  // leave `seenHackSlugs` empty and mass-reject every comunidad hackathon.
  if (!ghResult.fetchSucceeded) {
    console.warn("[ingest] skipping comunidad soft-delete because GitHub fetch failed");
  } else {
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
  // Same guard as above — don't mass-reject on a transient GitHub outage.
  if (!ghResult.fetchSucceeded) {
    console.warn("[ingest] skipping lfg soft-delete because GitHub fetch failed");
  } else {
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
  }

  console.log(`[ingest] done in ${Date.now() - t0}ms`);
}

main().catch((e) => {
  console.error("[ingest] fatal:", e);
  process.exit(1);
});
