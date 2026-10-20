/* Auren fingerprint collector (runs in the page).
 *
 *   await window.FPAudit.collect({ only: ['navigator', ...], workerUrl: '/worker.js' })
 *     -> { schema, collectedAt, location, surfaces: { <name>: { data, volatile, error? } } }
 *
 * Rules for adding a vector (see docs/privacy/fingerprinting/harness.md):
 *   - `data`     : values that SHOULD be identical across repeated loads in the same
 *                  browser session + site. They are hashed and compared.
 *   - `volatile` : values that legitimately change (timings, usage, counters). Reported, never hashed.
 *   - Never throw: unsupported APIs return `null` / `{ unsupported: true }`.
 *   - Keep each vector under ~3 s; whole run is expected to finish in < 20 s.
 */
(function () {
  'use strict';
  const SCHEMA = 1;
  const te = new TextEncoder();

  /* ---------- helpers ---------- */
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const withTimeout = (p, ms, fallback) => Promise.race([p, new Promise((r) => setTimeout(() => r(fallback), ms))]);
  const hex = (u8) => Array.from(u8).map((x) => x.toString(16).padStart(2, '0')).join('');
  function fnv(str) { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; } return 'fnv' + h.toString(16); }
  async function sha(input) {
    try {
      const buf = typeof input === 'string' ? te.encode(input) : input;
      return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', buf))).slice(0, 32);
    } catch (e) { return fnv(typeof input === 'string' ? input : Array.from(input).join(',')); }
  }
  const tryv = (fn, dflt = null) => { try { const v = fn(); return v === undefined ? dflt : v; } catch (e) { return { error: String(e && e.message || e) }; } };
  const ver = (re, s) => { const m = re.exec(s || ''); return m ? m[1] : null; };

  /* The canvas scene is shared with the worker (serialised via toString). Keep it self-contained. */
  function drawScene(ctx, w, h) {
    const g = ctx.createLinearGradient(0, 0, w, h);
    g.addColorStop(0, '#f60'); g.addColorStop(0.5, '#069'); g.addColorStop(1, '#3c9');
    ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
    ctx.textBaseline = 'alphabetic';
    ctx.fillStyle = '#fff'; ctx.font = '16px Arial'; ctx.fillText('Cwm fjordbank glyphs vext quiz, \u{1F600}\u{1F9D1}‍\u{1F680}', 4, 20);
    ctx.fillStyle = 'rgba(102,204,0,0.7)'; ctx.font = '18px "Times New Roman"'; ctx.fillText('ffi fl éüñ ЖΩ中', 4, 44);
    ctx.font = '14px "Courier New"'; ctx.strokeStyle = '#000'; ctx.strokeText('0O1lI|', 200, 44);
    ctx.font = '15px system-ui'; ctx.fillStyle = '#eee'; ctx.fillText('system-ui sans-serif', 4, 66);
    ctx.save(); ctx.translate(150, 100); ctx.rotate(0.3); ctx.font = 'italic 20px Georgia'; ctx.fillStyle = '#ff0'; ctx.fillText('Rotated', 0, 0); ctx.restore();
    ctx.beginPath(); ctx.arc(60, 100, 25, 0, Math.PI * 1.7); ctx.lineWidth = 3.3; ctx.strokeStyle = '#c0f'; ctx.stroke();
    ctx.beginPath(); ctx.moveTo(10, 140); ctx.bezierCurveTo(80, 60, 160, 200, 290, 120); ctx.lineJoin = 'miter'; ctx.lineWidth = 2.5; ctx.strokeStyle = '#0ff'; ctx.stroke();
    ctx.shadowColor = 'rgba(0,0,0,0.6)'; ctx.shadowBlur = 5; ctx.shadowOffsetX = 2; ctx.fillStyle = '#e00'; ctx.fillRect(220, 70, 40, 30);
    ctx.shadowBlur = 0; ctx.globalCompositeOperation = 'xor'; ctx.fillStyle = 'rgba(0,0,255,0.5)'; ctx.fillRect(235, 80, 40, 30);
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = '#000'; ctx.font = '11px monospace'; ctx.fillText(String(0.1 + 0.2) + ' ' + Math.PI.toFixed(10), 130, 144);
  }
  const SCENE_SRC = drawScene.toString();

  /* ======================================================================
   * Vectors. Each returns { data, volatile? }.
   * ====================================================================== */
  const V = {};

  /* ---- navigator & identity ---- */
  V.navigator = async () => {
    const n = navigator;
    const pick = ['userAgent', 'appVersion', 'platform', 'vendor', 'vendorSub', 'productSub', 'appName', 'appCodeName', 'product',
      'language', 'hardwareConcurrency', 'deviceMemory', 'maxTouchPoints', 'cookieEnabled', 'doNotTrack', 'globalPrivacyControl',
      'webdriver', 'pdfViewerEnabled'];
    const data = {};
    for (const k of pick) data[k] = tryv(() => n[k]);
    data.languages = tryv(() => Array.from(n.languages));
    data.plugins = tryv(() => Array.from(n.plugins).map((p) => ({ name: p.name, filename: p.filename, description: p.description, mimes: Array.from(p).map((m) => m.type + '|' + m.suffixes) })));
    data.mimeTypes = tryv(() => Array.from(n.mimeTypes).map((m) => m.type + '|' + m.suffixes + '|' + (m.enabledPlugin && m.enabledPlugin.name)));
    data.navigatorProtoKeys = tryv(() => Object.getOwnPropertyNames(Object.getPrototypeOf(n)).sort());
    data.navigatorOwnKeys = tryv(() => Object.getOwnPropertyNames(n));
    data.hasNavigatorBrave = 'brave' in n;
    data.braveIsBrave = null;
    if (n.brave && typeof n.brave.isBrave === 'function') { try { data.braveIsBrave = await n.brave.isBrave(); } catch (e) { data.braveIsBrave = 'error'; } }
    data.connection = tryv(() => (n.connection ? { present: true } : undefined));
    const volatile = { connection: tryv(() => n.connection ? { effectiveType: n.connection.effectiveType, downlink: n.connection.downlink, rtt: n.connection.rtt, saveData: n.connection.saveData, type: n.connection.type } : null) };
    data.userActivation = tryv(() => !!n.userActivation);
    data.windowChromeKeys = tryv(() => (window.chrome ? Object.getOwnPropertyNames(window.chrome).sort() : null));
    data.hasChromeRuntime = tryv(() => !!(window.chrome && window.chrome.runtime));
    data.suspiciousWindowKeys = tryv(() => Object.getOwnPropertyNames(window).filter((k) => /brave|auren|\bcdc_|\$cdc|__playwright|__pw_|puppeteer|_phantom|callPhantom|domAutomation|__nightmare|selenium|webdriver/i.test(k)));
    const wk = tryv(() => Object.getOwnPropertyNames(window).sort());
    data.windowKeyCount = Array.isArray(wk) ? wk.length : null;
    data.windowKeysHash = Array.isArray(wk) ? await sha(wk.join(',')) : null;
    data.apiPresence = {};
    for (const k of ['getBattery', 'bluetooth', 'usb', 'hid', 'serial', 'gpu', 'ml', 'keyboard', 'wakeLock', 'credentials', 'mediaSession', 'scheduling', 'storageBuckets', 'xr', 'share', 'canShare', 'clipboard', 'contacts', 'locks', 'presentation', 'virtualKeyboard', 'windowControlsOverlay', 'managed', 'login', 'ink', 'devicePosture', 'mediaCapabilities', 'permissions', 'serviceWorker', 'sendBeacon', 'requestMIDIAccess', 'getGamepads', 'vibrate', 'setAppBadge', 'getInstalledRelatedApps', 'joinAdInterestGroup', 'runAdAuction', 'cookieDeprecationLabel', 'userAgentData', 'deprecatedRunAdAuctionEnforcesKAnonymity', 'protectedAudience', 'getAutoplayPolicy', 'requestMediaKeySystemAccess']) data.apiPresence['navigator.' + k] = k in n;
    for (const k of ['queryLocalFonts', 'showOpenFilePicker', 'showDirectoryPicker', 'getScreenDetails', 'EyeDropper', 'Accelerometer', 'Gyroscope', 'Magnetometer', 'AmbientLightSensor', 'LinearAccelerationSensor', 'AbsoluteOrientationSensor', 'GravitySensor', 'Notification', 'PushManager', 'PaymentRequest', 'BarcodeDetector', 'FaceDetector', 'TextDetector', 'Highlight', 'CSSPaintWorklet', 'FileSystemObserver', 'SpeechRecognition', 'webkitSpeechRecognition', 'VideoDecoder', 'AudioDecoder', 'MediaStreamTrackProcessor', 'RTCPeerConnection', 'Float16Array', 'Iterator', 'Observable', 'CloseWatcher', 'Sanitizer', 'Temporal', 'ViewTransition', 'NavigateEvent', 'PressureObserver', 'LanguageDetector', 'Translator', 'Summarizer', 'LanguageModel', 'Writer', 'Rewriter']) data.apiPresence['window.' + k] = k in window;
    return { data, volatile };
  };

  V.userAgentData = async () => {
    const u = navigator.userAgentData;
    if (!u) return { data: { supported: false } };
    const hints = ['architecture', 'bitness', 'model', 'platformVersion', 'uaFullVersion', 'fullVersionList', 'wow64', 'formFactors'];
    let high = null; try { high = await u.getHighEntropyValues(hints); } catch (e) { high = { error: String(e) }; }
    return { data: { supported: true, brands: u.brands, mobile: u.mobile, platform: u.platform, high, toJSON: tryv(() => u.toJSON()) } };
  };

  /* ---- screen / window / media queries ---- */
  function bsearchMQ(prop, hi = 12000) { // largest N with (min-<prop>: Npx)
    let lo = 0; let h = hi;
    while (lo < h) { const mid = (lo + h + 1) >> 1; if (matchMedia(`(min-${prop}: ${mid}px)`).matches) lo = mid; else h = mid - 1; }
    return lo;
  }
  V.screen = async () => {
    const s = screen; const vv = window.visualViewport;
    const data = {
      width: s.width, height: s.height, availWidth: s.availWidth, availHeight: s.availHeight, availLeft: s.availLeft, availTop: s.availTop,
      colorDepth: s.colorDepth, pixelDepth: s.pixelDepth, devicePixelRatio: window.devicePixelRatio,
      orientation: tryv(() => ({ type: s.orientation.type, angle: s.orientation.angle })),
      isExtended: tryv(() => s.isExtended),
      mqDeviceWidth: tryv(() => bsearchMQ('device-width')), mqDeviceHeight: tryv(() => bsearchMQ('device-height')),
      mqWidth: tryv(() => bsearchMQ('width')), mqHeight: tryv(() => bsearchMQ('height')),
      mqResolutionDppx: tryv(() => { let best = 0; for (let r = 0.5; r <= 4.001; r += 0.25) if (matchMedia(`(min-resolution: ${r}dppx)`).matches) best = r; return best; }),
      colorGamut: ['rec2020', 'p3', 'srgb'].find((g) => matchMedia(`(color-gamut: ${g})`).matches) || null,
      dynamicRange: matchMedia('(dynamic-range: high)').matches, videoDynamicRange: matchMedia('(video-dynamic-range: high)').matches,
    };
    const volatile = {
      innerWidth: window.innerWidth, innerHeight: window.innerHeight, outerWidth: window.outerWidth, outerHeight: window.outerHeight,
      screenX: window.screenX, screenY: window.screenY, screenLeft: window.screenLeft, screenTop: window.screenTop,
      vv: vv ? { width: vv.width, height: vv.height, scale: vv.scale, offsetLeft: vv.offsetLeft, offsetTop: vv.offsetTop } : null,
      docClient: { w: document.documentElement.clientWidth, h: document.documentElement.clientHeight },
    };
    data.outerMinusInner = { w: window.outerWidth - window.innerWidth, h: window.outerHeight - window.innerHeight };
    // window position/size coordinates are intentionally in `volatile`: they depend on how the window was opened.
    data.windowOriginIsZero = window.screenX === 0 && window.screenY === 0;
    data.screenEqualsInner = s.width === window.innerWidth && s.height === window.innerHeight;
    return { data, volatile };
  };

  V.mediaQueries = async () => {
    const q = {};
    const list = ['prefers-color-scheme: dark', 'prefers-color-scheme: light', 'prefers-reduced-motion: reduce', 'prefers-reduced-transparency: reduce', 'prefers-contrast: more', 'prefers-contrast: less', 'prefers-contrast: custom',
      'prefers-reduced-data: reduce', 'forced-colors: active', 'inverted-colors: inverted', 'pointer: fine', 'pointer: coarse', 'pointer: none', 'hover: hover', 'hover: none', 'any-pointer: fine', 'any-pointer: coarse', 'any-hover: hover',
      'display-mode: browser', 'display-mode: standalone', 'orientation: landscape', 'orientation: portrait', 'monochrome', 'color-index', 'scan: progressive', 'grid', 'update: fast', 'update: slow', 'overflow-block: scroll', 'overflow-inline: scroll', 'scripting: enabled',
      'prefers-color-scheme: no-preference', 'color: 8', 'color: 10', 'min-color: 8', 'video-prefers-contrast: more', 'nav-controls: back-button', 'horizontal-viewport-segments: 2', 'device-posture: folded'];
    for (const m of list) q[m] = tryv(() => matchMedia(`(${m})`).matches);
    return { data: q };
  };

  /* ---- intl, timezone, locale ---- */
  V.intl = async () => {
    const dtf = Intl.DateTimeFormat().resolvedOptions();
    const dates = [new Date(2024, 0, 15, 12), new Date(2024, 6, 15, 12), new Date(1970, 0, 1), new Date(1990, 5, 1), new Date(2037, 0, 1), new Date(2007, 2, 11, 3)];
    const sample = new Date(Date.UTC(2023, 11, 25, 13, 45, 12));
    const data = {
      resolved: dtf, tz: dtf.timeZone, locale: dtf.locale,
      offsets: dates.map((d) => d.getTimezoneOffset()),
      dateString: dates[0].toString(), dateToLocale: sample.toLocaleString(), dateToLocaleUS: sample.toLocaleString('en-US'), dateToLocaleDE: sample.toLocaleString('de-DE'),
      tzNames: ['long', 'short', 'shortOffset', 'longOffset', 'shortGeneric', 'longGeneric'].map((tn) => tryv(() => new Intl.DateTimeFormat(undefined, { timeZoneName: tn }).format(sample))),
      numberFormat: tryv(() => ({ r: Intl.NumberFormat().resolvedOptions(), s: (1234567.891).toLocaleString(), c: (1234.5).toLocaleString(undefined, { style: 'currency', currency: 'USD' }), c2: (1234.5).toLocaleString(undefined, { style: 'unit', unit: 'kilometer-per-hour' }) })),
      listFormat: tryv(() => new Intl.ListFormat().format(['a', 'b', 'c'])),
      relative: tryv(() => new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' }).format(-1, 'day')),
      plural: tryv(() => new Intl.PluralRules().resolvedOptions().locale),
      collator: tryv(() => ['z', 'a', 'ä', 'Z', 'å'].sort(new Intl.Collator().compare).join('')),
      localeCompare: tryv(() => ['é', 'e', 'f', 'E'].sort((a, b) => a.localeCompare(b)).join('')),
      calendar: tryv(() => dtf.calendar), numbering: tryv(() => dtf.numberingSystem),
      hourCycle: tryv(() => new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions().hourCycle),
      supportedCalendars: tryv(() => Intl.supportedValuesOf('calendar').length), supportedTimeZones: tryv(() => Intl.supportedValuesOf('timeZone').length),
      supportedCurrencies: tryv(() => Intl.supportedValuesOf('currency').length), supportedUnits: tryv(() => Intl.supportedValuesOf('unit').length),
      displayNames: tryv(() => new Intl.DisplayNames(undefined, { type: 'region' }).of('US')),
      segmenter: tryv(() => Array.from(new Intl.Segmenter(undefined, { granularity: 'word' }).segment('Hello, 世界!')).length),
      upperLocale: tryv(() => 'i'.toLocaleUpperCase()),
    };
    return { data, volatile: { now: Date.now() } };
  };

  /* ---- canvas 2D + noise statistics ---- */
  function mk(w, h) { const c = document.createElement('canvas'); c.width = w; c.height = h; return c; }
  function imgStats(img, expected) { // expected = [r,g,b,a]
    let diffPx = 0, maxDelta = 0, alphaTouched = 0; const ch = [0, 0, 0];
    for (let i = 0; i < img.length; i += 4) {
      let px = false;
      for (let c = 0; c < 4; c++) { const d = Math.abs(img[i + c] - expected[c]); if (d) { px = true; if (c < 3) ch[c]++; else alphaTouched++; if (d > maxDelta) maxDelta = d; } }
      if (px) diffPx++;
    }
    return { pixels: img.length / 4, diffPx, maxDelta, alphaTouched, perChannel: ch };
  }
  V.canvas2d = async () => {
    const W = 300, H = 150; const data = {}; const volatile = {};
    const c = mk(W, H); const ctx = c.getContext('2d', { willReadFrequently: false });
    drawScene(ctx, W, H);
    const url1 = c.toDataURL(); const url2 = c.toDataURL();
    const id1 = ctx.getImageData(0, 0, W, H); const id2 = ctx.getImageData(0, 0, W, H);
    const blob = await new Promise((r) => c.toBlob(r)); const blobBuf = blob ? new Uint8Array(await blob.arrayBuffer()) : null;
    data.toDataURLHash = await sha(url1); data.getImageDataHash = await sha(new Uint8Array(id1.data.buffer)); data.toBlobHash = blobBuf ? await sha(blobBuf) : null;
    data.jpegHash = await sha(c.toDataURL('image/jpeg', 0.9)); data.webpHash = await sha(c.toDataURL('image/webp', 0.9));
    // re-reading the same canvas must be deterministic within a session (otherwise per-read noise = trivially detectable + unstable)
    data.repeatToDataURLEqual = url1 === url2;
    data.repeatGetImageDataEqual = hex(id1.data) === hex(id2.data);
    // cross-readback consistency: decode the PNG and compare with getImageData
    try {
      const bmp = await createImageBitmap(blob); const c2 = mk(W, H); const x2 = c2.getContext('2d'); x2.drawImage(bmp, 0, 0);
      const back = x2.getImageData(0, 0, W, H).data; let diff = 0; for (let i = 0; i < back.length; i++) if (back[i] !== id1.data[i]) diff++;
      data.pngVsGetImageDataDiffBytes = diff;
    } catch (e) { data.pngVsGetImageDataDiffBytes = 'error'; }
    // text metrics
    const m = ctx.measureText('Cwm fjordbank glyphs vext quiz'); ctx.font = '16px Arial';
    const m2 = ctx.measureText('Cwm fjordbank glyphs vext quiz');
    data.textMetrics = { w: m2.width, abl: m2.actualBoundingBoxLeft, abr: m2.actualBoundingBoxRight, asc: m2.actualBoundingBoxAscent, desc: m2.actualBoundingBoxDescent, fasc: m2.fontBoundingBoxAscent, fdesc: m2.fontBoundingBoxDescent, em: m2.emHeightAscent };
    // known-colour fill: any change from the requested colour is injected noise
    const u = mk(64, 64); const ux = u.getContext('2d'); ux.fillStyle = 'rgb(100,150,200)'; ux.fillRect(0, 0, 64, 64);
    const us = imgStats(ux.getImageData(0, 0, 64, 64).data, [100, 150, 200, 255]);
    data.noiseUniformFill = us; data.noiseDetectedUniform = us.diffPx > 0;
    const grad = mk(256, 256); const gx = grad.getContext('2d'); const gg = gx.createLinearGradient(0, 0, 256, 0); gg.addColorStop(0, '#000'); gg.addColorStop(1, '#fff'); gx.fillStyle = gg; gx.fillRect(0, 0, 256, 256);
    const gd = gx.getImageData(0, 0, 256, 256).data; // second read of an identical canvas + constructed twin: compare
    const twin = mk(256, 256); const tx = twin.getContext('2d'); const tg = tx.createLinearGradient(0, 0, 256, 0); tg.addColorStop(0, '#000'); tg.addColorStop(1, '#fff'); tx.fillStyle = tg; tx.fillRect(0, 0, 256, 256);
    const td = tx.getImageData(0, 0, 256, 256).data; let twinDiff = 0; for (let i = 0; i < gd.length; i++) if (gd[i] !== td[i]) twinDiff++;
    data.twinCanvasDiffBytes = twinDiff;
    // putImageData round trip: write a known buffer, read it back
    const pb = mk(32, 32); const px = pb.getContext('2d'); const known = px.createImageData(32, 32); for (let i = 0; i < known.data.length; i += 4) { known.data[i] = i & 255; known.data[i + 1] = (i * 3) & 255; known.data[i + 2] = (i * 7) & 255; known.data[i + 3] = 255; }
    px.putImageData(known, 0, 0); const back = px.getImageData(0, 0, 32, 32).data; let rt = 0; for (let i = 0; i < back.length; i++) if (back[i] !== known.data[i]) rt++;
    data.putGetRoundTripDiffBytes = rt;
    // WWW'25 "majority vote" bypass of per-canvas noise: 5 canvases, identical content + a unique marker strip each
    try {
      const N = 5, cw = 200, chh = 100, strip = 8; const arrs = [];
      const scene = (k) => { const cc = mk(cw, chh); const cx = cc.getContext('2d'); cx.fillStyle = `rgb(${10 + k * 40},${200 - k * 30},${30 + k * 20})`; cx.fillRect(0, 0, cw, strip); cx.translate(0, strip); drawScene(cx, cw, chh - strip); return cx; };
      // The marker strip differs per canvas, so content-keyed noise (Brave: HMAC over the whole buffer) differs per read.
      for (let k = 0; k < N; k++) arrs.push(scene(k).getImageData(0, 0, cw, chh).data.slice(cw * strip * 4));
      const rec = new Uint8ClampedArray(arrs[0].length);
      for (let i = 0; i < rec.length; i++) { const cnt = new Map(); let bv = arrs[0][i], bc = 0; for (let k = 0; k < N; k++) { const v = arrs[k][i]; const nn = (cnt.get(v) || 0) + 1; cnt.set(v, nn); if (nn > bc) { bc = nn; bv = v; } } rec[i] = bv; }
      data.voteRecoveredHash = await sha(new Uint8Array(rec.buffer));
      let nd = 0; for (let i = 0; i < rec.length; i++) if (arrs[0][i] !== arrs[1][i]) nd++;
      data.voteCanvasesDifferBytes = nd; // >0 proves the noise really differs per canvas
      const refd = scene(0).getImageData(0, 0, cw, chh).data.slice(cw * strip * 4); let dd = 0; for (let i = 0; i < rec.length; i++) if (rec[i] !== refd[i]) dd++;
      data.voteRecoveredVsSingleDiffBytes = dd; // >0 => vote removed noise the single read still had
    } catch (e) { data.voteError = String(e); }
    // OffscreenCanvas on main thread
    try {
      if (typeof OffscreenCanvas !== 'undefined') {
        const oc = new OffscreenCanvas(W, H); const ox = oc.getContext('2d'); drawScene(ox, W, H);
        const ob = await oc.convertToBlob(); data.offscreenBlobHash = await sha(new Uint8Array(await ob.arrayBuffer()));
        data.offscreenImageDataHash = await sha(new Uint8Array(ox.getImageData(0, 0, W, H).data.buffer));
        data.offscreenMatchesCanvasImageData = data.offscreenImageDataHash === data.getImageDataHash;
      }
    } catch (e) { data.offscreenError = String(e); }
    // emoji & alternate paths
    const e1 = mk(240, 60); const ex = e1.getContext('2d'); ex.font = '32px sans-serif'; ex.fillText('\u{1F600}\u{1F9D1}‍\u{1F680}\u{1FAE0}\u{1FAE8}\u{1F426}‍\u{1F525}', 4, 40);
    data.emojiHash = await sha(new Uint8Array(ex.getImageData(0, 0, 240, 60).data.buffer));
    data.isPointInPath = tryv(() => { const x = mk(10, 10).getContext('2d'); x.rect(0, 0, 5, 5); return [x.isPointInPath(2, 2), x.isPointInPath(7, 7)]; });
    data.canvasFilterSupported = tryv(() => 'filter' in ctx); data.colorSpace = tryv(() => ctx.getContextAttributes && ctx.getContextAttributes().colorSpace);
    return { data, volatile };
  };

  /* ---- WebGL / WebGL2 ---- */
  const GL_PARAMS = ['VERSION', 'SHADING_LANGUAGE_VERSION', 'VENDOR', 'RENDERER', 'MAX_VERTEX_ATTRIBS', 'MAX_VERTEX_UNIFORM_VECTORS', 'MAX_VARYING_VECTORS', 'MAX_COMBINED_TEXTURE_IMAGE_UNITS', 'MAX_VERTEX_TEXTURE_IMAGE_UNITS', 'MAX_TEXTURE_IMAGE_UNITS', 'MAX_FRAGMENT_UNIFORM_VECTORS', 'MAX_CUBE_MAP_TEXTURE_SIZE', 'MAX_RENDERBUFFER_SIZE', 'MAX_TEXTURE_SIZE', 'MAX_VIEWPORT_DIMS', 'ALIASED_LINE_WIDTH_RANGE', 'ALIASED_POINT_SIZE_RANGE', 'RED_BITS', 'GREEN_BITS', 'BLUE_BITS', 'ALPHA_BITS', 'DEPTH_BITS', 'STENCIL_BITS', 'SUBPIXEL_BITS', 'SAMPLES', 'SAMPLE_BUFFERS', 'MAX_3D_TEXTURE_SIZE', 'MAX_ARRAY_TEXTURE_LAYERS', 'MAX_COLOR_ATTACHMENTS', 'MAX_DRAW_BUFFERS', 'MAX_ELEMENTS_INDICES', 'MAX_ELEMENTS_VERTICES', 'MAX_FRAGMENT_INPUT_COMPONENTS', 'MAX_FRAGMENT_UNIFORM_BLOCKS', 'MAX_FRAGMENT_UNIFORM_COMPONENTS', 'MAX_PROGRAM_TEXEL_OFFSET', 'MIN_PROGRAM_TEXEL_OFFSET', 'MAX_SAMPLES', 'MAX_SERVER_WAIT_TIMEOUT', 'MAX_TEXTURE_LOD_BIAS', 'MAX_TRANSFORM_FEEDBACK_INTERLEAVED_COMPONENTS', 'MAX_TRANSFORM_FEEDBACK_SEPARATE_ATTRIBS', 'MAX_TRANSFORM_FEEDBACK_SEPARATE_COMPONENTS', 'MAX_UNIFORM_BLOCK_SIZE', 'MAX_UNIFORM_BUFFER_BINDINGS', 'MAX_VARYING_COMPONENTS', 'MAX_VERTEX_OUTPUT_COMPONENTS', 'MAX_VERTEX_UNIFORM_BLOCKS', 'MAX_VERTEX_UNIFORM_COMPONENTS', 'MAX_COMBINED_UNIFORM_BLOCKS', 'MAX_COMBINED_VERTEX_UNIFORM_COMPONENTS', 'MAX_COMBINED_FRAGMENT_UNIFORM_COMPONENTS', 'UNIFORM_BUFFER_OFFSET_ALIGNMENT'];
  function glInfo(gl, is2) {
    const o = { params: {}, precision: {}, extensions: [], extObjectMismatch: [] };
    for (const p of GL_PARAMS) { if (gl[p] === undefined) continue; const v = tryv(() => gl.getParameter(gl[p])); o.params[p] = (v && v.length !== undefined && typeof v !== 'string') ? Array.from(v) : v; }
    for (const st of ['VERTEX_SHADER', 'FRAGMENT_SHADER']) for (const pt of ['LOW_FLOAT', 'MEDIUM_FLOAT', 'HIGH_FLOAT', 'LOW_INT', 'MEDIUM_INT', 'HIGH_INT']) { const f = tryv(() => gl.getShaderPrecisionFormat(gl[st], gl[pt])); o.precision[st + '.' + pt] = f && f.precision !== undefined ? [f.rangeMin, f.rangeMax, f.precision] : f; }
    const ext = tryv(() => gl.getSupportedExtensions()) || []; o.extensions = Array.isArray(ext) ? ext.slice().sort() : ext;
    o.extensionOrder = Array.isArray(ext) ? ext.join(',') : null;
    if (Array.isArray(ext)) for (const e of ext) { if (!tryv(() => gl.getExtension(e))) o.extObjectMismatch.push(e); }
    o.contextAttributes = tryv(() => gl.getContextAttributes());
    const dbg = tryv(() => gl.getExtension('WEBGL_debug_renderer_info'));
    o.unmaskedVendor = dbg ? tryv(() => gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL)) : null;
    o.unmaskedRenderer = dbg ? tryv(() => gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL)) : null;
    const an = tryv(() => gl.getExtension('EXT_texture_filter_anisotropic')); o.maxAnisotropy = an ? gl.getParameter(an.MAX_TEXTURE_MAX_ANISOTROPY_EXT) : null;
    const wd = tryv(() => gl.getExtension('WEBGL_draw_buffers')); o.maxDrawBuffersExt = wd ? gl.getParameter(wd.MAX_DRAW_BUFFERS_WEBGL) : null;
    const lc = tryv(() => gl.getExtension('WEBGL_lose_context')); o.hasLoseContext = !!lc;
    o.is2 = is2; return o;
  }
  async function glRender(gl) {
    const vs = gl.createShader(gl.VERTEX_SHADER); gl.shaderSource(vs, 'attribute vec2 p;varying vec2 v;void main(){v=p*0.5+0.5;gl_Position=vec4(p,0.0,1.0);}'); gl.compileShader(vs);
    const fs = gl.createShader(gl.FRAGMENT_SHADER); gl.shaderSource(fs, 'precision highp float;varying vec2 v;void main(){float a=sin(v.x*37.0)*cos(v.y*91.0);gl_FragColor=vec4(fract(v.x*7.3+a),fract(v.y*3.1-a),pow(abs(a),0.3),1.0);}'); gl.compileShader(fs);
    const pr = gl.createProgram(); gl.attachShader(pr, vs); gl.attachShader(pr, fs); gl.linkProgram(pr); gl.useProgram(pr);
    const b = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, b); gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(pr, 'p'); gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.viewport(0, 0, 128, 128); gl.clearColor(0.1, 0.2, 0.3, 1); gl.clear(gl.COLOR_BUFFER_BIT); gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    const px = new Uint8Array(128 * 128 * 4); gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, px);
    return { px, linked: gl.getProgramParameter(pr, gl.LINK_STATUS) };
  }
  V.webgl = async () => {
    const data = {};
    for (const [name, type] of [['webgl', 'webgl'], ['webgl2', 'webgl2']]) {
      const c = mk(128, 128); const gl = c.getContext(type, { preserveDrawingBuffer: true });
      if (!gl) { data[name] = null; continue; }
      const info = glInfo(gl, type === 'webgl2');
      const r = await glRender(gl);
      info.renderHash = await sha(r.px); info.linked = r.linked;
      info.renderRepeatEqual = (() => { const p2 = new Uint8Array(128 * 128 * 4); gl.readPixels(0, 0, 128, 128, gl.RGBA, gl.UNSIGNED_BYTE, p2); return hex(p2) === hex(r.px); })();
      info.toDataURLHash = await sha(c.toDataURL());
      // uniform clear: any deviation is injected noise
      gl.clearColor(100 / 255, 150 / 255, 200 / 255, 1); gl.clear(gl.COLOR_BUFFER_BIT);
      const up = new Uint8Array(64 * 64 * 4); gl.readPixels(0, 0, 64, 64, gl.RGBA, gl.UNSIGNED_BYTE, up);
      info.noiseUniformClear = imgStats(up, [100, 150, 200, 255]); info.noiseDetectedUniform = info.noiseUniformClear.diffPx > 0;
      // drawImage(canvas->webgl texture) not tested; keep vector bounded
      data[name] = info;
    }
    return { data };
  };

  /* ---- WebGPU ---- */
  V.webgpu = async () => {
    if (!navigator.gpu) return { data: { supported: false } };
    const data = { supported: true };
    const adapter = await withTimeout(navigator.gpu.requestAdapter(), 2500, undefined);
    if (adapter === undefined) return { data: { supported: true, adapter: 'timeout' } };
    if (!adapter) return { data: { supported: true, adapter: null } };
    const info = adapter.info || (adapter.requestAdapterInfo ? await adapter.requestAdapterInfo() : null);
    data.info = info ? { vendor: info.vendor, architecture: info.architecture, device: info.device, description: info.description, subgroupMinSize: info.subgroupMinSize, subgroupMaxSize: info.subgroupMaxSize, isFallbackAdapter: info.isFallbackAdapter } : null;
    data.features = Array.from(adapter.features || []).sort();
    data.limits = {}; for (const k in adapter.limits) data.limits[k] = adapter.limits[k];
    data.isFallbackAdapter = adapter.isFallbackAdapter;
    data.preferredCanvasFormat = tryv(() => navigator.gpu.getPreferredCanvasFormat());
    data.wgslLanguageFeatures = tryv(() => Array.from(navigator.gpu.wgslLanguageFeatures || []).sort());
    // compute shader numeric output: reveals float-math differences between GPUs/drivers
    try {
      const dev = await withTimeout(adapter.requestDevice(), 2500, null);
      if (dev) {
        const code = '@group(0) @binding(0) var<storage, read_write> o: array<f32>; @compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3<u32>){ let x=f32(id.x)*0.0137+0.5; o[id.x]=sin(x*x)*exp(-x*0.05)+sqrt(x)*cos(x*3.0)+pow(x,0.37); }';
        const mod = dev.createShaderModule({ code }); const buf = dev.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_SRC });
        const rb = dev.createBuffer({ size: 256 * 4, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
        const pl = dev.createComputePipeline({ layout: 'auto', compute: { module: mod, entryPoint: 'main' } });
        const bg = dev.createBindGroup({ layout: pl.getBindGroupLayout(0), entries: [{ binding: 0, resource: { buffer: buf } }] });
        const enc = dev.createCommandEncoder(); const pass = enc.beginComputePass(); pass.setPipeline(pl); pass.setBindGroup(0, bg); pass.dispatchWorkgroups(4); pass.end();
        enc.copyBufferToBuffer(buf, 0, rb, 0, 1024); dev.queue.submit([enc.finish()]);
        await rb.mapAsync(GPUMapMode.READ); const out = new Uint8Array(rb.getMappedRange().slice(0)); rb.unmap();
        data.computeHash = await sha(out); dev.destroy();
      } else data.computeHash = 'no-device';
    } catch (e) { data.computeError = String(e && e.message || e).slice(0, 120); }
    return { data };
  };

  /* ---- Audio ---- */
  V.audio = async () => {
    const data = {}; const AC = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    if (!AC) return { data: { supported: false } };
    async function renderOsc(type, freq) {
      const ctx = new AC(1, 44100, 44100); const osc = ctx.createOscillator(); osc.type = type; osc.frequency.value = freq;
      const comp = ctx.createDynamicsCompressor(); for (const [k, v] of [['threshold', -50], ['knee', 40], ['ratio', 12], ['attack', 0], ['release', 0.25]]) comp[k].value = v;
      osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
      const buf = await withTimeout(ctx.startRendering(), 4000, null); return buf ? buf.getChannelData(0) : null;
    }
    const a = await renderOsc('triangle', 10000); const a2 = await renderOsc('triangle', 10000);
    if (a) {
      let sum = 0; for (let i = 4500; i < 5000; i++) sum += Math.abs(a[i]);
      data.compressorSum = sum; data.compressorHash = await sha(new Uint8Array(new Float32Array(a).buffer));
      data.repeatRenderEqual = a2 ? hex(new Uint8Array(new Float32Array(a).buffer)) === hex(new Uint8Array(new Float32Array(a2).buffer)) : null;
    }
    const s = await renderOsc('sine', 440); if (s) data.sineHash = await sha(new Uint8Array(new Float32Array(s).buffer));
    // known buffer round trip through getChannelData (where several browsers inject noise)
    try {
      const ctx = new AC(1, 4410, 44100); const ab = ctx.createBuffer(1, 4410, 44100); const src = new Float32Array(4410); for (let i = 0; i < src.length; i++) src[i] = Math.sin(i / 20) * 0.5;
      ab.copyToChannel(src, 0); const rd = ab.getChannelData(0); let diff = 0, mx = 0; for (let i = 0; i < src.length; i++) { const d = Math.abs(rd[i] - src[i]); if (d > 0) { diff++; if (d > mx) mx = d; } }
      data.getChannelDataNoise = { diff, maxDelta: mx }; data.noiseDetectedGetChannelData = diff > 0;
      const c2 = new Float32Array(4410); ab.copyFromChannel(c2, 0); let d2 = 0; for (let i = 0; i < src.length; i++) if (c2[i] !== src[i]) d2++; data.copyFromChannelNoiseDiff = d2;
    } catch (e) { data.bufferTestError = String(e); }
    // analyser
    try {
      const ctx = new AC(1, 8192, 44100); const osc = ctx.createOscillator(); osc.type = 'sawtooth'; osc.frequency.value = 1000; const an = ctx.createAnalyser(); an.fftSize = 1024; osc.connect(an); an.connect(ctx.destination); osc.start(0);
      ctx.suspend(4096 / 44100).then(() => { const fa = new Float32Array(an.frequencyBinCount); an.getFloatFrequencyData(fa); const bytes = new Uint8Array(an.frequencyBinCount); an.getByteFrequencyData(bytes); data._an = [Array.from(fa.slice(0, 64)).join(','), Array.from(bytes.slice(0, 64)).join(',')]; ctx.resume(); });
      await withTimeout(ctx.startRendering(), 4000, null); if (data._an) { data.analyserFloatHash = await sha(data._an[0]); data.analyserByteHash = await sha(data._an[1]); delete data._an; }
    } catch (e) { data.analyserError = String(e); }
    const volatile = {};
    try {
      const live = new (window.AudioContext || window.webkitAudioContext)();
      data.liveSampleRate = live.sampleRate; data.liveMaxChannelCount = live.destination.maxChannelCount; data.liveChannelCount = live.destination.channelCount;
      volatile.baseLatency = live.baseLatency; volatile.outputLatency = live.outputLatency; volatile.state = live.state; data.sinkId = tryv(() => live.sinkId); await live.close();
    } catch (e) { data.liveError = String(e); }
    return { data, volatile };
  };

  /* ---- fonts ---- */
  const FONT_LIST = ['Arial', 'Arial Black', 'Arial Narrow', 'Arial Rounded MT Bold', 'Avenir', 'Avenir Next', 'Baskerville', 'Big Caslon', 'Bodoni 72', 'Bradley Hand', 'Brush Script MT', 'Chalkboard', 'Chalkduster', 'Cochin', 'Copperplate', 'Courier', 'Courier New', 'Didot', 'Futura', 'Geneva', 'Georgia', 'Gill Sans', 'Helvetica', 'Helvetica Neue', 'Hoefler Text', 'Impact', 'Lucida Grande', 'Luminari', 'Marker Felt', 'Menlo', 'Monaco', 'Noteworthy', 'Optima', 'Palatino', 'Papyrus', 'Phosphate', 'Rockwell', 'San Francisco', 'SF Pro', 'SF Mono', 'Skia', 'Snell Roundhand', 'Tahoma', 'Times', 'Times New Roman', 'Trebuchet MS', 'Verdana', 'Zapfino', 'American Typewriter', 'Apple Chancery', 'Apple Color Emoji', 'Apple SD Gothic Neo', 'AppleGothic', 'Hiragino Sans', 'Hiragino Kaku Gothic ProN', 'PingFang SC', 'PingFang TC', 'Heiti SC', 'STHeiti', 'Songti SC', 'Kohinoor Devanagari', 'Damascus', 'Al Bayan', 'Thonburi', 'Tamil MN', 'Mishafi', 'Calibri', 'Cambria', 'Candara', 'Consolas', 'Constantia', 'Corbel', 'Segoe UI', 'Segoe UI Emoji', 'Segoe Print', 'Segoe Script', 'MS Gothic', 'MS PGothic', 'Microsoft YaHei', 'Microsoft JhengHei', 'Malgun Gothic', 'Yu Gothic', 'Meiryo', 'SimSun', 'NSimSun', 'Franklin Gothic Medium', 'Gabriola', 'Lucida Console', 'Lucida Sans Unicode', 'Palatino Linotype', 'Sylfaen', 'Ebrima', 'Gadugi', 'Nirmala UI', 'Leelawadee UI', 'Bahnschrift', 'Cascadia Code', 'Ubuntu', 'Ubuntu Mono', 'DejaVu Sans', 'DejaVu Serif', 'DejaVu Sans Mono', 'Liberation Sans', 'Liberation Serif', 'Liberation Mono', 'Noto Sans', 'Noto Serif', 'Noto Color Emoji', 'Noto Sans CJK SC', 'Droid Sans', 'Roboto', 'Open Sans', 'Lato', 'Montserrat', 'Source Sans Pro', 'Source Code Pro', 'Fira Sans', 'Fira Code', 'Cantarell', 'FreeMono', 'FreeSans', 'FreeSerif', 'Oxygen', 'Bitstream Vera Sans', 'Calibri Light', 'Century Gothic', 'Garamond', 'Book Antiqua', 'Bookman Old Style', 'Century', 'Cooper Black', 'Elephant', 'Gill Sans MT', 'Goudy Old Style', 'Haettenschweiler', 'Harrington', 'Lucida Bright', 'Lucida Handwriting', 'Maiandra GD', 'Mistral', 'Modern No. 20', 'Monotype Corsiva', 'OCR A Extended', 'Perpetua', 'Playbill', 'Rage Italic', 'Stencil', 'Tempus Sans ITC', 'Tw Cen MT', 'Wide Latin', 'Wingdings', 'Webdings', 'Symbol', 'Marlett', 'Helvetica Light', 'Adobe Garamond Pro', 'Minion Pro', 'Myriad Pro', 'Adobe Caslon Pro', 'Univers', 'Frutiger', 'Proxima Nova', 'Menlo Regular', 'Hack', 'JetBrains Mono', 'IBM Plex Sans', 'Inter', 'Zapf Dingbats', 'Charter', 'Seravek', 'Superclarendon', 'Iowan Old Style', 'Palatino Bold', 'PT Sans', 'PT Serif', 'Gotham', 'Nunito', 'Raleway', 'Oswald', 'Playfair Display'];
  V.fonts = async () => {
    const data = {};
    const bases = ['monospace', 'sans-serif', 'serif']; const txt = 'mmMwWLliI0O&1lé中Ж';
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;font-size:72px;line-height:normal;white-space:nowrap';
    document.body.appendChild(host);
    const span = document.createElement('span'); span.textContent = txt; host.appendChild(span);
    const measure = (family) => { span.style.fontFamily = family; const r = span.getBoundingClientRect(); return r.width + 'x' + r.height; };
    const baseSizes = {}; for (const b of bases) baseSizes[b] = measure(b);
    const detected = [];
    for (const f of FONT_LIST) { for (const b of bases) { if (measure(`"${f}",${b}`) !== baseSizes[b]) { detected.push(f); break; } } }
    data.detectedByWidth = detected; data.detectedCount = detected.length; data.baseSizes = baseSizes;
    data.documentFontsCheck = FONT_LIST.filter((f) => tryv(() => document.fonts.check(`12px "${f}"`)));
    // canvas measureText approach
    const cx = mk(10, 10).getContext('2d'); const mw = (f, b) => { cx.font = `72px ${f ? '"' + f + '",' : ''}${b}`; return cx.measureText(txt).width; };
    const cbase = {}; for (const b of bases) cbase[b] = mw(null, b);
    data.detectedByCanvas = FONT_LIST.filter((f) => bases.some((b) => mw(f, b) !== cbase[b]));
    data.canvasBaseWidths = cbase;
    data.sameAsWidthMethod = JSON.stringify(data.detectedByCanvas) === JSON.stringify(detected);
    data.queryLocalFontsPresent = typeof window.queryLocalFonts === 'function';
    data.localFontsPermission = await tryPerm('local-fonts');
    // system fonts keywords
    const sys = {}; for (const k of ['caption', 'icon', 'menu', 'message-box', 'small-caption', 'status-bar']) { span.style.font = k; const cs = getComputedStyle(span); sys[k] = cs.fontFamily + '|' + cs.fontSize; }
    data.systemFonts = sys; span.style.font = '';
    // fallback glyph widths per script (reveals installed CJK/Indic/Arabic/emoji fallback fonts)
    const scripts = { han: '漢字', kana: 'ひらがな', hangul: '한글', arabic: 'العربية', hebrew: 'עברית', devanagari: 'हिन्दी', thai: 'ไทย', bengali: 'বাংলা', tamil: 'தமிழ்', emoji: '\u{1F600}\u{1F9D1}‍\u{1F680}', math: '\u{1D400}\u{1D401}∫∑', symbols: '⌘⌥⇧⌃⏎', unicode16: '\u{1FAE9}\u{1FAC6}' };
    data.scriptFallbackWidths = {}; span.style.fontFamily = 'serif'; for (const [k, v] of Object.entries(scripts)) { span.textContent = v; data.scriptFallbackWidths[k] = span.getBoundingClientRect().width; }
    host.remove();
    return { data };
  };
  async function tryPerm(name) { try { const r = await navigator.permissions.query({ name }); return r.state; } catch (e) { return 'unsupported'; } }

  /* ---- DOM geometry (ClientRects, SVG, MathML) ---- */
  V.geometry = async () => {
    const data = {}; const root = document.createElement('div'); root.style.cssText = 'position:absolute;left:10.3px;top:20.7px;width:333.3px;font:13.37px/1.37 Arial;transform:rotate(0.37deg) scale(1.0137)';
    root.innerHTML = '<p id="a" style="margin:0;letter-spacing:0.13px">The quick brown fox jumps over the lazy dog 0123456789 éüñ</p><div id="b" style="width:50.5%;height:37.25px;border:1.5px solid #000;padding:3.3px">box</div><span id="c" style="font-size:19.19px">sp<b>an</b> text wraps across multiple lines if the container is narrow enough for it</span><svg id="s" width="200" height="60" xmlns="http://www.w3.org/2000/svg"><text id="t" x="3.3" y="30" font-family="Times New Roman" font-size="23.3">SVG text bbox Ж</text><path id="pth" d="M10 10 C 40 80, 90 -20, 150 40" stroke="#000" fill="none"/></svg><math id="m" display="block"><mfrac><mrow><mi>x</mi><mo>+</mo><mn>1</mn></mrow><msqrt><mi>y</mi></msqrt></mfrac><munderover><mo>∑</mo><mi>i</mi><mi>n</mi></munderover></math>';
    document.body.appendChild(root);
    const rect = (el) => { const r = el.getBoundingClientRect(); return [r.x, r.y, r.width, r.height, r.top, r.right, r.bottom, r.left].map((v) => +v.toFixed(5)); };
    data.rects = ['a', 'b', 'c', 's', 't', 'pth', 'm'].map((id) => rect(root.querySelector('#' + id)));
    const c = root.querySelector('#c'); data.clientRectsC = Array.from(c.getClientRects()).map((r) => [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(5)));
    const range = document.createRange(); range.selectNodeContents(root.querySelector('#a')); data.rangeRects = Array.from(range.getClientRects()).map((r) => [r.x, r.y, r.width, r.height].map((v) => +v.toFixed(5)));
    const t = root.querySelector('#t'); data.svg = { bbox: tryv(() => { const b = t.getBBox(); return [b.x, b.y, b.width, b.height]; }), textLen: tryv(() => t.getComputedTextLength()), sub: tryv(() => t.getSubStringLength(0, 5)), ext: tryv(() => { const e = t.getExtentOfChar(2); return [e.x, e.y, e.width, e.height]; }), pathLen: tryv(() => root.querySelector('#pth').getTotalLength()), point: tryv(() => { const p = root.querySelector('#pth').getPointAtLength(50); return [p.x, p.y]; }) };
    data.offsets = tryv(() => ['a', 'b', 'c'].map((id) => { const e = root.querySelector('#' + id); return [e.offsetWidth, e.offsetHeight, e.scrollWidth, e.clientWidth]; }));
    data.mathmlSupported = tryv(() => typeof MathMLElement !== 'undefined');
    // determinism and consistency across APIs
    const r1 = JSON.stringify(data.rects); const r2 = JSON.stringify(['a', 'b', 'c', 's', 't', 'pth', 'm'].map((id) => rect(root.querySelector('#' + id))));
    data.repeatRectsEqual = r1 === r2;
    const bw = root.querySelector('#b'); const br = bw.getBoundingClientRect();
    data.rectVsClientRects = (() => { const cr = bw.getClientRects()[0]; return Math.abs(cr.width - br.width) < 1e-9 && Math.abs(cr.height - br.height) < 1e-9; })();
    data.rectHash = await sha(JSON.stringify([data.rects, data.clientRectsC, data.rangeRects, data.svg]));
    // scrollbar width
    const sb = document.createElement('div'); sb.style.cssText = 'width:100px;height:100px;overflow:scroll;position:absolute;left:-9999px'; document.body.appendChild(sb); data.scrollbarWidth = sb.offsetWidth - sb.clientWidth; sb.remove();
    root.remove();
    return { data };
  };

  /* ---- emoji ---- */
  V.emoji = async () => {
    const emojis = ['\u{1F600}', '\u{1F9D1}‍\u{1F680}', '\u{1FAE0}', '\u{1FAE8}', '\u{1F426}‍\u{1F525}', '\u{1FAE9}', '\u{1FAC6}', '\u{1F1FA}\u{1F1F8}', '\u{1F3F3}️‍\u{1F308}', '\u{1F9D1}\u{1F3FD}‍\u{1F9B0}', '\u{1F6DD}', '\u{1FA75}', '\u{1FAE3}', '\u{1F979}', '\u{1FAD7}', '\u{1FAAD}'];
    const host = document.createElement('div'); host.style.cssText = 'position:absolute;left:-9999px;font-size:48px;white-space:nowrap'; document.body.appendChild(host);
    const widths = emojis.map((e) => { const s = document.createElement('span'); s.textContent = e; host.appendChild(s); const w = s.getBoundingClientRect().width; return +w.toFixed(3); }); host.remove();
    const c = mk(48 * emojis.length / 2, 64); const x = c.getContext('2d'); x.font = '40px sans-serif'; emojis.forEach((e, i) => x.fillText(e, i * 24, 44));
    return { data: { widths, canvasHash: await sha(new Uint8Array(x.getImageData(0, 0, c.width, c.height).data.buffer)) } };
  };

  /* ---- speech / media devices ---- */
  V.speech = async () => {
    if (!('speechSynthesis' in window)) return { data: { supported: false } };
    const grab = () => speechSynthesis.getVoices().map((v) => ({ name: v.name, lang: v.lang, local: v.localService, def: v.default, uri: v.voiceURI }));
    // Voices load asynchronously: poll until non-empty, then let the list settle.
    let v = grab(); const t0 = performance.now();
    while (!v.length && performance.now() - t0 < 2500) { await sleep(100); v = grab(); }
    if (v.length) { await sleep(300); v = grab(); }
    return { data: { supported: true, count: v.length, voices: v, hash: await sha(JSON.stringify(v)) } };
  };
  V.mediaDevices = async () => {
    const md = navigator.mediaDevices; if (!md) return { data: { supported: false } };
    let list = await withTimeout(md.enumerateDevices(), 2000, []); const t0 = performance.now();
    while (!list.length && performance.now() - t0 < 1500) { await sleep(150); list = await withTimeout(md.enumerateDevices(), 1000, []); }
    const kinds = {}; list.forEach((d) => { kinds[d.kind] = (kinds[d.kind] || 0) + 1; });
    return { data: { supported: true, kinds, labels: list.map((d) => d.label), anyLabel: list.some((d) => d.label), deviceIdLengths: list.map((d) => d.deviceId.length), groupIdLengths: list.map((d) => d.groupId.length), supportedConstraints: tryv(() => Object.keys(md.getSupportedConstraints()).sort()), hasGetDisplayMedia: typeof md.getDisplayMedia === 'function' } };
  };

  /* ---- WebRTC IP exposure ---- */
  V.webrtc = async () => {
    if (!window.RTCPeerConnection) return { data: { supported: false } };
    const cands = []; const pc = new RTCPeerConnection({ iceServers: [] }); pc.createDataChannel('x');
    pc.onicecandidate = (e) => { if (e.candidate) cands.push(e.candidate.candidate); };
    try { await pc.setLocalDescription(await pc.createOffer()); } catch (e) { return { data: { supported: true, error: String(e) } }; }
    await withTimeout(new Promise((r) => { pc.onicegatheringstatechange = () => { if (pc.iceGatheringState === 'complete') r(); }; }), 3000, null);
    const sdp = pc.localDescription && pc.localDescription.sdp || ''; pc.close();
    const parsed = cands.concat((sdp.match(/a=candidate:.*/g) || []).map((s) => s.slice(2))).map((c) => { const p = c.split(' '); return { type: p[7], proto: p[2], address: p[4] }; });
    const ipv4 = /^(\d{1,3}\.){3}\d{1,3}$/; const ipv6 = /^[0-9a-f:]+$/i;
    const raw = parsed.filter((p) => ipv4.test(p.address) || (ipv6.test(p.address) && p.address.includes(':')));
    const caps = tryv(() => ({ audio: RTCRtpSender.getCapabilities('audio').codecs.map((c) => c.mimeType + '/' + c.clockRate + '/' + (c.channels || 1)), video: RTCRtpSender.getCapabilities('video').codecs.map((c) => c.mimeType + '|' + (c.sdpFmtpLine || '')) }));
    return { data: { supported: true, candidateTypes: [...new Set(parsed.map((p) => p.type))].sort(), mdnsCount: parsed.filter((p) => /\.local$/.test(p.address)).length, rawIpCount: raw.length, rawIps: raw.map((r) => r.address), caps, capsHash: await sha(JSON.stringify(caps)) } };
  };

  /* ---- hardware / sensors / permissions / battery ---- */
  V.hardware = async () => {
    const data = {};
    data.batteryApi = typeof navigator.getBattery === 'function';
    if (data.batteryApi) { try { const b = await withTimeout(navigator.getBattery(), 800, null); data.battery = b ? { charging: b.charging, level: b.level, chargingTime: b.chargingTime, dischargingTime: b.dischargingTime } : 'timeout'; } catch (e) { data.battery = 'error'; } }
    data.gamepads = tryv(() => navigator.getGamepads ? Array.from(navigator.getGamepads()).filter(Boolean).length : 'unsupported');
    data.sensors = {}; for (const s of ['Accelerometer', 'Gyroscope', 'Magnetometer', 'AmbientLightSensor', 'AbsoluteOrientationSensor']) data.sensors[s] = typeof window[s] !== 'undefined';
    data.deviceMotionEvent = typeof DeviceMotionEvent !== 'undefined'; data.deviceMotionRequestPermission = typeof DeviceMotionEvent !== 'undefined' && typeof DeviceMotionEvent.requestPermission === 'function';
    data.touch = { ontouchstart: 'ontouchstart' in window, maxTouchPoints: navigator.maxTouchPoints, TouchEvent: typeof TouchEvent !== 'undefined' };
    data.permissions = {};
    for (const p of ['geolocation', 'notifications', 'push', 'midi', 'camera', 'microphone', 'clipboard-read', 'clipboard-write', 'persistent-storage', 'accelerometer', 'gyroscope', 'magnetometer', 'ambient-light-sensor', 'background-sync', 'screen-wake-lock', 'local-fonts', 'window-management', 'storage-access', 'display-capture', 'idle-detection', 'payment-handler', 'nfc', 'top-level-storage-access', 'bluetooth', 'speaker-selection', 'compute-pressure']) data.permissions[p] = await tryPerm(p);
    data.notificationPermission = typeof Notification !== 'undefined' ? Notification.permission : null;
    data.webusb = { present: 'usb' in navigator, devices: await (async () => { try { return navigator.usb ? (await withTimeout(navigator.usb.getDevices(), 800, [])).length : null; } catch (e) { return 'error'; } })() };
    data.hid = 'hid' in navigator; data.serial = 'serial' in navigator; data.bluetooth = 'bluetooth' in navigator;
    data.midi = typeof navigator.requestMIDIAccess === 'function';
    return { data };
  };

  /* ---- storage ---- */
  V.storage = async () => {
    const data = {}; const volatile = {};
    try { const est = await navigator.storage.estimate(); volatile.usage = est.usage; data.quota = est.quota; data.quotaGiB = +(est.quota / 2 ** 30).toFixed(3); data.quotaRoundedToGiB = est.quota % (2 ** 30) === 0; } catch (e) { data.quotaError = String(e); }
    data.persisted = await tryv(() => navigator.storage.persisted());
    data.localStorage = tryv(() => { localStorage.setItem('__fp', '1'); const v = localStorage.getItem('__fp'); localStorage.removeItem('__fp'); return v === '1'; });
    data.sessionStorage = tryv(() => { sessionStorage.setItem('__fp', '1'); const v = sessionStorage.getItem('__fp'); sessionStorage.removeItem('__fp'); return v === '1'; });
    data.indexedDB = typeof indexedDB !== 'undefined'; data.cacheStorage = typeof caches !== 'undefined'; data.serviceWorker = 'serviceWorker' in navigator;
    data.cookieRoundTrip = tryv(() => { document.cookie = '__fp=1; SameSite=Lax; path=/'; const ok = /__fp=1/.test(document.cookie); document.cookie = '__fp=; expires=Thu, 01 Jan 1970 00:00:00 GMT; path=/'; return ok; });
    data.fileSystemAccess = typeof window.showOpenFilePicker === 'function'; data.opfs = !!(navigator.storage && navigator.storage.getDirectory);
    data.indexedDBDatabasesApi = tryv(() => typeof indexedDB.databases === 'function');
    return { data, volatile };
  };

  /* ---- timers / timing ---- */
  V.timing = async () => {
    const deltas = new Set(); let last = performance.now(); const t0 = last;
    for (let i = 0; i < 50000; i++) { const t = performance.now(); if (t !== last) { deltas.add(+(t - last).toFixed(6)); last = t; } }
    const sorted = [...deltas].sort((a, b) => a - b);
    const dn = new Set(); let ld = Date.now(); for (let i = 0; i < 50000; i++) { const t = Date.now(); if (t !== ld) { dn.add(t - ld); ld = t; } }
    const raf = await new Promise((resolve) => { const ts = []; const step = (t) => { ts.push(t); if (ts.length < 6) requestAnimationFrame(step); else resolve(ts); }; requestAnimationFrame(step); });
    const minD = sorted[0] || 0;
    const bucket = (ms) => (ms === 0 ? 'none' : ms <= 0.002 ? '<=2us' : ms <= 0.01 ? '<=10us' : ms <= 0.05 ? '<=50us' : ms <= 0.1 ? '<=100us' : ms <= 0.2 ? '<=200us' : ms <= 1 ? '<=1ms' : '>1ms');
    const pm = tryv(() => performance.memory ? performance.memory.jsHeapSizeLimit : null);
    const data = {
      crossOriginIsolated: window.crossOriginIsolated, sharedArrayBuffer: typeof SharedArrayBuffer !== 'undefined',
      perfNowResolutionBucket: bucket(minD), perfNowHasJitter: sorted.length > 2 && new Set(sorted.slice(0, 20).map((d) => +(d / minD).toFixed(1))).size > 3,
      dateNowMinDelta: [...dn].sort((a, b) => a - b)[0] || 0,
      performanceMemoryLimit: pm,
    };
    return { data, volatile: { perfNowMinDeltaMs: minD, perfNowDistinctDeltas: sorted.length, perfNowFirstDeltas: sorted.slice(0, 6), rafs: raf, sampleStart: t0 } };
  };

  /* ---- CSS feature detection & system colours ---- */
  V.css = async () => {
    const props = ['aspect-ratio', 'backdrop-filter', 'container-type', 'contain', 'content-visibility', 'color-mix(in srgb, red, blue)', 'accent-color', 'anchor-name', 'animation-timeline', 'field-sizing', 'text-wrap', 'text-box-trim', 'view-transition-name', 'scrollbar-gutter', 'scrollbar-color', 'overscroll-behavior', 'overflow-anchor', 'position-area', 'interpolate-size', 'masonry', 'zoom', 'appearance', 'font-synthesis-weight', 'font-variant-emoji', 'hyphenate-character', 'initial-letter', 'math-depth', 'transition-behavior', 'corner-shape', 'scroll-target-group', 'reading-flow', 'sibling-index()', 'if(media(width > 0): 1)', 'attr(data-x type(<length>))', 'width: calc-size(auto, size)', 'color: contrast-color(red)', 'anchor-size(width)'];
    const data = { supports: {} };
    for (const p of props) data.supports[p] = tryv(() => (p.includes(':') || p.includes('(')) ? (p.includes(':') ? CSS.supports(p) : CSS.supports('color', p) || CSS.supports('width', p) || CSS.supports('order', p)) : CSS.supports(p, 'initial'));
    data.selectors = {}; for (const s of [':has(a)', ':is(a)', ':where(a)', ':focus-visible', ':user-valid', ':popover-open', ':modal', ':state(x)', '::highlight(x)', ':open', '::scroll-marker', '::details-content', ':target-current', ':dir(ltr)']) data.selectors[s] = tryv(() => CSS.supports(`selector(${s})`));
    const probe = document.createElement('div'); document.body.appendChild(probe);
    data.systemColors = {}; for (const k of ['ActiveBorder', 'ActiveCaption', 'AppWorkspace', 'Background', 'ButtonFace', 'ButtonHighlight', 'ButtonShadow', 'ButtonText', 'CaptionText', 'GrayText', 'Highlight', 'HighlightText', 'InactiveBorder', 'InactiveCaption', 'InactiveCaptionText', 'InfoBackground', 'InfoText', 'Menu', 'MenuText', 'Scrollbar', 'ThreeDDarkShadow', 'ThreeDFace', 'ThreeDHighlight', 'ThreeDLightShadow', 'ThreeDShadow', 'Window', 'WindowFrame', 'WindowText', 'Canvas', 'CanvasText', 'LinkText', 'VisitedText', 'ActiveText', 'Field', 'FieldText', 'Mark', 'MarkText', 'AccentColor', 'AccentColorText', 'SelectedItem', 'SelectedItemText']) { probe.style.color = ''; probe.style.color = k; data.systemColors[k] = getComputedStyle(probe).color; }
    probe.remove(); data.colorScheme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    data.cssRegisterProperty = typeof CSS.registerProperty === 'function'; data.cssHighlights = typeof CSS.highlights !== 'undefined'; data.cssPaint = typeof CSS.paintWorklet !== 'undefined';
    return { data };
  };

  /* ---- JS engine quirks, error strings, wasm ---- */
  V.jsEngine = async () => {
    const err = (fn) => { try { fn(); return 'no-throw'; } catch (e) { return e.name + ': ' + e.message; } };
    const data = {
      errors: [err(() => null.x), err(() => undefined()), err(() => JSON.parse('{')), err(() => new Array(-1)), err(() => 'a'.repeat(-1)), err(() => BigInt(1.5)), err(() => new Intl.DateTimeFormat('xx-invalid-locale-zz')), err(() => decodeURIComponent('%')), err(() => structuredClone(() => 1)), err(() => { 'use strict'; undefinedVar = 1; })],
      stackFirstLine: (new Error('x').stack || '').split('\n').slice(0, 2).join('|').replace(/https?:\/\/[^\s)]+/g, '<url>'),
      fnToString: [Math.max.toString(), (function f(a, b) { return a + b; }).toString(), Function.prototype.toString.call(Function.prototype.toString)],
      math: { tan: Math.tan(-1e300), sinh: Math.sinh(1), cosh: Math.cosh(10), tanh: Math.tanh(0.5), expm1: Math.expm1(1), log1p: Math.log1p(10), acosh: Math.acosh(1e10), asinh: Math.asinh(1), atanh: Math.atanh(0.5), cbrt: Math.cbrt(100), pow: Math.pow(Math.PI, -100), exp: Math.exp(1), sin: Math.sin(1e22), cos: Math.cos(1e22), atan2: Math.atan2(1e-300, 1) },
      numberFmt: [(0.000001234).toString(), (1e21).toString(), (123.456).toFixed(10), (0.1 + 0.2).toPrecision(21), (1 / 3).toExponential(20)],
      date: [new Date(0).toString(), new Date('2020-02-30').toString(), new Date(2021, 0, 1, 25).toISOString(), Date.parse('Thu, 01 Jan 1970 00:00:00 GMT+0100'), new Date(8.64e15).toString().slice(0, 40)],
      regex: tryv(() => [/(?<n>a)/.exec('a').groups.n, 'aBc'.replace(/b/i, '$&$&'), /\p{Script=Greek}/u.test('Ω'), /[\p{Emoji}--\p{ASCII}]/v.test('\u{1F600}')]),
      sort: tryv(() => [3, 1, 2, 10, 9].sort().join()), typedArraySort: tryv(() => new Float64Array([3, NaN, -0, 0, 1]).sort().join()),
      features: { bigInt: typeof BigInt, weakRef: typeof WeakRef, atomicsWait: typeof Atomics.waitAsync, arrayAt: typeof [].at, findLast: typeof [].findLast, groupBy: typeof Object.groupBy, structuredClone: typeof structuredClone, toSorted: typeof [].toSorted, setUnion: typeof new Set().union, promiseWithResolvers: typeof Promise.withResolvers, arrayFromAsync: typeof Array.fromAsync, iteratorHelpers: typeof Iterator !== 'undefined' && typeof Iterator.prototype.map, regexpEscape: typeof RegExp.escape, uint8Base64: typeof Uint8Array.fromBase64, float16: typeof Math.f16round, temporal: typeof Temporal, shadowRealm: typeof ShadowRealm, usingDecl: typeof Symbol.dispose, errorIsError: typeof Error.isError, mathSumPrecise: typeof Math.sumPrecise },
    };
    const wasm = { available: typeof WebAssembly !== 'undefined' };
    if (wasm.available) {
      const v = (bytes) => tryv(() => WebAssembly.validate(new Uint8Array(bytes)));
      wasm.simd = v([0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 123, 3, 2, 1, 0, 10, 10, 1, 8, 0, 65, 0, 253, 15, 253, 98, 11]);
      wasm.threads = v([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 4, 1, 3, 1, 1, 10, 11, 1, 9, 0, 65, 0, 254, 16, 2, 0, 26, 11]);
      wasm.bulkMemory = v([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 5, 3, 1, 0, 1, 10, 14, 1, 12, 0, 65, 0, 65, 0, 65, 0, 252, 10, 0, 0, 11]);
      wasm.exceptions = v([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 8, 1, 6, 0, 6, 64, 25, 11, 11]);
      wasm.tailCall = v([0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 6, 1, 4, 0, 18, 0, 11]);
      wasm.jspi = typeof WebAssembly.Suspending !== 'undefined'; wasm.memory64 = tryv(() => { try { new WebAssembly.Memory({ initial: 1n, index: 'i64' }); return true; } catch (e) { return false; } });
    }
    data.wasm = wasm; data.v8Hash = await sha(JSON.stringify([data.errors, data.math, data.numberFmt, data.fnToString]));
    return { data };
  };

  /* ---- codecs / media capabilities ---- */
  V.codecs = async () => {
    const v = document.createElement('video'); const a = document.createElement('audio'); const data = {};
    const vt = ['video/mp4; codecs="avc1.42E01E"', 'video/mp4; codecs="avc1.64002A"', 'video/mp4; codecs="hev1.1.6.L93.B0"', 'video/mp4; codecs="hvc1.1.6.L93.B0"', 'video/mp4; codecs="av01.0.05M.08"', 'video/mp4; codecs="vp09.00.10.08"', 'video/webm; codecs="vp8"', 'video/webm; codecs="vp9"', 'video/webm; codecs="av01.0.05M.08"', 'video/ogg; codecs="theora"', 'video/x-matroska', 'application/vnd.apple.mpegurl', 'application/x-mpegURL', 'video/mp4; codecs="dvh1.05.01"', 'video/mp4; codecs="vvc1"'];
    const at = ['audio/mpeg', 'audio/mp4; codecs="mp4a.40.2"', 'audio/mp4; codecs="ac-3"', 'audio/mp4; codecs="ec-3"', 'audio/mp4; codecs="flac"', 'audio/mp4; codecs="opus"', 'audio/ogg; codecs="vorbis"', 'audio/ogg; codecs="opus"', 'audio/wav', 'audio/flac', 'audio/aac', 'audio/webm; codecs="opus"', 'audio/x-m4a'];
    data.canPlayType = {}; for (const t of vt) data.canPlayType[t] = v.canPlayType(t); for (const t of at) data.canPlayType[t] = a.canPlayType(t);
    data.mse = {}; if (window.MediaSource) for (const t of vt.concat(at)) data.mse[t] = MediaSource.isTypeSupported(t);
    data.recorder = {}; if (window.MediaRecorder) for (const t of ['video/webm', 'video/webm;codecs=vp9', 'video/webm;codecs=h264', 'video/mp4', 'audio/webm;codecs=opus', 'audio/mp4']) data.recorder[t] = MediaRecorder.isTypeSupported(t);
    data.mediaCapabilities = {};
    if (navigator.mediaCapabilities) for (const [n, cfg] of [['h264', { type: 'file', video: { contentType: 'video/mp4; codecs="avc1.640028"', width: 1920, height: 1080, bitrate: 5e6, framerate: 30 } }], ['hevc', { type: 'file', video: { contentType: 'video/mp4; codecs="hvc1.1.6.L120.B0"', width: 3840, height: 2160, bitrate: 2e7, framerate: 60 } }], ['av1', { type: 'file', video: { contentType: 'video/mp4; codecs="av01.0.12M.10"', width: 3840, height: 2160, bitrate: 2e7, framerate: 60 } }], ['vp9', { type: 'file', video: { contentType: 'video/webm; codecs="vp09.00.51.08"', width: 3840, height: 2160, bitrate: 2e7, framerate: 60 } }], ['hdr', { type: 'file', video: { contentType: 'video/mp4; codecs="hvc1.2.4.L153.B0"', width: 3840, height: 2160, bitrate: 2e7, framerate: 60, transferFunction: 'pq', colorGamut: 'rec2020', hdrMetadataType: 'smpteSt2086' } }], ['aac', { type: 'file', audio: { contentType: 'audio/mp4; codecs="mp4a.40.2"', channels: 2, bitrate: 128000, samplerate: 44100 } }]]) { try { const r = await withTimeout(navigator.mediaCapabilities.decodingInfo(cfg), 1500, { timeout: true }); data.mediaCapabilities[n] = [r.supported, r.smooth, r.powerEfficient]; } catch (e) { data.mediaCapabilities[n] = 'error'; } }
    data.webCodecs = {}; if (window.VideoDecoder) for (const [n, c] of [['avc1', { codec: 'avc1.64001f' }], ['hev1', { codec: 'hev1.1.6.L93.B0' }], ['vp09', { codec: 'vp09.00.10.08' }], ['av01', { codec: 'av01.0.04M.08' }], ['vp8', { codec: 'vp8' }]]) { try { const r = await withTimeout(VideoDecoder.isConfigSupported(c), 1500, { supported: 'timeout' }); data.webCodecs[n] = r.supported; } catch (e) { data.webCodecs[n] = 'error'; } }
    data.drm = {}; if (navigator.requestMediaKeySystemAccess) for (const ks of ['org.w3.clearkey', 'com.widevine.alpha', 'com.microsoft.playready', 'com.apple.fps', 'com.apple.fps.1_0']) { try { await withTimeout(navigator.requestMediaKeySystemAccess(ks, [{ initDataTypes: ['cenc'], videoCapabilities: [{ contentType: 'video/mp4; codecs="avc1.42E01E"' }] }]), 1500, Promise.reject(new Error('timeout'))); data.drm[ks] = true; } catch (e) { data.drm[ks] = false; } }
    data.imageFormats = {}; for (const [n, u] of [['webp', 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA=='], ['avif', 'data:image/avif;base64,AAAAIGZ0eXBhdmlmAAAAAGF2aWZtaWYxbWlhZk1BMUIAAADybWV0YQAAAAAAAAAoaGRscgAAAAAAAAAAcGljdAAAAAAAAAAAAAAAAGxpYmF2aWYAAAAADnBpdG0AAAAAAAEAAAAeaWxvYwAAAABEAAABAAEAAAABAAABGgAAAB0AAAAoaWluZgAAAAAAAQAAABppbmZlAgAAAAABAABhdjAxQ29sb3IAAAAAamlwcnAAAABLaXBjbwAAABRpc3BlAAAAAAAAAAIAAAACAAAAEHBpeGkAAAAAAwgICAAAAAxhdjFDgQAMAAAAABNjb2xybmNseAACAAIAAYAAAAAXaXBtYQAAAAAAAAABAAEEAQKDBAAAAB9tZGF0EgAKCBgANogQEAwgMg8f8D///8WfhwB8+ErK42A='], ['jxl', 'data:image/jxl;base64,/woIAAAAAAAAAAAA']]) { data.imageFormats[n] = await withTimeout(new Promise((r) => { const i = new Image(); i.onload = () => r(true); i.onerror = () => r(false); i.src = u; }), 1500, false); }
    return { data };
  };

  /* ---- network-visible values (server echo) ---- */
  V.headers = async (opts) => {
    const base = opts.serverBase || '';
    const get = async (path, init) => { try { const r = await fetch(base + path, init); return await r.json(); } catch (e) { return { error: String(e) }; } };
    const nav = await get('/echo?kind=fetch&n=' + Math.random().toString(36).slice(2), { cache: 'no-store' });
    const nav2 = await get('/echo?kind=fetch2&n=' + Math.random().toString(36).slice(2), { cache: 'no-store', credentials: 'omit' });
    let tls = null;
    if (opts.tlsBase) {
      try { const r = await fetch(opts.tlsBase + '/tls?n=' + Math.random().toString(36).slice(2), { cache: 'no-store', mode: 'cors' }); tls = await r.json(); } catch (e) { tls = { error: String(e) }; }
    }
    const h = window.__navHeaders || null;
    const lowHints = new Set(['sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform']);
    const dropHint = (k) => /^sec-ch-/.test(k) && !lowHints.has(k) || k === 'device-memory' || k === 'dpr' || k === 'viewport-width';
    const fh = {}; for (const [k, v] of Object.entries((nav && nav.headers) || {})) if (!dropHint(k)) fh[k] = v;
    const ord = (o) => (o || []).filter((k) => !dropHint(k));
    const data = { fetchHeaders: fh, fetchHeaderOrder: ord(nav && nav.order), fetchHeaderOrderNoCreds: ord(nav2 && nav2.order), httpVersion: nav && nav.httpVersion, navigationHeaderOrderLowEntropy: ord(h && h.order), highEntropyHintsSentOnFetch: Object.keys((nav && nav.clientHints) || {}).filter(dropHint).sort() };
    if (tls && tls.hello) data.tls = { ja4: tls.hello.ja4, ja3Sorted: tls.hello.ja3Sorted, alpn: tls.alpn, greasePresent: tls.hello.greasePresent, cipherCount: tls.hello.cipherCount, groups: tls.hello.groups, sigAlgs: tls.hello.sigAlgs, tlsVersionOffered: tls.hello.tlsVersionOffered, h2: tls.h2 || null, h1: tls.h1 || null };
    else if (tls) data.tls = { unavailable: tls.error || 'no-hello' };
    return { data, volatile: { tlsRaw: tls && tls.hello && { ja4Raw: tls.hello.ja4Raw, ja3: tls.hello.ja3, extensionOrder: tls.hello.extensionOrder }, navigationHeaders: h && h.headers, navigationHeaderOrderFull: h && h.order, clientHintValuesOnFetch: nav && nav.clientHints } };
  };

  /* ---- automation hygiene ---- */
  V.automation = async () => {
    const data = {};
    data.webdriver = navigator.webdriver; data.headlessUA = /HeadlessChrome/.test(navigator.userAgent); data.pluginsLength = navigator.plugins.length; data.languagesLength = (navigator.languages || []).length;
    data.chromeObject = typeof window.chrome; data.outerSizeZero = window.outerWidth === 0 && window.outerHeight === 0;
    let leaked = false; const e = new Error(); Object.defineProperty(e, 'stack', { get() { leaked = true; return ''; } }); console.debug(e);
    await sleep(30); data.cdpRuntimeEnableLeak = leaked;
    data.notificationPermissionMismatch = await (async () => { try { if (typeof Notification === 'undefined') return null; const p = await navigator.permissions.query({ name: 'notifications' }); return Notification.permission === 'denied' && p.state === 'prompt'; } catch (e2) { return null; } })();
    data.automationGlobals = Object.getOwnPropertyNames(window).filter((k) => /^(cdc_|\$cdc_|__webdriver|__selenium|__fxdriver|_Selenium_IDE|callSelenium|__playwright|__pwInitScripts|__puppeteer|puppeteer|_phantom|phantom|domAutomation|domAutomationController)/i.test(k));
    data.documentWebdriverAttr = document.documentElement.getAttribute('webdriver');
    data.permissionsQueryToStringNative = /\[native code\]/.test(Function.prototype.toString.call(navigator.permissions.query));
    return { data };
  };

  /* ---- ad-blocker / extension detection ---- */
  V.blockers = async (opts) => {
    const data = {}; const base = opts.serverBase || '';
    const bait = document.createElement('div'); bait.className = 'ad-banner adsbox ad-placement textads banner-ads pub_300x250'; bait.id = 'ad-container'; bait.style.cssText = 'width:300px;height:250px;position:absolute;left:-9999px'; bait.innerHTML = '&nbsp;'; document.body.appendChild(bait);
    await sleep(80); const cs = getComputedStyle(bait); data.baitHidden = bait.offsetHeight === 0 || cs.display === 'none' || cs.visibility === 'hidden'; bait.remove();
    const probe = (path) => fetch(base + path, { cache: 'no-store' }).then((r) => r.status).catch(() => 'blocked');
    data.adPathStatus = await probe('/ads/pagead/adframe.js'); data.controlPathStatus = await probe('/static/control.js'); data.trackerPathStatus = await probe('/analytics/collect.js');
    data.contentBlockerLikely = data.adPathStatus === 'blocked' || data.trackerPathStatus === 'blocked';
    data.extensionProbes = {};
    for (const [n, id, p] of [['ublock-origin', 'cjpalhdlnbpafiamejdnhcphjbkeiagm', 'web_accessible_resources/1x1.gif'], ['bitwarden', 'nngceckbapebfimnlniiiahkandclblb', 'images/icon48.png'], ['grammarly', 'kbfnbcaeplbcioakkpcpgfkobkghlhen', 'src/images/icon-48.png'], ['lastpass', 'hdokiejnpimakedhajhdlcegeplioahd', 'images/icon-48.png'], ['metamask', 'nkbihfbeogaeaoehlefnkodbefgpgknn', 'images/logo.png']]) {
      data.extensionProbes[n] = await withTimeout(new Promise((r) => { const i = new Image(); i.onload = () => r('loaded'); i.onerror = () => r('error'); i.src = `chrome-extension://${id}/${p}`; }), 700, 'timeout');
    }
    data.injectedElements = Array.from(document.documentElement.children).map((e) => e.tagName).filter((t) => !['HEAD', 'BODY'].includes(t));
    data.bodyChildrenWithShadow = Array.from(document.body.children).filter((e) => e.shadowRoot).length;
    return { data };
  };

  /* ---- cross-context consistency & lie detection ---- */
  V.consistency = async (opts, ctx) => {
    const checks = []; const add = (id, ok, detail) => checks.push({ id, ok: ok === null ? null : !!ok, detail: detail === undefined ? null : detail });
    const S = ctx.surfaces; const nav = S.navigator && S.navigator.data || {}; const uad = S.userAgentData && S.userAgentData.data || {}; const scr = S.screen && S.screen.data || {};
    const w = ctx.worker || {};
    const ua = navigator.userAgent;
    add('ua_platform_matches_uach', uad.supported ? ((/Macintosh/.test(ua) && uad.platform === 'macOS') || (/Windows/.test(ua) && uad.platform === 'Windows') || (/Linux/.test(ua) && !/Android/.test(ua) && uad.platform === 'Linux') || (/CrOS/.test(ua) && uad.platform === 'Chrome OS') || (/Android/.test(ua) && uad.platform === 'Android')) : null, { ua, platform: uad.platform });
    const chromeV = ver(/Chrome\/(\d+)/, ua); const chromiumBrand = uad.supported ? (uad.brands || []).find((b) => b.brand === 'Chromium') : null;
    add('ua_version_matches_brands', chromiumBrand ? chromiumBrand.version === chromeV : null, { chromeV, chromiumBrand });
    add('brands_no_brave_or_auren', uad.supported ? !(uad.brands || []).some((b) => /brave|auren/i.test(b.brand)) : null, uad.brands);
    add('fullVersionList_no_brave_or_auren', uad.supported && uad.high && uad.high.fullVersionList ? !uad.high.fullVersionList.some((b) => /brave|auren/i.test(b.brand)) : null, uad.high && uad.high.fullVersionList);
    add('ua_no_brave_or_auren_token', !/brave|auren/i.test(ua), ua);
    add('no_navigator_brave', !nav.hasNavigatorBrave, null);
    add('uach_mobile_false_on_desktop', uad.supported ? (uad.mobile === false) : null, uad.mobile);
    add('platform_matches_ua', (/Macintosh/.test(ua) && navigator.platform === 'MacIntel') || (/Windows/.test(ua) && navigator.platform === 'Win32') || (/Linux/.test(ua) && /Linux/.test(navigator.platform)) || /CrOS|Android/.test(ua), { platform: navigator.platform });
    add('appVersion_matches_ua', navigator.appVersion === ua.replace(/^Mozilla\//, ''), null);
    add('language_is_languages0', navigator.language === (navigator.languages || [])[0], null);
    const intlLocale = Intl.DateTimeFormat().resolvedOptions().locale; add('language_matches_intl_locale', intlLocale.split('-')[0] === navigator.language.split('-')[0], { intlLocale, language: navigator.language });
    if (ctx.echo && ctx.echo.headers) { const al = ctx.echo.headers['accept-language']; const exp = (navigator.languages || []).map((l, i) => i === 0 ? l : `${l};q=${(1 - i * 0.1).toFixed(1)}`).join(','); add('accept_language_matches_navigator_languages', al === exp, { header: al, expected: exp }); const sec = ctx.echo.headers['sec-ch-ua']; if (sec && uad.supported) add('sec_ch_ua_matches_js_brands', (uad.brands || []).every((b) => sec.includes(`"${b.brand}";v="${b.version}"`)), { header: sec, brands: uad.brands }); add('ua_header_matches_js', ctx.echo.headers['user-agent'] === ua, { header: ctx.echo.headers['user-agent'] }); }
    // worker vs main
    if (w.navigator && !w.navigator.error) {
      add('worker_ua_equal', w.navigator.userAgent === ua); add('worker_platform_equal', w.navigator.platform === navigator.platform);
      add('worker_hardwareConcurrency_equal', w.navigator.hardwareConcurrency === navigator.hardwareConcurrency, { main: navigator.hardwareConcurrency, worker: w.navigator.hardwareConcurrency });
      add('worker_deviceMemory_equal', w.navigator.deviceMemory === navigator.deviceMemory, { main: navigator.deviceMemory, worker: w.navigator.deviceMemory });
      add('worker_languages_equal', JSON.stringify(w.navigator.languages) === JSON.stringify(Array.from(navigator.languages)), { main: Array.from(navigator.languages), worker: w.navigator.languages });
      add('worker_no_navigator_brave', !w.navigator.hasBrave);
    } else add('worker_available', false, w.navigator);
    if (w.userAgentData && w.userAgentData.brands) add('worker_uach_brands_equal', JSON.stringify(w.userAgentData.brands) === JSON.stringify(uad.brands), { worker: w.userAgentData.brands, main: uad.brands });
    if (w.intl) add('worker_timezone_equal', w.intl.tz === Intl.DateTimeFormat().resolvedOptions().timeZone && w.intl.offset === new Date(2024, 0, 15).getTimezoneOffset());
    const gl = S.webgl && S.webgl.data && S.webgl.data.webgl; if (w.webgl && gl && !w.webgl.error) { add('worker_webgl_renderer_equal', w.webgl.unmaskedRenderer === gl.unmaskedRenderer && w.webgl.renderer === (gl.params || {}).RENDERER, { worker: w.webgl.unmaskedRenderer, main: gl.unmaskedRenderer }); add('worker_webgl_extensions_equal', JSON.stringify(w.webgl.extensions) === JSON.stringify(gl.extensions)); }
    const c2 = S.canvas2d && S.canvas2d.data || {}; if (w.offscreen2d && c2.getImageDataHash) add('worker_canvas_imagedata_equals_main', w.offscreen2d.imageDataHash === c2.getImageDataHash, { worker: w.offscreen2d.imageDataHash, main: c2.getImageDataHash });
    // iframe realm
    try {
      const fr = document.createElement('iframe'); fr.style.display = 'none'; document.body.appendChild(fr); const fw = fr.contentWindow;
      add('iframe_ua_equal', fw.navigator.userAgent === ua); add('iframe_hardwareConcurrency_equal', fw.navigator.hardwareConcurrency === navigator.hardwareConcurrency, { main: navigator.hardwareConcurrency, frame: fw.navigator.hardwareConcurrency });
      add('iframe_languages_equal', JSON.stringify(Array.from(fw.navigator.languages)) === JSON.stringify(Array.from(navigator.languages))); add('iframe_deviceMemory_equal', fw.navigator.deviceMemory === navigator.deviceMemory);
      add('iframe_plugins_equal', fw.navigator.plugins.length === navigator.plugins.length);
      const fc = fw.document.createElement('canvas'); fc.width = 64; fc.height = 64; const fx = fc.getContext('2d'); fx.fillStyle = 'rgb(100,150,200)'; fx.fillRect(0, 0, 64, 64); const fs = imgStats(fx.getImageData(0, 0, 64, 64).data, [100, 150, 200, 255]); add('iframe_canvas_noise_matches_main', (fs.diffPx > 0) === !!c2.noiseDetectedUniform, { frame: fs.diffPx, main: c2.noiseUniformFill && c2.noiseUniformFill.diffPx });
      fr.remove();
      const sb = document.createElement('iframe'); sb.setAttribute('sandbox', 'allow-scripts'); sb.srcdoc = '<script>parent.postMessage({hc:navigator.hardwareConcurrency,dm:navigator.deviceMemory,l:navigator.languages.join(),ua:navigator.userAgent,pl:navigator.plugins.length},"*")<\/script>'; document.body.appendChild(sb);
      const msg = await withTimeout(new Promise((r) => window.addEventListener('message', (e) => { if (e.source === sb.contentWindow) r(e.data); }, { once: true })), 1500, null); sb.remove();
      if (msg) add('sandboxed_iframe_values_equal', msg.hc === navigator.hardwareConcurrency && msg.dm === navigator.deviceMemory && msg.l === Array.from(navigator.languages).join() && msg.ua === ua && msg.pl === navigator.plugins.length, { msg });
    } catch (e) { add('iframe_tests', null, String(e)); }
    // plausibility
    add('deviceMemory_in_chrome_set', navigator.deviceMemory === undefined ? null : [2, 4, 8, 16, 32].includes(navigator.deviceMemory), navigator.deviceMemory);
    add('hardwareConcurrency_plausible_integer', Number.isInteger(navigator.hardwareConcurrency) && navigator.hardwareConcurrency >= 1 && navigator.hardwareConcurrency <= 256, navigator.hardwareConcurrency);
    const pn = (nav.plugins || []).map((p) => p.name); const chromePdf = ['PDF Viewer', 'Chrome PDF Viewer', 'Chromium PDF Viewer', 'Microsoft Edge PDF Viewer', 'WebKit built-in PDF'];
    add('plugins_are_chrome_standard_five', navigator.pdfViewerEnabled ? (pn.length === 5 && chromePdf.every((n) => pn.includes(n))) : pn.length === 0, pn);
    add('plugins_no_random_names', !pn.some((n) => /^[A-Za-z0-9]{6,9}$/.test(n)), pn);
    add('pdfViewerEnabled_matches_plugins', navigator.pdfViewerEnabled === (pn.length > 0), null);
    const mt = nav.mimeTypes || []; add('mimeTypes_consistent_with_plugins', mt.length === 0 ? pn.length === 0 : mt.every((m) => !/\|null$/.test(m)), mt);
    const g1 = gl; if (g1) { add('webgl_extension_objects_all_present', (g1.extObjectMismatch || []).length === 0, g1.extObjectMismatch); add('webgl_renderer_not_brave_literal', !/^Brave$/i.test(String(g1.unmaskedRenderer)) && !/^Brave$/i.test(String(g1.unmaskedVendor)), { vendor: g1.unmaskedVendor, renderer: g1.unmaskedRenderer }); add('webgl_renderer_not_random_string', !/^[A-Za-z0-9]{8}$/.test(String(g1.unmaskedRenderer)), g1.unmaskedRenderer); add('webgl_renderer_platform_plausible', /Macintosh/.test(ua) ? /Apple|Intel|AMD|ANGLE|Metal/.test(String(g1.unmaskedRenderer)) || g1.unmaskedRenderer == null : true, g1.unmaskedRenderer); }
    add('screen_matches_media_query', scr.mqDeviceWidth === undefined ? null : (scr.mqDeviceWidth === screen.width && scr.mqDeviceHeight === screen.height), { screen: [screen.width, screen.height], mq: [scr.mqDeviceWidth, scr.mqDeviceHeight] });
    add('screen_avail_le_size', screen.availWidth <= screen.width && screen.availHeight <= screen.height);
    add('outer_ge_inner', window.outerWidth >= window.innerWidth && window.outerHeight >= window.innerHeight, { outer: [window.outerWidth, window.outerHeight], inner: [window.innerWidth, window.innerHeight] });
    add('dpr_matches_mq_resolution', scr.mqResolutionDppx === undefined ? null : Math.abs(scr.mqResolutionDppx - window.devicePixelRatio) <= 0.25, { dpr: window.devicePixelRatio, mq: scr.mqResolutionDppx });
    const iz = S.intl && S.intl.data || {}; add('timezone_intl_matches_date', (() => { try { const d = new Date(2024, 0, 15, 12); return new Intl.DateTimeFormat('en-US', { timeZone: iz.tz, hour: 'numeric', hourCycle: 'h23' }).format(d) === '12'; } catch (e) { return null; } })(), { tz: iz.tz });
    // canvas/audio noise behaviour summary
    add('canvas_reads_repeatable', c2.repeatToDataURLEqual && c2.repeatGetImageDataEqual, null);
    add('canvas_png_matches_getImageData', c2.pngVsGetImageDataDiffBytes === 0, c2.pngVsGetImageDataDiffBytes);
    add('canvas_put_get_roundtrip_exact', c2.putGetRoundTripDiffBytes === 0, c2.putGetRoundTripDiffBytes);
    add('canvas_offscreen_equals_canvas', c2.offscreenMatchesCanvasImageData === undefined ? null : c2.offscreenMatchesCanvasImageData, null);
    const au = S.audio && S.audio.data || {}; add('audio_render_repeatable', au.repeatRenderEqual === undefined ? null : au.repeatRenderEqual, null); add('audio_getChannelData_exact', au.noiseDetectedGetChannelData === undefined ? null : !au.noiseDetectedGetChannelData, au.getChannelDataNoise);
    const ge = S.geometry && S.geometry.data || {}; add('geometry_repeatable', ge.repeatRectsEqual, null);
    // native-ness (JS-level spoofing leaves non-native functions / own properties)
    const nat = (fn) => typeof fn === 'function' && /\{\s*\[native code\]\s*\}/.test(Function.prototype.toString.call(fn));
    const getterOf = (obj, k) => { const d = Object.getOwnPropertyDescriptor(obj, k); return d && d.get; };
    const nonNative = [];
    for (const k of ['userAgent', 'platform', 'languages', 'hardwareConcurrency', 'webdriver', 'plugins', 'vendor']) { const gtr = getterOf(Navigator.prototype, k); if (gtr && !nat(gtr)) nonNative.push('Navigator.' + k); }
    for (const [o, ks] of [[HTMLCanvasElement.prototype, ['toDataURL', 'toBlob', 'getContext']], [CanvasRenderingContext2D.prototype, ['getImageData', 'measureText', 'fillText']], [WebGLRenderingContext.prototype, ['getParameter', 'readPixels', 'getExtension', 'getSupportedExtensions']], [Element.prototype, ['getBoundingClientRect', 'getClientRects']], [Function.prototype, ['toString']]]) for (const k of ks) { if (!nat(o[k])) nonNative.push((o.constructor && o.constructor.name) + '.' + k); }
    if (typeof AudioBuffer !== 'undefined') for (const k of ['getChannelData', 'copyFromChannel']) if (!nat(AudioBuffer.prototype[k])) nonNative.push('AudioBuffer.' + k);
    add('tampering_all_probed_functions_native', nonNative.length === 0, nonNative);
    add('navigator_has_no_own_properties', Object.getOwnPropertyNames(navigator).length === 0, Object.getOwnPropertyNames(navigator));
    add('navigator_proto_chain_clean', Object.getPrototypeOf(navigator) === Navigator.prototype && Object.getPrototypeOf(Navigator.prototype) === Object.prototype, null);
    add('stack_no_injected_frames', !/extension|userscript|inject|puppeteer|playwright|__puppeteer_evaluation_script__/i.test(new Error().stack || ''), null);
    return { data: { checks, failed: checks.filter((c) => c.ok === false).map((c) => c.id), passedCount: checks.filter((c) => c.ok === true).length, naCount: checks.filter((c) => c.ok === null).length } };
  };

  /* ---------- orchestration ---------- */
  const ORDER = ['navigator', 'userAgentData', 'screen', 'mediaQueries', 'intl', 'canvas2d', 'webgl', 'webgpu', 'audio', 'fonts', 'geometry', 'emoji', 'speech', 'mediaDevices', 'webrtc', 'hardware', 'storage', 'timing', 'css', 'jsEngine', 'codecs', 'headers', 'automation', 'blockers', 'consistency'];

  async function runWorker(url) {
    try {
      const w = new Worker(url);
      const res = await withTimeout(new Promise((resolve, reject) => { w.onmessage = (e) => resolve(e.data); w.onerror = (e) => reject(new Error(e.message || 'worker error')); w.postMessage({ sceneSrc: SCENE_SRC }); }), 6000, { error: 'worker timeout' });
      w.terminate(); return res;
    } catch (e) { return { navigator: { error: String(e) } }; }
  }

  const CONSISTENCY_DEPS = ['navigator', 'userAgentData', 'screen', 'intl', 'canvas2d', 'webgl', 'audio', 'geometry', 'speech', 'headers'];
  async function collect(opts = {}) {
    let want = null;
    if (opts.only && opts.only.length) { want = new Set(opts.only); if (want.has('consistency')) CONSISTENCY_DEPS.forEach((d) => want.add(d)); }
    const surfaces = {}; const t0 = performance.now();
    const ctx = { surfaces, worker: null, echo: null };
    if (!want || want.has('consistency') || want.has('workerContext')) ctx.worker = await runWorker(opts.workerUrl || '/worker.js');
    for (const name of ORDER) {
      if (want && !want.has(name)) continue;
      const s0 = performance.now();
      try { const r = await V[name](opts, ctx); surfaces[name] = { data: r.data, volatile: Object.assign({}, r.volatile || {}, { ms: Math.round(performance.now() - s0) }) }; if (name === 'headers') ctx.echo = { headers: Object.assign({}, r.data.fetchHeaders || {}, r.volatile && r.volatile.clientHintValuesOnFetch || {}) }; }
      catch (e) { surfaces[name] = { data: null, error: String(e && e.stack || e).slice(0, 300), volatile: { ms: Math.round(performance.now() - s0) } }; }
    }
    if (ctx.worker) { const { timing, ...wdata } = ctx.worker; surfaces.workerContext = { data: wdata, volatile: { timing } }; }
    return { schema: SCHEMA, collectedAt: new Date().toISOString(), location: location.href, durationMs: Math.round(performance.now() - t0), surfaces };
  }

  window.FPAudit = { collect, SCENE_SRC, version: SCHEMA, surfaceNames: ORDER.concat(['workerContext']) };
})();
