-- ============================================================
-- 族谱系统 · 本地库结构  (SQLite 3.35+)
-- ============================================================
-- 设计约定：
--   1. 所有主键一律 TEXT（UUID），禁止自增整数——多机交换必然撞车。
--   2. 所有业务表必带 5 个审计字段：device_id / created_at / updated_at / rev / deleted。
--   3. 删除一律软删除（deleted = 1），保证可撤销、可追溯。
--   4. 时间字段统一 ISO 8601 字符串（如 2026-11-04T10:35:19+08:00）。
--   5. "时间原文"与"归一化数值"分开存：老谱写"乾隆壬寅"，原文绝不能丢。
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- 元信息（单行键值）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);
-- 常用键：
--   schema_version   库结构版本，用于升级迁移
--   clan_name        家族名（堂号）
--   device_id        本机标识，写入每条记录的 device_id 字段
--   device_label     人看得懂的机器名，如「二房-小明家」
--   root_person_uuid 始祖 UUID

-- ------------------------------------------------------------
-- 人物
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person (
  uuid         TEXT PRIMARY KEY,
  branch_id    TEXT,                       -- 所属房支（可为空，一房一支也是支）
  gen          INTEGER,                    -- 代次（以始祖为 1）；冗余字段，替换后必须重算
  gender       INTEGER NOT NULL DEFAULT 0, -- 0 未知 / 1 男 / 2 女
  alive        INTEGER NOT NULL DEFAULT 1, -- 1 在世 / 0 已故；在世者默认脱敏
  surname      TEXT,                       -- 姓
  given_name   TEXT,                       -- 名（谱名，最常用称呼）
  gen_char     TEXT,                       -- 字辈用字
  note         TEXT,                       -- 备注
  photo        TEXT,                       -- 人像照片，data URL（data:image/...;base64,...），一人一张；NULL 为无
  device_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_person_branch ON person(branch_id, deleted);
CREATE INDEX IF NOT EXISTS idx_person_gen    ON person(gen, deleted);
CREATE INDEX IF NOT EXISTS idx_person_name   ON person(surname, given_name, deleted);

-- ------------------------------------------------------------
-- 称名：一个人的多个称呼（谱名 / 讳 / 字 / 号 / 乳名 / 行第）
-- 老谱里一人常有 3-5 个称呼，必须一对多。
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_name (
  uuid         TEXT PRIMARY KEY,
  person_uuid  TEXT NOT NULL REFERENCES person(uuid),
  kind         TEXT NOT NULL,              -- 谱名|讳|字|号|乳名|行第|谥
  value        TEXT NOT NULL,
  seq          INTEGER NOT NULL DEFAULT 0, -- 同一 kind 出现多次时排序
  device_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_name_person ON person_name(person_uuid, deleted);
CREATE INDEX IF NOT EXISTS idx_name_value  ON person_name(value);

-- ------------------------------------------------------------
-- 婚配：独立实体，绝不能把配偶塞进 person 的字段里
-- 一人可有多段婚姻（嫡 / 继 / 侧）
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_union (
  uuid          TEXT PRIMARY KEY,
  husband_uuid  TEXT REFERENCES person(uuid),  -- 可为空：只知一方
  wife_uuid     TEXT REFERENCES person(uuid),
  seq           INTEGER NOT NULL DEFAULT 1,    -- 第几娶 / 第几嫁
  kind          TEXT,                          -- 嫡|继|侧|平|未知
  status        TEXT,                          -- 婚姻|离异|丧偶|未知
  start_text    TEXT,                          -- 时间原文，如「民国十年」
  start_year    INTEGER,                       -- 归一化起始年
  end_text      TEXT,
  end_year      INTEGER,
  device_id     TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  rev           INTEGER NOT NULL DEFAULT 1,
  deleted       INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_union_h ON person_union(husband_uuid, deleted);
CREATE INDEX IF NOT EXISTS idx_union_w ON person_union(wife_uuid, deleted);

-- ------------------------------------------------------------
-- 亲子关系：关系类型是族谱建模的核心
-- 一人可有多父（生父 + 嗣父），即「兼祧」，所以不能只有一个 parent_uuid 字段
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS parent_child (
  uuid         TEXT PRIMARY KEY,
  parent_uuid  TEXT NOT NULL REFERENCES person(uuid),
  child_uuid   TEXT NOT NULL REFERENCES person(uuid),
  kind         TEXT NOT NULL DEFAULT '生',  -- 生|嗣|继|养|入赘|兼祧
  seq          INTEGER NOT NULL DEFAULT 1,  -- 排行
  is_primary   INTEGER NOT NULL DEFAULT 1,  -- 兼祧时标记主要归属（用于分卷）
  device_id    TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL,
  rev          INTEGER NOT NULL DEFAULT 1,
  deleted      INTEGER NOT NULL DEFAULT 0,
  CHECK (parent_uuid <> child_uuid)          -- 禁止自己是自己的父
);

CREATE INDEX IF NOT EXISTS idx_pc_parent ON parent_child(parent_uuid, deleted);
CREATE INDEX IF NOT EXISTS idx_pc_child  ON parent_child(child_uuid, deleted);

-- ------------------------------------------------------------
-- 事件：生 / 卒 / 葬 / 迁 / 婚 / 功名 / 事迹
-- 时间必须双轨：原文永不丢 + 归一化区间，精度单独标记
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS person_event (
  uuid        TEXT PRIMARY KEY,
  person_uuid TEXT NOT NULL REFERENCES person(uuid),
  type        TEXT NOT NULL,
  time_text   TEXT,                        -- 「乾隆壬寅」「约民国十年」「失考」
  time_start  INTEGER,                     -- 归一化起始年（公元前用负数）
  time_end    INTEGER,                     -- 区间上界；单点时间与 start 相同
  time_ganzhi TEXT,                        -- 干支（乙卯）。与 time_start、time_text 三者并存，互不覆盖
  precision   TEXT,                        -- 年|月|日|约|失考
  place       TEXT,                        -- 地点（老地名原样保留）
  description TEXT,
  device_id   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  rev         INTEGER NOT NULL DEFAULT 1,
  deleted     INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_event_person ON person_event(person_uuid, type, deleted);
CREATE INDEX IF NOT EXISTS idx_event_year   ON person_event(time_start);

-- ------------------------------------------------------------
-- 导入批次：每次替换留一条，支撑「撤销上一次导入」和审计
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS import_batch (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  package_id    TEXT NOT NULL,             -- manifest.package_id
  source_device TEXT,                      -- manifest.device_label
  exported_at   TEXT,                      -- manifest.exported_at
  anchor_uuid   TEXT NOT NULL,             -- 本地被替换的节点（旧）
  new_root_uuid TEXT,                      -- 包内根节点（新）
  imported_at   TEXT NOT NULL,
  stats_json    TEXT,                      -- {deleted, inserted, overwritten, relinked, unionsBroken}
  old_uuids_json TEXT,                     -- 本次被软删除的旧节点集合，撤销时据此复活
  new_uuids_json TEXT,                     -- 本次写入的新节点集合，撤销时据此移除
  relinked_json  TEXT,                     -- 本次新建的父子关系 uuid，撤销时据此拆除
  before_json    TEXT,                     -- 导入前的原始行快照：撤销时恢复被覆盖的字段值
  snapshot_path TEXT,                      -- 执行前自动快照的文件路径（双保险）
  reverted      INTEGER NOT NULL DEFAULT 0
);

-- ------------------------------------------------------------
-- UUID 映射：旧节点 → 新节点
-- 完整替换时旧 UUID 会被包内 UUID 取代，此表用于：
--   1. 撤销时反查
--   2. 外部引用重定向
--   3. 追溯「这个人换过几次身份」
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS uuid_map (
  batch_id INTEGER NOT NULL,
  old_uuid TEXT NOT NULL,
  new_uuid TEXT,
  PRIMARY KEY (batch_id, old_uuid)
);

CREATE INDEX IF NOT EXISTS idx_map_old ON uuid_map(old_uuid);
