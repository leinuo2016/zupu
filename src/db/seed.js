'use strict';

/**
 * 首次运行写入的示例家族（张氏·百忍堂）
 * ------------------------------------------------------------
 * 目的不是「好看」，而是把族谱里真正难处理的情形先摆出来：
 *   · 长子/次子分房
 *   · 次子之子入嗣长房（parent_child.kind = '嗣'，一人两处出现）
 *   · 长房娶外姓女（李氏），她本人不属本支
 *   · 老谱式模糊纪年（「乾隆壬寅」「失考」）
 *   · 在世 / 已故混排
 * 这样在开发早期就能看到数据结构在真实形态下会不会崩。
 */

const crypto = require('node:crypto');
const { recomputeGeneration } = require('../core/import-replace');

const nowIso = () => new Date().toISOString();

// id 仅用于本文件内部引用，写入库时全部换成 UUID
const PEOPLE = [
  { id: 'root', g: 1, sex: 1, sur: '张', name: '守拙', alive: 0, birth: '康熙戊寅', death: '乾隆庚寅', note: '始迁祖，自山西洪洞迁至邑南张庄' },

  { id: 'dc', parent: 'root', g: 2, sex: 1, sur: '张', name: '德昌', alive: 0, birth: '雍正乙巳', death: '乾隆乙卯', note: '长房' },
  { id: 'dm', parent: 'root', g: 2, sex: 1, sur: '张', name: '德明', alive: 0, birth: '雍正己酉', death: '嘉庆壬戌', note: '次房' },

  { id: 'wm', parent: 'dc', g: 3, sex: 1, sur: '张', name: '文明', alive: 0, birth: '乾隆辛未', death: '嘉庆庚辰' },
  { id: 'wu', parent: 'dc', g: 3, sex: 1, sur: '张', name: '武明', alive: 0, birth: '乾隆甲戌', death: '嘉庆己未' },
  { id: 'wz', parent: 'dc', from: 'dm', kind: '嗣', g: 3, sex: 1, sur: '张', name: '文昭', alive: 0, birth: '乾隆戊寅', note: '德明次子，入嗣长房' },

  { id: 'wy', parent: 'dm', g: 3, sex: 1, sur: '张', name: '文远', alive: 0, birth: '乾隆癸未', death: '道光癸巳' },

  { id: 'cz', parent: 'wm', g: 4, sex: 1, sur: '张', name: '承祖', alive: 0, birth: '乾隆庚子', death: '咸丰乙卯' },
  { id: 'cy', parent: 'wm', g: 4, sex: 1, sur: '张', name: '承业', alive: 0, birth: '乾隆癸卯', death: '咸丰庚申' },
  { id: 'cZhi', parent: 'wu', g: 4, sex: 1, sur: '张', name: '承志', alive: 0, birth: '乾隆壬寅', death: '咸丰辛亥' },
  { id: 'cl', parent: 'wy', g: 4, sex: 1, sur: '张', name: '承礼', alive: 0, birth: '乾隆庚戌', death: '同治壬戌' },

  { id: 'sx', parent: 'cz', g: 5, sex: 1, sur: '张', name: '绍先', alive: 0, birth: '嘉庆庚午', death: '光绪己丑' },
  { id: 'sd', parent: 'cz', g: 5, sex: 1, sur: '张', name: '绍德', alive: 0, birth: '嘉庆癸酉', death: '咸丰壬子' },
  { id: 'sxian', parent: 'cy', g: 5, sex: 1, sur: '张', name: '绍贤', alive: 0, birth: '嘉庆乙亥', death: '光绪癸巳' },

  { id: 'yz', parent: 'sx', g: 6, sex: 1, sur: '张', name: '允中', alive: 0, birth: '道光乙巳', death: '宣统辛亥' },
  { id: 'yh', parent: 'sd', g: 6, sex: 1, sur: '张', name: '允和', alive: 0, birth: '道光己酉', death: '光绪辛丑' },

  { id: 'hl', parent: 'yz', g: 7, sex: 1, sur: '张', name: '鸿烈', alive: 0, birth: '光绪庚辰', death: '1952', note: '民国时主持续修族谱' },
  { id: 'ss', parent: 'hl', g: 8, sex: 1, sur: '张', name: '树声', alive: 0, birth: '1915', death: '1998' },
  { id: 'shd', parent: 'hl', g: 8, sex: 1, sur: '张', name: '树德', alive: 0, birth: '1919', death: '2001' },

  { id: 'my', parent: 'ss', g: 9, sex: 1, sur: '张', name: '明远', alive: 1, birth: '1952' },
  { id: 'md', parent: 'ss', g: 9, sex: 1, sur: '张', name: '明道', alive: 1, birth: '1956' },
  { id: 'ml', parent: 'shd', g: 9, sex: 1, sur: '张', name: '明礼', alive: 1, birth: '1955' },

  { id: 'jz', parent: 'my', g: 10, sex: 1, sur: '张', name: '继宗', alive: 1, birth: '1980' },
  { id: 'jzu', parent: 'my', g: 10, sex: 1, sur: '张', name: '继祖', alive: 1, birth: '1985' },
  { id: 'jx', parent: 'md', g: 10, sex: 1, sur: '张', name: '继贤', alive: 1, birth: '1983' },
  { id: 'jf', parent: 'ml', g: 10, sex: 2, sur: '张', name: '继芳', alive: 1, birth: '1984', note: '女，适李' },
];

// 婚配：本支男子 → 外姓女。配偶本人不属本支房次。
const UNIONS = [
  { h: 'root', sur: '王', name: '氏', birth: '康熙庚辰', death: '乾隆丁亥' },
  { h: 'dc', sur: '李', name: '氏', birth: '雍正丁未', death: '嘉庆辛酉', note: '李家庄李门女' },
  { h: 'wm', sur: '赵', name: '氏', birth: '乾隆癸酉', death: '道光乙酉' },
  { h: 'wu', sur: '孙', name: '氏', birth: '乾隆丁丑', death: '失考' },
  { h: 'cz', sur: '周', name: '氏', birth: '乾隆壬寅', death: '咸丰甲寅' },
  { h: 'hl', sur: '王', name: '氏', birth: '光绪乙酉', death: '1961' },
  { h: 'ss', sur: '陈', name: '秀英', birth: '1920', death: '2005' },
  { h: 'shd', sur: '刘', name: '桂兰', birth: '1924', death: '2010' },
  { h: 'my', sur: '林', name: '小娥', birth: '1955' },
  { h: 'md', sur: '黄', name: '美珍', birth: '1958' },
  { h: 'ml', sur: '吴', name: '秀珍', birth: '1957' },
];

function seedIfEmpty(db, { deviceLabel = '本机' } = {}) {
  const count = db.prepare('SELECT COUNT(*) AS c FROM person WHERE deleted = 0').get().c;
  if (count > 0) return { seeded: false };

  const t = nowIso();
  const deviceId = db.prepare('SELECT value FROM meta WHERE key = ?').get('device_id');
  const devId = deviceId ? deviceId.value : 'seed';

  const run = db.transaction(() => {
    const idMap = new Map();
    const insPerson = db.prepare(
      `INSERT INTO person
       (uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note,
        device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, 1, 0)`
    );
    const insEvent = db.prepare(
      `INSERT INTO person_event
       (uuid, person_uuid, type, time_text, place, precision, device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, NULL, '原文', ?, ?, ?, 1, 0)`
    );

    for (const p of PEOPLE) {
      const id = crypto.randomUUID();
      idMap.set(p.id, id);
      // 房支：以「始祖之子的 id」为房支标识
      const branch = p.id === 'root' ? null : p.parent === 'root' ? id : null;
      insPerson.run(
        id,
        branch,
        p.g ?? null,
        p.sex ?? 0,
        p.alive ? 1 : 0,
        p.sur,
        p.name,
        p.note || null,
        devId,
        t,
        t
      );
      if (p.birth) insEvent.run(crypto.randomUUID(), id, '生', p.birth, devId, t, t);
      if (p.death) insEvent.run(crypto.randomUUID(), id, '卒', p.death, devId, t, t);
    }

    // 父子关系：parent 为主，from 存在时额外建一条「嗣」
    const insEdge = db.prepare(
      `INSERT INTO parent_child
       (uuid, parent_uuid, child_uuid, kind, seq, is_primary, device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 0)`
    );
    const seqCounter = new Map();
    const nextSeq = (parentId) => {
      const n = (seqCounter.get(parentId) || 0) + 1;
      seqCounter.set(parentId, n);
      return n;
    };

    for (const p of PEOPLE) {
      if (!p.parent) continue;
      insEdge.run(
        crypto.randomUUID(),
        idMap.get(p.parent),
        idMap.get(p.id),
        p.kind || '生',
        nextSeq(p.parent),
        p.kind === '嗣' ? 0 : 1,
        devId,
        t,
        t
      );
      if (p.from) {
        insEdge.run(
          crypto.randomUUID(),
          idMap.get(p.from),
          idMap.get(p.id),
          '生',
          nextSeq(p.from),
          1,
          devId,
          t,
          t
        );
      }
    }

    const insUnion = db.prepare(
      `INSERT INTO person_union
       (uuid, husband_uuid, wife_uuid, seq, kind, status, device_id, created_at, updated_at, rev, deleted)
       VALUES (?, ?, ?, ?, '嫡', '婚姻', ?, ?, ?, 1, 0)`
    );
    let uSeq = 0;
    for (const u of UNIONS) {
      uSeq += 1;
      const wifeId = crypto.randomUUID();
      const husbandId = idMap.get(u.h);
      const husbandGen = db.prepare('SELECT gen FROM person WHERE uuid = ?').get(husbandId).gen;
      insPerson.run(wifeId, null, husbandGen, 2, 0, u.sur, u.name, u.note || null, devId, t, t);
      if (u.birth) insEvent.run(crypto.randomUUID(), wifeId, '生', u.birth, devId, t, t);
      if (u.death) insEvent.run(crypto.randomUUID(), wifeId, '卒', u.death, devId, t, t);
      insUnion.run(crypto.randomUUID(), husbandId, wifeId, 1, devId, t, t);
    }

    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run(idMap.get('root'), 'root_person_uuid');
    const curClan = db.prepare('SELECT value FROM meta WHERE key = ?').get('clan_name');
    if (!curClan || !curClan.value || curClan.value === '未命名家族') {
      db.prepare(
        'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
      ).run('clan_name', '张氏·百忍堂');
    }
    recomputeGeneration(db, idMap.get('root'), t);
    return true;
  });

  run();
  return { seeded: true };
}

module.exports = { seedIfEmpty };
