'use strict';

/**
 * 设备身份
 * ------------------------------------------------------------
 * 为什么不能把 device_id 只存在数据库里：
 *   家族自用最常见的操作就是「把库文件拷到笔记本上继续录」。
 *   如果 device_id 随库走，两台机器就会自称同一台设备，
 *   谁改的、哪台机器导的，全部追溯不了。
 *
 * 做法：身份存在库文件旁边的 device.json 里，并记住写入时的主机名。
 *   一旦发现主机名变了（整个文件夹被拷到另一台电脑），
 *   就换发新身份，同时记下它是由谁转来的（rotated_from）。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const FILE_NAME = 'device.json';

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * @param {{dataDir:string, label?:string}} opts
 * @returns {{device_id:string, label:string, hostname:string, rotatedFrom?:string}}
 */
function resolveDevice({ dataDir, label }) {
  const file = path.join(dataDir, FILE_NAME);
  const hostname = os.hostname();
  let cur = readJson(file);

  if (cur && cur.device_id && cur.hostname && cur.hostname !== hostname) {
    const previous = cur.device_id;
    cur = {
      device_id: crypto.randomUUID(),
      label: cur.label || label || hostname,
      hostname,
      rotated_from: previous,
      rotated_at: new Date().toISOString(),
    };
    console.log(`[device] 检测到库文件夹被复制到另一台机器（${cur.hostname}），已换发新的设备标识`);
  }

  if (!cur || !cur.device_id) {
    cur = {
      device_id: crypto.randomUUID(),
      label: label || hostname || '本机',
      hostname,
      created_at: new Date().toISOString(),
    };
  }

  if (label && cur.label !== label) cur.label = label;

  try {
    fs.writeFileSync(file, JSON.stringify(cur, null, 2), 'utf8');
  } catch (e) {
    // 只读介质（U 盘写保护）下不要因此打不开程序
    console.warn(`[device] 无法写入 ${file}：${e.message}`);
  }

  return cur;
}

module.exports = { resolveDevice, FILE_NAME };
