'use strict';

/**
 * 导出功能测试（真浏览器、真落盘）
 * ------------------------------------------------------------
 * 验证三种导出格式都能产出可用文件：
 *   .zupu（记谱包）→ JSON 可解析
 *   .png          → PNG magic + 尺寸合理
 *   .pdf          → %PDF 头 + 含 /DCTDecode 图像 + 能定位到 xref
 *
 * 跑法：node test/export.js
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const puppeteer = require('puppeteer-core');

const CHROME = process.env.CHROME || '/usr/bin/google-chrome';
const PORT = Number(process.env.EXPORT_PORT || 4176);
const URL = `http://127.0.0.1:${PORT}/`;
const DATA_DIR = path.join(__dirname, '..', 'data-exporttest');
const EXPORT_DIR = path.join(DATA_DIR, 'exports');
const SHOT_DIR = path.join(__dirname, '..', 'screenshots');

let passed = 0;
function ok(cond, label, extra) {
  if (cond) {
    passed += 1;
    console.log(`  PASS  ${label}`);
  } else {
    console.log(`  FAIL  ${label}${extra ? `  → ${extra}` : ''}`);
    process.exitCode = 1;
  }
}

async function waitForServer(timeoutMs = 15000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/api/bootstrap`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
      });
      if (res.ok) return true;
    } catch (_) {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error('dev server 启动超时');
}

function newestFile(dir, ext) {
  if (!fs.existsSync(dir)) return null;
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.toLowerCase().endsWith(ext))
    .map((f) => ({ f, t: fs.statSync(path.join(dir, f)).mtimeMs }))
    .sort((a, b) => b.t - a.t);
  return files.length ? path.join(dir, files[0].f) : null;
}

(async () => {
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  const server = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'dev-server.js')], {
    env: { ...process.env, PORT: String(PORT), ZUPU_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  await waitForServer();

  const browser = await puppeteer.launch({
    executablePath: CHROME,
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 90000,
  });
  const page = await browser.newPage();
  // 无头环境没有文件选择框，先走「下载 + 服务端副本」这条降级链
  await page.evaluateOnNewDocument(() => {
    window.__zupuDisablePicker = true;
  });
  const errors = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('dialog', (d) => d.accept());

  await page.goto(URL, { waitUntil: 'networkidle2' });
  await page.waitForFunction(() => window.__view && window.__view.data.nodes.length > 0, { timeout: 15000 });

  console.log('\n【1】打开导出弹窗');
  await page.click('#btnExport');
  await page.waitForSelector('#exportMask:not([hidden])', { timeout: 5000 });
  ok(true, '点「导出本支」后弹窗出现（不再依赖原生 prompt）');

  await page.waitForFunction(() => /共 \d+ 人/.test(document.getElementById('expMeta').textContent), { timeout: 5000 });
  const meta = await page.$eval('#expMeta', (el) => el.textContent);
  ok(/共 \d+ 人/.test(meta), `弹窗显示支系人数：${meta}`);

  console.log('\n【2】导出 PNG');
  await page.select('#expFormat', 'png');
  await page.waitForFunction(() => !document.getElementById('expRowImage').hidden, { timeout: 3000 });
  await page.select('#expScale', '2');
  await page.click('#expOk');
  await page.waitForFunction(() => document.getElementById('expResult').hidden === false, { timeout: 30000 });

  const pngPath = newestFile(EXPORT_DIR, '.png');
  ok(!!pngPath, 'PNG 文件已写入磁盘', pngPath || EXPORT_DIR);
  const png = fs.readFileSync(pngPath);
  ok(png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])), 'PNG magic 正确');
  const pngW = png.readUInt32BE(16);
  const pngH = png.readUInt32BE(20);
  ok(pngW > 1200 && pngH > 800, `PNG 尺寸合理：${pngW}×${pngH}`);

  await page.screenshot({ path: path.join(SHOT_DIR, '05-导出弹窗.png') });

  console.log('\n【3】导出 PDF');
  await page.select('#expFormat', 'pdf');
  await page.select('#expPaper', 'a3');
  await page.click('#expOk');
  await page.waitForFunction(
    () => document.getElementById('expResultPath').textContent.includes('.pdf'),
    { timeout: 30000 }
  );

  const pdfPath = newestFile(EXPORT_DIR, '.pdf');
  ok(!!pdfPath, 'PDF 文件已写入磁盘', pdfPath || EXPORT_DIR);
  const pdf = fs.readFileSync(pdfPath);
  const head = pdf.subarray(0, 5).toString('latin1');
  ok(head === '%PDF-', `PDF 头正确：${head}`);
  ok(pdf.includes(Buffer.from('/DCTDecode')), 'PDF 内含 DCTDecode 图像对象');
  ok(pdf.includes(Buffer.from('/MediaBox [0 0 1190.55 841.89]')), 'A3 横向页面尺寸正确');
  const tail = pdf.subarray(-64).toString('latin1');
  ok(tail.includes('%%EOF'), 'PDF 结尾带 %%EOF');

  console.log('\n【4】导出记谱包');
  await page.select('#expFormat', 'zupu');
  await page.waitForFunction(() => !document.getElementById('expRowRemark').hidden, { timeout: 3000 });
  await page.type('#expRemark', '自动化测试导出');
  await page.click('#expOk');
  await page.waitForFunction(
    () => document.getElementById('expResultPath').textContent.includes('.zupu'),
    { timeout: 30000 }
  );

  const zupuPath = newestFile(EXPORT_DIR, '.zupu');
  ok(!!zupuPath, '记谱包已写入磁盘', zupuPath || EXPORT_DIR);
  const pkg = JSON.parse(fs.readFileSync(zupuPath, 'utf8'));
  ok(pkg.manifest && pkg.manifest.counts.person > 0, `记谱包可解析，含 ${pkg.manifest.counts.person} 人`);
  ok(/自动化测试导出/.test(pkg.manifest.remark || ''), '说明字段写入包内');

  console.log('\n【5】控制台无报错');
  ok(errors.length === 0, `运行时零报错${errors.length ? `（${errors.slice(0, 3).join(' | ')}）` : ''}`);

  // ── 保存位置 ───────────────────────────────────────────
  console.log('\n【6】保存位置可自选（模拟浏览器文件选择框）');

  const page2 = await browser.newPage();
  await page2.evaluateOnNewDocument(() => {
    window.__picked = [];
    window.__written = 0;
    window.__closed = false;
    window.showSaveFilePicker = async (opts) => {
      window.__picked.push({ name: opts.suggestedName, at: performance.now() });
      return {
        name: opts.suggestedName,
        createWritable: async () => ({
          write: async (blob) => {
            window.__written += blob.size || 0;
          },
          close: async () => {
            window.__closed = true;
          },
        }),
      };
    };
  });
  await page2.goto(URL, { waitUntil: 'networkidle2' });
  await page2.waitForFunction(() => window.__view && window.__view.data.nodes.length > 0, { timeout: 15000 });

  // 记录渲染开始的时刻，用来验证选择框确实弹在渲染之前（手势有效期只有几秒）
  await page2.evaluate(() => {
    const v = window.__view;
    const orig = v.renderAll.bind(v);
    v.renderAll = (...args) => {
      window.__renderAt = performance.now();
      return orig(...args);
    };
  });

  await page2.click('#btnExport');
  await page2.waitForSelector('#exportMask:not([hidden])', { timeout: 5000 });

  const dirHint = await page2.$eval('#expDirHint', (el) => el.textContent.trim());
  ok(dirHint.includes('浏览器'), `浏览器版说明了位置由浏览器决定：${dirHint.slice(0, 18)}…`);
  const dirLineHidden = await page2.$eval('#expDirLine', (el) => el.hidden);
  ok(dirLineHidden === true, '浏览器版不显示不可点的「位置」框（避免误当成按钮）');

  await page2.select('#expFormat', 'png');
  await page2.select('#expScale', '2');
  await page2.click('#expOk');
  await page2.waitForFunction(() => document.getElementById('expResult').hidden === false, { timeout: 30000 });

  const picked = await page2.evaluate(() => window.__picked);
  ok(picked.length === 1, `点导出后弹出了保存位置选择框（${picked.length} 次）`);
  ok(/\.png$/.test(picked[0].name), `建议文件名为 PNG：${picked[0].name}`);

  const order = await page2.evaluate(() => ({ pick: window.__picked[0].at, render: window.__renderAt || 0 }));
  ok(order.render > 0 && order.pick < order.render, '选择框在渲染大图之前弹出（用户手势未过期）');

  const written = await page2.evaluate(() => ({ bytes: window.__written, closed: window.__closed }));
  ok(written.closed === true, '写入流已正常关闭（文件落盘完成）');
  ok(written.bytes > 50 * 1024, `写入字节数合理：${Math.round(written.bytes / 1024)} KB`);

  const pickedPath = await page2.$eval('#expResultPath', (el) => el.textContent.trim());
  ok(/\.png$/.test(pickedPath) && !pickedPath.includes('exports'), `结果显示的是用户选定的文件名：${pickedPath}`);
  const altHidden = await page2.$eval('#expResultAlt', (el) => el.hidden);
  ok(altHidden === true, '走选择框时不显示服务端副本路径');

  await page2.close();

  await browser.close();
  server.kill();
  console.log(`\n${passed} 项断言通过。导出目录：${EXPORT_DIR}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
