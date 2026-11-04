'use strict';

/**
 * 数据库驱动适配层
 * ------------------------------------------------------------
 * 目标：同一套业务代码在两种驱动下都能跑。
 *   1. node:sqlite        —— Node 22+ / Electron 自带，零原生依赖，开箱即用
 *   2. better-sqlite3     —— 生态成熟，打包体积更小，需要 electron-rebuild
 *
 * 对外暴露 better-sqlite3 风格的 API（prepare/get/all/run/exec/transaction），
 * 因此 src/core/import-replace.js 一行都不用改。
 */

const fs = require('node:fs');
const path = require('node:path');

const SCHEMA_PATH = path.join(__dirname, 'schema.sql');

/** 老库缺列时补一列（SQLite 的 ADD COLUMN 很便宜） */
function ensureColumn(db, table, column, type) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all();
  if (!cols.some((c) => c.name === column)) {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}`);
  }
}

/** node:sqlite 没有 db.transaction()，这里补一个，语义与 better-sqlite3 一致 */
function attachTransaction(db) {
  if (typeof db.transaction === 'function') return;
  db.transaction = (fn) => (...args) => {
    db.exec('BEGIN IMMEDIATE');
    try {
      const result = fn(...args);
      db.exec('COMMIT');
      return result;
    } catch (err) {
      try {
        db.exec('ROLLBACK');
      } catch (_) {
        /* 事务可能已被自动回滚 */
      }
      throw err;
    }
  };
}

function openRaw(filePath) {
  // 优先使用内置驱动：不需要编译原生模块，十年后也一定还能装得上
  try {
    const { DatabaseSync } = require('node:sqlite');
    const db = new DatabaseSync(filePath);
    return { db, driver: 'node:sqlite' };
  } catch (e1) {
    try {
      const Database = require('better-sqlite3');
      const db = new Database(filePath);
      return { db, driver: 'better-sqlite3' };
    } catch (e2) {
      const err = new Error(
        'NO_SQLITE_DRIVER: 既没有 node:sqlite（需 Node 22+ / Electron 内置），也没有安装 better-sqlite3。\n' +
          `node:sqlite 失败原因：${e1.message}\nbetter-sqlite3 失败原因：${e2.message}`
      );
      throw err;
    }
  }
}

/**
 * 打开（必要时创建）一个族谱库。
 * @param {string} filePath  .db 文件路径，传 ':memory:' 用于测试
 * @returns {{ db, driver, filePath, close }}
 */
function openDatabase(filePath) {
  if (filePath !== ':memory:') {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
  }

  const { db, driver } = openRaw(filePath);
  attachTransaction(db);

  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA busy_timeout = 5000;');

  const schema = fs.readFileSync(SCHEMA_PATH, 'utf8');
  db.exec(schema);

  // 轻量迁移：老库缺列时补上，避免升级后打不开
  ensureColumn(db, 'import_batch', 'before_json', 'TEXT');
  ensureColumn(db, 'person_event', 'time_ganzhi', 'TEXT'); // v3：干支与年份并列保存
  ensureColumn(db, 'person', 'photo', 'TEXT'); // v4：人像照片（data URL，一人一张）

  // 结构版本：以后加字段时靠它判断要不要迁移
  const cur = db.prepare('SELECT value FROM meta WHERE key = ?').get('schema_version');
  if (!cur) {
    db.prepare('INSERT INTO meta (key, value) VALUES (?, ?)').run('schema_version', '4');
  } else if (Number(cur.value) < 4) {
    db.prepare('UPDATE meta SET value = ? WHERE key = ?').run('4', 'schema_version');
  }

  return {
    db,
    driver,
    filePath,
    close() {
      try {
        db.close();
      } catch (_) {
        /* ignore */
      }
    },
  };
}

/**
 * 文件级快照。导入前必做：撤销能救「导错了」，救不了「软件崩了」「硬盘坏了」。
 * 只保留最近 keep 份，避免备份目录无限膨胀。
 */
function snapshot(filePath, backupDir, keep = 20) {
  if (filePath === ':memory:' || !fs.existsSync(filePath)) return null;
  fs.mkdirSync(backupDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const target = path.join(backupDir, `backup-${stamp}.db`);
  fs.copyFileSync(filePath, target);

  // WAL 模式下主文件可能不含最新提交，连 -wal 一起留一份
  const wal = `${filePath}-wal`;
  if (fs.existsSync(wal)) fs.copyFileSync(wal, `${target}-wal`);

  const olds = fs
    .readdirSync(backupDir)
    .filter((f) => /^backup-.*\.db$/.test(f))
    .sort();
  while (olds.length > keep) {
    const f = olds.shift();
    try {
      fs.unlinkSync(path.join(backupDir, f));
      const w = path.join(backupDir, `${f}-wal`);
      if (fs.existsSync(w)) fs.unlinkSync(w);
    } catch (_) {
      /* ignore */
    }
  }
  return target;
}

module.exports = { openDatabase, snapshot, SCHEMA_PATH };
