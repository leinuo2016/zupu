'use strict';

/**
 * 数据访问层：人物、关系、事件、树
 * ------------------------------------------------------------
 * 约定：
 *   - 所有写操作都带 device_id / updated_at / rev 自增，保证可交换、可追溯
 *   - 删除一律软删除
 *   - 代次 gen 是冗余字段，凡改动父子关系必须重算（recomputeGeneration）
 */

const crypto = require('node:crypto');
const { recomputeGeneration } = require('../core/import-replace');
const Ganzhi = require('../../renderer/ganzhi');

const uuid = () => crypto.randomUUID();
const now = () => new Date().toISOString();
const fullName = (p) => (`${p.surname || ''}${p.given_name || ''}`.trim() || '(无名)');

// ── meta ──────────────────────────────────────────────────

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

/** 首次运行：落地设备标识与堂号 */
function ensureMeta(db, { clanName, deviceLabel } = {}) {
  if (!getMeta(db, 'device_id')) setMeta(db, 'device_id', uuid());
  if (!getMeta(db, 'device_label')) setMeta(db, 'device_label', deviceLabel || '本机');
  if (!getMeta(db, 'clan_name')) setMeta(db, 'clan_name', clanName || '未命名家族');
  return {
    deviceId: getMeta(db, 'device_id'),
    deviceLabel: getMeta(db, 'device_label'),
    clanName: getMeta(db, 'clan_name'),
    rootUuid: getMeta(db, 'root_person_uuid'),
  };
}

// ── 读取 ──────────────────────────────────────────────────

function livePersons(db) {
  return db
    .prepare(
      `SELECT uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note
       FROM person WHERE deleted = 0`
    )
    .all();
}

function liveEdges(db) {
  return db
    .prepare(
      `SELECT uuid, parent_uuid, child_uuid, kind, seq, is_primary
       FROM parent_child WHERE deleted = 0 ORDER BY seq`
    )
    .all();
}

function liveUnions(db) {
  return db
    .prepare(
      `SELECT uuid, husband_uuid, wife_uuid, seq, kind, status, start_text, end_text
       FROM person_union WHERE deleted = 0`
    )
    .all();
}

/**
 * 整棵世系树（或指定子树）。
 * 一次性把全量读进内存：几千人量级下比递归查询快一个数量级，
 * 渲染层再做视口裁剪。
 */
function getTree(db, { rootUuid } = {}) {
  const persons = livePersons(db);
  const edges = liveEdges(db);
  const unions = liveUnions(db);

  const byUuid = new Map(persons.map((p) => [p.uuid, p]));
  const childrenOf = new Map();
  const parentsOf = new Map();
  for (const e of edges) {
    if (!childrenOf.has(e.parent_uuid)) childrenOf.set(e.parent_uuid, []);
    childrenOf.get(e.parent_uuid).push(e.child_uuid);
    if (!parentsOf.has(e.child_uuid)) parentsOf.set(e.child_uuid, []);
    parentsOf.get(e.child_uuid).push(e.parent_uuid);
  }

  // 子树裁剪
  let keep = null;
  if (rootUuid && byUuid.has(rootUuid)) {
    keep = new Set([rootUuid]);
    const stack = [rootUuid];
    while (stack.length) {
      const cur = stack.pop();
      for (const c of childrenOf.get(cur) || []) {
        if (!keep.has(c)) {
          keep.add(c);
          stack.push(c);
        }
      }
    }
  }

  const root = rootUuid || getMeta(db, 'root_person_uuid') || findRoots(persons, parentsOf)[0];
  const rootGen = root && byUuid.get(root) ? byUuid.get(root).gen || 1 : 1;

  const spousesOf = new Map();
  for (const u of unions) {
    for (const [a, b] of [
      [u.husband_uuid, u.wife_uuid],
      [u.wife_uuid, u.husband_uuid],
    ]) {
      if (!a || !b || !byUuid.has(a) || !byUuid.has(b)) continue;
      if (!spousesOf.has(a)) spousesOf.set(a, []);
      spousesOf.get(a).push({ uuid: b, ...byUuid.get(b), unionUuid: u.uuid, seq: u.seq, kind: u.kind });
    }
  }

  const nodes = persons
    .filter((p) => !keep || keep.has(p.uuid))
    .map((p) => ({
      uuid: p.uuid,
      name: fullName(p),
      surname: p.surname,
      given_name: p.given_name,
      gen: p.gen,
      relGen: p.gen == null ? null : p.gen - rootGen + 1,
      gender: p.gender,
      alive: p.alive,
      note: p.note,
      childCount: (childrenOf.get(p.uuid) || []).length,
      spouses: (spousesOf.get(p.uuid) || []).map((s) => ({
        uuid: s.uuid,
        name: fullName(s),
        gender: s.gender,
        alive: s.alive,
      })),
    }));

  const keptEdges = edges
    .filter((e) => byUuid.has(e.parent_uuid) && byUuid.has(e.child_uuid))
    .filter((e) => !keep || (keep.has(e.parent_uuid) && keep.has(e.child_uuid)))
    .map((e) => ({
      parent: e.parent_uuid,
      child: e.child_uuid,
      kind: e.kind,
      seq: e.seq,
      isPrimary: e.is_primary,
    }));

  const roots = findRoots(
    nodes.map((n) => ({ uuid: n.uuid })),
    new Map([...parentsOf].filter(([k]) => byUuid.has(k)))
  );

  return { rootUuid: root || null, nodes, edges: keptEdges, roots, total: persons.length };
}

function findRoots(persons, parentsOf) {
  return persons
    .filter((p) => {
      const ps = parentsOf.get(p.uuid);
      return !ps || ps.length === 0;
    })
    .map((p) => p.uuid);
}

/** 单人完整档案：称谓、事件、婚配、父母、子嗣 */
function getPerson(db, personUuid) {
  const p = db.prepare('SELECT * FROM person WHERE uuid = ? AND deleted = 0').get(personUuid);
  if (!p) return null;

  const nameRow = (u) => {
    const r = db.prepare('SELECT surname, given_name FROM person WHERE uuid = ?').get(u);
    return r ? fullName(r) : '(已删)';
  };

  const names = db
    .prepare('SELECT uuid, kind, value, seq FROM person_name WHERE person_uuid = ? AND deleted = 0 ORDER BY kind, seq')
    .all(personUuid);

  const events = db
    .prepare(
      `SELECT uuid, type, time_text, time_start, time_end, time_ganzhi, precision, place, description
       FROM person_event WHERE person_uuid = ? AND deleted = 0 ORDER BY type`
    )
    .all(personUuid);

  const unions = db
    .prepare(
      `SELECT uuid, husband_uuid, wife_uuid, seq, kind, status, start_text, end_text
       FROM person_union WHERE deleted = 0 AND (husband_uuid = ? OR wife_uuid = ?) ORDER BY seq`
    )
    .all(personUuid, personUuid)
    .map((u) => {
      const other = u.husband_uuid === personUuid ? u.wife_uuid : u.husband_uuid;
      return { ...u, spouseUuid: other, spouseName: other ? nameRow(other) : '（未记）' };
    });

  const parents = db
    .prepare(
      `SELECT uuid, parent_uuid, kind, is_primary FROM parent_child
       WHERE child_uuid = ? AND deleted = 0`
    )
    .all(personUuid)
    .map((e) => ({ ...e, name: nameRow(e.parent_uuid) }));

  const children = db
    .prepare(
      `SELECT uuid, child_uuid, kind, seq, is_primary FROM parent_child
       WHERE parent_uuid = ? AND deleted = 0 ORDER BY seq`
    )
    .all(personUuid)
    .map((e) => {
      const c = db.prepare('SELECT gen, gender, alive FROM person WHERE uuid = ?').get(e.child_uuid);
      return { ...e, name: nameRow(e.child_uuid), gen: c ? c.gen : null, gender: c ? c.gender : 0 };
    });

  const eventOf = (type) => events.find((e) => e.type === type) || {};

  // 老数据（或从别处导入的谱）可能只填了原文「乾隆壬寅」，
  // 读的时候把年份和干支顺手补出来，但绝不写回库——推算值不能冒充实录。
  const timeOf = (type) => {
    const e = eventOf(type);
    return {
      text: e.time_text || '',
      year: e.time_start ?? Ganzhi.findYear(e.time_text),
      ganzhi: e.time_ganzhi || Ganzhi.findGanzhi(e.time_text) || '',
      place: e.place || '',
    };
  };

  return {
    uuid: p.uuid,
    name: fullName(p),
    surname: p.surname || '',
    given_name: p.given_name || '',
    gen_char: p.gen_char || '',
    gender: p.gender,
    alive: p.alive,
    gen: p.gen,
    genLabel: Ganzhi.shiLabelFull(p.gen),
    branch_id: p.branch_id || '',
    note: p.note || '',
    photo: p.photo || null,
    // 三样都留着：原文是史料，年份便于排序统计，干支是谱上印的那两个字
    birth: timeOf('生'),
    death: timeOf('卒'),
    burial: { place: eventOf('葬').place || '' },
    names,
    events,
    unions,
    parents,
    children,
  };
}

// ── 写入 ──────────────────────────────────────────────────

/**
 * 照片大小上限（base64 字符串长度）。SQLite 存几 MB 没问题，
 * 但整个库要靠 .zupu 包在电脑间拷来拷去，放任 4K 原图入库，
 * 三十个人就能把包撑到上百 MB。前端上传前会先压一版，这里是最后防线。
 */
const PHOTO_MAX_LEN = 4 * 1024 * 1024; // 约 3MB 原图

function setPhoto(db, personUuid, dataUrl) {
  const p = db.prepare('SELECT uuid FROM person WHERE uuid = ? AND deleted = 0').get(personUuid);
  if (!p) throw new Error('人物不存在或已删除');

  let value = null;
  if (dataUrl != null && dataUrl !== '') {
    const s = String(dataUrl);
    if (!/^data:image\/(png|jpeg|jpg|gif|webp);base64,[A-Za-z0-9+/=]+$/.test(s)) {
      throw new Error('照片格式不对：只收 png / jpg / gif / webp 的 base64 图片');
    }
    if (s.length > PHOTO_MAX_LEN) {
      throw new Error(`照片太大（约 ${Math.round(s.length * 0.75 / 1024 / 1024 * 10) / 10} MB）。上限 3 MB，请压一压再传`);
    }
    value = s;
  }

  db.prepare('UPDATE person SET photo = ?, updated_at = ?, rev = rev + 1 WHERE uuid = ?').run(
    value,
    now(),
    personUuid
  );
  return value;
}

function touchPerson(db, personUuid) {
  db.prepare('UPDATE person SET updated_at = ?, rev = rev + 1 WHERE uuid = ?').run(now(), personUuid);
}

/**
 * 保存人物。uuid 为空即新建。
 * 生 / 卒 / 葬 三类事件同步维护：有值则建，清空则软删。
 */
function savePerson(db, payload) {
  const deviceId = getMeta(db, 'device_id') || 'unknown';
  const t = now();
  const isNew = !payload.uuid;

  const run = db.transaction(() => {
    let personUuid = payload.uuid;
    if (isNew) {
      personUuid = uuid();
      db.prepare(
        `INSERT INTO person
         (uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note,
          device_id, created_at, updated_at, rev, deleted)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
      ).run(
        personUuid,
        payload.branch_id || null,
        payload.gen ?? null,
        payload.gender ?? 0,
        payload.alive ? 1 : 0,
        payload.surname || null,
        payload.given_name || null,
        payload.gen_char || null,
        payload.note || null,
        deviceId,
        t,
        t
      );
    } else {
      db.prepare(
        `UPDATE person SET
           branch_id = ?, gender = ?, alive = ?, surname = ?, given_name = ?,
           gen_char = ?, note = ?, updated_at = ?, rev = rev + 1
         WHERE uuid = ? AND deleted = 0`
      ).run(
        payload.branch_id || null,
        payload.gender ?? 0,
        payload.alive ? 1 : 0,
        payload.surname || null,
        payload.given_name || null,
        payload.gen_char || null,
        payload.note || null,
        t,
        personUuid
      );
    }

    setEvent(db, personUuid, '生', payload.birth, deviceId, t);
    setEvent(db, personUuid, '卒', payload.death, deviceId, t);
    setEvent(db, personUuid, '葬', { place: payload.burial && payload.burial.place }, deviceId, t);

    return personUuid;
  });

  return run();
}

/**
 * 事件写入。生 / 卒 / 葬 三种时间都走这里。
 * 年份与干支不是二选一：原文（time_text）、公元年（time_start）、干支（time_ganzhi）
 * 三个字段各存各的，谁也不能覆盖谁——老谱只有干支，新录只有年份，两种都得能检索。
 */
function setEvent(db, personUuid, type, data, deviceId, t) {
  if (!data) return;
  const time = Ganzhi.normalize(data);
  const place = (data.place || '').trim();
  const hasTime = !!(time.text || time.year != null || time.ganzhi);

  const existing = db
    .prepare(
      `SELECT uuid FROM person_event WHERE person_uuid = ? AND type = ? AND deleted = 0 LIMIT 1`
    )
    .get(personUuid, type);

  if (!hasTime && !place) {
    if (existing) {
      db.prepare('UPDATE person_event SET deleted = 1, updated_at = ?, rev = rev + 1 WHERE uuid = ?').run(t, existing.uuid);
    }
    return;
  }

  if (existing) {
    db.prepare(
      `UPDATE person_event SET time_text = ?, time_start = ?, time_ganzhi = ?, place = ?,
              updated_at = ?, rev = rev + 1
       WHERE uuid = ?`
    ).run(time.text || null, time.year, time.ganzhi || null, place || null, t, existing.uuid);
  } else {
    db.prepare(
      `INSERT INTO person_event
       (uuid, person_uuid, type, time_text, time_start, time_ganzhi, place, precision,
        device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
    ).run(
      uuid(),
      personUuid,
      type,
      time.text || null,
      time.year,
      time.ganzhi || null,
      place || null,
      null,
      deviceId,
      t,
      t
    );
  }
}

/** 新增子嗣：建人 + 建边 + 重算本支代次 */
function addChild(db, { parentUuid, person, kind = '生' }) {
  const deviceId = getMeta(db, 'device_id') || 'unknown';
  const parent = db.prepare('SELECT * FROM person WHERE uuid = ? AND deleted = 0').get(parentUuid);
  if (!parent) throw new Error('PARENT_NOT_FOUND');

  const t = now();
  const run = db.transaction(() => {
    const childUuid = uuid();
    db.prepare(
      `INSERT INTO person
       (uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note,
        device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
    ).run(
      childUuid,
      parent.branch_id || null,
      (parent.gen || 1) + 1,
      person.gender ?? 1,
      person.alive === false ? 0 : 1,
      person.surname || parent.surname || null,
      person.given_name || null,
      person.gen_char || null,
      person.note || null,
      deviceId,
      t,
      t
    );

    const seqRow = db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM parent_child WHERE parent_uuid = ?')
      .get(parentUuid);
    db.prepare(
      `INSERT INTO parent_child
       (uuid, parent_uuid, child_uuid, kind, seq, is_primary, device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, 1, 0)`
    ).run(uuid(), parentUuid, childUuid, kind, (seqRow.m || 0) + 1, deviceId, t, t);

    // 迷你表单里填的生年不能丢：之前这里漏了 setEvent，
    // 用户填了「乾隆壬寅」保存后，档案里却是空的。
    setEvent(db, childUuid, '生', person.birth, deviceId, t);

    // 代次必须重算：只挂关系不重算，按代次检索与分卷印谱会全错
    recomputeGeneration(db, parentUuid, t);
    return childUuid;
  });

  return run();
}

/** 新增配偶：建人 + 建婚配关系 */
function addSpouse(db, { personUuid, person, kind = '嫡', seq }) {
  const deviceId = getMeta(db, 'device_id') || 'unknown';
  const p = db.prepare('SELECT * FROM person WHERE uuid = ? AND deleted = 0').get(personUuid);
  if (!p) throw new Error('PERSON_NOT_FOUND');

  const t = now();
  const run = db.transaction(() => {
    const spouseUuid = uuid();
    const spouseGender = person.gender ?? (p.gender === 2 ? 1 : 2);
    db.prepare(
      `INSERT INTO person
       (uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note,
        device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
    ).run(
      spouseUuid,
      null, // 配偶不归属本支房次：替换本支时不能把她一起删掉
      p.gen,
      spouseGender,
      person.alive === false ? 0 : 1,
      person.surname || null,
      person.given_name || null,
      null,
      person.note || null,
      deviceId,
      t,
      t
    );

    const seqRow = db
      .prepare(
        `SELECT COALESCE(MAX(seq), 0) AS m FROM person_union
         WHERE husband_uuid = ? OR wife_uuid = ?`
      )
      .get(personUuid, personUuid);

    const husband = spouseGender === 1 ? spouseUuid : personUuid;
    const wife = spouseGender === 1 ? personUuid : spouseUuid;

    db.prepare(
      `INSERT INTO person_union
       (uuid, husband_uuid, wife_uuid, seq, kind, status, device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, '婚姻', ?, ?, ?, 1, 0)`
    ).run(uuid(), husband, wife, seq ?? (seqRow.m || 0) + 1, kind, deviceId, t, t);

    setEvent(db, spouseUuid, '生', person.birth, deviceId, t);

    return spouseUuid;
  });

  return run();
}

/**
 * 某节点的整棵子树（含自己）。
 * 用递归 CTE 一次算完：几千人量级下比在 JS 里逐层展开简单也更稳。
 */
function subtreeUuids(db, rootUuid) {
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(uuid) AS (
         SELECT ?
         UNION
         SELECT pc.child_uuid FROM parent_child pc
           JOIN sub ON pc.parent_uuid = sub.uuid
          WHERE pc.deleted = 0
       )
       SELECT uuid FROM sub`
    )
    .all(rootUuid);
  return rows.map((r) => r.uuid);
}

/**
 * 删除前的影响预览。界面上要先把「会失去谁」摆出来，
 * 再让人点确认——这是唯一能防住误删的办法。
 */
function deletePreview(db, personUuid) {
  const p = db.prepare('SELECT uuid, surname, given_name, gen FROM person WHERE uuid = ? AND deleted = 0').get(personUuid);
  if (!p) throw new Error('PERSON_NOT_FOUND');

  const ids = subtreeUuids(db, personUuid);
  const idSet = new Set(ids);

  const rows = db
    .prepare(
      `SELECT uuid, surname, given_name, gen FROM person WHERE deleted = 0
       AND uuid IN (SELECT value FROM json_each(?))
       ORDER BY gen, surname, given_name`
    )
    .all(JSON.stringify(ids));

  // 配偶：只解婚，不删人。若对方不在删除范围内，本人仍留在别支的谱里。
  const unions = db
    .prepare(
      `SELECT uuid, husband_uuid, wife_uuid FROM person_union WHERE deleted = 0
       AND (husband_uuid IN (SELECT value FROM json_each(?))
         OR wife_uuid IN (SELECT value FROM json_each(?)))`
    )
    .all(JSON.stringify(ids), JSON.stringify(ids));

  const outside = new Set();
  for (const u of unions) {
    for (const other of [u.husband_uuid, u.wife_uuid]) {
      if (other && !idSet.has(other)) outside.add(other);
    }
  }
  const externalSpouses = [...outside].map((u) => {
    const r = db.prepare('SELECT surname, given_name FROM person WHERE uuid = ?').get(u);
    return r ? fullName(r) : '(已删)';
  });

  return {
    person: fullName(p),
    gen: p.gen,
    genLabel: Ganzhi.shiLabelFull(p.gen),
    total: ids.length,
    descendants: ids.length - 1,
    unionsBroken: unions.length,
    externalSpouses,
    names: rows.slice(0, 12).map((r) => fullName(r)),
  };
}

/**
 * 软删除人物。
 * cascade = true（默认）：连同全部后代一起删——父辈没了、子嗣还挂在树上会变成孤儿根节点，
 *                          看起来像「多出一支无祖之家」，比删掉更让人困惑。
 * cascade = false：只删本人，子嗣变为无父（一般只在「录错了一个空节点」时用）。
 * 外支配偶一律只解除婚姻关系，绝不删人：删了别支的谱就缺人了。
 */
function removePerson(db, personUuid, { cascade = true } = {}) {
  const t = now();
  const run = db.transaction(() => {
    const ids = cascade ? subtreeUuids(db, personUuid) : [personUuid];
    const idsJson = JSON.stringify(ids);

    const inIds = `IN (SELECT value FROM json_each(?))`;

    const unions = db
      .prepare(
        `SELECT husband_uuid, wife_uuid FROM person_union WHERE deleted = 0
         AND (husband_uuid ${inIds} OR wife_uuid ${inIds})`
      )
      .all(idsJson, idsJson);

    db.prepare(
      `UPDATE person_event SET deleted = 1, updated_at = ?, rev = rev + 1
       WHERE deleted = 0 AND person_uuid ${inIds}`
    ).run(t, idsJson);
    db.prepare(
      `UPDATE person_name SET deleted = 1, updated_at = ?, rev = rev + 1
       WHERE deleted = 0 AND person_uuid ${inIds}`
    ).run(t, idsJson);
    db.prepare(
      `UPDATE person_union SET deleted = 1, updated_at = ?, rev = rev + 1
       WHERE deleted = 0 AND (husband_uuid ${inIds} OR wife_uuid ${inIds})`
    ).run(t, idsJson, idsJson);
    db.prepare(
      `UPDATE parent_child SET deleted = 1, updated_at = ?, rev = rev + 1
       WHERE deleted = 0 AND (parent_uuid ${inIds} OR child_uuid ${inIds})`
    ).run(t, idsJson, idsJson);
    db.prepare(
      `UPDATE person SET deleted = 1, updated_at = ?, rev = rev + 1
       WHERE deleted = 0 AND uuid ${inIds}`
    ).run(t, idsJson);

    const idSet = new Set(ids);
    let external = 0;
    for (const u of unions) {
      if ((u.husband_uuid && !idSet.has(u.husband_uuid)) || (u.wife_uuid && !idSet.has(u.wife_uuid))) {
        external += 1;
      }
    }

    return { removed: ids.length, unionsBroken: unions.length, externalSpouses: external };
  });
  return run();
}

function stats(db) {
  const one = (sql, ...args) => {
    const r = db.prepare(sql).get(...args);
    return r ? Object.values(r)[0] || 0 : 0;
  };
  return {
    total: one('SELECT COUNT(*) AS c FROM person WHERE deleted = 0'),
    male: one('SELECT COUNT(*) AS c FROM person WHERE deleted = 0 AND gender = 1'),
    female: one('SELECT COUNT(*) AS c FROM person WHERE deleted = 0 AND gender = 2'),
    maxGen: one('SELECT COALESCE(MAX(gen), 0) AS c FROM person WHERE deleted = 0'),
    unions: one('SELECT COUNT(*) AS c FROM person_union WHERE deleted = 0'),
  };
}

/** 导入批次列表，供「撤销上一次导入」 */
function listBatches(db, limit = 10) {
  return db
    .prepare(
      `SELECT id, package_id, source_device, exported_at, anchor_uuid, new_root_uuid,
              imported_at, stats_json, reverted
       FROM import_batch ORDER BY id DESC LIMIT ?`
    )
    .all(limit)
    .map((b) => ({
      ...b,
      stats: b.stats_json ? JSON.parse(b.stats_json) : null,
    }));
}

module.exports = {
  uuid,
  now,
  fullName,
  getMeta,
  setMeta,
  ensureMeta,
  getTree,
  getPerson,
  savePerson,
  addChild,
  addSpouse,
  removePerson,
  deletePreview,
  setPhoto,
  subtreeUuids,
  stats,
  listBatches,
  touchPerson,
};
