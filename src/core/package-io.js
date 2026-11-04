'use strict';

/**
 * 记谱包（.zupu）读写
 * ------------------------------------------------------------
 * 格式：当前为纯 JSON 文本，manifest + family 两段。
 *   —— 之所以先不用 zip：JSON 可人工核对、可 diff、可直接丢进 git 存档，
 *      几千人规模下体积也只有几 MB。等要放老照片附件时再切 zip，
 *      靠 manifest.format_version 区分，不影响老包读取。
 *
 * 导出范围（重要）：
 *   锚点及其全部后代 + 这些人的配偶（含外姓、外支）。
 *   配偶必须一起带走，否则导入时婚配记录指向不存在的人，
 *   外键约束会直接让整次导入失败。
 */

const crypto = require('node:crypto');

const FORMAT_VERSION = 1;

const nodeUuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const nameOf = (p) => (`${p.surname || ''}${p.given_name || ''}`.trim() || '(无名)');

const PERSON_COLS = [
  'uuid', 'branch_id', 'gen', 'gender', 'alive', 'surname', 'given_name', 'gen_char', 'note', 'photo',
  'device_id', 'created_at', 'updated_at', 'rev', 'deleted',
];
const NAME_COLS = ['uuid', 'person_uuid', 'kind', 'value', 'seq', 'device_id', 'created_at', 'updated_at', 'rev', 'deleted'];
const UNION_COLS = ['uuid', 'husband_uuid', 'wife_uuid', 'seq', 'kind', 'status',
  'start_text', 'start_year', 'end_text', 'end_year', 'device_id', 'created_at', 'updated_at', 'rev', 'deleted'];
const PC_COLS = ['uuid', 'parent_uuid', 'child_uuid', 'kind', 'seq', 'is_primary',
  'device_id', 'created_at', 'updated_at', 'rev', 'deleted'];
const EVENT_COLS = ['uuid', 'person_uuid', 'type', 'time_text', 'time_start', 'time_end',
  'precision', 'place', 'description', 'device_id', 'created_at', 'updated_at', 'rev', 'deleted'];

function pick(row, cols) {
  const out = {};
  for (const c of cols) out[c] = row[c] === undefined ? null : row[c];
  return out;
}

/**
 * 从本地库导出一支。
 * @param {object} db
 * @param {{rootUuid:string, remark?:string, mode?:'subtree'|'full'}} opts
 */
function buildPackage(db, { rootUuid, remark = '', mode = 'subtree' }) {
  const meta = (k) => {
    const r = db.prepare('SELECT value FROM meta WHERE key = ?').get(k);
    return r ? r.value : '';
  };

  const root = db.prepare('SELECT * FROM person WHERE uuid = ? AND deleted = 0').get(rootUuid);
  if (!root) throw new Error('ROOT_NOT_FOUND: 要导出的节点不存在');

  // 1. 后代闭包
  const included = new Set([rootUuid]);
  const edges = db
    .prepare('SELECT * FROM parent_child WHERE deleted = 0 ORDER BY seq')
    .all();
  const childrenOf = new Map();
  for (const e of edges) {
    if (!childrenOf.has(e.parent_uuid)) childrenOf.set(e.parent_uuid, []);
    childrenOf.get(e.parent_uuid).push(e.child_uuid);
  }
  const stack = [rootUuid];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of childrenOf.get(cur) || []) {
      if (!included.has(c)) {
        included.add(c);
        stack.push(c);
      }
    }
  }
  const descendantCount = included.size;

  // 2. 配偶一并带走（只带一层，避免把整个别支拖进来）
  const unionsAll = db.prepare('SELECT * FROM person_union WHERE deleted = 0 ORDER BY seq').all();
  for (const u of unionsAll) {
    for (const [a, b] of [
      [u.husband_uuid, u.wife_uuid],
      [u.wife_uuid, u.husband_uuid],
    ]) {
      if (a && b && included.has(a) && !included.has(b)) {
        const exists = db.prepare('SELECT 1 FROM person WHERE uuid = ? AND deleted = 0').get(b);
        if (exists) included.add(b);
      }
    }
  }

  const inList = JSON.stringify([...included]);
  const q = (sql) => db.prepare(sql).all(inList);

  const persons = q(
    `SELECT * FROM person WHERE deleted = 0 AND uuid IN (SELECT value FROM json_each(?))`
  ).map((r) => pick(r, PERSON_COLS));

  const names = q(
    `SELECT * FROM person_name WHERE deleted = 0 AND person_uuid IN (SELECT value FROM json_each(?))`
  ).map((r) => pick(r, NAME_COLS));

  const events = q(
    `SELECT * FROM person_event WHERE deleted = 0 AND person_uuid IN (SELECT value FROM json_each(?))`
  ).map((r) => pick(r, EVENT_COLS));

  const unions = unionsAll
    .filter(
      (u) =>
        (u.husband_uuid && included.has(u.husband_uuid)) ||
        (u.wife_uuid && included.has(u.wife_uuid))
    )
    .filter((u) => {
      // 两端都得在包内，否则导入时外键会指向不存在的人
      const h = !u.husband_uuid || included.has(u.husband_uuid);
      const w = !u.wife_uuid || included.has(u.wife_uuid);
      return h && w;
    })
    .map((r) => pick(r, UNION_COLS));

  const parentChild = edges
    .filter((e) => included.has(e.parent_uuid) && included.has(e.child_uuid))
    .map((r) => pick(r, PC_COLS));

  const pkg = {
    manifest: {
      format_version: FORMAT_VERSION,
      package_id: nodeUuid(),
      app_version: '0.1.0',
      device_id: meta('device_id'),
      device_label: meta('device_label') || '未知设备',
      clan_name: meta('clan_name'),
      exported_at: nowIso(),
      root_uuid: rootUuid,
      root_name: nameOf(root),
      mode: mode === 'full' ? 'full' : 'subtree',
      counts: {
        person: persons.length,
        person_name: names.length,
        person_union: unions.length,
        parent_child: parentChild.length,
        person_event: events.length,
      },
      remark: remark || '',
    },
    family: {
      person: persons,
      person_name: names,
      person_union: unions,
      parent_child: parentChild,
      person_event: events,
    },
  };

  return { pkg, descendantCount, spouseCount: included.size - descendantCount };
}

/** 导出为可下载/可保存的文本 */
function serialize(pkg) {
  return JSON.stringify(pkg, null, 2);
}

function defaultFileName(pkg) {
  const clan = (pkg.manifest.clan_name || '族谱').replace(/[\\/:*?"<>|]/g, '');
  const root = (pkg.manifest.root_name || '一支').replace(/[\\/:*?"<>|]/g, '');
  const d = new Date();
  const stamp = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
  return `${clan}-${root}-${stamp}.zupu`;
}

/**
 * 解析并做结构校验。宁可在这里拦住，也不要让半坏的数据进库。
 * @returns {{pkg, summary}}
 */
function parsePackage(text) {
  let pkg;
  try {
    pkg = typeof text === 'string' ? JSON.parse(text) : text;
  } catch (e) {
    throw new Error('FILE_NOT_JSON: 这不是有效的记谱包文件（JSON 解析失败）');
  }

  const problems = [];
  // 兼容「外面套了一层 manifest/family」和「直接给 manifest/family 的 JSON」两种写法
  if (!pkg || typeof pkg !== 'object') problems.push('文件内容为空');
  if (pkg && !pkg.manifest && pkg.Manifest) pkg.manifest = pkg.Manifest;
  if (!pkg.manifest) problems.push('缺少 manifest 段');
  if (!pkg.family) problems.push('缺少 family 段');

  if (pkg.manifest) {
    const m = pkg.manifest;
    if (m.format_version !== FORMAT_VERSION) {
      problems.push(`包格式版本是 ${m.format_version}，本程序只认 ${FORMAT_VERSION}`);
    }
    if (!m.root_uuid) problems.push('manifest 缺少 root_uuid');
    if (!m.exported_at) problems.push('manifest 缺少 exported_at');
  }

  if (pkg.family) {
    if (!Array.isArray(pkg.family.person)) problems.push('family.person 不是数组');
    if (!Array.isArray(pkg.family.parent_child)) problems.push('family.parent_child 不是数组');
    if (Array.isArray(pkg.family.person) && pkg.family.person.length === 0) {
      problems.push('包里一个人都没有');
    }
  }

  if (problems.length) {
    throw new Error(`PACKAGE_INVALID: 记谱包校验未通过\n· ${problems.join('\n· ')}`);
  }

  const rootPerson = pkg.family.person.find((p) => p.uuid === pkg.manifest.root_uuid);
  if (!rootPerson) {
    throw new Error('PACKAGE_ROOT_MISSING: 包里找不到 manifest.root_uuid 对应的人物');
  }

  // 引用完整性：包内父子关系必须两端都在
  const ids = new Set(pkg.family.person.map((p) => p.uuid));
  const danglingEdges = (pkg.family.parent_child || []).filter(
    (e) => !ids.has(e.parent_uuid) || !ids.has(e.child_uuid)
  );
  const danglingUnions = (pkg.family.person_union || []).filter(
    (u) => (u.husband_uuid && !ids.has(u.husband_uuid)) || (u.wife_uuid && !ids.has(u.wife_uuid))
  );

  return {
    pkg,
    summary: {
      from: pkg.manifest.device_label || '未知设备',
      clanName: pkg.manifest.clan_name || '',
      exportedAt: pkg.manifest.exported_at,
      remark: pkg.manifest.remark || '',
      rootUuid: pkg.manifest.root_uuid,
      rootName: nameOf(rootPerson),
      rootGen: rootPerson.gen,
      persons: pkg.family.person.length,
      edges: (pkg.family.parent_child || []).length,
      unions: (pkg.family.person_union || []).length,
      danglingEdges: danglingEdges.length,
      danglingUnions: danglingUnions.length,
    },
  };
}

module.exports = {
  FORMAT_VERSION,
  buildPackage,
  serialize,
  defaultFileName,
  parsePackage,
};
