import test from 'node:test';
import assert from 'node:assert/strict';
import { parseClientHello, ja4, ja3, describe } from '../lib/tlsparse.js';

function hello({ ciphers, exts, version = 0x0303 }) {
  const u16 = (n) => Buffer.from([n >> 8, n & 255]);
  const extBytes = Buffer.concat(exts.map((e) => Buffer.concat([u16(e.type), u16(e.data.length), e.data])));
  const body = Buffer.concat([u16(version), Buffer.alloc(32), Buffer.from([0]), u16(ciphers.length * 2), ...ciphers.map(u16), Buffer.from([1, 0]), u16(extBytes.length), extBytes]);
  const hs = Buffer.concat([Buffer.from([1, 0, body.length >> 8, body.length & 255]), body]);
  return Buffer.concat([Buffer.from([0x16, 3, 1, hs.length >> 8, hs.length & 255]), hs]);
}
const sni = (h) => { const n = Buffer.from(h); return Buffer.concat([Buffer.from([(n.length + 3) >> 8, (n.length + 3) & 255, 0, n.length >> 8, n.length & 255]), n]); };
const sample = () => hello({
  ciphers: [0x0a0a, 0x1301, 0x1302, 0xc02b],
  exts: [{ type: 0x0a0a, data: Buffer.alloc(0) }, { type: 0, data: sni('localhost') }, { type: 0x000a, data: Buffer.from([0, 4, 0x0a, 0x0a, 0, 29]) },
    { type: 0x000d, data: Buffer.from([0, 4, 4, 3, 8, 4]) }, { type: 0x0010, data: Buffer.concat([Buffer.from([0, 3, 2]), Buffer.from('h2')]) }, { type: 0x002b, data: Buffer.from([4, 0x0a, 0x0a, 3, 4]) }],
});

test('parses a synthetic ClientHello', () => {
  const h = parseClientHello(sample());
  assert.equal(h.sni, 'localhost'); assert.deepEqual(h.alpn, ['h2']); assert.deepEqual(h.groups, [0x0a0a, 29]); assert.deepEqual(h.sigAlgs, [0x0403, 0x0804]);
});
test('JA4 ignores GREASE and has the expected prefix', () => {
  const j = ja4(parseClientHello(sample()));
  assert.match(j.a, /^t13d0305h2$/); // 3 non-GREASE ciphers, 5 non-GREASE exts (sni,groups,sigalgs,alpn,versions)
  assert.match(j.full, /^t13d0305h2_[0-9a-f]{12}_[0-9a-f]{12}$/);
});
test('JA3 hash is md5 hex and describe() round-trips', () => {
  assert.match(ja3(parseClientHello(sample())).hash, /^[0-9a-f]{32}$/);
  assert.equal(describe(sample()).sni, 'localhost');
});
test('non-TLS input returns null', () => { assert.equal(parseClientHello(Buffer.from('GET / HTTP/1.1\r\n')), null); });
