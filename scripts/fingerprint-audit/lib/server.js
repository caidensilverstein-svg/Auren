/* Local test server: serves the collector page, echoes request headers (raw order),
 * and exposes the TLS ClientHello / HTTP/2 fingerprint of the browser's own connection.
 * Zero dependencies; the TLS side shells out to `openssl` once to make a throwaway cert. */
import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe } from './tlsparse.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const DROP = new Set(['host', 'referer', 'origin', 'cookie', 'content-length', 'connection', ':authority', ':path']);
const ACCEPT_CH = ['Sec-CH-UA-Arch', 'Sec-CH-UA-Bitness', 'Sec-CH-UA-Full-Version', 'Sec-CH-UA-Full-Version-List', 'Sec-CH-UA-Model', 'Sec-CH-UA-Platform-Version', 'Sec-CH-UA-WoW64', 'Sec-CH-UA-Form-Factors', 'Sec-CH-Prefers-Color-Scheme', 'Sec-CH-Prefers-Reduced-Motion', 'Sec-CH-Device-Memory', 'Sec-CH-DPR', 'Sec-CH-Viewport-Width', 'Sec-CH-Save-Data'].join(', ');

function rawHeaders(req) {
  const order = []; const map = {};
  const raw = req.rawHeaders || [];
  for (let i = 0; i < raw.length; i += 2) {
    const k = raw[i]; const lk = k.toLowerCase();
    if (DROP.has(lk)) continue;
    order.push(k); map[lk] = map[lk] === undefined ? raw[i + 1] : map[lk] + ', ' + raw[i + 1];
  }
  return { order, map };
}

export function makeCert(dir) {
  const key = path.join(dir, 'k.pem'); const crt = path.join(dir, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-keyout', key, '-out', crt, '-subj', '/CN=localhost', '-days', '2',
    '-addext', 'subjectAltName=DNS:localhost,DNS:*.localhost,IP:127.0.0.1,IP:::1'], { stdio: 'ignore' });
  return { key: fs.readFileSync(key), cert: fs.readFileSync(crt) };
}

export async function startServers({ port = 0, tlsPort = 0, outDir = null, bind = '127.0.0.1', tls = true, log = false } = {}) {
  const lib = (f) => fs.readFileSync(path.join(here, f));
  const helloByPeer = new Map(); // "ip:port" -> description
  const resultsDir = outDir ? path.join(outDir, 'posted') : null; if (resultsDir) fs.mkdirSync(resultsDir, { recursive: true });

  function handler(req, res) {
    const u = new URL(req.url, 'http://x');
    const hs = rawHeaders(req);
    const base = { 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Private-Network': 'true' };
    if (log) console.error(req.method, req.url);
    const send = (code, type, body, extra = {}) => { res.writeHead(code, { 'Content-Type': type, ...base, ...extra }); res.end(body); };
    if (u.pathname === '/' || u.pathname === '/index.html') {
      const html = fs.readFileSync(path.join(here, '..', 'page', 'index.html'), 'utf8').replace('/*__NAV__*/', 'window.__navHeaders=' + JSON.stringify({ order: hs.order, headers: hs.map, httpVersion: req.httpVersion }) + ';');
      return send(200, 'text/html; charset=utf-8', html, { 'Accept-CH': ACCEPT_CH });
    }
    if (u.pathname === '/collect.js') return send(200, 'text/javascript', lib('collect.js'));
    if (u.pathname === '/worker.js') return send(200, 'text/javascript', lib('worker.js'));
    if (u.pathname === '/evaluate.js') return send(200, 'text/javascript', lib('evaluate.cjs'));
    if (u.pathname === '/echo') {
      const ch = {}; for (const [k, v] of Object.entries(hs.map)) if (k.startsWith('sec-ch-') || k === 'device-memory' || k === 'dpr' || k === 'viewport-width') ch[k] = v;
      return send(200, 'application/json', JSON.stringify({ headers: hs.map, order: hs.order.map((s) => s.toLowerCase()), rawOrder: hs.order, httpVersion: req.httpVersion, clientHints: ch }));
    }
    if (u.pathname === '/tls') {
      const peer = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
      const hello = helloByPeer.get(peer) || helloByPeer.get(peer.replace('::ffff:', '')) || null;
      const out = { hello, httpVersion: req.httpVersion, alpn: req.socket.alpnProtocol || null };
      if (req.httpVersion === '2.0') {
        const sess = req.stream && req.stream.session;
        out.h2 = { remoteSettings: sess ? sess.remoteSettings : null, pseudoOrder: (req.rawHeaders || []).filter((k, i) => i % 2 === 0 && k.startsWith(':')), headerOrder: (req.rawHeaders || []).filter((k, i) => i % 2 === 0).map((s) => s.toLowerCase()) };
      } else out.h1 = { headerOrder: hs.order.map((s) => s.toLowerCase()) };
      return send(200, 'application/json', JSON.stringify(out));
    }
    if (u.pathname.startsWith('/ads/') || u.pathname.startsWith('/static/') || u.pathname.startsWith('/analytics/')) return send(200, 'text/javascript', '/* bait */');
    if (u.pathname === '/result' && req.method === 'POST') {
      let body = ''; req.on('data', (c) => { body += c; if (body.length > 50e6) req.destroy(); });
      req.on('end', () => { if (resultsDir) fs.writeFileSync(path.join(resultsDir, (u.searchParams.get('id') || Date.now()) + '.json'), body); send(200, 'application/json', '{"ok":true}'); });
      return;
    }
    if (u.pathname === '/favicon.ico') return send(204, 'image/x-icon', '');
    send(404, 'text/plain', 'not found');
  }

  const httpServer = http.createServer(handler);
  await new Promise((r) => httpServer.listen(port, bind, r));
  const out = { httpPort: httpServer.address().port, tlsPort: null, close: null, servers: [httpServer] };

  if (tls) {
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auren-fp-cert-'));
      const { key, cert } = makeCert(dir);
      const h2 = http2.createSecureServer({ key, cert, allowHTTP1: true, settings: { enablePush: false } }, handler);
      const front = net.createServer((sock) => {
        sock.once('data', (chunk) => {
          try { const d = describe(chunk); if (d) helloByPeer.set(`${sock.remoteAddress}:${sock.remotePort}`, d); } catch (e) { /* ignore */ }
          sock.unshift(chunk); h2.emit('connection', sock);
          sock.on('close', () => setTimeout(() => helloByPeer.delete(`${sock.remoteAddress}:${sock.remotePort}`), 30000).unref());
        });
        sock.on('error', () => { });
      });
      await new Promise((r) => front.listen(tlsPort, bind, r));
      out.tlsPort = front.address().port; out.servers.push(front, h2);
    } catch (e) { out.tlsError = String(e.message || e); }
  }
  out.close = () => Promise.all(out.servers.map((s) => new Promise((r) => { try { s.close(() => r()); if (s.closeAllConnections) s.closeAllConnections(); setTimeout(r, 500); } catch (e) { r(); } })));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  const s = await startServers({ port: +arg('port', 8123), tlsPort: +arg('tls-port', 8124), outDir: arg('out', null), log: true });
  console.log(`http://site-a.localhost:${s.httpPort}/  https://localhost:${s.tlsPort}/tls  ${s.tlsError || ''}`);
}
