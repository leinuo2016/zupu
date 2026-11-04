'use strict';

/**
 * 导出 Excel：节点全部信息
 * ------------------------------------------------------------
 * 三张表 + 一张说明：
 *   人物：一人一行，把所有字段摊平（含生卒的年份 / 干支 / 原文三份）
 *   婚配：一段婚姻一行
 *   父子：一条父关系一行（兼祧的两个人会各占一行）
 *   说明：导出时间、本机、范围，以及字段含义
 *
 * 为什么摊平而不是「一人一列」：Excel 是用来核对和交给不懂软件的人看的，
 * 一行一人最容易排序、筛选、打印。
 */

const Ganzhi = require('../../renderer/ganzhi');
const { buildWorkbook } = require('./xlsx');

const GENDER = { 0: '', 1: '男', 2: '女' };

function subtreeIds(db, rootUuid) {
  if (!rootUuid) return null;
  const rows = db
    .prepare(
      `WITH RECURSIVE sub(uuid) AS (
         SELECT ?
         UNION
         SELECT pc.child_uuid FROM parent_child pc JOIN sub ON pc.parent_uuid = sub.uuid WHERE pc.deleted = 0
       )
       SELECT uuid FROM sub`
    )
    .all(rootUuid);
  return new Set(rows.map((r) => r.uuid));
}

const nameOf = (r) => (r ? `${r.surname || ''}${r.given_name || ''}`.trim() || '(无名)' : '');

function exportExcel(db, { rootUuid = null, clanName = '', deviceLabel = '', scopeLabel = '' } = {}) {
  const allUnions = db
    .prepare(
      `SELECT uuid, husband_uuid, wife_uuid, seq, kind, status, start_text, start_year, end_text, end_year
       FROM person_union WHERE deleted = 0 ORDER BY seq`
    )
    .all();

  // 范围：本支后代 + 他们的配偶。
  // 配偶是独立人物记录、在图上也有方框，漏掉他们等于导出半份谱。
  let keep = null;
  if (rootUuid) {
    keep = subtreeIds(db, rootUuid);
    for (const u of allUnions) {
      const a = keep.has(u.husband_uuid);
      const b = keep.has(u.wife_uuid);
      if (a && u.wife_uuid) keep.add(u.wife_uuid);
      if (b && u.husband_uuid) keep.add(u.husband_uuid);
    }
  }

  const persons = db
    .prepare(
      `SELECT uuid, branch_id, gen, gender, alive, surname, given_name, gen_char, note, photo,
              created_at, updated_at, rev
       FROM person WHERE deleted = 0 ORDER BY gen, given_name`
    )
    .all()
    .filter((p) => !keep || keep.has(p.uuid));

  const byUuid = new Map(persons.map((p) => [p.uuid, p]));
  const keepId = (u) => (byUuid.has(u) ? u : null);

  // 房支字段里存的是「这一房始祖」的 uuid。导给自家人看时印一串 uuid 没有意义，
  // 要转成「张德昌（二世）」。始祖可能不在本次导出范围里（单支导出），
  // 所以这张表查全谱；连人都找不到（已被删）就保留 uuid，至少还能追。
  const allById = new Map(
    db.prepare(`SELECT uuid, surname, given_name, gen FROM person WHERE deleted = 0`).all().map((p) => [p.uuid, p])
  );
  const branchLabel = (id) => {
    if (!id) return '';
    const a = allById.get(id);
    if (!a) return id;
    return `${nameOf(a)}${a.gen ? `（${Ganzhi.shiLabel(a.gen)}）` : ''}`;
  };

  const events = db
    .prepare(
      `SELECT person_uuid, type, time_text, time_start, time_ganzhi, place
       FROM person_event WHERE deleted = 0`
    )
    .all();

  const eventsOf = new Map();
  for (const e of events) {
    if (!byUuid.has(e.person_uuid)) continue;
    if (!eventsOf.has(e.person_uuid)) eventsOf.set(e.person_uuid, {});
    eventsOf.get(e.person_uuid)[e.type] = e;
  }

  const aliases = new Map();
  for (const n of db
    .prepare(`SELECT person_uuid, kind, value FROM person_name WHERE deleted = 0 ORDER BY kind, seq`)
    .all()) {
    if (!byUuid.has(n.person_uuid)) continue;
    if (!aliases.has(n.person_uuid)) aliases.set(n.person_uuid, []);
    aliases.get(n.person_uuid).push(`${n.kind}：${n.value}`);
  }

  const edges = db
    .prepare(
      `SELECT parent_uuid, child_uuid, kind, seq, is_primary FROM parent_child
       WHERE deleted = 0 ORDER BY seq`
    )
    .all()
    .filter((e) => byUuid.has(e.parent_uuid) && byUuid.has(e.child_uuid));

  const parentsOf = new Map();
  const childrenOf = new Map();
  for (const e of edges) {
    if (!parentsOf.has(e.child_uuid)) parentsOf.set(e.child_uuid, []);
    parentsOf.get(e.child_uuid).push(e);
    if (!childrenOf.has(e.parent_uuid)) childrenOf.set(e.parent_uuid, []);
    childrenOf.get(e.parent_uuid).push(e);
  }

  const unions = allUnions.filter((u) => keepId(u.husband_uuid) || keepId(u.wife_uuid));

  const unionsOf = new Map();
  for (const u of unions) {
    for (const a of [u.husband_uuid, u.wife_uuid]) {
      if (!byUuid.has(a)) continue;
      if (!unionsOf.has(a)) unionsOf.set(a, []);
      unionsOf.get(a).push(u);
    }
  }

  // ── 人物表 ──
  const personHeader = [
    '世次',
    '世次(数字)',
    '姓名',
    '姓',
    '名',
    '字辈',
    '性别',
    '状态',
    '生年(公元)',
    '生年干支',
    '生年原文',
    '出生地',
    '卒年(公元)',
    '卒年干支',
    '卒年原文',
    '卒地',
    '葬地',
    '生父',
    '嗣/继父',
    '配偶',
    '子嗣数',
    '别名字号',
    '房支',
    '备注',
    '照片',
    '内部ID',
  ];

  const personRows = persons.map((p) => {
    const ev = eventsOf.get(p.uuid) || {};
    const birth = ev['生'] || {};
    const death = ev['卒'] || {};
    const burial = ev['葬'] || {};

    // 老谱只抄了「雍正乙巳」这类原文时，年份和干支靠推导入表，
    // 和界面看到的保持一致（库里仍是空的，不伪造数据）。
    const birthYear = birth.time_start ?? Ganzhi.findYear(birth.time_text);
    const birthGz = birth.time_ganzhi || Ganzhi.findGanzhi(birth.time_text) || '';
    const deathYear = death.time_start ?? Ganzhi.findYear(death.time_text);
    const deathGz = death.time_ganzhi || Ganzhi.findGanzhi(death.time_text) || '';

    const ps = parentsOf.get(p.uuid) || [];
    const bio = ps.filter((e) => e.kind === '生' || !e.kind).map((e) => nameOf(byUuid.get(e.parent_uuid)));
    const other = ps.filter((e) => e.kind && e.kind !== '生').map((e) => `${nameOf(byUuid.get(e.parent_uuid))}(${e.kind})`);

    const spouses = (unionsOf.get(p.uuid) || []).map((u) => {
      const otherU = u.husband_uuid === p.uuid ? u.wife_uuid : u.husband_uuid;
      const nm = nameOf(byUuid.get(otherU));
      return u.kind && u.kind !== '嫡' ? `${nm}(${u.kind})` : nm || '（未记）';
    });

    return [
      Ganzhi.shiLabel(p.gen),
      p.gen ?? '',
      nameOf(p),
      p.surname || '',
      p.given_name || '',
      p.gen_char || '',
      GENDER[p.gender] || '',
      p.alive ? '在世' : '已故',
      birthYear ?? '',
      birthGz,
      birth.time_text || '',
      birth.place || '',
      deathYear ?? '',
      deathGz,
      death.time_text || '',
      death.place || '',
      burial.place || '',
      bio.join('、'),
      other.join('、'),
      spouses.join('、'),
      (childrenOf.get(p.uuid) || []).length || '',
      (aliases.get(p.uuid) || []).join('；'),
      branchLabel(p.branch_id),
      p.note || '',
      p.photo ? '有' : '',
      p.uuid,
    ];
  });

  // ── 婚配表 ──
  const unionHeader = ['序号', '夫', '妻', '第几娶/嫁', '类型', '状态', '起始原文', '起始年', '终止原文', '终止年'];
  const unionRows = unions.map((u, i) => [
    i + 1,
    nameOf(byUuid.get(u.husband_uuid)) || '（未记）',
    nameOf(byUuid.get(u.wife_uuid)) || '（未记）',
    u.seq ?? '',
    u.kind || '',
    u.status || '',
    u.start_text || '',
    u.start_year ?? '',
    u.end_text || '',
    u.end_year ?? '',
  ]);

  // ── 父子表 ──
  const edgeHeader = ['父', '子', '关系', '排行', '是否主父'];
  const edgeRows = edges.map((e) => [
    nameOf(byUuid.get(e.parent_uuid)),
    nameOf(byUuid.get(e.child_uuid)),
    e.kind || '生',
    e.seq ?? '',
    e.is_primary ? '是' : '否',
  ]);

  // ── 说明 ──
  const maxGen = persons.reduce((m, p) => Math.max(m, p.gen || 0), 0);
  const noteRows = [
    ['家族', clanName || ''],
    ['导出时间', new Date().toISOString().replace('T', ' ').slice(0, 19)],
    ['导出范围', scopeLabel || '全谱'],
    ['人数', persons.length],
    ['世数', maxGen],
    ['导出机器', deviceLabel || ''],
    ['', ''],
    ['字段说明', '生年 / 卒年保留三份：公元年、干支、谱上原话。三者互不覆盖，缺哪个就空着。'],
    ['', '只抄了年号（如「康熙戊寅」）时，公元年按年号推算；推不出来就留空，不猜。'],
    ['', '「嗣/继父」指过继、兼祧的另一位父亲；生父为空但有嗣父时，说明此人由别房入嗣。'],
    ['', '「房支」写的是这一房始祖的姓名与世次，不是一串编号。'],
    ['', '「内部ID」是给机器用的，人工核对时不用管；跨表对照时可以用它找同一个人。'],
  ];

  const buffer = buildWorkbook([
    {
      name: '人物',
      header: personHeader,
      rows: personRows,
      widths: [8, 9, 12, 6, 10, 8, 6, 6, 10, 10, 14, 14, 10, 10, 14, 14, 16, 12, 14, 16, 8, 20, 10, 30, 38],
    },
    { name: '婚配', header: unionHeader, rows: unionRows, widths: [6, 12, 12, 10, 8, 8, 16, 10, 16, 10] },
    { name: '父子', header: edgeHeader, rows: edgeRows, widths: [12, 12, 8, 6, 10] },
    { name: '说明', header: ['项', '内容'], rows: noteRows, widths: [14, 90] },
  ]);

  return {
    buffer,
    counts: {
      persons: persons.length,
      unions: unionRows.length,
      edges: edgeRows.length,
      maxGen,
    },
  };
}

module.exports = { exportExcel };
