'use strict';

/**
 * 预加载脚本：只暴露必要能力，渲染进程拿不到 Node。
 * 渲染层通过 window.zupu 访问，浏览器调试时由 renderer/api-client.js 提供同名实现。
 */

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('zupu', {
  isDesktop: true,
  platform: process.platform,

  invoke: (method, args) => ipcRenderer.invoke('api', method, args || {}),

  savePackageFile: (defaultName, text) => ipcRenderer.invoke('dialog:savePackage', defaultName, text),
  saveFile: (payload) => ipcRenderer.invoke('dialog:saveFile', payload || {}),
  openPackageFile: () => ipcRenderer.invoke('dialog:openPackage'),
  showItemInFolder: (filePath) => ipcRenderer.invoke('shell:showItem', filePath),

  // 导出前先问「写到哪」。桌面版不做预告，等 saveFile 里的系统对话框一起处理，
  // 所以这里只是个空实现，让界面代码两端写法一致。
  beginSave: async () => ({ mode: 'dialog' }),
  getExportDir: () => ipcRenderer.invoke('prefs:exportDir'),
  chooseExportDir: (current) => ipcRenderer.invoke('dialog:chooseExportDir', current),

  onMenuAction: (handler) => {
    const listener = (_event, action) => handler(action);
    ipcRenderer.on('menu:action', listener);
    return () => ipcRenderer.removeListener('menu:action', listener);
  },
});
