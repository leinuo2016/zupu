'use strict';

/**
 * 本地调试服务器
 * ------------------------------------------------------------
 * 作用：不装 Electron 也能把界面跑起来（用同一套 renderer 与同一套 API）。
 *   启动：node scripts/dev-server.js        默认 http://127.0.0.1:4173
 *   数据：data/zupu-dev.db（与桌面版分开，不污染正式库）
 * 只监听 127.0.0.1，不对局域网开放。
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const { createApi } = require('../src/api');

const PORT = Number(process.env.PORT || 4173);
const HOST = '127.0.0.1';
const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'renderer');
const DATA_DIR = process.env.ZUPU_DATA_DIR || path.join(ROOT, 'data');

const dbPath = path.join(DATA_DIR, 'zupu-dev.db');
const api = createApi({ filePath: dbPath, backupDir: path.join(DATA_DIR, 'backups') });

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

function sendJson(res, status, data) {
  const body = JSON.stringify(data);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, buf) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('404');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': 'no-store',
    });
    res.end(buf);
  });
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${HOST}:${PORT}`);

  if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
    const method = url.pathname.slice('/api/'.length);
    let body = '';
    req.on('data', (chunk) => {
      body += chunk;
      if (body.length > 64 * 1024 * 1024) req.destroy(); // 64MB 上限，防手滑传大文件
    });
    req.on('end', () => {
      try {
        if (typeof api[method] !== 'function') throw new Error(`UNKNOWN_API: ${method}`);
        const args = body ? JSON.parse(body) : {};
        sendJson(res, 200, api[method](args));
      } catch (e) {
        sendJson(res, 500, { error: e.message });
      }
    });
    return;
  }

  // 静态文件
  let p = url.pathname === '/' ? '/index.html' : url.pathname;
  const filePath = path.join(RENDERER, path.normalize(p).replace(/^(\.\.[/\\])+/, ''));
  if (!filePath.startsWith(RENDERER)) {
    res.writeHead(403);
    res.end('403');
    return;
  }
  sendFile(res, filePath);
});

server.listen(PORT, HOST, () => {
  console.log(`族谱 dev server → http://${HOST}:${PORT}`);
  console.log(`数据库：${dbPath}`);
  console.log('按 Ctrl+C 结束。');
});
