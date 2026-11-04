'use strict';

/**
 * 本轮新增功能的测试（纯 Node，不需要浏览器）
 * ------------------------------------------------------------
 *  1. 年份 ↔ 干支互转，年份 / 干支 / 原文三者并存
 *  2. 删除预览与级联删除（外支配偶只解婚不删人）
 *  3. 世次标注（第一世…）
 *  4. 纵向 / 横向布局：坐标轴方向、同辈不重叠
 *  5. Excel：zip 结构、工作表数量、行数与关键字段
 *
 * 跑法：node test/features.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const G = require('../renderer/ganzhi');
const { createApi } = require('../src/api');

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

function section(title) {
  console.log(`\n【${title}】`);
}

/** 极简 zip 读取：解析中央目录 + inflate。测试用，不追求健壮。 */
function unzip(buf) {
  const out = new Map();
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i -= 1) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new Error('不是合法 zip：找不到 EOCD');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i += 1) {
    if (buf.readUInt32LE(p) !== 0x02014b50) throw new Error('中央目录损坏');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.slice(p + 46, p + 46 + nameLen).toString('utf8');

    // 本地头长度要单独读，因为 extra 字段长度可能不同
    const lhNameLen = buf.readUInt16LE(offset + 26);
    const lhExtraLen = buf.readUInt16LE(offset + 28);
    const dataStart = offset + 30 + lhNameLen + lhExtraLen;
    const raw = buf.slice(dataStart, dataStart + csize);
    out.set(name, method === 0 ? raw : zlib.inflateRawSync(raw));

    p += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zupu-feat-'));
const api = createApi({ filePath: path.join(tmp, 't.db'), backupDir: path.join(tmp, 'bk'), deviceLabel: 'testA' });

// ── 1. 干支 ────────────────────────────────────────────
section('1. 年份 ↔ 天干地支');

ok(G.ganzhiOfYear(1984) === '甲子', '1984 → 甲子');
ok(G.ganzhiOfYear(1735) === '乙卯', '1735 → 乙卯');
ok(G.ganzhiOfYear(2026) === '丙午', '2026 → 丙午');
ok(G.ganzhiOfYear(1911) === '辛亥', '1911 → 辛亥');
ok(G.findGanzhi('乾隆壬寅') === '壬寅', '从「乾隆壬寅」抠出壬寅');
ok(G.findYear('乾隆壬寅（1735）') === 1735, '原文里明写了四位年份，以明写的为准');
ok(G.findYear('康熙戊寅') === 1698, '年号 + 干支 → 康熙年间唯一的戊寅年 = 1698');
ok(G.findYear('康熙三十七年') === 1698, '年号 + 年数 → 1662 + 37 - 1 = 1698');
ok(G.findYear('民国二十五年') === 1936, '民国纪年 → 1912 + 25 - 1 = 1936');
ok(G.findYear('乾隆六十年') === 1795, '年号最后一年不越界');
ok(G.findYear('戊寅') === null, '只有干支、没有年号：六十甲子定不了年，留空');
ok(G.findYear('康熙年间') === null, '只有年号、没有年数也没有干支：留空');
ok(G.shiLabel(3) === '三世' && G.shiLabel(12) === '十二世', '世次写中文：三世 / 十二世');
ok(G.shiLabelFull(1) === '第一世', '带「第」：第一世');
ok(G.cnToInt('二十三') === 23 && G.cnToInt('元') === 1, '中文数字：二十三 / 元');

const n1 = G.normalize({ year: 1735 });
ok(n1.ganzhi === '乙卯' && n1.text === '', '只给年份：自动补干支，不编造原文');
const n2 = G.normalize({ text: '乾隆壬寅' });
ok(n2.ganzhi === '壬寅' && n2.year === 1782, '只给原文：年号能定年就补年份（1782），干支照抠');
const n3 = G.normalize({ text: '壬寅' });
ok(n3.ganzhi === '壬寅' && n3.year == null, '只有干支：抠出干支，不猜公元年');

// ── 2. 数据层：年份与干支双存 ───────────────────────────
section('2. 年份 / 干支 / 原文 三者并存');

const boot = api.bootstrap();
const rootUuid = boot.rootUuid;
api.savePerson({
  uuid: rootUuid,
  surname: '张',
  given_name: '守拙',
  gender: 1,
  alive: false,
  birth: { year: 1735, text: '康熙戊寅', ganzhi: '' },
  death: { text: '' },
  burial: {},
});
const saved = api.person({ uuid: rootUuid });
ok(saved.birth.year === 1735, `年份写入：${saved.birth.year}`);
ok(saved.birth.ganzhi === '乙卯', `年份自动转出干支：${saved.birth.ganzhi}`);
ok(saved.birth.text === '康熙戊寅', `原文原样保留：${saved.birth.text}`);

api.savePerson({
  uuid: rootUuid,
  surname: '张',
  given_name: '守拙',
  gender: 1,
  alive: false,
  birth: { year: '', text: '乾隆壬寅', ganzhi: '' },
  death: { year: 1790, ganzhi: '庚戌', text: '' },
  burial: {},
});
const saved2 = api.person({ uuid: rootUuid });
ok(saved2.birth.ganzhi === '壬寅' && saved2.birth.year === 1782, '只写原文：干支抠出来，年号也推算成公元年');
ok(saved2.death.year === 1790 && saved2.death.ganzhi === '庚戌', '手填年份 + 手填干支都保留');
ok(saved2.genLabel === '第一世', `面板世次：${saved2.genLabel}`);

// ── 3. 删除 ────────────────────────────────────────────
section('3. 删除预览与级联删除');

// 造一棵小树：甲 → 乙 → 丙、丁；丙娶外姓「戊」
const jia = api.addChild({ parentUuid: rootUuid, person: { given_name: '甲', gender: 1 } }).uuid;
const yi = api.addChild({ parentUuid: jia, person: { given_name: '乙', gender: 1 } }).uuid;
const bing = api.addChild({ parentUuid: yi, person: { given_name: '丙', gender: 1 } }).uuid;
api.addChild({ parentUuid: yi, person: { given_name: '丁', gender: 1 } });
const wu = api.addSpouse({ personUuid: bing, person: { surname: '外', given_name: '戊', gender: 2 } }).uuid;

const prev = api.deletePreview({ uuid: yi });
ok(prev.person === '张乙', `预览对象正确：${prev.person}`);
ok(prev.total === 3, `将删除 3 人（乙、丙、丁）：${prev.total}`);
ok(prev.descendants === 2, `其中后代 2 人：${prev.descendants}`);
ok(prev.externalSpouses.includes('外戊'), `识别出外支配偶：${prev.externalSpouses.join('、')}`);

const del = api.removePerson({ uuid: yi, cascade: true });
ok(del.removed === 3, `实际删除 3 人：${del.removed}`);
ok(del.externalSpouses === 1, `解婚 1 段（外支配偶仅解婚）：${del.externalSpouses}`);

const afterTree = api.tree({});
const names = afterTree.nodes.map((x) => x.name);
ok(!names.includes('张乙') && !names.includes('张丙') && !names.includes('张丁'), '乙丙丁已不在谱中');
ok(names.includes('外戊'), '外支配偶「外戊」仍在（不能被连带删掉）');
ok(names.includes('张甲'), '上一代未受影响');

const wuPerson = api.person({ uuid: wu });
ok(wuPerson !== null && wuPerson.unions.length === 0, '外戊的婚姻记录已解除，本人仍在');

// ── 4. 布局方向 ────────────────────────────────────────
section('4. 纵向 / 横向布局');

global.window = { devicePixelRatio: 1 };
require('../renderer/tree.js');
const ZT = global.window.ZupuTree;

function buildTree() {
  // 配偶在数据里是独立的人物记录（有自己的 uuid），否则不会被画成配偶框——
  // 第一版测试就是漏了这一点，spousePos 全空。
  const mk = (uuid, name, gen, gender) => ({
    uuid,
    name,
    gen,
    relGen: gen,
    gender,
    alive: 1,
    childCount: 0,
    spouses: [],
  });
  const nodes = [
    mk('a', '甲', 1, 1),
    mk('b', '乙', 2, 1),
    mk('c', '丙', 2, 1),
    mk('d', '丁', 3, 1),
    mk('e', '戊', 3, 1),
    mk('as', '甲妻', 1, 2),
    mk('bs', '乙妻', 2, 2),
  ];
  nodes[0].spouses = [{ uuid: 'as', name: '甲妻', gender: 2, alive: 1 }];
  nodes[1].spouses = [{ uuid: 'bs', name: '乙妻', gender: 2, alive: 1 }];
  nodes[5].spouses = [{ uuid: 'a', name: '甲', gender: 1, alive: 1 }];
  nodes[6].spouses = [{ uuid: 'b', name: '乙', gender: 1, alive: 1 }];

  const edges = [
    { parent: 'a', child: 'b', kind: '生', seq: 1, isPrimary: 1 },
    { parent: 'a', child: 'c', kind: '生', seq: 2, isPrimary: 1 },
    { parent: 'b', child: 'd', kind: '生', seq: 1, isPrimary: 1 },
    { parent: 'c', child: 'e', kind: '生', seq: 1, isPrimary: 1 },
  ];
  return { nodes, edges, roots: ['a'] };
}

function layoutOf(orient) {
  const inst = Object.create(ZT.prototype);
  inst.orient = orient;
  inst.data = buildTree();
  inst.pos = new Map();
  inst.spousePos = new Map();
  inst.computeLayout();
  return inst;
}

const vLay = layoutOf('v');
const hLay = layoutOf('h');

ok(vLay.pos.get('b').y > vLay.pos.get('a').y, '纵向：子代在父代下方');
ok(Math.abs(vLay.pos.get('b').y - vLay.pos.get('c').y) < 0.01, '纵向：同辈同高');
ok(hLay.pos.get('b').x > hLay.pos.get('a').x, '横向：子代在父代右侧');
ok(Math.abs(hLay.pos.get('b').x - hLay.pos.get('c').x) < 0.01, '横向：同辈同列');
ok(Math.abs(hLay.pos.get('b').y - hLay.pos.get('c').y) > 1, '横向：兄弟沿纵向错开');

// 配偶：纵向在右侧，横向在下方
const vS = [...vLay.spousePos.values()][0];
const vOwner = vLay.pos.get([...vLay.spousePos.entries()][0][1].owner);
ok(vS.x > vOwner.x && Math.abs(vS.y - vOwner.y) < 0.01, '纵向配偶框贴在本人右侧');
const hEntry = [...hLay.spousePos.entries()][0];
const hOwner = hLay.pos.get(hEntry[1].owner);
ok(hEntry[1].y > hOwner.y && Math.abs(hEntry[1].x - hOwner.x) < 0.01, '横向配偶框贴在本人下方');

// 任意两个节点不重叠（同一坐标系下比较矩形）
function overlaps(inst) {
  const ids = [...inst.pos.keys()];
  for (let i = 0; i < ids.length; i += 1) {
    for (let j = i + 1; j < ids.length; j += 1) {
      const p = inst.pos.get(ids[i]);
      const q = inst.pos.get(ids[j]);
      if (Math.abs(p.x - q.x) < 130 && Math.abs(p.y - q.y) < 52) return `${ids[i]}/${ids[j]}`;
    }
  }
  return null;
}
ok(overlaps(vLay) === null, '纵向：节点互不重叠', overlaps(vLay) || '');
ok(overlaps(hLay) === null, '横向：节点互不重叠', overlaps(hLay) || '');

ok(vLay.levels.length === 3 && vLay.levels[0].gen === 1, '世次分层：3 代，首层为第一世');
ok(vLay.levels[2].gen === 3, `第三层是第三世：${vLay.levels[2].gen}`);

// 横向布局应该明显更「趴」：同一棵树，横向的宽高比一定大于纵向
const vAspect = vLay.bbox.w / vLay.bbox.h;
const hAspect = hLay.bbox.w / hLay.bbox.h;
ok(
  hAspect > vAspect,
  `横向明显更宽（纵 ${vAspect.toFixed(2)} → 横 ${hAspect.toFixed(2)}）`
);

// ── 5. Excel ──────────────────────────────────────────
section('5. 导出 Excel');

const xls = api.exportExcel({ rootUuid: null });
const bytes = Buffer.from(xls.base64, 'base64');
ok(/\.xlsx$/.test(xls.fileName), `文件名是 .xlsx：${xls.fileName}`);
ok(bytes.subarray(0, 2).toString('latin1') === 'PK', 'zip magic（PK）正确');

const entries = unzip(bytes);
ok(entries.has('[Content_Types].xml'), '包含 [Content_Types].xml');
ok(entries.has('xl/workbook.xml'), '包含 workbook.xml');
ok(entries.has('xl/styles.xml'), '包含 styles.xml');

const wb = entries.get('xl/workbook.xml').toString('utf8');
const sheetNames = [...wb.matchAll(/<sheet name="([^"]+)"/g)].map((m) => m[1]);
ok(sheetNames.join(',') === '人物,婚配,父子,说明', `四张表：${sheetNames.join('、')}`);

const sheet1 = entries.get('xl/worksheets/sheet1.xml').toString('utf8');
const rowCount = (sheet1.match(/<row r="/g) || []).length;
const personCount = api.bootstrap().stats.total;
ok(rowCount === personCount + 1, `人物表 ${rowCount - 1} 行数据 + 1 行表头（库里 ${personCount} 人）`);

const headerCells = [...sheet1.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].slice(0, 25).map((m) => m[1]);
for (const col of ['世次', '姓名', '生年(公元)', '生年干支', '生年原文', '卒年干支', '生父', '配偶', '备注']) {
  ok(headerCells.includes(col), `人物表含「${col}」列`);
}

const hasShi = /<t[^>]*>[一二三四五六七八九十]+世<\/t>/.test(sheet1);
ok(hasShi, '世次写的是「第一世」这类中文，不是裸数字');

const sheet2 = entries.get('xl/worksheets/sheet2.xml').toString('utf8');
ok((sheet2.match(/<row r="/g) || []).length >= 2, '婚配表至少有 1 行数据');
const sheet4 = entries.get('xl/worksheets/sheet4.xml').toString('utf8');
ok(sheet4.includes('干支') || sheet4.includes('字段说明'), '说明表写有字段解释');

// ── 6. 照片：一人一张，随记谱包走 ────────────────────────
section('6. 照片');

// 1x1 红点 PNG
const TINY_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// 前面删过一轮，这里另造一个人来传照片
const photoGuy = api.addChild({ parentUuid: jia, person: { given_name: '禄', gender: 1 } }).uuid;

api.setPhoto({ uuid: photoGuy, dataUrl: TINY_PNG });
ok(api.person({ uuid: photoGuy }).photo === TINY_PNG, '照片存进去，读出来一字不差');
ok(api.person({ uuid: jia }).photo === null, '没传照片的人该字段是空');

let threw = '';
try {
  api.setPhoto({ uuid: photoGuy, dataUrl: 'data:text/html;base64,PGgxPjwvaDE+' });
} catch (e) {
  threw = e.message;
}
ok(/格式/.test(threw), '非图片 data URL 被拒', threw);

threw = '';
try {
  api.setPhoto({ uuid: photoGuy, dataUrl: 'data:image/png;base64,' + 'A'.repeat(4 * 1024 * 1024 + 100) });
} catch (e) {
  threw = e.message;
}
ok(/太大/.test(threw), '超过 3MB 的照片被拒', threw);

api.setPhoto({ uuid: photoGuy, dataUrl: null });
ok(api.person({ uuid: photoGuy }).photo === null, '传 null 即移除照片');
api.setPhoto({ uuid: photoGuy, dataUrl: TINY_PNG }); // 留着给后面两步用

// Excel 里标记有无照片（照片本身不进表格——表格是拿来核对的，不是相册）
const xls2 = api.exportExcel({ rootUuid: null });
const s1 = unzip(Buffer.from(xls2.base64, 'base64')).get('xl/worksheets/sheet1.xml').toString('utf8');
ok(s1.includes('照片'), '人物表有「照片」列');
ok(/<t[^>]*>有<\/t>/.test(s1), '传了照片的人标记「有」');

// 记谱包整支导出 → 另一个库整支导入，照片跟着走
const pkgJson = api.exportPackage({ rootUuid }).json;
const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'zupu-photo-'));
const apiB = createApi({ filePath: path.join(tmpB, 'b.db'), backupDir: path.join(tmpB, 'bk'), deviceLabel: 'testB' });
const rootB = apiB.savePerson({ given_name: '落地', gender: 1 }).uuid;
apiB.importExecute({ anchorUuid: rootB, text: pkgJson });
const imported = apiB.tree({}).nodes.find((n) => n.name.includes('禄'));
ok(!!imported, '导入后能找到「张禄」');
ok(apiB.person({ uuid: imported.uuid }).photo === TINY_PNG, '照片随 .zupu 包一起导入');
apiB.close();

api.close();
console.log(`\n${passed} 项断言通过。临时库：${tmp}`);
