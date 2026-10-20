/* =========================================================
   Render-rate RCA — error classifiers.

   These patterns are the ONLY place that encodes log wording.
   When a run shows errors in "Unclassified signatures", add a
   pattern here — no other code needs to change.

   Rules are evaluated in order; first match wins. Each rule is
   tested first against msg/reason/err/meta, and only if nothing
   matches is the stacktrace included (stack frames contain words
   like "timeout" or "download" in function names that would
   otherwise cause false matches).

   `owner` says who has to act, which is what an RCA ultimately
   needs to tell a customer:
     AD_PARTNER       — the demand partner sent something unusable
     SSAI_TRANSCODER  — our pipeline failed on a valid creative
     SSAI_TRACKER     — our side failed to fire the beacon
     TRACKER_ENDPOINT — the 3rd-party beacon endpoint failed
     UNKNOWN          — needs a new pattern
   ========================================================= */

export const RULE_ENGINE_RULES = [
  {
    category: "MAX_TRANSCODE_ATTEMPTS",
    label: "Max transcode attempts reached (profile stayed FAILED)",
    owner: "SSAI_TRANSCODER",
    patterns: [
      /max(imum)?[\s_-]*(transcod\w*[\s_-]*)?(attempt|retr)/i,
      /(attempts?|retries)\s*(exhausted|exceeded)/i,
      /exceeded\s*(max(imum)?\s*)?(transcod\w*\s*)?(attempts?|retries)/i,
    ],
  },
  {
    category: "VPAID",
    label: "VPAID / interactive creative (not transcodable)",
    owner: "AD_PARTNER",
    patterns: [
      /vpaid/i,
      /apiframework/i,
      /application\/(x-)?(javascript|shockwave-flash)/i,
      /https?:\/\/\S+\.(js|swf)(\?|\s|$)/i,
    ],
  },
  {
    category: "NO_AUDIO",
    label: "Ad asset has no audio track",
    owner: "AD_PARTNER",
    patterns: [
      /no\s*audio/i,
      /without\s*audio/i,
      /missing\s*audio/i,
      /audio\s*(stream|track|channel)s?\s*(not\s*found|missing|absent|empty)/i,
      /audio_?stream_?count\W*0\b/i,
    ],
  },
  {
    category: "URL_INACCESSIBLE",
    label: "Ad asset URL not accessible",
    owner: "AD_PARTNER",
    patterns: [
      /status(\s*code)?\W{0,3}(4\d\d|5\d\d)\b/i,
      /\b(403|404|410)\b.*\b(forbidden|not\s*found|gone)\b/i,
      /\bforbidden\b/i,
      /unable\s*to\s*(access|download|fetch|reach|open)/i,
      /(download|fetch)\w*\s*fail/i,
      /fail\w*\s*to\s*(download|fetch)/i,
      /connection\s*(refused|reset)/i,
      /no\s*such\s*host/i,
      /dial\s*tcp/i,
      /i\/o\s*timeout/i,
      /tls|x509|certificate/i,
    ],
  },
  {
    category: "INVALID_ASSET",
    label: "Invalid / unusable ad asset",
    owner: "AD_PARTNER",
    patterns: [
      /invalid\s*(media|asset|creative|media\s*file|mediafile|video)/i,
      /unsupported\s*(codec|format|mime|container|media)/i,
      /no\s*(valid\s*)?(media\s*files?|mediafiles?|renditions?)/i,
      /corrupt/i,
      /ffprobe/i,
      /moov\s*atom/i,
      /invalid\s*data\s*found/i,
    ],
  },
];

export const TRACKER_RULES = [
  {
    category: "INVALID_TRACKER",
    label: "Tracker URL invalid / malformed",
    owner: "AD_PARTNER",
    patterns: [
      /invalid\s*(tracker|tracking|beacon|impression|url|uri)/i,
      /malformed/i,
      /unsupported\s*protocol/i,
      /(missing|empty)\s*(tracker|tracking|beacon|url|uri)/i,
      /parse\s*(error|fail)/i,
      /fail\w*\s*to\s*parse/i,
      /invalid\s*(control\s*character|port|host)/i,
    ],
  },
  {
    category: "TRACKER_TIMEOUT",
    label: "Tracker request timed out",
    owner: "TRACKER_ENDPOINT",
    patterns: [/time[\s-]?d?\s*out/i, /deadline\s*exceeded/i, /context\s*canceled/i],
  },
  {
    category: "TRACKER_HTTP_ERROR",
    label: "Tracker endpoint returned an error / unreachable",
    owner: "TRACKER_ENDPOINT",
    patterns: [
      /status(\s*code)?\W{0,3}(4\d\d|5\d\d)\b/i,
      /non[\s-]?2\d\d/i,
      /connection\s*(refused|reset)/i,
      /no\s*such\s*host/i,
      /dial\s*tcp/i,
      /\beof\b/i,
      /tls|x509|certificate/i,
    ],
  },
  {
    category: "TRACKER_NOT_FIRED",
    label: "Tracker not fired",
    owner: "SSAI_TRACKER",
    patterns: [
      /not\s*fired/i,
      /fail\w*\s*to\s*(fire|send|ping)/i,
      /(fire|firing|send|ping)\w*\s*fail/i,
      /could\s*not\s*(fire|send)/i,
      /skip\w*\s*(tracker|tracking|beacon)/i,
    ],
  },
];

export const UNCLASSIFIED = {
  category: "UNCLASSIFIED",
  label: "Unclassified error",
  owner: "UNKNOWN",
};

/* ─── Helpers ─────────────────────────────────────────────────────────── */

export function parseMeta(meta) {
  if (meta === null || meta === undefined || meta === "") return null;
  if (typeof meta === "object") return meta;
  try {
    return JSON.parse(meta);
  } catch {
    return null;
  }
}

function rowText(row, { includeStack }) {
  return [row.msg, row.reason, row.err, row.meta, includeStack ? row.stacktrace : null]
    .filter((v) => v !== null && v !== undefined && v !== "")
    .map((v) => (typeof v === "string" ? v : JSON.stringify(v)))
    .join(" | ");
}

function matchRules(rules, text) {
  for (const rule of rules) {
    if (rule.patterns.some((p) => p.test(text))) return rule;
  }
  return null;
}

export function classify(row, rules) {
  const primary = matchRules(rules, rowText(row, { includeStack: false }));
  if (primary) return { ...primary, patterns: undefined, matchedOn: "message" };

  const withStack = matchRules(rules, rowText(row, { includeStack: true }));
  if (withStack) return { ...withStack, patterns: undefined, matchedOn: "stacktrace" };

  return { ...UNCLASSIFIED, matchedOn: null };
}

/**
 * Collapse a message into a stable "signature" so unclassified errors
 * can be grouped: URLs, UUIDs, hex ids and numbers are replaced.
 */
export function messageSignature(row) {
  const base = [row.msg, row.reason || row.err].filter(Boolean).join(" — ") || "(empty message)";
  return base
    .replace(/https?:\/\/\S+/g, "<url>")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<uuid>")
    .replace(/\b[0-9a-f]{16,}\b/gi, "<hex>")
    .replace(/\d+/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 240);
}

/* ─── Field extraction from meta / free text ─────────────────────────── */

const URL_KEYS = [
  "asset_url", "assetUrl", "media_url", "mediaUrl", "mediafile_url", "mediaFileUrl",
  "creative_url", "creativeUrl", "ad_url", "adUrl", "source_url", "sourceUrl",
  "src", "url", "uri",
];

const CREATIVE_ID_KEYS = ["creative_id", "creativeId", "asset_id", "assetId", "ad_id", "adId"];
const PROFILE_KEYS = ["profile", "profile_name", "profileName", "rendition", "transcode_profile"];

const MEDIA_EXT = /\.(mp4|m4v|mov|webm|m3u8|mpd|ts|mxf|mkv|flv)(\?|#|$)/i;

/** Depth-limited, case-insensitive key lookup in a parsed meta object. */
function findKey(obj, keys, depth = 0) {
  if (!obj || typeof obj !== "object" || depth > 3) return null;
  const lowerKeys = keys.map((k) => k.toLowerCase());

  for (const [k, v] of Object.entries(obj)) {
    if (lowerKeys.includes(k.toLowerCase()) && v !== null && v !== "" && typeof v !== "object") {
      return String(v);
    }
  }
  for (const v of Object.values(obj)) {
    if (v && typeof v === "object") {
      const found = findKey(v, keys, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

function cleanUrl(url) {
  return url.replace(/[)\]},;:.'"\\]+$/, "");
}

export function extractAssetUrl(row, meta = parseMeta(row.meta)) {
  if (row.ad_url) return cleanUrl(row.ad_url);

  const fromMeta = findKey(meta, URL_KEYS);
  if (fromMeta && /^https?:\/\//i.test(fromMeta)) return cleanUrl(fromMeta);

  const text = [row.meta, row.err, row.reason, row.msg, row.stacktrace].filter(Boolean).join(" ");
  const matches = (text.match(/https?:\/\/[^\s"'<>|]+/g) || []).map(cleanUrl);
  if (!matches.length) return null;

  // Prefer something that looks like a media file over e.g. a VAST/tracker URL
  return matches.find((u) => MEDIA_EXT.test(u)) || matches[0];
}

export function extractCreativeId(row, meta = parseMeta(row.meta)) {
  return row.asset_id || findKey(meta, CREATIVE_ID_KEYS);
}

export function extractProfile(meta) {
  return findKey(meta, PROFILE_KEYS);
}

/** Group key for an asset URL: strip query/hash so cache-busters don't split one creative. */
export function assetKey(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`;
  } catch {
    return url.split(/[?#]/)[0];
  }
}

export function urlHost(url) {
  if (!url) return null;
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

export function extractHttpStatus(row) {
  const text = [row.err, row.reason, row.msg, row.meta].filter(Boolean).join(" ");
  const m = text.match(/status(?:\s*code)?\W{0,3}([1-5]\d\d)\b/i);
  return m ? Number(m[1]) : null;
}
