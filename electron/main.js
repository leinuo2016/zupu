'use strict';

/**
 * Electron 主进程
 * ------------------------------------------------------------
 * 只做四件事：开窗口、给数据目录、接文件对话框、转发 API。
 * 所有业务逻辑在 src/ 下，不依赖 Electron，方便单测和以后换壳。
 */

const path = require('node:path');
const fs = require('node:fs');
const { app, BrowserWindow, Menu, dialog, ipcMain, shell } = require('electron');

const { createApi } = require('../src/api');

// ── 数据目录 ─────────────────────────────────────────────
// 便携版：exe 同级目录下 data/  （拷进 U 盘就能带走）
// 安装版：用户数据目录下的 data/（不写 Program Files，避免权限问题）
function resolvePaths() {
  if (process.env.ZUPU_DATA_DIR) {
    const dir = process.env.ZUPU_DATA_DIR;
    return { dataDir: dir, dbPath: path.join(dir, 'zupu.db'), backupDir: path.join(dir, 'backups') };
  }
  const isPortable = !!process.env.PORTABLE_EXECUTABLE_DIR;
  const base = isPortable
    ? path.join(process.env.PORTABLE_EXECUTABLE_DIR, 'data')
    : path.join(app.getPath('userData'), 'data');
  return { dataDir: base, dbPath: path.join(base, 'zupu.db'), backupDir: path.join(base, 'backups') };
}

const paths = resolvePaths();
fs.mkdirSync(paths.dataDir, { recursive: true });

const api = createApi({ filePath: paths.dbPath, backupDir: paths.backupDir });

let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1080,
    minHeight: 680,
    backgroundColor: '#f6f4ef',
    title: '族谱',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
  mainWindow.once('ready-to-show', () => mainWindow.show());
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

// ── 菜单 ─────────────────────────────────────────────────

function send(action) {
  if (mainWindow) mainWindow.webContents.send('menu:action', action);
}

function buildMenu() {
  const template = [
    {
      label: '文件',
      submenu: [
        { label: '导出本支…', accelerator: 'CmdOrCtrl+E', click: () => send('export') },
        { label: '导入记谱包…', accelerator: 'CmdOrCtrl+O', click: () => send('import') },
        { type: 'separator' },
        { label: '立即备份数据库', click: () => send('backup') },
        {
          label: '打开数据目录',
          click: () => shell.openPath(paths.dataDir),
        },
        { type: 'separator' },
        { role: 'quit', label: '退出' },
      ],
    },
    {
      label: '编辑',
      submenu: [
        { label: '新增子嗣', accelerator: 'CmdOrCtrl+N', click: () => send('addChild') },
        { label: '设为显示根', click: () => send('setRoot') },
        { label: '返回全谱', click: () => send('resetRoot') },
      ],
    },
    {
      label: '视图',
      submenu: [
        { role: 'reload', label: '重新载入' },
        { role: 'toggleDevTools', label: '开发者工具' },
        { type: 'separator' },
        { role: 'resetZoom', label: '实际大小' },
        { role: 'zoomIn', label: '放大' },
        { role: 'zoomOut', label: '缩小' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── IPC ──────────────────────────────────────────────────

ipcMain.handle('api', async (_event, method, args) => {
  if (!api[method]) throw new Error(`UNKNOWN_API: ${method}`);
  return api[method](args || {});
});

ipcMain.handle('dialog:savePackage', async (_event, defaultName, text) => {
  const dir = exportDir();
  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出记谱包',
    defaultPath: path.join(dir, defaultName || '族谱.zupu'),
    filters: [{ name: '记谱包', extensions: ['zupu'] }],
  });
  if (canceled || !filePath) return { saved: false, canceled: true };
  fs.writeFileSync(filePath, text, 'utf8');
  rememberExportDir(filePath);
  return { saved: true, path: filePath, via: 'dialog', bytes: fs.statSync(filePath).size };
});

// 上次导出到哪个文件夹，记在库里；记不住就退回「文档」
function exportDir() {
  const saved = api.getPref({ key: 'export_dir' }).value;
  if (saved && fs.existsSync(saved)) return saved;
  return app.getPath('documents');
}

function rememberExportDir(filePath) {
  try {
    api.setPref({ key: 'export_dir', value: path.dirname(filePath) });
  } catch (_) {
    /* 记不住不影响本次导出 */
  }
}

ipcMain.handle('prefs:exportDir', async () => ({ dir: exportDir(), remembered: !!api.getPref({ key: 'export_dir' }).value }));

// 用户主动指定「以后都存到这里」
ipcMain.handle('dialog:chooseExportDir', async (_event, current) => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择导出的文件夹',
    buttonLabel: '用这个文件夹',
    properties: ['openDirectory', 'createDirectory'],
    defaultPath: current || exportDir(),
  });
  if (canceled || !filePaths || !filePaths.length) return { chosen: false };
  api.setPref({ key: 'export_dir', value: filePaths[0] });
  return { chosen: true, dir: filePaths[0] };
});

ipcMain.handle('dialog:saveFile', async (_event, { fileName, base64, text } = {}) => {
  const ext = path.extname(fileName || '').slice(1).toLowerCase();
  const named = {
    png: { name: 'PNG 图片', extensions: ['png'] },
    jpg: { name: 'JPEG 图片', extensions: ['jpg', 'jpeg'] },
    pdf: { name: 'PDF 文档', extensions: ['pdf'] },
    xlsx: { name: 'Excel 表格', extensions: ['xlsx'] },
    zupu: { name: '记谱包', extensions: ['zupu'] },
    json: { name: 'JSON 数据', extensions: ['json'] },
  };
  const filters = named[ext]
    ? [named[ext], { name: '全部文件', extensions: ['*'] }]
    : [{ name: '全部文件', extensions: ['*'] }];

  const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
    title: '导出',
    defaultPath: path.join(exportDir(), fileName || '族谱导出'),
    filters,
  });
  if (canceled || !filePath) return { saved: false, canceled: true };

  if (base64) fs.writeFileSync(filePath, Buffer.from(base64, 'base64'));
  else fs.writeFileSync(filePath, String(text == null ? '' : text), 'utf8');
  rememberExportDir(filePath);
  return { saved: true, path: filePath, via: 'dialog', bytes: fs.statSync(filePath).size };
});

ipcMain.handle('dialog:openPackage', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    title: '选择记谱包',
    properties: ['openFile'],
    filters: [
      { name: '记谱包', extensions: ['zupu', 'json'] },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  if (canceled || !filePaths || !filePaths.length) return { opened: false };
  const text = fs.readFileSync(filePaths[0], 'utf8');
  return { opened: true, name: path.basename(filePaths[0]), path: filePaths[0], text };
});

ipcMain.handle('shell:showItem', async (_event, filePath) => {
  if (filePath) shell.showItemInFolder(filePath);
});

// ── 生命周期 ─────────────────────────────────────────────

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    buildMenu();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('before-quit', () => {
    try {
      api.close();
    } catch (_) {
      /* ignore */
    }
  });
}
