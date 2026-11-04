'use strict';

/**
 * 应用 API
 * ------------------------------------------------------------
 * Electron 主进程与本地 dev server 共用这一份实现：
 *   Electron → ipcMain.handle('api', (e, method, args) => api[method](args))
 *   dev      → POST /api/<method> → 同一函数
 * 这样界面代码只有一套，调试时也能直接在浏览器里点。
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { openDatabase, snapshot } = require('./db/driver');
const { resolveDevice } = require('./db/device');
const repo = require('./db/repo');
const { seedIfEmpty } = require('./db/seed');
const IO = require('./core/package-io');
const R = require('./core/import-replace');
const { exportExcel } = require('./core/excel-export');

/**
 * 接口版本号。前端拿它和 bootstrap 返回的值比对：
 * 老进程还在跑时，新界面调新接口只会得到 UNKNOWN_API，
 * 与其让用户对着「导出失败」猜，不如直接说「你连着的是旧服务」。
 * 加了新接口就 +1。
 */
const API_REV = 4;

/** 去掉路径分隔符等危险字符，只留一个安全文件名 */
function safeFileName(name) {
  const base = String(name || 'export').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').trim();
  return base || 'export';
}

/** 同名文件不覆盖：自动加 -2、-3 */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const stem = path.basename(name, ext);
  let target = path.join(dir, name);
  let i = 2;
  while (fs.existsSync(target)) {
    target = path.join(dir, `${stem}-${i}${ext}`);
    i += 1;
  }
  return target;
}

function createApi({ filePath, backupDir, seed = true, deviceLabel }) {
  // 设备身份跟随「库文件所在的文件夹」，不跟随库文件本身：
  // 这样单把 .db 拷到另一台电脑，也不会两台机器共用一个 device_id。
  const dataDir = filePath === ':memory:' ? os.tmpdir() : path.dirname(filePath);
  const device = resolveDevice({ dataDir, label: deviceLabel });

  const { db, driver } = openDatabase(filePath);

  repo.ensureMeta(db);
  repo.setMeta(db, 'device_id', device.device_id);
  repo.setMeta(db, 'device_label', device.label);

  if (seed) seedIfEmpty(db);
  repo.ensureMeta(db, { deviceLabel: device.label });

  // 库里有数据但没有始祖标记（例如手工导入过别人的库），补一个
  if (!repo.getMeta(db, 'root_person_uuid')) {
    const roots = repo.getTree(db).roots;
    if (roots && roots.length) repo.setMeta(db, 'root_person_uuid', roots[0]);
  }

  const api = {
    // ── 基础信息 ──
    bootstrap() {
      const m = repo.ensureMeta(db);
      return {
        clanName: m.clanName,
        deviceLabel: m.deviceLabel,
        deviceId: m.deviceId,
        rootUuid: m.rootUuid,
        apiRev: API_REV,
        driver,
        dataPath: filePath,
        stats: repo.stats(db),
        batches: repo.listBatches(db, 5),
        fileExists: filePath !== ':memory:' && fs.existsSync(filePath),
      };
    },

    updateMeta({ clanName, deviceLabel }) {
      if (clanName) repo.setMeta(db, 'clan_name', clanName);
      if (deviceLabel) repo.setMeta(db, 'device_label', deviceLabel);
      return api.bootstrap();
    },

    // ── 读 ──
    tree({ rootUuid } = {}) {
      return repo.getTree(db, { rootUuid });
    },

    person({ uuid }) {
      if (!uuid) throw new Error('MISSING_UUID: person 接口需要 uuid');
      return repo.getPerson(db, uuid);
    },

    // ── 写 ──
    savePerson(payload) {
      const uuid = repo.savePerson(db, payload);
      return { uuid, person: repo.getPerson(db, uuid) };
    },

    addChild({ parentUuid, person, kind }) {
      const uuid = repo.addChild(db, { parentUuid, person, kind });
      return { uuid, person: repo.getPerson(db, uuid) };
    },

    addSpouse({ personUuid, person, kind, seq }) {
      const uuid = repo.addSpouse(db, { personUuid, person, kind, seq });
      return { uuid, person: repo.getPerson(db, uuid) };
    },

    removePerson({ uuid, cascade = true }) {
      const result = repo.removePerson(db, uuid, { cascade });
      return { ok: true, ...result, stats: repo.stats(db) };
    },

    // 删除前先看影响：界面要先把「会失去谁」摆出来再让人确认
    deletePreview({ uuid }) {
      return repo.deletePreview(db, uuid);
    },

    // 一人一张照片（配偶也是人，自然也能传）。传 null/'' 即移除。
    setPhoto({ uuid, dataUrl }) {
      const photo = repo.setPhoto(db, uuid, dataUrl);
      return { ok: true, photo };
    },

    // 只取统计，不生成 JSON（导出图片前用来写「共 N 人」）
    branchInfo({ rootUuid }) {
      const root = rootUuid || repo.getMeta(db, 'root_person_uuid');
      const { pkg, descendantCount, spouseCount } = IO.buildPackage(db, { rootUuid: root });
      const rootPerson = pkg.family.person.find((x) => x.uuid === pkg.manifest.root_uuid);
      return {
        rootName: pkg.manifest.root_name,
        rootGen: rootPerson ? rootPerson.gen : null,
        persons: pkg.manifest.counts.person,
        descendantCount,
        spouseCount,
      };
    },

    // ── 偏好设置 ──
    // 目前只存「上次导出到哪个文件夹」。记在 meta 表里，跟着库走，
    // 换台电脑重装程序也不会丢；值只是路径，不含隐私。
    getPref({ key }) {
      if (!key) throw new Error('MISSING_KEY');
      return { key, value: repo.getMeta(db, 'pref.' + key) || null };
    },

    setPref({ key, value }) {
      if (!key) throw new Error('MISSING_KEY');
      repo.setMeta(db, 'pref.' + key, value == null ? '' : String(value));
      return { ok: true };
    },

    /**
     * 保存导出文件（服务端落盘）。
     * 桌面版一般不走到这里——那边弹系统「另存为」，由用户自己选位置；
     * 浏览器调试版用它当兜底目录，避免预览面板把下载拦掉后文件凭空消失。
     */
    saveFile({ fileName, base64, text }) {
      const dir = path.join(dataDir, 'exports');
      fs.mkdirSync(dir, { recursive: true });
      const target = uniquePath(dir, safeFileName(fileName));
      if (base64) fs.writeFileSync(target, Buffer.from(base64, 'base64'));
      else fs.writeFileSync(target, String(text == null ? '' : text), 'utf8');
      return { saved: true, path: target, bytes: fs.statSync(target).size, dir };
    },

    // ── 导出 ──
    exportPackage({ rootUuid, remark, mode }) {
      const root = rootUuid || repo.getMeta(db, 'root_person_uuid');
      const { pkg, descendantCount, spouseCount } = IO.buildPackage(db, { rootUuid: root, remark, mode });
      const json = IO.serialize(pkg);
      return {
        json,
        fileName: IO.defaultFileName(pkg),
        summary: {
          rootName: pkg.manifest.root_name,
          persons: pkg.manifest.counts.person,
          descendantCount,
          spouseCount,
          bytes: Buffer.byteLength(json, 'utf8'),
        },
      };
    },

    /** Excel：一人一行，把人物、婚配、父子三张表都导出来 */
    exportExcel({ rootUuid = null, scopeLabel } = {}) {
      // 不传 rootUuid 就是全谱；传了才按支系裁剪。
      // 不要在这里兜底成 meta 里的始祖——那样「导全谱」会静默变成「导某一支」。
      const root = rootUuid || null;
      const rootPerson = root ? repo.getPerson(db, root) : null;
      const scope = scopeLabel || (rootPerson ? `${rootPerson.name} 一支` : '全谱');

      const { buffer, counts } = exportExcel(db, {
        rootUuid: root,
        clanName: repo.getMeta(db, 'clan_name') || '',
        deviceLabel: repo.getMeta(db, 'device_label') || '',
        scopeLabel: scope,
      });

      const now = new Date();
      const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
      const clan = repo.getMeta(db, 'clan_name') || '族谱';
      const who = rootPerson ? `${rootPerson.name}一支` : '全谱';

      return {
        fileName: `${clan}-${who}-${stamp}.xlsx`,
        base64: buffer.toString('base64'),
        summary: { ...counts, bytes: buffer.length, scope },
      };
    },

    // ── 导入：只看不动 ──
    inspectPackage({ text }) {
      return IO.parsePackage(text).summary;
    },

    importPreview({ anchorUuid, text }) {
      const { pkg, summary } = IO.parsePackage(text);
      const preview = R.previewReplace(db, anchorUuid, pkg);
      return { ...preview, packageSummary: summary };
    },

    // ── 导入：执行 ──
    importExecute({ anchorUuid, text }) {
      const { pkg, summary } = IO.parsePackage(text);
      const backupPath = snapshot(filePath, backupDir, 20);
      const result = R.executeReplace(db, anchorUuid, pkg, { snapshotPath: backupPath });
      return {
        ...result,
        backupPath,
        packageSummary: summary,
        dbStats: repo.stats(db),
      };
    },

    revert({ batchId }) {
      const result = R.revertBatch(db, batchId);
      return { ...result, dbStats: repo.stats(db) };
    },

    batches() {
      return repo.listBatches(db, 20);
    },

    // ── 备份 ──
    backup() {
      const p = snapshot(filePath, backupDir, 20);
      return { path: p };
    },

    close() {
      db.close();
    },
  };

  return api;
}

module.exports = { createApi };
