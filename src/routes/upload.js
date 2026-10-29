import express from "express";
import multer from "multer";
import fs from "fs";

import { requireAuth } from "../middleware/authMiddleware.js";
import { sanitizeFilename } from "../utils/filename.js";
import { uploadToS3 } from "../s3.js";
import { getPromos, putPromos } from "../stormforge.js";
import Channel from "../models/Channel.js";
import Log from "../models/Log.js";
import { resolvePlatformId, canAccessChannel } from "../utils/platforms.js";

const upload = multer({ dest: "/tmp" });
const router = express.Router();

router.use(requireAuth);

/* ---------- Ensure SSAI config ---------- */
function ensureFillerConfig(data) {
  if (!data.ssai_configuration) {
    data.ssai_configuration = {};
  }

  if (!data.ssai_configuration.filler_config) {
    data.ssai_configuration.filler_config = {
      no_replacement_mode: "fill_ad_break",
      partial_replacement_mode: "fill_ad_break",
      filler_selection_strategy: "random",
      url: []
    };
  }

  if (!Array.isArray(data.ssai_configuration.filler_config.url)) {
    data.ssai_configuration.filler_config.url = [];
  }

  return data;
}

/* ---------- Parse targets ----------
   New:    targets = [{ channel: "Zee News", platforms: ["Samsung","LG"] }, ...]
           (each channel has its own platform selection)
   Legacy: channelNames = [...], platforms = [...]  (same platforms for all)
-------------------------------------- */
function parseJsonField(value, field) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    throw Object.assign(new Error(`${field} must be valid JSON`), { status: 400 });
  }
}

function parseTargets(body) {
  const targets = parseJsonField(body.targets, "targets");

  let list;
  if (targets !== undefined) {
    if (!Array.isArray(targets)) throw Object.assign(new Error("targets must be an array"), { status: 400 });
    list = targets.map((t) => ({
      channel: String(t?.channel || "").trim(),
      platforms: Array.isArray(t?.platforms) ? t.platforms.map(String) : [],
    }));
  } else {
    const channelNames = parseJsonField(body.channelNames, "channelNames") || [];
    const platforms = parseJsonField(body.platforms, "platforms") || [];
    list = channelNames.map((channel) => ({ channel: String(channel), platforms: platforms.map(String) }));
  }

  // merge duplicates, drop empties
  const merged = new Map();
  for (const t of list) {
    if (!t.channel || !t.platforms.length) continue;
    const set = merged.get(t.channel) || new Set();
    t.platforms.forEach((p) => set.add(p));
    merged.set(t.channel, set);
  }
  return [...merged.entries()].map(([channel, set]) => ({ channel, platforms: [...set] }));
}

function cleanupTemp(file) {
  if (!file?.path) return;
  try {
    fs.unlinkSync(file.path);
  } catch (err) {
    console.warn("Failed to remove temp file:", err.message);
  }
}

/* ---------- Concurrency helper ---------- */
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

const S3_FILE_CONCURRENCY = Number(process.env.S3_FILE_CONCURRENCY || 3);
const STORMFORGE_CONCURRENCY = Number(process.env.STORMFORGE_CONCURRENCY || 4);

/* ---------- Progress stream ----------
   With ?stream=1 the response is NDJSON (one JSON object per line):
     {"type":"start", ...}
     {"type":"s3", "loaded":…, "total":…, "filesDone":…, "filesTotal":…}
     {"type":"delivery", "done":…, "total":…, "channel":…, "platform":…, "ok":true}
     {"type":"done", …final result…}
   so the browser can show real progress for the server-side work.
   Without it, a single JSON response is returned (old behaviour).
-------------------------------------- */
function makeReporter(req, res, streaming) {
  let lastS3 = 0;
  const write = (obj) => {
    if (!streaming || res.writableEnded || res.destroyed) return;
    res.write(JSON.stringify(obj) + "\n");
  };
  return {
    start(info) {
      if (!streaming) return;
      res.writeHead(200, {
        "Content-Type": "application/x-ndjson; charset=utf-8",
        "Cache-Control": "no-cache",
        "X-Accel-Buffering": "no"        // stop nginx buffering the progress lines
      });
      write({ type: "start", ...info });
    },
    s3(progress, force = false) {
      const now = Date.now();
      if (!force && now - lastS3 < 250) return;   // throttle
      lastS3 = now;
      write({ type: "s3", ...progress });
    },
    event: write,
  };
}

/* ---------- UPLOAD ----------
   Accepts one file ("file", old client) or many ("files").
   1. Validate + resolve every channel/platform target (nothing uploaded yet)
   2. Upload all files to S3 in parallel (multipart)
   3. Update each StormForge delivery ONCE with all new files, in parallel
-------------------------------- */
router.post(
  "/",
  upload.fields([{ name: "file", maxCount: 1 }, { name: "files", maxCount: 50 }]),
  async (req, res) => {
    const files = [...(req.files?.files || []), ...(req.files?.file || [])];
    const streaming = req.query.stream === "1";
    const report = makeReporter(req, res, streaming);
    const t0 = Date.now();
    const timings = {};

    try {
      if (!files.length) {
        return res.status(400).json({ error: "file(s) required" });
      }

      const targets = parseTargets(req.body);
      if (!targets.length) {
        return res.status(400).json({ error: "Select at least one platform for at least one channel" });
      }

      /* ---------- Access check: refuse the whole request ---------- */
      const forbidden = targets.filter((t) => !canAccessChannel(req.user, t.channel)).map((t) => t.channel);
      if (forbidden.length) {
        return res.status(403).json({ error: `No access to channel(s): ${forbidden.join(", ")}` });
      }

      /* ---------- Files: sanitize names, refuse duplicates ---------- */
      const fileItems = files.map((f) => ({
        original: f.originalname,
        filename: sanitizeFilename(f.originalname),
        path: f.path,
        size: f.size,
      }));
      const dupes = fileItems
        .map((f) => f.filename)
        .filter((n, i, all) => all.indexOf(n) !== i);
      if (dupes.length) {
        return res.status(400).json({ error: `Duplicate file name(s) in this batch: ${[...new Set(dupes)].join(", ")}` });
      }

      /* ---------- Resolve every target BEFORE uploading ---------- */
      const failures = [];
      const resolved = [];

      const docs = await Channel.find({ channel: { $in: targets.map((t) => t.channel) } });
      const byName = new Map(docs.map((d) => [d.channel, d]));

      for (const t of targets) {
        const doc = byName.get(t.channel);
        if (!doc) {
          t.platforms.forEach((platform) => failures.push({ channel: t.channel, platform, reason: "Channel not found" }));
          continue;
        }
        for (const platform of t.platforms) {
          const channelId = resolvePlatformId(doc, platform);
          if (!channelId) {
            failures.push({ channel: t.channel, platform, reason: "Platform not configured for this channel" });
            continue;
          }
          resolved.push({ channel: t.channel, platform, channelId });
        }
      }

      if (!resolved.length) {
        return res.status(400).json({
          error: "None of the selected channel/platform combinations are configured",
          failures,
        });
      }

      // Two channel/platform entries pointing at the same delivery are updated once
      const deliveriesById = new Map();
      for (const r of resolved) {
        if (!deliveriesById.has(r.channelId)) deliveriesById.set(r.channelId, { channelId: r.channelId, targets: [] });
        deliveriesById.get(r.channelId).targets.push(r);
      }
      const deliveryJobs = [...deliveriesById.values()];

      timings.receivedMs = Date.now() - t0;   // time since the files finished arriving
      report.start({
        files: fileItems.map((f) => ({ name: f.original, size: f.size })),
        deliveries: deliveryJobs.length,
      });

      /* ---------- 1. S3, files in parallel ---------- */
      const s3Start = Date.now();
      const totalBytes = fileItems.reduce((n, f) => n + (f.size || 0), 0);
      const loadedByFile = new Array(fileItems.length).fill(0);
      let filesDone = 0;

      await mapLimit(fileItems, S3_FILE_CONCURRENCY, async (f, i) => {
        const fileStart = Date.now();
        try {
          f.url = await uploadToS3(f.path, f.filename, (loaded, total) => {
            // fraction of THIS file × its size, so the sum can't exceed the batch size
            const frac = total > 0 ? Math.min(1, loaded / total) : 0;
            loadedByFile[i] = Math.max(loadedByFile[i], Math.round(frac * (f.size || 0)));
            report.s3({
              loaded: loadedByFile.reduce((a, b) => a + b, 0),
              total: totalBytes,
              filesDone,
              filesTotal: fileItems.length,
            });
          });
          f.ok = true;
          loadedByFile[i] = f.size || 0;
        } catch (err) {
          console.error(`❌ S3 upload failed for ${f.filename}:`, err.message);
          f.ok = false;
          f.error = `S3 upload failed: ${err.message}`;
          loadedByFile[i] = f.size || 0;   // count as finished for progress
        }
        f.s3Ms = Date.now() - fileStart;
        filesDone++;
        report.s3({
          loaded: loadedByFile.reduce((a, b) => a + b, 0),
          total: totalBytes,
          filesDone,
          filesTotal: fileItems.length,
          file: f.original,
          ok: f.ok,
        }, true);
      });
      timings.s3Ms = Date.now() - s3Start;

      const uploaded = fileItems.filter((f) => f.ok);
      for (const f of fileItems.filter((x) => !x.ok)) {
        failures.push({ file: f.original, reason: f.error });
      }

      const deliveries = [];

      /* ---------- 2. StormForge, once per delivery, in parallel ---------- */
      const sfStart = Date.now();
      let deliveriesDone = 0;

      if (uploaded.length) {
        // Same final order as before: the last file in the batch ends up first
        const newUrls = uploaded.map((f) => f.url).reverse();
        const newNames = uploaded.map((f) => f.filename);

        await mapLimit(deliveryJobs, STORMFORGE_CONCURRENCY, async (job) => {
          const { channelId, targets: jobTargets } = job;
          const label = jobTargets.map((t) => `${t.channel} | ${t.platform}`).join(", ");
          let ok = false;
          let reason = null;

          try {
            let data = await getPromos(channelId);
            if (!data) throw new Error("StormForge returned no delivery config");

            data = ensureFillerConfig(data);

            // Replace any previous promo with the same filename, then put the new ones on top
            const existing = (data.ssai_configuration.filler_config.url || [])
              .filter((url) => typeof url !== "string" || !newNames.some((n) => url.endsWith(n)));
            data.ssai_configuration.filler_config.url = [...newUrls, ...existing];

            await putPromos(channelId, data);
            ok = true;
            console.log(`✅ Updated ${label} (${uploaded.length} file(s))`);
          } catch (err) {
            reason = `StormForge update failed: ${err.message}`;
            console.error(`❌ ${label} | ${channelId}:`, err.message);
          }

          deliveriesDone++;
          for (const t of jobTargets) {
            if (ok) deliveries.push({ ...t, files: uploaded.map((f) => f.original) });
            else failures.push({ ...t, reason });
          }
          report.event({
            type: "delivery",
            done: deliveriesDone,
            total: deliveryJobs.length,
            channel: jobTargets[0].channel,
            platform: jobTargets.map((t) => t.platform).join(", "),
            ok,
            reason,
          });
        });
      }
      timings.stormforgeMs = Date.now() - sfStart;

      /* ---------- Audit log: one entry per file per delivery (as before) ---------- */
      const logDocs = [];
      for (const d of deliveries) {
        for (const f of uploaded) {
          logDocs.push({
            action: "UPLOAD_PROMO",
            userEmail: req.user.email,
            channel: d.channel,
            platform: d.platform,
            channelId: d.channelId,
            details: { filename: f.filename, url: f.url, overwritten: true }
          });
        }
      }
      if (logDocs.length) {
        try { await Log.insertMany(logDocs); } catch (err) { console.error("Upload audit log failed:", err.message); }
      }

      timings.totalMs = Date.now() - t0;

      const result = {
        success: failures.length === 0,
        partial: deliveries.length > 0 && failures.length > 0,
        files: fileItems.map((f) => ({
          name: f.original, filename: f.filename, url: f.url || null, ok: !!f.ok, error: f.error || null,
          deliveriesUpdated: f.ok ? deliveries.length : 0,
        })),
        deliveries,
        failures,
        channelsProcessed: targets.length,
        targetsRequested: targets.reduce((n, t) => n + t.platforms.length, 0),
        timings,
        // single-file compatibility with the old response
        ...(fileItems.length === 1 ? { filename: fileItems[0].filename, url: fileItems[0].url || null } : {}),
        ...(!deliveries.length ? { error: "No StormForge delivery was updated" } : {})
      };

      console.log(
        `⏱ Upload ${fileItems.length} file(s) → ${deliveryJobs.length} deliveries: ` +
        `S3 ${timings.s3Ms}ms, StormForge ${timings.stormforgeMs}ms, total ${timings.totalMs}ms`
      );

      if (streaming) {
        report.event({ type: "done", status: deliveries.length ? 200 : 502, ...result });
        return res.end();
      }
      return res.status(deliveries.length ? 200 : 502).json(result);

    } catch (err) {
      console.error("❌ Upload error:", err);
      if (res.headersSent) {
        report.event({ type: "error", error: err.message });
        return res.end();
      }
      res.status(err.status || 500).json({ error: err.message });
    } finally {
      files.forEach(cleanupTemp);
    }
  }
);

export default router;
