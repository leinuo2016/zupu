'use strict';

/**
 * 渲染层 API 客户端
 * ------------------------------------------------------------
 * Electron 里直接用 preload 暴露的 window.zupu；
 * 浏览器里（node scripts/dev-server.js）用同名对象走 HTTP。
 * 界面代码只认 window.zupu，不关心跑在哪。
 *
 * 保存位置的三级策略（越靠前越贴近用户预期）：
 *   1. 系统「另存为」对话框（File System Access API）—— 用户自己挑文件夹
 *   2. 浏览器下载 —— 落到下载目录（Chrome 可设为每次询问）
 *   3. 服务端目录 —— 兜底，同时留一份，防止面板把下载拦掉后文件凭空消失
 */

(function () {
  if (window.zupu && window.zupu.isDesktop) return;

  const MIME = {
    zupu: 'application/json;charset=utf-8',
    json: 'application/json;charset=utf-8',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    webp: 'image/webp',
    pdf: 'application/pdf',
    xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  };

  const PICKER_TYPES = {
    png: { description: 'PNG 图片', accept: { 'image/png': ['.png'] } },
    jpg: { description: 'JPEG 图片', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } },
    pdf: { description: 'PDF 文档', accept: { 'application/pdf': ['.pdf'] } },
    xlsx: { description: 'Excel 表格', accept: { 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': ['.xlsx'] } },
    zupu: { description: '记谱包', accept: { 'application/json': ['.zupu'] } },
    json: { description: 'JSON 数据', accept: { 'application/json': ['.json'] } },
  };

  function extOf(name) {
    const m = /\.([^.]+)$/.exec(String(name || ''));
    return m ? m[1].toLowerCase() : '';
  }

  function toBlob({ fileName, base64, text }) {
    const type = MIME[extOf(fileName)] || 'application/octet-stream';
    if (base64) {
      const bin = atob(base64);
      const buf = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) buf[i] = bin.charCodeAt(i);
      return new Blob([buf], { type });
    }
    return new Blob([String(text == null ? '' : text)], { type });
  }

  // 用户已经选好的写入目标。File System Access 的句柄必须在点击的同一拍拿到，
  // 而导出大图要跑好几秒，所以「先选位置、后写入」拆成两步。
  let pendingHandle = null;

  // 服务端「不在」和「在但是旧版本」是完全不同的两件事，界面上给的指引也不同。
  // 这两个事件由 app.js 监听，负责顶上那条红条。
  function reportOffline(message) {
    window.dispatchEvent(new CustomEvent('zupu:offline', { detail: { message } }));
  }

  // 报错里不要出现 exportExcel 这种内部名 —— 用户按这个名字找不到任何按钮
  const METHOD_LABEL = {
    deletePreview: '删除',
    removePerson: '删除',
    exportExcel: '导出 Excel',
    exportPackage: '导出记谱包',
    saveFile: '保存文件',
    getPref: '读取设置',
    setPref: '保存设置',
    importPreview: '导入预检',
    importExecute: '导入',
  };

  async function call(method, args) {
    let res;
    try {
      res = await fetch('/api/' + method, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(args || {}),
      });
    } catch (e) {
      // fetch 直接抛，只有一种情况：压根没连上（服务窗口被关、端口没起、面板只托管了静态文件）
      const msg = '连不上本地服务。请确认运行 npm run dev 的窗口还开着（关掉后要重新启动），然后刷新页面。';
      reportOffline(msg);
      throw new Error(msg);
    }

    let data = null;
    try {
      data = await res.json();
    } catch (e) {
      const msg = `本地服务返回了看不懂的内容（HTTP ${res.status}），多半是服务版本不对，请重启 npm run dev。`;
      reportOffline(msg);
      throw new Error(msg);
    }

    if (!res.ok) {
      const raw = (data && data.error) || `请求失败（HTTP ${res.status}）`;
      // 老进程还在跑时，新加的接口会报 UNKNOWN_API。这句翻译很关键：
      // 否则用户看到的是「导出失败：UNKNOWN_API: exportExcel」，完全无从下手。
      if (/UNKNOWN_API/.test(raw)) {
        const what = METHOD_LABEL[method] || method;
        const msg = `当前运行的服务是旧版本，「${what}」这个操作它不认识。请关掉 npm run dev 的窗口再重新启动（改了 src/ 下的代码必须重启，热重载不生效）。`;
        reportOffline(msg);
        throw new Error(msg);
      }
      throw new Error(raw);
    }

    window.dispatchEvent(new CustomEvent('zupu:online'));
    return data;
  }

  function pickerUsable() {
    if (typeof window.showSaveFilePicker !== 'function') return false;
    // 预览面板的跨域 iframe 里会被浏览器拒绝，支持关掉（测试也用这个开关）
    if (window.__zupuDisablePicker) return false;
    if (/[?&]nopicker\b/.test(location.search)) return false;
    // 跨域 iframe（预览面板就是这种）：选择框也许弹得出来，但真正写入时平台会拒绝
    //（'createWritable ... not allowed by the user agent or the platform'）。
    // 与其让用户在最后一步收到报错，不如一开始就不用这个选择框。
    try {
      if (window.self !== window.top && location.origin !== window.top.location.origin) return false;
    } catch (_) {
      // 跨域时读 top.location 直接抛 SecurityError —— 这正是要拦的场景
      return false;
    }
    return true;
  }

  window.zupu = {
    isDesktop: false,
    platform: 'web',
    invoke: call,

    /** 导出前：先把「写到哪」定下来。返回 {mode, canceled} */
    async beginSave(fileName) {
      pendingHandle = null;
      if (!pickerUsable()) return { mode: 'download' };

      const ext = extOf(fileName);
      const type = PICKER_TYPES[ext];
      try {
        pendingHandle = await window.showSaveFilePicker({
          suggestedName: fileName,
          types: type ? [type] : undefined,
        });
        return { mode: 'picker' };
      } catch (e) {
        if (e && e.name === 'AbortError') return { mode: 'picker', canceled: true };
        // SecurityError / 跨域 iframe / 无用户手势 → 退回下载
        return { mode: 'download' };
      }
    },

    async saveFile(payload) {
      const { fileName } = payload;

      // 1. 用户已经在对话框里选好位置
      if (pendingHandle) {
        const handle = pendingHandle;
        pendingHandle = null;
        try {
          const writable = await handle.createWritable();
          await writable.write(toBlob(payload));
          await writable.close();
          return { saved: true, path: handle.name, via: 'picker' };
        } catch (e) {
          // 「选择框弹得出来」不等于「写得进去」。跨域 iframe 里 createWritable
          // 会被平台拒绝（'request is not allowed by the user agent or the platform'）。
          // 到这里绝不能报错了事——文件还没落到任何地方呢。继续往下走
          // 「浏览器下载 + 服务端留副本」，文件永远要有去处。
        }
      }

      // 2. 浏览器下载（桌面 Chrome 可在设置里勾「下载前询问保存位置」）
      let downloadOk = false;
      let fallbackPath = '';
      try {
        const blob = toBlob(payload);
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        a.rel = 'noopener';
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        downloadOk = true;
      } catch (_) {
        downloadOk = false;
      }

      // 3. 无论下载是否成功，服务端都留一份；面板拦截下载时它才是唯一的出口
      try {
        const res = await call('saveFile', payload);
        fallbackPath = res.path;
      } catch (_) {
        /* 服务端也没写成，就看下载了 */
      }

      if (downloadOk) {
        return {
          saved: true,
          path: `浏览器下载：${fileName}`,
          via: 'download',
          copyPath: fallbackPath,
        };
      }
      if (fallbackPath) return { saved: true, path: fallbackPath, via: 'server' };
      return { saved: false, error: '保存失败：浏览器与本地服务都无法写入' };
    },

    async getExportDir() {
      return { dir: '', remembered: false, web: true };
    },

    async chooseExportDir() {
      return { chosen: false, unsupported: true };
    },

    async savePackageFile(defaultName, text) {
      return this.saveFile({ fileName: defaultName, text });
    },

    openPackageFile() {
      return new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.zupu,.json,application/json';
        input.onchange = async () => {
          const file = input.files && input.files[0];
          if (!file) return resolve({ opened: false });
          try {
            const text = await file.text();
            resolve({ opened: true, name: file.name, text });
          } catch (e) {
            resolve({ opened: false, error: e.message });
          }
        };
        input.click();
      });
    },

    async showItemInFolder() {
      /* 浏览器无此能力 */
    },

    onMenuAction() {
      return () => {};
    },
  };
})();
