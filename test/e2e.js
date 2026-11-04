'use strict';

/**
 * 端到端测试：模拟两台电脑的完整闭环
 * ------------------------------------------------------------
 *   1. A 机建库（示例家族），导出一支 → 记谱包 P1
 *   2. 把 A 的库整份拷到 B（相当于把主修文件拷到笔记本）
 *   3. 两台各自继续录：A 补子嗣，B 也补了子嗣（本地独有）
 *   4. A 重新导出这一支 → P2
 *   5. B 选锚点导入 P2 → 整段替换
 *   6. 再导一次 P2（验证幂等，不会重复插入）
 *   7. 撤销 → B 回到导入前的样子，且自己录的人还在
 *
 * 运行：node test/e2e.js
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert');

const { createApi } = require('../src/api');
const { DatabaseSync } = require('node:sqlite');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zupu-e2e-'));
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

function section(title) {
  console.log(`\n【${title}】`);
}

function open(name) {
  const dir = path.join(tmp, name);
  fs.mkdirSync(dir, { recursive: true });
  return createApi({
    filePath: path.join(dir, 'zupu.db'),
    backupDir: path.join(dir, 'backups'),
    deviceLabel: name,
  });
}

function nameMap(api) {
  const t = api.tree({});
  const m = new Map();
  for (const n of t.nodes) m.set(n.name, n.uuid);
  return { map: m, tree: t };
}

function aliveNames(api) {
  return api
    .tree({})
    .nodes.filter((n) => !(n.spouses || []).length || true)
    .map((n) => n.name)
    .sort();
}

// ─────────────────────────────────────────────────────────
section('1. A 机建库并导出初版');

const A = open('A');
const bootA = A.bootstrap();
console.log(`  设备：${bootA.deviceLabel} · 驱动：${bootA.driver} · 人数：${bootA.stats.total} · 代数：${bootA.stats.maxGen}`);
ok(bootA.stats.total >= 25, '示例家族人数 ≥ 25');
ok(bootA.stats.maxGen >= 9, '示例家族至少 9 代');

const a1 = nameMap(A);
const dcUuid = a1.map.get('张德昌');
ok(!!dcUuid, '找到锚点候选人「张德昌」');

const P1 = A.exportPackage({ rootUuid: dcUuid, remark: '初版' });
const pkg1 = JSON.parse(P1.json);
console.log(
  `  导出：${P1.summary.persons} 人（后代 ${P1.summary.descendantCount} + 配偶 ${P1.summary.spouseCount}），${Math.round(P1.summary.bytes / 1024)} KB`
);
ok(P1.summary.descendantCount > 0, '导出的后代数 > 0');
ok(pkg1.manifest.root_uuid === dcUuid, '包内 root_uuid 就是锚点');
ok(pkg1.manifest.format_version === 1, '包格式版本为 1');

// 结构校验：父子关系两端都在包内
const pkgIds = new Set(pkg1.family.person.map((p) => p.uuid));
ok(
  pkg1.family.parent_child.every((e) => pkgIds.has(e.parent_uuid) && pkgIds.has(e.child_uuid)),
  '包内父子关系两端都在包内（否则导入会触发外键错误）'
);
ok(
  pkg1.family.person_union.every(
    (u) => (!u.husband_uuid || pkgIds.has(u.husband_uuid)) && (!u.wife_uuid || pkgIds.has(u.wife_uuid))
  ),
  '包内婚姻两端都在包内'
);

// ─────────────────────────────────────────────────────────
section('2. 把 A 的库文件拷到 B 的文件夹（模拟主修文件拷到笔记本）');

const bDir = path.join(tmp, 'B');
fs.mkdirSync(bDir, { recursive: true });
const bPath = path.join(bDir, 'zupu.db');
const rawA = new DatabaseSync(path.join(tmp, 'A', 'zupu.db'));
rawA.exec(`VACUUM INTO '${bPath.replace(/'/g, "''")}'`);
rawA.close();

const B = open('B');
ok(B.bootstrap().stats.total === bootA.stats.total, 'B 与 A 的初始人数一致');
ok(
  B.bootstrap().deviceId !== bootA.deviceId,
  'B 有独立的 device_id（只拷 .db 文件，设备身份不会跟着走）'
);
ok(fs.existsSync(path.join(bDir, 'device.json')), '设备身份落在库文件旁边的 device.json');

// 万一用户是整个文件夹拷过去的，device.json 里记的主机名会对不上，自动换发身份
const devFile = path.join(bDir, 'device.json');
const fake = JSON.parse(fs.readFileSync(devFile, 'utf8'));
fake.hostname = '另一台电脑';
fs.writeFileSync(devFile, JSON.stringify(fake));
const { resolveDevice } = require('../src/db/device');
const rotated = resolveDevice({ dataDir: bDir, label: 'B' });
ok(
  rotated.device_id !== fake.device_id && rotated.rotated_from === fake.device_id,
  '整份文件夹被搬到另一台电脑时，设备身份自动换发并留下去向'
);

// ─────────────────────────────────────────────────────────
section('3. 两台各自继续录');

// A：修改备注 + 给文明补一个儿子
const aWm = nameMap(A).map.get('张文明');
A.savePerson({ uuid: aWm, surname: '张', given_name: '文明', gender: 1, alive: false, note: 'A 机补录：曾主持分房' });
const newOnA = A.addChild({
  parentUuid: aWm,
  person: { surname: '张', given_name: '承福', gender: 1, birth: { text: '嘉庆戊辰' } },
});
const fuUuid = newOnA.uuid;
console.log(`  A 新增：张承福（${fuUuid.slice(0, 8)}…，第 ${newOnA.person.gen} 代）`);
ok(newOnA.person.gen === 4, 'A 新增子嗣的代次被自动算成第 4 代');

// B：给承祖补一个儿子（导入时将被删除），并改武明的备注（将被包内容覆盖）
const bTree = nameMap(B).map;
const bCz = bTree.get('张承祖');
const newOnB = B.addChild({
  parentUuid: bCz,
  person: { surname: '张', given_name: '承新', gender: 1, birth: { text: '嘉庆辛未' } },
});
B.savePerson({ uuid: bTree.get('张武明'), surname: '张', given_name: '武明', gender: 1, alive: false, note: 'B 机写的备注，导入后应被覆盖' });
console.log(`  B 新增：张承新（本地独有，导入时应被删除）`);

// ─────────────────────────────────────────────────────────
section('4. A 重新导出这一支');

const P2 = A.exportPackage({ rootUuid: dcUuid, remark: '补录承福' });
const pkg2 = JSON.parse(P2.json);
ok(pkg2.family.person.some((p) => p.uuid === fuUuid), '新导出的包里含张承福');

// ─────────────────────────────────────────────────────────
section('5. B 选锚点导入 P2（整段替换）');

const before = B.tree({}).nodes.length;
const preview = B.importPreview({ anchorUuid: dcUuid, text: P2.json });
console.log(
  `  预检：删除 ${preview.counts.willDelete} · 新增 ${preview.counts.willInsert} · 本地独有 ${preview.counts.localOnly}`
);
ok(preview.counts.localOnly >= 1, '预检识别出本地独有的人');
ok(
  preview.localOnlyList.some((p) => p.name === '张承新'),
  '预检清单里列出了「张承新」——用户有权在确认前知道自己将失去谁'
);

const beforePersonB = B.person({ uuid: bTree.get('张武明') });
ok(beforePersonB.note.includes('B 机写的备注'), '导入前 B 的备注是 B 自己写的');

const res = B.importExecute({ anchorUuid: dcUuid, text: P2.json });
console.log(
  `  执行：删除 ${res.stats.deleted} · 新增 ${res.stats.inserted} · 覆盖 ${res.stats.overwritten} · 重挂 ${res.stats.relinked} · 解婚 ${res.stats.unionsBroken}`
);
ok(res.batchId > 0, '落了一条导入批次，可用于撤销');
ok(!!res.backupPath && fs.existsSync(res.backupPath), '执行前自动做了文件级备份');

const bAfter = nameMap(B);
ok(bAfter.map.has('张承福'), '包内新增的人已进库');
ok(!bAfter.map.has('张承新'), '本地独有的人已按默认策略删除');
ok(
  B.person({ uuid: bTree.get('张武明') }).note.includes('A 机') === false &&
    B.person({ uuid: bTree.get('张武明') }).note !== beforePersonB.note,
  '同名节点的字段被包内容覆盖（B 的备注被替换）'
);
ok(!!bAfter.map.get('李氏'), '锚点的外姓配偶仍然存活（没有被连带删除）');

// 关键：锚点以上没被动
ok(bAfter.map.get('张守拙') === a1.map.get('张守拙'), '锚点以上（始祖）没有被动');
ok(bAfter.map.get('张德明') === a1.map.get('张德明'), '锚点以上（次房）没有被动');

// 代次：承福应为第 4 代，其后代（无）不影响；绍先仍是第 5 代
const genOf = (name) => {
  const uuid = bAfter.map.get(name);
  return uuid ? B.person({ uuid }).gen : null;
};
ok(genOf('张承福') === 4, `承福代次 = 4（实际 ${genOf('张承福')}）`);
ok(genOf('张绍先') === 5, `绍先代次 = 5（实际 ${genOf('张绍先')}）`);
ok(genOf('张继宗') === 10, `继宗代次 = 10（实际 ${genOf('张继宗')}）`);

// B 的库与 A 在这一支上应完全一致
const aAfter = nameMap(A);
const branchNames = (api, rootName) => {
  const t = api.tree({ rootUuid: nameMap(api).map.get(rootName) });
  return t.nodes.map((n) => n.name).sort();
};
const aBranch = branchNames(A, '张德昌');
const bBranch = branchNames(B, '张德昌');
ok(
  aBranch.length === bBranch.length && aBranch.every((n, i) => n === bBranch[i]),
  `导入后 B 的这一支与 A 完全一致（${aBranch.length} 人）`
);

// ─────────────────────────────────────────────────────────
section('6. 同一个包再导一次（幂等性）');

const countBefore = B.tree({}).nodes.length;
const res2 = B.importExecute({ anchorUuid: dcUuid, text: P2.json });
const countAfter = B.tree({}).nodes.length;
console.log(`  第二次导入：删除 ${res2.stats.deleted} · 新增 ${res2.stats.inserted} · 人数 ${countBefore} → ${countAfter}`);
ok(countBefore === countAfter, '人数不变——包内 UUID 原样沿用，没有整支重复插入');

// ─────────────────────────────────────────────────────────
section('7. 撤销第二次导入');

B.revert({ batchId: res2.batchId });
const afterRevert = nameMap(B);
ok(afterRevert.map.has('张承福'), '撤销后仍保有第一次导入的结果');
ok(afterRevert.tree.nodes.length === countBefore, '撤销后人数回到第二次导入之前');

// ─────────────────────────────────────────────────────────
section('8. 撤销第一次导入，回到 B 自己录的状态');

const res3 = B.batches().find((b) => b.id === res.batchId);
ok(!res3.reverted, '第一次导入批次仍为有效状态');
B.revert({ batchId: res.batchId });

const bBack = nameMap(B);
ok(bBack.map.has('张承新'), 'B 自己录的「张承新」回来了');
ok(!bBack.map.has('张承福'), 'A 带来的「张承福」已移除');
ok(bBack.tree.nodes.length === before, `人数回到导入前（${before}）`);
ok(
  B.person({ uuid: bTree.get('张武明') }).note.includes('B 机写的备注'),
  '被覆盖的字段也恢复了'
);

// 代次在撤销后必须正确
const genBack = B.person({ uuid: bTree.get('张绍先') }).gen;
ok(genBack === 5, `撤销后代次仍为 5（实际 ${genBack}）`);

// ─────────────────────────────────────────────────────────
section('9. 导入非法文件时的保护');

let threw = false;
try {
  B.importPreview({ anchorUuid: dcUuid, text: '{"hello":1}' });
} catch (e) {
  threw = /PACKAGE_INVALID/.test(e.message);
}
ok(threw, '结构不完整的包被拒绝，不会写入任何数据');

threw = false;
try {
  B.importPreview({ anchorUuid: 'not-exist', text: P2.json });
} catch (e) {
  threw = /ANCHOR_NOT_FOUND/.test(e.message);
}
ok(threw, '锚点不存在时明确报错');

A.close();
B.close();

console.log(`\n${passed} 项断言全部通过。临时目录：${tmp}`);
