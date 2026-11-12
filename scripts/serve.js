#!/usr/bin/env node
/**
 * Serves public/ on http://localhost:8080 with the same security headers as
 * vercel.json (including the Content-Security-Policy), so what you test
 * locally behaves like the live demo. No dependencies.
 *
 *   node scripts/serve.js [port]
 */
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..', 'public');
const PORT = Number(process.argv[2] || process.env.PORT || 8080);
const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vercel.json'), 'utf8'));
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.woff2': 'font/woff2', '.csv': 'text/csv; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.json': 'application/json',
};

function headersFor(urlPath) {
  const out = {};
  for (const rule of config.headers) {
    const re = new RegExp(`^${rule.source.replace(/\(\.\*\)/g, '(.*)')}$`);
    if (re.test(urlPath)) for (const h of rule.headers) out[h.key] = h.value;
  }
  return out;
}

http.createServer((req, res) => {
  const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  let file = path.normalize(path.join(ROOT, urlPath));
  if (!file.startsWith(ROOT)) { res.writeHead(403); return res.end(); }
  if (fs.existsSync(file) && fs.statSync(file).isDirectory()) file = path.join(file, 'index.html');
  fs.readFile(file, (err, data) => {
    const headers = headersFor(urlPath);
    if (err) { res.writeHead(404, Object.assign(headers, { 'Content-Type': 'text/plain' })); return res.end('Not found'); }
    res.writeHead(200, Object.assign(headers, { 'Content-Type': TYPES[path.extname(file)] || 'application/octet-stream' }));
    res.end(data);
  });
}).listen(PORT, () => console.log(`PulsePay demo on http://localhost:${PORT}`));
