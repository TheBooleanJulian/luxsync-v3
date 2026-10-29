// R2 cache for thumbnails, full images, videos and folder listings. Binding: env.CACHE.
// Every call degrades to a miss/no-op on error so the request that already has
// the data can still be answered.

export async function getJson(env, key, maxAgeSeconds) {
  try {
    const obj = await env.CACHE.get(key);
    if (!obj) return null;
    if ((Date.now() - obj.uploaded.getTime()) / 1000 > maxAgeSeconds) return null;
    return await obj.json();
  } catch (err) {
    console.warn(`[cache] get_json error for ${key}: ${err}`);
    return null;
  }
}

export async function putJson(env, key, data) {
  try {
    await env.CACHE.put(key, JSON.stringify(data), { httpMetadata: { contentType: "application/json" } });
    return true;
  } catch (err) {
    console.error(`[cache] put_json FAILED for ${key}: ${err}`);
    return false;
  }
}

/** R2ObjectBody or null. Pass `range` ({offset,length} | {suffix}) for partial reads. */
export async function getObject(env, key, range) {
  try {
    return await env.CACHE.get(key, range ? { range } : undefined);
  } catch (err) {
    console.warn(`[cache] get error for ${key}: ${err}`);
    return null;
  }
}

/** value: ArrayBuffer | Uint8Array | ReadableStream with a known length (FixedLengthStream). */
export async function putObject(env, key, value, contentType) {
  try {
    await env.CACHE.put(key, value, { httpMetadata: { contentType } });
    return true;
  } catch (err) {
    console.error(`[cache] put FAILED for ${key}: ${err}`);
    return false;
  }
}
