// Progress of in-flight zip downloads, polled by the "Now downloading" panel.
// Kept in the Cache API (shared by every isolate in a data centre) because the
// zip and the polls are handled by different isolates. Best effort: if it fails
// the panel just loses track of the zip — the download itself never depends on it.
// Job ids are random, client-generated and only reveal per-file status letters:
// p(ending) a(ctive) d(one) f(ailed).

const JOB_ID_RE = /^[A-Za-z0-9_-]{8,40}$/;
const TTL_SECONDS = 3600;
const key = (id) => new Request(`https://luxsync-jobs.internal/${id}`);

export function newJob(jobId, fileCount) {
  return {
    id: JOB_ID_RE.test(jobId || "") ? jobId : null,
    state: "running",
    st: Array(fileCount).fill("p"),
    bytes: 0,
    fail: {},
    error: null,
    savedAt: 0,
  };
}

export async function saveJob(job, force = false) {
  if (!job.id) return;
  const now = Date.now();
  if (!force && now - job.savedAt < 400) return;
  job.savedAt = now;
  try {
    await caches.default.put(
      key(job.id),
      new Response(JSON.stringify({ state: job.state, files: job.st.join(""), bytes: job.bytes, fail: job.fail, error: job.error }), {
        headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${TTL_SECONDS}` },
      }),
    );
  } catch (err) {
    console.warn(`[jobs] save failed: ${err}`);
  }
}

export async function readJobs(idsCsv) {
  const out = {};
  for (const id of idsCsv.split(",").slice(0, 20)) {
    if (!JOB_ID_RE.test(id)) continue;
    try {
      const hit = await caches.default.match(key(id));
      if (hit) out[id] = await hit.json();
    } catch { /* best effort */ }
  }
  return out;
}
