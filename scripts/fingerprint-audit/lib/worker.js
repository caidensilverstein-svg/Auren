/* Dedicated-worker half of the fingerprint collector.
 * Receives { sceneSrc } from collect.js, returns the same observable values the
 * main thread reports so that cross-context consistency can be checked
 * (a classic tell for naive spoofing and for incomplete randomization). */
self.onmessage = async (ev) => {
  const out = {};
  const safe = async (k, fn) => { try { out[k] = await fn(); } catch (e) { out[k] = { error: String(e && e.message || e) }; } };
  const n = self.navigator;
  await safe('navigator', () => ({
    userAgent: n.userAgent, platform: n.platform, appVersion: n.appVersion, vendor: n.vendor,
    language: n.language, languages: Array.from(n.languages || []),
    hardwareConcurrency: n.hardwareConcurrency, deviceMemory: n.deviceMemory,
    webdriver: n.webdriver, hasBrave: 'brave' in n,
  }));
  await safe('userAgentData', async () => {
    if (!n.userAgentData) return null;
    const hi = await n.userAgentData.getHighEntropyValues(['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64', 'formFactors']);
    return { brands: n.userAgentData.brands, mobile: n.userAgentData.mobile, platform: n.userAgentData.platform, high: hi };
  });
  await safe('intl', () => ({ tz: Intl.DateTimeFormat().resolvedOptions().timeZone, locale: Intl.DateTimeFormat().resolvedOptions().locale, offset: new Date(2024, 0, 15).getTimezoneOffset() }));
  await safe('offscreen2d', async () => {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const draw = new Function('return (' + ev.data.sceneSrc + ')')();
    const c = new OffscreenCanvas(300, 150);
    const ctx = c.getContext('2d');
    draw(ctx, 300, 150);
    const blob = await c.convertToBlob();
    const buf = new Uint8Array(await blob.arrayBuffer());
    const img = ctx.getImageData(0, 0, 300, 150).data;
    const h = async (u8) => Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', u8))).map(x => x.toString(16).padStart(2, '0')).join('').slice(0, 32);
    return { blobHash: await h(buf), imageDataHash: await h(img) };
  });
  await safe('webgl', () => {
    if (typeof OffscreenCanvas === 'undefined') return null;
    const gl = new OffscreenCanvas(16, 16).getContext('webgl');
    if (!gl) return null;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    return {
      vendor: gl.getParameter(gl.VENDOR), renderer: gl.getParameter(gl.RENDERER),
      unmaskedVendor: dbg ? gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL) : null,
      unmaskedRenderer: dbg ? gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL) : null,
      extensions: (gl.getSupportedExtensions() || []).slice().sort(),
      maxTexture: gl.getParameter(gl.MAX_TEXTURE_SIZE),
    };
  });
  await safe('timing', () => {
    const deltas = new Set(); let last = performance.now();
    for (let i = 0; i < 20000; i++) { const t = performance.now(); if (t !== last) { deltas.add(+(t - last).toFixed(6)); last = t; } }
    const sorted = [...deltas].sort((a, b) => a - b);
    return { minDelta: sorted[0] || 0, distinct: sorted.length };
  });
  self.postMessage(out);
};
