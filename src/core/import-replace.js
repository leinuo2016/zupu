'use strict';

/**
 * 族谱系统 · 整段替换导入内核
 * ------------------------------------------------------------
 * 依据已确认的决策：
 *   1. 指定节点「完整替换」——锚点及其全部后代都用包内数据取代；
 *   2. 只需更新该节点对应的父级节点的子嗣关系；
 *   3. 本地独有人员默认删除；
 *   4. 不考虑两台机器各建一次的重复合并。
 *
 * 因此不存在「冲突裁决」：导入结果完全由包内容决定，可预测、可回放、可精确撤销。
 *
 * 依赖：better-sqlite3（Electron 主进程标准选择）
 * 用法：
 *   const R = require('./import-replace');
 *   const report = R.previewReplace(db, anchorUuid, pkg);   // 预检，不动数据
 *   const result = R.executeReplace(db, anchorUuid, pkg);   // 执行，单事务
 *   R.revertBatch(db, result.batchId);                      // 精确撤销
 */

const crypto = require('node:crypto');

const newUuid = () => crypto.randomUUID();
const nowIso = () => new Date().toISOString();
const nameOf = (p) => (`${p.surname || ''}${p.given_name || ''}`.trim() || '(无名)');

// ── meta 读写 ─────────────────────────────────────────────

function getMeta(db, key) {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMeta(db, key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// ── 收集范围 ──────────────────────────────────────────────

/**
 * 收集锚点及其全部下游节点（含嗣子、兼祧产生的多父情形）。
 *
 * externalSpouses 刻意不并入 core：
 * 本支祖先娶了别支女子，若连人一起删，别支的谱里她就凭空消失了。
 * 外部配偶只解除婚姻关系，本人保留。
 */
function collectLocalSubtree(db, anchorUuid) {
  const core = new Set([anchorUuid]);

  const childStmt = db.prepare(
    'SELECT child_uuid FROM parent_child WHERE parent_uuid = ? AND deleted = 0'
  );
  const stack = [anchorUuid];
  while (stack.length) {
    const cur = stack.pop();
    for (const row of childStmt.all(cur)) {
      if (!core.has(row.child_uuid)) {
        core.add(row.child_uuid);
        stack.push(row.child_uuid);
      }
    }
  }

  const unionStmt = db.prepare(
    `SELECT uuid, husband_uuid, wife_uuid FROM person_union
     WHERE deleted = 0 AND (husband_uuid = ? OR wife_uuid = ?)`
  );
  const externalSpouses = new Set();
  for (const uuid of [...core]) {
    for (const u of unionStmt.all(uuid, uuid)) {
      for (const spouse of [u.husband_uuid, u.wife_uuid]) {
        if (spouse && !core.has(spouse)) externalSpouses.add(spouse);
      }
    }
  }

  return { core, externalSpouses };
}

/** 包内子树：以 manifest.root_uuid 为根，沿包内 parent_child 向下 */
function collectPackageSubtree(pkg, rootUuid) {
  const set = new Set([rootUuid]);
  const childrenOf = new Map();
  for (const pc of pkg.family.parent_child || []) {
    if (pc.deleted) continue;
    if (!childrenOf.has(pc.parent_uuid)) childrenOf.set(pc.parent_uuid, []);
    childrenOf.get(pc.parent_uuid).push(pc.child_uuid);
  }
  const stack = [rootUuid];
  while (stack.length) {
    const cur = stack.pop();
    for (const c of childrenOf.get(cur) || []) {
      if (!set.has(c)) {
        set.add(c);
        stack.push(c);
      }
    }
  }
  return set;
}

// ── 预检 ──────────────────────────────────────────────────

/**
 * 只算不动。默认删除本地独有人员，但仍必须把名单列出来——
 * 用户有权在按下确认之前，看清自己将失去哪些人。
 */
function previewReplace(db, anchorUuid, pkg) {
  const anchor = db.prepare('SELECT * FROM person WHERE uuid = ? AND deleted = 0').get(anchorUuid);
  if (!anchor) throw new Error('ANCHOR_NOT_FOUND: 指定的节点在本地不存在或已被删除');
  if (!pkg || !pkg.manifest || !pkg.manifest.root_uuid) {
    throw new Error('PACKAGE_INVALID: 缺少 manifest.root_uuid');
  }

  const pkgRootUuid = pkg.manifest.root_uuid;
  const pkgRoot = (pkg.family.person || []).find((p) => p.uuid === pkgRootUuid);
  if (!pkgRoot) throw new Error('PACKAGE_ROOT_MISSING: 包内找不到根节点对应的记录');

  const { core, externalSpouses } = collectLocalSubtree(db, anchorUuid);
  const pkgSet = collectPackageSubtree(pkg, pkgRootUuid);

  const localOnly = [...core].filter((u) => !pkgSet.has(u));
  const pkgOnly = [...pkgSet].filter((u) => !core.has(u));

  const fetchName = (uuid) => {
    const p = db.prepare('SELECT surname, given_name FROM person WHERE uuid = ?').get(uuid);
    return p ? nameOf(p) : '(已删)';
  };

  const warnings = [];

  const localName = nameOf(anchor);
  const pkgName = nameOf(pkgRoot);
  if (localName !== '(无名)' && pkgName !== '(无名)' && localName !== pkgName) {
    warnings.push(`包内根节点是「${pkgName}」，本地指定节点是「${localName}」——姓名不同，请确认没有选错节点`);
  }
  if (anchor.gen != null && pkgRoot.gen != null && anchor.gen !== pkgRoot.gen) {
    warnings.push(`代次不同（本地第 ${anchor.gen} 代 / 包内第 ${pkgRoot.gen} 代），替换后将以父节点为基准重算`);
  }
  if (localOnly.length > 0) {
    warnings.push(`本地有 ${localOnly.length} 人在包内不存在，将被删除（可在下方清单中核对）`);
  }
  if (externalSpouses.size > 0) {
    warnings.push(`有 ${externalSpouses.size} 位外支配偶，只解除婚姻关系、不删除本人`);
  }

  return {
    anchor: { uuid: anchorUuid, name: localName, gen: anchor.gen },
    newRoot: { uuid: pkgRootUuid, name: pkgName, gen: pkgRoot.gen },
    counts: {
      willDelete: core.size,
      willInsert: pkgOnly.length,
      willOverwrite: core.size - localOnly.length,
      localOnly: localOnly.length,
      externalSpouses: externalSpouses.size,
    },
    localOnlyList: localOnly.slice(0, 100).map((u) => ({ uuid: u, name: fetchName(u) })),
    externalSpouseList: [...externalSpouses].slice(0, 100).map((u) => ({ uuid: u, name: fetchName(u) })),
    warnings,
    package: {
      from: pkg.manifest.device_label || pkg.manifest.device_id || '未知来源',
      exportedAt: pkg.manifest.exported_at || '',
      remark: pkg.manifest.remark || '',
    },
  };
}

// ── 执行 ──────────────────────────────────────────────────

/** 从属表列定义：显式声明，避免依赖包内字段顺序 */
const COMPANION = {
  person_name: ['uuid', 'person_uuid', 'kind', 'value', 'seq', 'device_id', 'created_at', 'updated_at', 'rev', 'deleted'],
  person_union: ['uuid', 'husband_uuid', 'wife_uuid', 'seq', 'kind', 'status',
    'start_text', 'start_year', 'end_text', 'end_year', 'device_id', 'created_at', 'updated_at', 'rev', 'deleted'],
  parent_child: ['uuid', 'parent_uuid', 'child_uuid', 'kind', 'seq', 'is_primary',
    'device_id', 'created_at', 'updated_at', 'rev', 'deleted'],
  person_event: ['uuid', 'person_uuid', 'type', 'time_text', 'time_start', 'time_end',
    'precision', 'place', 'description', 'device_id', 'created_at', 'updated_at', 'rev', 'deleted'],
};

/** 各从属表里指向人物的外键列 */
const FK_COLS = {
  person_union: ['husband_uuid', 'wife_uuid'],
  parent_child: ['parent_uuid', 'child_uuid'],
  person_name: ['person_uuid'],
  person_event: ['person_uuid'],
};

/**
 * 抓取将被本次导入改动的原始行。
 * 人物 + 其称谓/婚姻/亲子/事件，全部按原样存一份 JSON。
 * 千人规模的支系大约几十 KB，比数据丢失便宜得多。
 */
function captureBeforeImage(db, core) {
  const ids = JSON.stringify([...core]);
  const inIds = (cols) => cols.map((c) => `${c} IN (SELECT value FROM json_each(?))`).join(' OR ');
  const image = {
    person: db
      .prepare('SELECT * FROM person WHERE deleted = 0 AND uuid IN (SELECT value FROM json_each(?))')
      .all(ids),
  };
  for (const [table, cols] of Object.entries(FK_COLS)) {
    image[table] = db.prepare(`SELECT * FROM ${table} WHERE deleted = 0 AND (${inIds(cols)})`).all(ids);
  }
  return image;
}

/** 按原样写回一行：已存在就整行覆盖，不存在就补插 */
function restoreRows(db, table, rows) {
  if (!Array.isArray(rows) || rows.length === 0) return 0;
  const cols = Object.keys(rows[0]);
  const update = db.prepare(
    `UPDATE ${table} SET ${cols.filter((c) => c !== 'uuid').map((c) => `${c} = @${c}`).join(', ')} WHERE uuid = @uuid`
  );
  const insert = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')}) VALUES (${cols.map((c) => '@' + c).join(', ')})`
  );

  let n = 0;
  for (const row of rows) {
    const params = {};
    for (const c of cols) params[c] = row[c] === undefined ? null : row[c];
    const info = update.run(params);
    if (!info.changes) insert.run(params);
    n += 1;
  }
  return n;
}

/**
 * 整段替换。全程单事务，任何一步失败自动回滚。
 *
 * UUID 策略：一律采用包内 UUID。
 *   新锚点 UUID = manifest.root_uuid；父节点的子嗣关系重挂到新 UUID。
 *   绝不给包内节点重新生成 UUID——否则同一个包再导一次会整支重复插入。
 */
function executeReplace(db, anchorUuid, pkg, options = {}) {
  const now = nowIso();
  const deviceId = getMeta(db, 'device_id') || 'unknown';
  const pkgRootUuid = pkg.manifest.root_uuid;
  const pkgRoot = (pkg.family.person || []).find((p) => p.uuid === pkgRootUuid);
  if (!pkgRoot) throw new Error('PACKAGE_ROOT_MISSING');

  const { core, externalSpouses } = collectLocalSubtree(db, anchorUuid);
  const pkgSet = collectPackageSubtree(pkg, pkgRootUuid);

  // 锚点的父必须落在 core 之外，否则会被一起删掉，导致新支悬空
  const anchorParents = db
    .prepare('SELECT * FROM parent_child WHERE child_uuid = ? AND deleted = 0')
    .all(anchorUuid)
    .filter((pc) => !core.has(pc.parent_uuid));

  const stats = { deleted: 0, inserted: 0, overwritten: 0, relinked: 0, unionsBroken: 0 };
  const relinkedUuids = [];

  const run = db.transaction(() => {
    // ── 1. 登记批次 ──
    const batchInfo = db.prepare(
      `INSERT INTO import_batch
       (package_id, source_device, exported_at, anchor_uuid, new_root_uuid, imported_at, snapshot_path)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      pkg.manifest.package_id || newUuid(),
      pkg.manifest.device_label || pkg.manifest.device_id || '',
      pkg.manifest.exported_at || '',
      anchorUuid,
      pkgRootUuid,
      now,
      options.snapshotPath || null
    );
    const batchId = batchInfo.lastInsertRowid;

    // ── 2. UUID 映射（撤销与追溯的依据）──
    db.prepare('INSERT OR REPLACE INTO uuid_map (batch_id, old_uuid, new_uuid) VALUES (?, ?, ?)')
      .run(batchId, anchorUuid, pkgRootUuid);

    // ── 2.5 导入前的原始行快照 ──
    // 只靠软删除标记撤销是不够的：包的 UUID 与本地重合时（最常见的情形——
    // 两台机器本来就是从同一份库派生出来的），节点是被「就地覆盖」的，
    // deleted 一直是 0，撤销时没人复活它，用户会发现自己刚改的字段被导入
    // 悄悄带走且再也回不来。所以这里把将被改动的行原样存一份。
    const before = captureBeforeImage(db, core);

    // ── 3. 软删除本支涉及的全部从属记录（婚姻 / 亲子 / 称谓 / 事件）──
    // 先断关系再删人，避免出现指向已删除人物的悬空行。
    for (const table of ['person_union', 'parent_child', 'person_name', 'person_event']) {
      const fkCols = {
        person_union: ['husband_uuid', 'wife_uuid'],
        parent_child: ['parent_uuid', 'child_uuid'],
        person_name: ['person_uuid'],
        person_event: ['person_uuid'],
      }[table];

      const sql = `UPDATE ${table} SET deleted = 1, updated_at = ?, rev = rev + 1
                   WHERE deleted = 0 AND (${fkCols.map((c) => `${c} IN (SELECT value FROM json_each(?))`).join(' OR ')})`;
      const info = db.prepare(sql).run(now, JSON.stringify([...core]));
      if (table === 'person_union') stats.unionsBroken = info.changes;
    }

    // ── 4. 软删除旧子树（保留数据，撤销时据此复活）──
    const softDelete = db.prepare(
      'UPDATE person SET deleted = 1, updated_at = ?, rev = rev + 1 WHERE uuid = ? AND deleted = 0'
    );
    for (const uuid of core) stats.deleted += softDelete.run(now, uuid).changes;

    // ── 5. 写入包内数据 ──
    const existedBefore = new Set(db.prepare('SELECT uuid FROM person').all().map((r) => r.uuid));

    const upsertPerson = db.prepare(
      `INSERT INTO person
       (uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note, photo,
        device_id, created_at, updated_at, rev, deleted)
       VALUES (@uuid, @branch_id, @gen, @gender, @alive, @surname, @given_name, @gen_char, @note, @photo,
        @device_id, @created_at, @updated_at, 1, 0)
       ON CONFLICT(uuid) DO UPDATE SET
         branch_id  = excluded.branch_id,
         gen        = excluded.gen,
         gender     = excluded.gender,
         alive      = excluded.alive,
         surname    = excluded.surname,
         given_name = excluded.given_name,
         gen_char   = excluded.gen_char,
         note       = excluded.note,
         photo      = excluded.photo,
         updated_at = excluded.updated_at,
         rev        = person.rev + 1,
         deleted    = 0`
    );

    for (const p of pkg.family.person || []) {
      if (p.deleted) continue; // 源端已删的记录不再写回
      upsertPerson.run({
        uuid: p.uuid,
        branch_id: p.branch_id ?? null,
        gen: p.gen ?? null,
        gender: p.gender ?? 0,
        alive: p.alive ?? 1,
        surname: p.surname ?? null,
        given_name: p.given_name ?? null,
        gen_char: p.gen_char ?? null,
        note: p.note ?? null,
        photo: p.photo ?? null,
        device_id: p.device_id || deviceId,
        created_at: p.created_at || now,
        updated_at: p.updated_at || now,
      });
      if (existedBefore.has(p.uuid)) stats.overwritten += 1;
      else stats.inserted += 1;
    }

    for (const [table, cols] of Object.entries(COMPANION)) {
      writeCompanion(db, table, cols, pkg.family[table] || [], deviceId, now);
    }

    // ── 6. 重挂父节点：这就是「只更新父级节点信息」──
    const insertPC = db.prepare(
      `INSERT INTO parent_child
       (uuid, parent_uuid, child_uuid, kind, seq, is_primary, device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
    );
    const edgeExists = db.prepare(
      'SELECT 1 FROM parent_child WHERE parent_uuid = ? AND child_uuid = ? AND deleted = 0'
    );
    for (const pc of anchorParents) {
      if (edgeExists.get(pc.parent_uuid, pkgRootUuid)) continue;
      const edgeUuid = newUuid();
      insertPC.run(edgeUuid, pc.parent_uuid, pkgRootUuid, pc.kind, pc.seq, pc.is_primary, deviceId, now, now);
      relinkedUuids.push(edgeUuid);
      stats.relinked += 1;
    }

    // ── 7. 强制重算代次：不重算，按代次检索与按房支分卷印谱会全错 ──
    recomputeGeneration(db, pkgRootUuid, now);

    // ── 8. 留痕，供精确撤销 ──
    db.prepare(
      `UPDATE import_batch
       SET stats_json = ?, old_uuids_json = ?, new_uuids_json = ?, relinked_json = ?, before_json = ?
       WHERE id = ?`
    ).run(
      JSON.stringify(stats),
      JSON.stringify([...core]),
      JSON.stringify([...pkgSet]),
      JSON.stringify(relinkedUuids),
      JSON.stringify(before),
      batchId
    );

    return { batchId, stats, anchorUuid, newRootUuid: pkgRootUuid };
  });

  return run();
}

/** 从属表写入：显式列顺序，缺字段补 null，UUID 冲突则覆盖 */
function writeCompanion(db, table, cols, rows, deviceId, now) {
  if (!Array.isArray(rows) || rows.length === 0) return;

  const insert = db.prepare(
    `INSERT INTO ${table} (${cols.join(', ')})
     VALUES (${cols.map((c) => '@' + c).join(', ')})
     ON CONFLICT(uuid) DO UPDATE SET
       ${cols.filter((c) => c !== 'uuid' && c !== 'created_at').map((c) => `${c} = excluded.${c}`).join(', ')}`
  );

  for (const r of rows) {
    if (!r || !r.uuid) continue;
    const params = {};
    for (const c of cols) {
      if (c === 'device_id') params[c] = r.device_id || deviceId;
      else if (c === 'created_at') params[c] = r.created_at || now;
      else if (c === 'updated_at') params[c] = r.updated_at || now;
      else if (c === 'rev') params[c] = r.rev ?? 1;
      else if (c === 'deleted') params[c] = r.deleted ?? 0;
      else params[c] = r[c] ?? null;
    }
    insert.run(params);
  }
}

/** 重算代次：从新根 BFS，父先于子 */
function recomputeGeneration(db, rootUuid, now) {
  const childStmt = db.prepare(
    'SELECT child_uuid FROM parent_child WHERE parent_uuid = ? AND deleted = 0 ORDER BY seq'
  );
  const setGen = db.prepare('UPDATE person SET gen = ?, updated_at = ? WHERE uuid = ?');

  const rootRow = db.prepare('SELECT gen FROM person WHERE uuid = ?').get(rootUuid);
  const rootGen = rootRow && rootRow.gen ? rootRow.gen : 1;

  const visited = new Set();
  const queue = [[rootUuid, rootGen]];
  while (queue.length) {
    const [uuid, gen] = queue.shift();
    if (visited.has(uuid)) continue;
    visited.add(uuid);
    setGen.run(gen, now, uuid);
    for (const row of childStmt.all(uuid)) {
      if (!visited.has(row.child_uuid)) queue.push([row.child_uuid, gen + 1]);
    }
  }
  return visited.size;
}

// ── 精确撤销 ──────────────────────────────────────────────

/**
 * 撤销某次导入：反向操作 + 原样写回，不靠整库恢复快照。
 *   1. 拆除本次新建的父子关系
 *   2. 本次新写入的节点（及其从属记录）→ 软删除
 *   3. 把导入前的原始行按原值写回（这一步才能救回被覆盖的字段）
 *   4. 重算代次
 * 好处：导入之后你自己录的其它内容不会被一起回滚掉。
 */
function revertBatch(db, batchId) {
  const batch = db.prepare('SELECT * FROM import_batch WHERE id = ?').get(batchId);
  if (!batch) throw new Error('BATCH_NOT_FOUND');
  if (batch.reverted) throw new Error('BATCH_ALREADY_REVERTED');

  const oldUuids = JSON.parse(batch.old_uuids_json || '[]');
  const newUuids = JSON.parse(batch.new_uuids_json || '[]');
  const relinked = JSON.parse(batch.relinked_json || '[]');
  const before = batch.before_json ? JSON.parse(batch.before_json) : null;
  const oldSet = new Set(oldUuids);
  const toRemove = newUuids.filter((u) => !oldSet.has(u)); // 本次真正新写入的人
  const now = nowIso();

  const run = db.transaction(() => {
    // 1. 拆除本次新建的父子关系
    for (const edgeUuid of relinked) {
      db.prepare('UPDATE parent_child SET deleted = 1, updated_at = ?, rev = rev + 1 WHERE uuid = ?').run(
        now,
        edgeUuid
      );
    }

    // 2. 移除本次新写入的节点及其从属记录，避免留下指向已删人物的悬空行
    if (toRemove.length) {
      const removeIds = JSON.stringify(toRemove);
      for (const [table, cols] of Object.entries(FK_COLS)) {
        const sql = `UPDATE ${table} SET deleted = 1, updated_at = ?, rev = rev + 1
                     WHERE deleted = 0 AND (${cols.map((c) => `${c} IN (SELECT value FROM json_each(?))`).join(' OR ')})`;
        db.prepare(sql).run(now, removeIds);
      }
      const kill = db.prepare(
        'UPDATE person SET deleted = 1, updated_at = ?, rev = rev + 1 WHERE uuid = ? AND deleted = 0'
      );
      for (const uuid of toRemove) kill.run(now, uuid);
    }

    // 3. 把导入前的行原样写回
    let restored = 0;
    if (before) {
      for (const [table, rows] of Object.entries(before)) {
        restored += restoreRows(db, table, rows);
      }
    } else {
      // 老批次没有存快照，退化为「只复活」：字段被覆盖的情况救不回来
      const revive = db.prepare(
        'UPDATE person SET deleted = 0, updated_at = ?, rev = rev + 1 WHERE uuid = ? AND deleted = 1'
      );
      for (const uuid of oldUuids) revive.run(now, uuid);
      const reviveIds = JSON.stringify(oldUuids);
      for (const [table, cols] of Object.entries(FK_COLS)) {
        const sql = `UPDATE ${table} SET deleted = 0, updated_at = ?, rev = rev + 1
                     WHERE deleted = 1 AND (${cols.map((c) => `${c} IN (SELECT value FROM json_each(?))`).join(' OR ')})`;
        db.prepare(sql).run(now, reviveIds);
      }
      restored = oldUuids.length;
    }

    // 4. 重算代次，否则按代次检索与分卷印谱会错位
    if (batch.anchor_uuid) recomputeGeneration(db, batch.anchor_uuid, now);

    db.prepare('UPDATE import_batch SET reverted = 1 WHERE id = ?').run(batchId);
    return { batchId, restored, removed: toRemove.length };
  });

  return run();
}

module.exports = {
  collectLocalSubtree,
  collectPackageSubtree,
  previewReplace,
  executeReplace,
  revertBatch,
  recomputeGeneration,
  getMeta,
  setMeta,
};
