'use strict';

/**
 * 界面交互测试（用系统 Chrome 驱动，不装额外浏览器）
 * 运行前先启动 dev server：node scripts/dev-server.js
 *   node test/ui.js
 */

const puppeteer = require('puppeteer-core');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const PORT = Number(process.env.UI_PORT || 4174);
const URL = `http://127.0.0.1:${PORT}/`;
const DATA_DIR = path.join(__dirname, '..', 'data-uitest');
const SHOT_DIR = process.env.SHOT_DIR || '/tmp/zupu-shots';
let passed = 0;

function ok(cond, msg) {
  if (!cond) {
    console.error(`  FAIL  ${msg}`);
    process.exitCode = 1;
    throw new Error(msg);
  }
  passed += 1;
  console.log(`  PASS  ${msg}`);
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
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('dev server 启动超时');
}

(async () => {
  fs.mkdirSync(SHOT_DIR, { recursive: true });

  // 每次都用全新的数据目录，测试结果不受上一轮残留影响
  fs.rmSync(DATA_DIR, { recursive: true, force: true });
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const server = spawn(process.execPath, [path.join(__dirname, '..', 'scripts', 'dev-server.js')], {
    env: { ...process.env, PORT: String(PORT), ZUPU_DATA_DIR: DATA_DIR },
    stdio: 'ignore',
  });
  await waitForServer();

  const browser = await puppeteer.launch({
    executablePath: '/usr/bin/google-chrome',
    headless: 'new',
    args: ['--no-sandbox', '--disable-gpu', '--window-size=1440,900'],
    defaultViewport: { width: 1440, height: 900 },
    protocolTimeout: 60000,
  });

  const page = await browser.newPage();
  const errors = [];
  const dialogs = [];
  page.on('dialog', async (d) => {
    dialogs.push({ type: d.type(), message: d.message().slice(0, 40) });
    await d.accept();
  });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => {
    if (m.type() === 'error') errors.push(m.text());
  });

  await page.goto(URL, { waitUntil: 'networkidle0' });
  await new Promise((r) => setTimeout(r, 700));

  console.log('\n【界面初始状态】');
  const boot = await page.evaluate(() => ({
    clan: document.getElementById('clanName').textContent,
    meta: document.getElementById('clanMeta').textContent,
    zoom: document.getElementById('zoomLabel').textContent,
    panelHidden: document.getElementById('panelBody').hidden,
    emptyHidden: document.getElementById('treeEmpty').hidden,
    name: document.getElementById('pName').textContent,
  }));
  console.log(`  ${boot.clan} · ${boot.meta} · ${boot.zoom} · 选中 ${boot.name}`);
  ok(boot.clan.includes('张氏'), '顶栏显示堂号');
  ok(!boot.panelHidden, '右侧人物档案已渲染');
  ok(boot.emptyHidden, '有数据时不显示空态提示');

  await page.screenshot({ path: path.join(SHOT_DIR, '01-home.png') });

  console.log('\n【点击世系图节点】');
  // 用 API 数据换算出「张文明」的屏幕坐标，模拟真实点击
  const target = await page.evaluate(async () => {
    const t = await window.zupu.invoke('tree', {});
    const n = t.nodes.find((x) => x.name === '张文明');
    const canvas = document.getElementById('tree');
    const rect = canvas.getBoundingClientRect();
    return { uuid: n.uuid, name: n.name, rectLeft: rect.left, rectTop: rect.top };
  });

  const pos = await page.evaluate((uuid) => {
    // 通过 tree 实例的世界坐标反算屏幕坐标
    const inst = window.__view;
    const p = inst.pos.get(uuid);
    const rect = document.getElementById('tree').getBoundingClientRect();
    return { x: rect.left + p.x * inst.scale + inst.tx, y: rect.top + p.y * inst.scale + inst.ty };
  }, target.uuid);

  await page.mouse.click(pos.x, pos.y);
  await new Promise((r) => setTimeout(r, 400));
  const selected = await page.evaluate(() => ({
    name: document.getElementById('pName').textContent,
    meta: document.getElementById('pMeta').textContent,
    given: document.getElementById('fGiven').value,
    children: document.getElementById('childCount').textContent,
    spouses: document.getElementById('spouseCount').textContent,
    parents: document.getElementById('parentList').textContent.trim(),
  }));
  console.log(`  选中：${selected.name}（${selected.meta}）子嗣 ${selected.children} 配偶 ${selected.spouses}`);
  ok(selected.name === '张文明', '点击节点后右侧切换到对应人物');
  const apiKids = await page.evaluate(async (uuid) => {
    const p = await window.zupu.invoke('person', { uuid });
    return p.children.length;
  }, target.uuid);
  ok(Number(selected.children) === apiKids, `子嗣数量与数据一致（${selected.children}）`);
  ok(selected.parents.includes('张德昌'), '父母一栏显示德昌');

  console.log('\n【编辑并保存】');
  await page.click('#fNote', { clickCount: 3 });
  await page.type('#fNote', '界面测试写入的备注');
  await page.click('#btnSave');
  await new Promise((r) => setTimeout(r, 600));
  const saved = await page.evaluate(() => document.getElementById('saveHint').textContent);
  ok(saved.includes('已保存'), '保存后出现保存提示');

  const persisted = await page.evaluate(async (uuid) => {
    const p = await window.zupu.invoke('person', { uuid });
    return p.note;
  }, target.uuid);
  ok(persisted.includes('界面测试写入的备注'), '备注已落库（不是只改在界面上）');

  console.log('\n【新增子嗣】');
  await page.click('#btnAddChild2');
  await new Promise((r) => setTimeout(r, 300));
  await page.type('#miniGiven', '承安');
  await page.click('#miniOk');
  await new Promise((r) => setTimeout(r, 700));
  const added = await page.evaluate(() => ({
    name: document.getElementById('pName').textContent,
    gen: document.getElementById('pMeta').textContent,
    kids: document.getElementById('childCount').textContent,
  }));
  ok(added.name === '张承安', '新增子嗣后自动选中新人物');
  ok(added.gen.includes('第四世'), `世次按父辈自动算为第四世（${added.gen}）`);
  await page.screenshot({ path: path.join(SHOT_DIR, '02-add-child.png') });

  console.log('\n【设为只看这一支】');
  await page.evaluate(async () => {
    const t = await window.zupu.invoke('tree', {});
    const dc = t.nodes.find((x) => x.name === '张德昌');
    window.__view.select(dc.uuid);
  });
  await new Promise((r) => setTimeout(r, 400));
  await page.click('#btnFocusRoot');
  await new Promise((r) => setTimeout(r, 700));
  const focused = await page.evaluate(() => ({
    nodes: window.__view.data.nodes.length,
    status: document.getElementById('statusLeft').textContent,
  }));
  ok(focused.status.includes('只看'), '「只看这一支」生效并给出提示');
  await page.screenshot({ path: path.join(SHOT_DIR, '03-focus-branch.png') });

  await page.click('#btnRoot');
  await new Promise((r) => setTimeout(r, 700));

  console.log('\n【导入向导第 1 步】');
  await page.click('#btnImport');
  await new Promise((r) => setTimeout(r, 400));
  const wizardStep1 = await page.evaluate(() => ({
    visible: !document.getElementById('importMask').hidden,
    anchor: document.getElementById('anchorName').textContent,
    nextDisabled: document.getElementById('wizardNext').disabled,
  }));
  ok(wizardStep1.visible, '导入向导已打开');
  ok(wizardStep1.anchor.length > 0, `向导里带出了当前锚点：${wizardStep1.anchor}`);
  ok(wizardStep1.nextDisabled, '没选包之前「下一步」不可点');
  await page.screenshot({ path: path.join(SHOT_DIR, '04-wizard-step1.png') });

  console.log('\n【导入向导：选包 → 预检】');
  // 浏览器版通过隐藏的 input 选文件，这里直接用 DataTransfer 模拟
  const pkgText = await page.evaluate(async () => {
    const t = await window.zupu.invoke('tree', {});
    const dc = t.nodes.find((x) => x.name === '张德昌');
    const res = await window.zupu.invoke('exportPackage', { rootUuid: dc.uuid, remark: '界面测试导出' });
    return res.json;
  });
  await page.evaluate((text) => {
    const input = document.createElement('input');
    input.type = 'file';
    const file = new File([text], '测试.zupu', { type: 'application/json' });
    const dt = new DataTransfer();
    dt.items.add(file);
    input.files = dt.files;
    // 找到 api-client 创建的那个 input 不现实，改为直接调用内部流程：
    window.__fakePicked = { opened: true, name: '测试.zupu', text };
    window.zupu.openPackageFile = async () => window.__fakePicked;
  }, pkgText);
  await page.click('#wizardChoose');
  await new Promise((r) => setTimeout(r, 800));

  const pkgShown = await page.evaluate(() => ({
    shown: !document.getElementById('pkgBox').hidden,
    from: document.getElementById('pkgFrom').textContent,
    root: document.getElementById('pkgRoot').textContent,
    count: document.getElementById('pkgCount').textContent,
    nextDisabled: document.getElementById('wizardNext').disabled,
  }));
  console.log(`  包信息：${pkgShown.root} · ${pkgShown.count}`);
  ok(pkgShown.shown, '选择包后显示包摘要');
  ok(!pkgShown.nextDisabled, '选好包后「下一步」可点');

  await page.click('#wizardNext');
  await new Promise((r) => setTimeout(r, 900));
  const preview = await page.evaluate(() => ({
    step: document.querySelector('.steps li.active').dataset.step,
    stats: document.getElementById('previewStats').textContent.replace(/\s+/g, ' ').trim(),
    localOnly: document.getElementById('localOnlyCount').textContent,
    warnings: document.getElementById('previewWarnings').textContent.trim(),
  }));
  console.log(`  预检：${preview.stats}`);
  ok(preview.step === '2', '进入预检步骤');
  ok(preview.stats.includes('将删除'), '预检列出将删除人数');
  await page.screenshot({ path: path.join(SHOT_DIR, '05-wizard-preview.png') });

  console.log('\n【确认执行：必须先输入锚点姓名】');
  await page.click('#wizardNext');
  await new Promise((r) => setTimeout(r, 400));
  const guard1 = await page.evaluate(() => document.getElementById('wizardNext').disabled);
  ok(guard1, '未输入姓名时执行按钮禁用（防手滑）');

  await page.type('#confirmInput', '张德昌');
  await new Promise((r) => setTimeout(r, 200));
  const guard2 = await page.evaluate(() => document.getElementById('wizardNext').disabled);
  ok(!guard2, '输入正确的锚点姓名后才可执行');

  await page.click('#wizardNext');
  await new Promise((r) => setTimeout(r, 1500));
  const done = await page.evaluate(() => ({
    doneShown: !document.getElementById('doneBox').hidden,
    stats: document.getElementById('doneStats').textContent.replace(/\s+/g, ' ').trim(),
    backup: document.getElementById('backupPath').textContent,
  }));
  console.log(`  执行结果：${done.stats}`);
  ok(done.doneShown, '执行完成后显示结果卡片');
  ok(done.backup.includes('备份'), '结果里给出备份文件位置');
  await page.screenshot({ path: path.join(SHOT_DIR, '06-wizard-done.png') });

  console.log('\n【撤销这次导入】');
  await page.click('#btnUndoNow');
  await new Promise((r) => setTimeout(r, 1500));
  const afterUndo = await page.evaluate(async () => {
    const t = await window.zupu.invoke('tree', {});
    return {
      hasNew: t.nodes.some((n) => n.name === '张承安'),
      batches: await window.zupu.invoke('batches'),
      maskHidden: document.getElementById('importMask').hidden,
    };
  });
  ok(afterUndo.maskHidden, '撤销后关闭导入弹窗');
  ok(afterUndo.batches[0].reverted === 1, '批次被标记为已撤销');

  console.log('\n【导入记录】');
  await page.click('#btnBatches');
  await new Promise((r) => setTimeout(r, 500));
  const batches = await page.evaluate(() => ({
    visible: !document.getElementById('batchesMask').hidden,
    items: document.querySelectorAll('#batchList .batch-item').length,
  }));
  ok(batches.visible && batches.items > 0, `导入记录里列出 ${batches.items} 条`);
  await page.screenshot({ path: path.join(SHOT_DIR, '07-batches.png') });

  console.log('\n【布局切换 / 世次 / 删除确认】');

  // 上一节把「导入记录」弹窗留在屏幕上了，遮罩会吃掉所有点击，先关掉
  await page.click('#batchesClose');
  await new Promise((r) => setTimeout(r, 300));

  const orientBefore = await page.evaluate(() => ({
    orient: window.__view.orient,
    btn: document.getElementById('btnOrient').textContent,
  }));
  await page.click('#btnOrient');
  await new Promise((r) => setTimeout(r, 600));
  const orientAfter = await page.evaluate(() => ({
    orient: window.__view.orient,
    btn: document.getElementById('btnOrient').textContent,
    levels: window.__view.levels.length,
  }));
  ok(orientAfter.orient !== orientBefore.orient, `布局按钮切换了方向（${orientBefore.btn} → ${orientAfter.btn}）`);
  ok(orientAfter.levels > 1, `切到横向后仍有 ${orientAfter.levels} 层世次分层（节点内标注不变）`);
  await page.screenshot({ path: path.join(SHOT_DIR, '08-orient-h.png') });
  await page.click('#btnOrient'); // 切回纵向
  await new Promise((r) => setTimeout(r, 400));

  // 删除：弹窗要先列出影响范围，未勾选时按钮不可用
  const victim = await page.evaluate(async () => {
    const t = await window.zupu.invoke('tree', {});
    const n = t.nodes.find((x) => x.childCount > 0 && x.gen > 1) || t.nodes[0];
    window.__view.select(n.uuid);
    return { uuid: n.uuid, name: n.name };
  });
  await new Promise((r) => setTimeout(r, 500));
  await page.click('#btnDelete');
  await page.waitForSelector('#deleteMask:not([hidden])', { timeout: 5000 });
  const delInfo = await page.evaluate(() => ({
    meta: document.getElementById('delMeta').textContent,
    names: document.getElementById('delList').textContent,
    disabled: document.getElementById('delOk').disabled,
  }));
  ok(/\d+ 人/.test(delInfo.meta), `删除弹窗列出影响人数：${delInfo.meta}`);
  ok(delInfo.names.includes('将从谱中移除'), '删除弹窗列出将被移除的姓名');
  ok(delInfo.disabled === true, '未勾选确认时删除按钮不可点');
  await page.screenshot({ path: path.join(SHOT_DIR, '09-delete-confirm.png') });
  await page.click('#delCancel');
  await new Promise((r) => setTimeout(r, 200));
  const stillThere = await page.evaluate(async (uuid) => {
    const p = await window.zupu.invoke('person', { uuid });
    return !!p;
  }, victim.uuid);
  ok(stillThere, '点取消后人物仍在（不会误删）');

  ok(errors.length === 0, `浏览器控制台无报错${errors.length ? '：' + errors.slice(0, 3).join(' | ') : ''}`);

  await browser.close();
  server.kill();
  console.log(`\n${passed} 项界面断言全部通过。截图：${SHOT_DIR}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
