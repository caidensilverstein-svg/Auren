/* Minimal TLS ClientHello parser -> JA3 / JA4 (FoxIO spec, TCP "t" variant).
 * Pure functions; unit-tested in test/tlsparse.test.js with a synthetic hello. */
import { createHash } from 'node:crypto';

const isGrease = (v) => (v & 0x0f0f) === 0x0a0a && ((v >> 8) & 0xff) === (v & 0xff);
const h4 = (v) => v.toString(16).padStart(4, '0');
const sha12 = (s) => createHash('sha256').update(s).digest('hex').slice(0, 12);

export function parseClientHello(buf) {
  // buf must start at the TLS record header
  if (buf.length < 9 || buf[0] !== 0x16) return null;
  const recLen = buf.readUInt16BE(3);
  if (buf.length < 5 + Math.min(recLen, 4)) return null;
  let o = 5;
  if (buf[o] !== 0x01) return null; // ClientHello
  o += 4; // type + 3-byte len
  const clientVersion = buf.readUInt16BE(o); o += 2;
  o += 32; // random
  const sidLen = buf[o]; o += 1 + sidLen;
  const csLen = buf.readUInt16BE(o); o += 2;
  const ciphers = [];
  for (let i = 0; i < csLen; i += 2) ciphers.push(buf.readUInt16BE(o + i));
  o += csLen;
  const compLen = buf[o]; o += 1 + compLen;
  const extTotal = o + 2 <= buf.length ? buf.readUInt16BE(o) : 0; o += 2;
  const end = Math.min(buf.length, o + extTotal);
  const exts = []; const x = { sni: null, groups: [], pointFormats: [], sigAlgs: [], alpn: [], versions: [] };
  while (o + 4 <= end) {
    const type = buf.readUInt16BE(o); const len = buf.readUInt16BE(o + 2); const d = buf.subarray(o + 4, o + 4 + len); o += 4 + len;
    exts.push(type);
    if (type === 0x0000 && d.length > 5) { x.sni = d.subarray(5, 5 + d.readUInt16BE(3)).toString('latin1'); }
    else if (type === 0x000a && d.length >= 2) { for (let i = 2; i + 1 < d.length; i += 2) x.groups.push(d.readUInt16BE(i)); }
    else if (type === 0x000b && d.length >= 1) { for (let i = 1; i < d.length; i++) x.pointFormats.push(d[i]); }
    else if (type === 0x000d && d.length >= 2) { for (let i = 2; i + 1 < d.length; i += 2) x.sigAlgs.push(d.readUInt16BE(i)); }
    else if (type === 0x0010 && d.length >= 2) { let p = 2; while (p < d.length) { const l = d[p]; x.alpn.push(d.subarray(p + 1, p + 1 + l).toString('latin1')); p += 1 + l; } }
    else if (type === 0x002b && d.length >= 1) { for (let i = 1; i + 1 < d.length; i += 2) x.versions.push(d.readUInt16BE(i)); }
  }
  return { clientVersion, ciphers, exts, ...x };
}

export function ja3(h) {
  const f = (a) => a.filter((v) => !isGrease(v));
  const s = [h.clientVersion, f(h.ciphers).join('-'), f(h.exts).join('-'), f(h.groups).join('-'), h.pointFormats.join('-')].join(',');
  return { string: s, hash: createHash('md5').update(s).digest('hex') };
}
/* JA3 with extensions sorted: stable under Chrome's extension-order permutation. */
export function ja3Sorted(h) {
  const f = (a) => a.filter((v) => !isGrease(v));
  const s = [h.clientVersion, f(h.ciphers).join('-'), f(h.exts).sort((a, b) => a - b).join('-'), f(h.groups).join('-'), h.pointFormats.join('-')].join(',');
  return { string: s, hash: createHash('md5').update(s).digest('hex') };
}

export function ja4(h) {
  const vers = h.versions.filter((v) => !isGrease(v)); const maxV = vers.length ? Math.max(...vers) : h.clientVersion;
  const vmap = { 0x0304: '13', 0x0303: '12', 0x0302: '11', 0x0301: '10', 0x0300: 's3' };
  const ciphers = h.ciphers.filter((v) => !isGrease(v)); const exts = h.exts.filter((v) => !isGrease(v));
  const alpn = h.alpn[0] || ''; const a1 = alpn ? (alpn[0] + alpn[alpn.length - 1]) : '00';
  const a = `t${vmap[maxV] || '00'}${h.sni ? 'd' : 'i'}${String(Math.min(ciphers.length, 99)).padStart(2, '0')}${String(Math.min(exts.length, 99)).padStart(2, '0')}${a1}`;
  const b = ciphers.length ? sha12(ciphers.map(h4).sort().join(',')) : '000000000000';
  const extFiltered = exts.filter((v) => v !== 0x0000 && v !== 0x0010).map(h4).sort().join(',');
  const sig = h.sigAlgs.filter((v) => !isGrease(v)).map(h4).join(',');
  const c = exts.length ? sha12(sig ? `${extFiltered}_${sig}` : extFiltered) : '000000000000';
  return { a, b, c, full: `${a}_${b}_${c}` };
}

export function describe(buf) {
  const h = parseClientHello(buf); if (!h) return null;
  const j3 = ja3(h), j3s = ja3Sorted(h), j4 = ja4(h);
  return {
    ja4: j4.full, ja3: j3.hash, ja3Sorted: j3s.hash, ja3String: j3.string,
    tlsVersionOffered: h.versions.filter((v) => !isGrease(v)).map(h4), cipherCount: h.ciphers.filter((v) => !isGrease(v)).length,
    extensionOrder: h.exts.map((v) => (isGrease(v) ? 'GREASE' : v)), extensionsSortedCount: h.exts.length,
    groups: h.groups.filter((v) => !isGrease(v)).map(h4), sigAlgs: h.sigAlgs.map(h4), alpn: h.alpn, sni: h.sni,
    greasePresent: h.exts.some(isGrease) || h.ciphers.some(isGrease),
  };
}
