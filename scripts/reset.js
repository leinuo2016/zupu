'use strict';

/**
 * 重开一份空谱（默认 data/zupu-dev.db）
 * ------------------------------------------------------------
 * 用法：
 *   node scripts/reset.js            → 只把当前库改名存档，再建一份空库
 *   ZUPU_DATA_DIR=... node scripts/reset.js   → 换目录
 *
 * 为什么是「改名」不是「删除」：谱录是一次次访谈抄下来的，删错一次就没了。
 * 这里只把旧库挪成 zupu-dev.db.bak-<时间戳>，想找回改名回去就行。
 * 真删是用户自己在文件管理器里做的事，不归脚本管。
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIR = process.env.ZUPU_DATA_DIR || path.join(ROOT, 'data');
const DB = path.join(DIR, 'zupu-dev.db');

function stamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

if (!fs.existsSync(DIR)) fs.mkdirSync(DIR, { recursive: true });

if (!fs.existsSync(DB)) {
  console.log(`没有找到库文件：${DB}`);
  console.log('直接启动软件就会自动建一份空库。');
} else {
  const target = `${DB}.bak-${stamp()}`;
  fs.renameSync(DB, target);
  // WAL 是库的「未落盘部分」，跟着一起挪走，否则新库会被旧 WAL 污染。
  for (const ext of ['-wal', '-shm']) {
    const side = `${DB}${ext}`;
    if (fs.existsSync(side)) fs.renameSync(side, `${target}${ext}`);
  }
  console.log(`旧库已存档：${target}`);
}

// 建一份空库：走和软件一样的初始化路径，保证表结构、始祖、设备身份都齐
const { createApi } = require('../src/api');
const api = createApi({ filePath: DB, backupDir: path.join(DIR, 'backups') });
const boot = api.bootstrap();
const root = boot.rootUuid ? api.person({ uuid: boot.rootUuid }) : null;
console.log(`新库已建好：${DB}`);
console.log(`始祖：${root ? `${root.surname || ''}${root.given_name || ''}` : '(待填)'}`);
api.close();
