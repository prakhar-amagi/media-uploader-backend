/* =========================================================
   Platform helpers — one place that knows the shape of
   Channel.platforms ({ platformName: stormforgeChannelId }).
   ========================================================= */

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9 _+&()\-]{0,39}$/;   // no "." or "$" (Mongo keys)
const CHANNEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:\-]{2,199}$/;

/** Configured platforms of a channel document, skipping empty IDs. */
export function getChannelPlatforms(channelDoc) {
  const raw = channelDoc?.platforms;
  const obj = raw instanceof Map ? Object.fromEntries(raw) : (raw && typeof raw === "object" ? raw : {});
  const out = {};
  for (const [name, id] of Object.entries(obj)) {
    if (typeof id === "string" && id.trim()) out[name] = id.trim();
  }
  return out;
}

export function getPlatformNames(channelDoc) {
  return Object.keys(getChannelPlatforms(channelDoc));
}

/** Case-insensitive lookup so "lg" in a request still matches "LG". */
export function resolvePlatformId(channelDoc, platformName) {
  const platforms = getChannelPlatforms(channelDoc);
  if (platforms[platformName]) return platforms[platformName];
  const key = Object.keys(platforms).find((k) => k.toLowerCase() === String(platformName).toLowerCase());
  return key ? platforms[key] : null;
}

/**
 * Normalize platforms from a request body into { name: id }.
 * Accepts:
 *   platforms: [{ name, channelId }, …]      (new admin UI)
 *   platforms: { Samsung: "amg…", … }        (object form)
 *   samsung / xiaomi / lg fields             (old admin UI — still works)
 * Returns { platforms, errors }.
 */
export function normalizePlatformsInput(body = {}) {
  const errors = [];
  let entries = [];
  let legacy = false;

  if (Array.isArray(body.platforms)) {
    entries = body.platforms.map((p) => [p?.name, p?.channelId ?? p?.id]);
  } else if (body.platforms && typeof body.platforms === "object") {
    entries = Object.entries(body.platforms);
  } else {
    // old form: fixed fields, blanks simply mean "not on this platform"
    legacy = true;
    entries = [
      ["Samsung", body.samsung],
      ["Xiaomi", body.xiaomi],
      ["LG", body.lg],
    ];
  }

  const platforms = {};
  const seen = new Set();

  for (const [rawName, rawId] of entries) {
    const name = String(rawName ?? "").trim().replace(/\s+/g, " ");
    const id = String(rawId ?? "").trim();

    if (!name && !id) continue;                       // blank row in the form
    if (legacy && !id) continue;
    if (!name) { errors.push(`Platform name missing for channel ID "${id}"`); continue; }
    if (!id) { errors.push(`Channel ID missing for platform "${name}"`); continue; }
    if (!NAME_RE.test(name)) {
      errors.push(`Invalid platform name "${name}" (letters, digits, spaces, _ - + & ( ); max 40; no dots)`);
      continue;
    }
    if (!CHANNEL_ID_RE.test(id)) {
      errors.push(`Invalid channel ID for ${name}: "${id}" (no spaces; letters, digits, . _ : -)`);
      continue;
    }
    if (seen.has(name.toLowerCase())) { errors.push(`Platform "${name}" is listed twice`); continue; }

    seen.add(name.toLowerCase());
    platforms[name] = id;
  }

  return { platforms, errors };
}

/** Field-level diff for audit logs. */
export function diffPlatforms(before = {}, after = {}) {
  const added = {}, removed = {}, changed = {};
  for (const [k, v] of Object.entries(after)) {
    if (!(k in before)) added[k] = v;
    else if (before[k] !== v) changed[k] = { from: before[k], to: v };
  }
  for (const [k, v] of Object.entries(before)) if (!(k in after)) removed[k] = v;
  return { added, removed, changed };
}

/** Admins see every channel; users only the channels assigned to them. */
export function canAccessChannel(user, channelName) {
  if (!user) return false;
  if (user.role === "admin") return true;
  return (user.channels || []).includes(channelName);
}
