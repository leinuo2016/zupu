'use strict';

/**
 * 主界面控制器
 * ------------------------------------------------------------
 * 最小闭环：
 *   打开 → 看到世系树 → 点节点编辑人物 → 选中一支导出记谱包
 *        → 另一台机器选锚点导入替换 → 可精确撤销
 */

(function () {
  const $ = (id) => document.getElementById(id);
  const api = window.zupu;
  const GZ = window.ZupuGanzhi;

  const state = {
    boot: null,
    tree: null,
    selected: null,
    person: null,
    rootUuid: null,
    orient: 'v',
    del: null,
    // 干支是否被手工改过：改过就不再被「年份→干支」覆盖
    gzDirty: { birth: false, death: false },
    wizard: { step: 1, text: '', summary: null, anchor: null, preview: null, batchId: null },
  };

  let view = null;
  let toastTimer = null;

  // ── 工具 ─────────────────────────────────────────────

  function toast(message, type) {
    const el = $('toast');
    el.textContent = message;
    el.className = 'toast' + (type === 'error' ? ' error' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      el.hidden = true;
    }, type === 'error' ? 5200 : 2600);
  }

  function show(el, visible) {
    if (typeof el === 'string') el = $(el);
    if (!el) return;
    el.hidden = !visible;
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  function fmtTime(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return iso;
    const p = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
  }

  // ── 服务连接横幅 ─────────────────────────────────────
  // 「点了没反应」和「弹一句 Failed to fetch」对使用者是同一件事：不知道出了什么事。
  // 连不上时给一条能照着做的指引，比在控制台里留个英文报错有用。

  function setOffline(message) {
    const bar = $('offlineBar');
    if (!bar) return;
    $('offlineText').textContent = message || '连不上本地服务';
    bar.hidden = false;
    document.body.classList.add('offline');
    startReconnect();
  }

  function setOnline() {
    const bar = $('offlineBar');
    if (bar) bar.hidden = true;
    document.body.classList.remove('offline');
    stopReconnect();
  }

  // 服务恢复后自动接回来：用户重启 npm run dev 之后不必再手动刷新页面
  let reconnectTimer = null;

  function stopReconnect() {
    if (reconnectTimer) clearInterval(reconnectTimer);
    reconnectTimer = null;
  }

  function startReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setInterval(async () => {
      try {
        await refreshBootstrap();
        await loadTree({ rootUuid: state.rootUuid, keepView: false });
        setOnline();
        toast('已重新连接到本地服务');
      } catch (_) {
        /* 还没起来，下一轮再试 */
      }
    }, 3000);
  }

  function setupOfflineBar() {
    window.addEventListener('zupu:offline', (e) => setOffline(e.detail && e.detail.message));
    window.addEventListener('zupu:online', setOnline);

    const retry = $('offlineRetry');
    if (!retry) return;
    retry.addEventListener('click', async () => {
      retry.disabled = true;
      retry.textContent = '连接中…';
      try {
        await refreshBootstrap();
        await loadTree();
        setOnline();
        toast('已重新连接');
      } catch (e) {
        setOffline(e.message);
      } finally {
        retry.disabled = false;
        retry.textContent = '重试';
      }
    });
  }

  // ── 启动 ─────────────────────────────────────────────

  async function init() {
    setupOfflineBar();

    view = new ZupuTree($('tree'), {
      onSelect: (uuid) => selectPerson(uuid),
      onEdit: () => focusForm(),
      onZoom: (scale) => {
        $('zoomLabel').textContent = `${Math.round(scale * 100)}%`;
      },
    });

    window.__view = view; // 调试/自动化测试用的句柄

    await restoreOrient();

    new ResizeObserver(() => view.resize()).observe($('tree').parentElement);
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') closeAllModals();
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (state.selected) savePerson();
      }
    });

    await refreshBootstrap();
    await loadTree();

    if (api.onMenuAction) {
      api.onMenuAction((action) => {
        if (action === 'export') openExport();
        if (action === 'import') openImport();
        if (action === 'addChild') openMini('child');
        if (action === 'backup') doBackup();
        if (action === 'setRoot') focusRoot();
        if (action === 'resetRoot') resetRoot();
      });
    }

    if (state.boot && state.boot.rootUuid) selectPerson(state.boot.rootUuid);
    $('statusLeft').textContent = `数据文件：${state.boot.dataPath}（${state.boot.driver}）`;
    show('treeEmpty', state.tree.nodes.length === 0);

    bind();
  }

  // ── 布局方向 ─────────────────────────────────────────

  function orientLabel() {
    return state.orient === 'h' ? '布局：横向' : '布局：纵向';
  }

  function applyOrient(orient, { persist = false } = {}) {
    state.orient = orient === 'h' ? 'h' : 'v';
    if (view) view.setOrient(state.orient);
    $('btnOrient').textContent = orientLabel();
    if (persist) {
      api.invoke('setPref', { key: 'tree_orient', value: state.orient }).catch(() => {});
    }
  }

  async function restoreOrient() {
    let saved = '';
    try {
      const r = await api.invoke('getPref', { key: 'tree_orient' });
      saved = (r && r.value) || '';
    } catch (_) {
      /* 取不到就用默认纵向 */
    }
    applyOrient(saved === 'h' ? 'h' : 'v');
  }

  const MIN_API_REV = 4; // 与服务端 src/api.js 的 API_REV 对齐

  async function refreshBootstrap() {
    state.boot = await api.invoke('bootstrap');
    $('clanName').textContent = state.boot.clanName;
    const s = state.boot.stats;
    $('clanMeta').textContent = `${s.total} 人 · ${s.maxGen} 代 · 本机「${state.boot.deviceLabel}」`;
    renderBatchHint();

    // 服务端版本比界面旧：接口缺失会表现为「删除 / 导出 Excel 点了报错」，
    // 这里提前说清楚，省得对着「导出失败」猜。
    const rev = Number(state.boot.apiRev) || 0;
    if (rev < MIN_API_REV) {
      setOffline('当前运行的是旧版本服务，新功能（删除确认、导出 Excel）用不了。请关掉 npm run dev 的窗口重新启动。');
    }
  }

  function renderBatchHint() {
    const b = (state.boot.batches || []).find((x) => !x.reverted);
    if (!b) {
      $('statusBatch').textContent = '尚无导入记录';
      return;
    }
    $('statusBatch').textContent = `上次导入：${b.source_device || '未知'} · ${fmtTime(b.imported_at)}`;
  }

  async function loadTree({ rootUuid = null, keepView = false } = {}) {
    state.tree = await api.invoke('tree', { rootUuid });
    state.rootUuid = rootUuid;
    view.setData(state.tree, { keepView });
    show('treeEmpty', state.tree.nodes.length === 0);
  }

  // ── 选中与档案 ───────────────────────────────────────

  async function selectPerson(uuid, { center = false } = {}) {
    if (!uuid) return;
    state.selected = uuid;
    view.select(uuid, { silent: true });
    if (center) view.centerOn(uuid);

    const p = await api.invoke('person', { uuid });
    if (!p) {
      toast('这个人物可能已被删除', 'error');
      return;
    }
    state.person = p;
    renderPanel(p);
  }

  function renderPanel(p) {
    show('panelEmpty', false);
    show('panelBody', true);

    $('pName').textContent = p.name;
    const bits = [];
    if (p.gen != null) bits.push(GZ.shiLabelFull(p.gen));
    bits.push(p.gender === 2 ? '女' : p.gender === 1 ? '男' : '性别未记');
    bits.push(p.alive ? '在世' : '已故');
    // 生卒带干支一起显示：老谱核对时看的就是这两个字
    const life = [];
    if (p.birth.year != null || p.birth.ganzhi) {
      life.push(`生 ${[p.birth.year ?? '', p.birth.ganzhi].filter(Boolean).join(' ')}`.trim());
    }
    if (!p.alive && (p.death.year != null || p.death.ganzhi)) {
      life.push(`卒 ${[p.death.year ?? '', p.death.ganzhi].filter(Boolean).join(' ')}`.trim());
    }
    $('pMeta').textContent = bits.join(' · ') + (life.length ? ` · ${life.join('，')}` : '');

    $('fSurname').value = p.surname || '';
    $('fGiven').value = p.given_name || '';
    $('fGenChar').value = p.gen_char || '';
    $('fGender').value = String(p.gender ?? 0);
    $('fAlive').value = p.alive ? '1' : '0';
    $('fBirth').value = p.birth.text || '';
    $('fBirthYear').value = p.birth.year ?? '';
    $('fBirthGz').value = p.birth.ganzhi || '';
    $('fDeath').value = p.death.text || '';
    $('fDeathYear').value = p.death.year ?? '';
    $('fDeathGz').value = p.death.ganzhi || '';
    $('fBurial').value = p.burial.place || '';
    $('fNote').value = p.note || '';
    renderPhoto(p);
    $('saveHint').textContent = '';
    state.gzDirty = { birth: false, death: false };

    // 子嗣
    const cl = $('childList');
    cl.innerHTML = '';
    $('childCount').textContent = String(p.children.length);
    if (!p.children.length) {
      cl.innerHTML = '<li class="empty">暂无记录</li>';
    } else {
      for (const c of p.children) {
        const li = document.createElement('li');
        li.innerHTML =
          (c.kind && c.kind !== '生' ? `<span class="chip-kind">${esc(c.kind)}</span>` : '') +
          `<span>${esc(c.name)}</span>`;
        li.onclick = () => selectPerson(c.child_uuid, { center: true });
        cl.appendChild(li);
      }
    }

    // 配偶
    const sl = $('spouseList');
    sl.innerHTML = '';
    $('spouseCount').textContent = String(p.unions.length);
    if (!p.unions.length) {
      sl.innerHTML = '<li class="empty">暂无记录</li>';
    } else {
      for (const u of p.unions) {
        const li = document.createElement('li');
        li.innerHTML =
          `<span class="chip-kind">${esc(u.kind || '配')}</span><span>${esc(u.spouseName)}</span>`;
        if (u.spouseUuid) li.onclick = () => selectPerson(u.spouseUuid, { center: true });
        sl.appendChild(li);
      }
    }

    // 父母
    const pl = $('parentList');
    pl.innerHTML = '';
    if (!p.parents.length) {
      pl.innerHTML = '<li class="empty">暂无记录（可能是始祖）</li>';
    } else {
      for (const e of p.parents) {
        const li = document.createElement('li');
        li.innerHTML =
          (e.kind && e.kind !== '生' ? `<span class="chip-kind">${esc(e.kind)}</span>` : '') +
          `<span>${esc(e.name)}</span>`;
        li.onclick = () => selectPerson(e.parent_uuid, { center: true });
        pl.appendChild(li);
      }
    }

    $('exportName').textContent = p.name;
  }

  function focusForm() {
    $('fGiven').focus();
    $('fGiven').select();
  }

  // ── 年份 ↔ 干支 ───────────────────────────────────────
  // 手填过干支就不再覆盖：老谱上「乾隆壬寅」对应 1782，但族里可能按另一年记，
  // 人的判断优先于程序推算。

  function syncGanzhi(kind) {
    if (state.gzDirty[kind]) return;
    const yearEl = kind === 'birth' ? $('fBirthYear') : $('fDeathYear');
    const gzEl = kind === 'birth' ? $('fBirthGz') : $('fDeathGz');
    const raw = yearEl.value.trim();
    const y = Number(raw);
    gzEl.value = raw !== '' && Number.isFinite(y) ? GZ.ganzhiOfYear(y) || '' : '';
  }

  function guessGanzhiFromText(kind) {
    const textEl = kind === 'birth' ? $('fBirth') : $('fDeath');
    const gzEl = kind === 'birth' ? $('fBirthGz') : $('fDeathGz');
    const yearEl = kind === 'birth' ? $('fBirthYear') : $('fDeathYear');

    if (!gzEl.value.trim()) {
      const g = GZ.findGanzhi(textEl.value);
      if (g) gzEl.value = g;
    }
    if (!yearEl.value.trim()) {
      const y = GZ.findYear(textEl.value);
      if (y) {
        yearEl.value = y;
        syncGanzhi(kind);
      }
    }
  }

  // ── 保存 ─────────────────────────────────────────────

  async function savePerson() {
    if (!state.person) return;
    const payload = {
      uuid: state.person.uuid,
      surname: $('fSurname').value.trim(),
      given_name: $('fGiven').value.trim(),
      gen_char: $('fGenChar').value.trim(),
      gender: Number($('fGender').value),
      alive: $('fAlive').value === '1',
      branch_id: state.person.branch_id || null,
      note: $('fNote').value.trim(),
      birth: {
        text: $('fBirth').value.trim(),
        year: $('fBirthYear').value.trim(),
        ganzhi: $('fBirthGz').value.trim(),
      },
      death: {
        text: $('fDeath').value.trim(),
        year: $('fDeathYear').value.trim(),
        ganzhi: $('fDeathGz').value.trim(),
      },
      burial: { place: $('fBurial').value.trim() },
    };

    try {
      await api.invoke('savePerson', payload);
      await loadTree({ rootUuid: state.rootUuid, keepView: true });
      await selectPerson(payload.uuid);
      $('saveHint').textContent = `已保存 ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
      await refreshBootstrap();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ── 迷你表单（子嗣 / 配偶）──────────────────────────

  const mini = { mode: 'child', parentUuid: null };

  function openMini(mode) {
    if (!state.person) {
      toast('请先在左侧点选一个人物');
      return;
    }
    mini.mode = mode;
    mini.parentUuid = state.person.uuid;
    $('miniTitle').textContent = mode === 'child' ? `为「${state.person.name}」新增子嗣` : `为「${state.person.name}」新增配偶`;
    $('miniHint').textContent =
      mode === 'child'
        ? '谱名优先，字号可稍后在档案里补。代次会按父辈自动计算。'
        : '配偶不归属本支房次：替换本支时只会解除婚姻关系，不会删除配偶本人。';
    $('miniSurname').value = mode === 'child' ? state.person.surname || '' : '';
    $('miniGiven').value = '';
    $('miniGender').value = mode === 'child' ? '1' : state.person.gender === 2 ? '1' : '2';
    $('miniBirth').value = '';
    show('miniMask', true);
    setTimeout(() => $('miniGiven').focus(), 30);
  }

  async function submitMini() {
    const person = {
      surname: $('miniSurname').value.trim(),
      given_name: $('miniGiven').value.trim(),
      gender: Number($('miniGender').value),
      birth: { text: $('miniBirth').value.trim() },
    };
    if (!person.given_name) {
      toast('请填写名字', 'error');
      return;
    }

    try {
      const res =
        mini.mode === 'child'
          ? await api.invoke('addChild', { parentUuid: mini.parentUuid, person })
          : await api.invoke('addSpouse', { personUuid: mini.parentUuid, person });

      show('miniMask', false);
      await loadTree({ rootUuid: state.rootUuid, keepView: true });
      await selectPerson(res.uuid, { center: true });
      await refreshBootstrap();
      toast(mini.mode === 'child' ? '子嗣已新增' : '配偶已新增');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  // ── 照片：一人一张（配偶也是人，自然也有）────────────────────
  // 存的是 data URL（data:image/...;base64,...），直接进 person 表，
  // 跟着 .zupu 包走——换电脑、整支导入都带着，不搞第二个「图片文件夹」。

  function renderPhoto(p) {
    const img = $('photoImg');
    const empty = $('photoEmpty');
    if (p.photo) {
      img.src = p.photo;
      img.hidden = false;
      empty.hidden = true;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
      empty.hidden = false;
    }
    $('photoDownload').hidden = !p.photo;
    $('photoRemove').hidden = !p.photo;
  }

  /** 大图压到长边 ≤1200px 的 JPEG；小图原样存（png 透明背景不折腾）。 */
  function compressImage(file) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('读不出这个文件'));
      reader.onload = () => {
        if (file.size <= 500 * 1024) {
          resolve(String(reader.result));
          return;
        }
        const img = new Image();
        img.onerror = () => reject(new Error('这不是能识别的图片'));
        img.onload = () => {
          const MAX = 1200;
          const scale = Math.min(1, MAX / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.round(img.width * scale);
          canvas.height = Math.round(img.height * scale);
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        };
        img.src = String(reader.result);
      };
      reader.readAsDataURL(file);
    });
  }

  async function onPhotoChosen(ev) {
    const input = ev.target;
    const file = input.files && input.files[0];
    input.value = ''; // 允许连续选同一张
    if (!file || !state.person) return;
    if (file.size > 20 * 1024 * 1024) {
      toast('图片太大（超过 20MB），请先在外面压一压', 'error');
      return;
    }
    try {
      const dataUrl = await compressImage(file);
      const r = await api.invoke('setPhoto', { uuid: state.person.uuid, dataUrl });
      state.person.photo = r.photo;
      renderPhoto({ photo: r.photo });
      toast('照片已保存');
    } catch (e) {
      toast(`照片保存失败：${e.message}`, 'error');
    }
  }

  async function onPhotoDownload() {
    const p = state.person;
    if (!p || !p.photo) return;
    const m = /^data:image\/(\w+);base64,(.+)$/.exec(p.photo);
    if (!m) return;
    const ext = m[1] === 'jpeg' ? 'jpg' : m[1];
    const fileName = `${p.name}-照片.${ext}`;
    try {
      const target = await api.beginSave(fileName);
      if (target.canceled) return;
      const r = await api.saveFile({ fileName, base64: m[2] });
      toast(`照片已保存：${r.path || fileName}`);
    } catch (e) {
      toast(`保存失败：${e.message}`, 'error');
    }
  }

  async function onPhotoRemove() {
    const p = state.person;
    if (!p || !p.photo) return;
    try {
      await api.invoke('setPhoto', { uuid: p.uuid, dataUrl: null });
      p.photo = null;
      renderPhoto({ photo: null });
      toast('照片已移除');
    } catch (e) {
      toast(`移除失败：${e.message}`, 'error');
    }
  }

  function openPhotoLight() {
    const p = state.person;
    if (!p || !p.photo) return;
    let light = document.getElementById('photoLight');
    if (!light) {
      light = document.createElement('div');
      light.id = 'photoLight';
      light.innerHTML = '<img alt="照片" />';
      document.body.appendChild(light);
      light.addEventListener('click', () => light.remove());
    }
    light.querySelector('img').src = p.photo;
  }

  /**
   * 删除：先算「会失去谁」，摆出来再让人确认。
   * 不用 window.confirm —— Electron 渲染进程与沙箱 iframe 都不可靠，
   * 而且原生 confirm 根本没法把名单列出来。
   */
  async function deletePerson() {
    if (!state.person) return;
    let info;
    try {
      info = await api.invoke('deletePreview', { uuid: state.person.uuid });
    } catch (e) {
      toast(e.message, 'error');
      return;
    }

    state.del = info;
    $('delName').textContent = info.person;
    $('delMeta').textContent =
      `${info.genLabel || ''} · 将移除 ${info.total} 人` +
      (info.descendants ? `（含后代 ${info.descendants} 人）` : '（无后代）');

    const parts = [];
    if (info.names.length) {
      const more = info.total > info.names.length ? ` 等 ${info.total} 人` : '';
      parts.push(
        `<div class="warn-title">将从谱中移除</div><div class="warn-names">${info.names
          .map(esc)
          .join('、')}${more}</div>`
      );
    }
    if (info.externalSpouses.length) {
      parts.push(
        `<div class="warn-note">外支配偶只解除婚姻、不删除本人：${info.externalSpouses.map(esc).join('、')}</div>`
      );
    }
    $('delList').innerHTML = parts.join('');

    $('delConfirm').checked = false;
    $('delOk').disabled = true;
    show('deleteMask', true);
  }

  async function confirmDelete() {
    if (!state.person || !state.del) return;
    const name = state.del.person;
    const btn = $('delOk');
    btn.disabled = true;
    btn.textContent = '删除中…';
    try {
      const res = await api.invoke('removePerson', { uuid: state.person.uuid, cascade: true });
      show('deleteMask', false);
      state.selected = null;
      state.person = null;
      state.del = null;
      show('panelBody', false);
      show('panelEmpty', true);
      await loadTree({ rootUuid: state.rootUuid, keepView: true });
      await refreshBootstrap();
      const extra = res.externalSpouses ? `，${res.externalSpouses} 位外支配偶仅解婚` : '';
      toast(`已删除「${name}」等 ${res.removed} 人${extra}`);
    } catch (e) {
      toast(e.message, 'error');
    } finally {
      btn.textContent = '确认删除';
      btn.disabled = !$('delConfirm').checked;
    }
  }

  // ── 导出：记谱包 / PNG / PDF ─────────────────────────

  let exportInfo = null;
  let lastExportPath = '';
  let lastExportDir = '';

  async function openExport() {
    if (!state.selected) {
      toast('请先在左侧世系图中点选要导出的那一支');
      return;
    }
    const p = state.person;
    $('expWho').textContent = p.name;
    $('expMeta').textContent = `第 ${p.gen ?? '?'} 代 · 含此人全部后代及其配偶`;
    $('expRemark').value = '';
    $('expResult').hidden = true;
    show('expResultAlt', false);
    show('expOpenFolder', false);
    lastExportPath = '';
    $('expOk').textContent = '导出';
    $('expOk').disabled = false;
    syncExportForm();
    loadExportDir();
    show('exportMask', true);

    // 人数统计稍后补上，不阻塞弹窗出现
    exportInfo = null;
    try {
      exportInfo = await api.invoke('branchInfo', { rootUuid: state.selected });
      $('expMeta').textContent =
        `第 ${exportInfo.rootGen ?? '?'} 代起 · 共 ${exportInfo.persons} 人（其中配偶 ${exportInfo.spouseCount}）`;
    } catch (e) {
      /* 统计失败不影响导出 */
    }
  }

  function syncExportForm() {
    const fmt = $('expFormat').value;
    show('expRowImage', fmt === 'png' || fmt === 'pdf');
    show('expRowRemark', fmt === 'zupu');
    $('expPaper').disabled = fmt !== 'pdf';
    $('expHint').textContent =
      fmt === 'zupu'
        ? '导入方在树里选一个节点当锚点，该节点以下的内容将与包内完全一致（不做合并）。'
        : fmt === 'xlsx'
          ? '四张表：人物（一人一行，含世次、生卒的年份与干支、父母、配偶、备注）、婚配、父子、说明。'
          : fmt === 'pdf'
            ? '「图页」：把整幅世系图封进单页 PDF，适合打印悬挂或存档；页面内是位图，文字不可选中。'
            : '整幅世系图按所选倍率出图，不受当前缩放与窗口大小影响，可直接发微信。';
  }

  /** 显示「会存到哪」，桌面版可改默认文件夹 */
  async function loadExportDir() {
    const desktop = !!api.isDesktop;
    show('expDirLine', desktop);
    show('expChangeDir', desktop);
    $('expDirHint').textContent = desktop
      ? '每次导出都会弹「另存为」，可随时改到别的文件夹；这里设的是它每次默认打开的位置。'
      : '点「导出」后由浏览器询问保存位置。若浏览器不允许弹选择框，会存到下载目录，并在本机数据目录留一份副本。';
    if (!desktop) return;
    $('expDirText').textContent = lastExportDir || '文档';
    try {
      const r = await api.getExportDir();
      if (r && r.dir) {
        lastExportDir = r.dir;
        $('expDirText').textContent = r.dir;
      }
    } catch (_) {
      /* 取不到就显示默认 */
    }
  }

  async function doExport() {
    const fmt = $('expFormat').value;
    const remark = $('expRemark').value.trim();
    const p = state.person;
    const btn = $('expOk');
    if (!p) return;

    btn.disabled = true;
    btn.textContent = fmt === 'zupu' ? '正在打包…' : fmt === 'xlsx' ? '正在整理表格…' : '正在出图…';

    const now = new Date();
    const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
    const base = `${state.boot.clanName}-${p.name}一支-${stamp}`;

    try {
      if (fmt === 'zupu') {
        const res = await api.invoke('exportPackage', { rootUuid: state.selected, remark });
        const target = await api.beginSave(res.fileName);
        if (target && target.canceled) return;
        const saved = await api.saveFile({ fileName: res.fileName, text: res.json });
        finishExport(
          saved,
          `记谱包 · ${res.summary.persons} 人（后代 ${res.summary.descendantCount}、配偶 ${res.summary.spouseCount}）`
        );
      } else if (fmt === 'xlsx') {
        const res = await api.invoke('exportExcel', { rootUuid: state.selected });
        const target = await api.beginSave(res.fileName);
        if (target && target.canceled) return;
        const saved = await api.saveFile({ fileName: res.fileName, base64: res.base64 });
        finishExport(
          saved,
          `Excel · 人物 ${res.summary.persons} 行、婚配 ${res.summary.unions} 行、父子 ${res.summary.edges} 行`
        );
      } else {
        const scale = Number($('expScale').value) || 3;
        const persons = exportInfo ? exportInfo.persons : state.tree.nodes.length;

        // 必须先问「存到哪」再渲染：浏览器的文件选择框只认点击那一刻的用户手势，
        // 等 3× 大图渲染完（可能好几秒）再弹就会被拒。
        const fileName = fmt === 'png' ? `${base}.png` : `${base}.pdf`;
        const target = await api.beginSave(fileName);
        if (target && target.canceled) return;

        const rendered = view.renderAll({
          scale,
          title: `${state.boot.clanName}　${p.name} 一支世系图`,
          subtitle: `第 ${p.gen ?? '?'} 代起 · 共 ${persons} 人 · 导出于 ${fmtTime(now.toISOString())} · 本机「${state.boot.deviceLabel}」`,
          note: remark ? `说明：${remark}` : '',
          legend: true,
        });

        if (fmt === 'png') {
          const dataUrl = rendered.canvas.toDataURL('image/png');
          const saved = await api.saveFile({ fileName, base64: dataUrl.split(',')[1] });
          finishExport(saved, `PNG ${rendered.width}×${rendered.height}`);
        } else {
          const jpeg = await ZupuPdf.canvasToJpeg(rendered.canvas, 0.94);
          const bytes = ZupuPdf.build(jpeg, {
            page: $('expPaper').value,
            imgW: rendered.width,
            imgH: rendered.height,
          });
          const saved = await api.saveFile({ fileName, base64: ZupuPdf.toBase64(bytes) });
          finishExport(saved, `PDF ${rendered.width}×${rendered.height}`);
        }
      }
    } catch (e) {
      toast(`导出失败：${e.message}`, 'error');
    } finally {
      btn.disabled = false;
      if (btn.textContent !== '再导一次') btn.textContent = '导出';
    }
  }

  function finishExport(saved, detail) {
    if (!saved) return;
    if (saved.saved === false) {
      // 用户自己按了取消，不必弹红色报错
      if (saved.canceled) {
        $('statusLeft').textContent = '已取消导出';
        return;
      }
      toast(saved.error || '保存失败', 'error');
      return;
    }
    const size = saved.bytes ? ` · ${Math.max(1, Math.round(saved.bytes / 1024))} KB` : '';
    lastExportPath = saved.path || '';
    $('expResult').hidden = false;
    $('expResultHead').textContent = '已导出';
    $('expResultPath').textContent = `${saved.path}${size}`;
    $('expResultPath').title = saved.path || '';

    // 浏览器下载时服务端也留了一份，面板把下载拦掉时靠它找回文件
    const alt =
      saved.copyPath && saved.copyPath !== saved.path ? `另存副本：${saved.copyPath}` : '';
    show('expResultAlt', !!alt);
    $('expResultAlt').textContent = alt;

    show('expOpenFolder', !!lastExportPath && !!api.isDesktop);
    $('statusLeft').textContent = `已导出：${saved.path}`;
    $('expOk').textContent = '再导一次';
    toast(`已导出 · ${detail}${size}`);
  }

  // ── 导入向导 ─────────────────────────────────────────

  function openImport() {
    state.wizard = { step: 1, text: '', summary: null, anchor: null, preview: null, batchId: null };
    renderWizardAnchor();
    show('pkgBox', false);
    show('wizardWarn1', false);
    $('wizardNext').textContent = '下一步';
    $('wizardNext').disabled = true;
    $('wizardChoose').disabled = false;
    show('confirmBox', true);
    show('doneBox', false);
    $('confirmInput').value = '';
    setWizardStep(1);
    show('importMask', true);
  }

  function renderWizardAnchor() {
    const p = state.person;
    state.wizard.anchor = p ? { uuid: p.uuid, name: p.name, gen: p.gen } : null;

    const box = $('anchorBox');
    if (!p) {
      $('anchorName').textContent = '未选中';
      $('anchorSub').textContent = '请先在左侧世系图中点选一个节点，再回来导入';
      box.classList.add('bad');
      return;
    }
    box.classList.remove('bad');
    $('anchorName').textContent = p.name;
    $('anchorSub').textContent = `第 ${p.gen ?? '?'} 代 · ${p.children.length} 个子嗣将一并被替换`;
  }

  function setWizardStep(step) {
    state.wizard.step = step;
    document.querySelectorAll('.wizard-body').forEach((el) => {
      el.hidden = Number(el.dataset.step) !== step;
    });
    document.querySelectorAll('#wizardSteps li').forEach((li) => {
      const n = Number(li.dataset.step);
      li.classList.toggle('active', n === step);
      li.classList.toggle('done', n < step);
    });
    show('wizardChoose', step === 1);
    show('wizardNext', true);
    $('wizardCancel').textContent = '取消';
  }

  async function choosePackage() {
    const picked = await api.openPackageFile();
    if (!picked || !picked.opened) return;
    try {
      const summary = await api.invoke('inspectPackage', { text: picked.text });
      state.wizard.text = picked.text;
      state.wizard.summary = summary;

      $('pkgFrom').textContent = summary.from;
      $('pkgTime').textContent = fmtTime(summary.exportedAt);
      $('pkgRoot').textContent = `${summary.rootName}（第 ${summary.rootGen ?? '?'} 代）`;
      $('pkgCount').textContent = `${summary.persons} 人 · ${summary.edges} 条父子关系`;
      if (summary.remark) {
        $('pkgRemark').textContent = summary.remark;
        show('pkgRemarkRow', true);
      } else {
        show('pkgRemarkRow', false);
      }
      show('pkgBox', true);

      // 结构性问题先摆出来，别等执行时才发现
      const warns = [];
      if (summary.danglingEdges) warns.push(`包内有 ${summary.danglingEdges} 条父子关系指向包外的人，导入后会被忽略`);
      if (summary.danglingUnions) warns.push(`包内有 ${summary.danglingUnions} 条婚姻记录指向包外的人，导入后会被忽略`);
      if (state.wizard.anchor && summary.rootName && summary.rootName !== state.wizard.anchor.name) {
        warns.push(`包内根节点是「${summary.rootName}」，本地锚点是「${state.wizard.anchor.name}」——请确认没有选错节点`);
      }
      if (warns.length) {
        $('wizardWarn1').innerHTML = warns.map(esc).join('<br />');
        show('wizardWarn1', true);
      } else {
        show('wizardWarn1', false);
      }

      $('wizardNext').disabled = !state.wizard.anchor;
      $('statusLeft').textContent = `已选择：${picked.name}`;
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function gotoPreview() {
    if (!state.wizard.text) {
      toast('请先选择记谱包');
      return;
    }
    if (!state.wizard.anchor) {
      toast('请先在左侧点选锚点');
      return;
    }
    try {
      const preview = await api.invoke('importPreview', {
        anchorUuid: state.wizard.anchor.uuid,
        text: state.wizard.text,
      });
      state.wizard.preview = preview;
      renderPreview(preview);
      setWizardStep(2);
      $('wizardNext').textContent = '继续';
      $('wizardNext').disabled = false;
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  function renderPreview(pv) {
    const c = pv.counts;
    $('previewStats').innerHTML = [
      stat('本地锚点', pv.anchor.name, `第 ${pv.anchor.gen ?? '?'} 代`),
      stat('包内新根', pv.newRoot.name, `第 ${pv.newRoot.gen ?? '?'} 代`),
      stat('将删除', c.willDelete, '本支现有节点', true),
      stat('将新增', c.willInsert, '包内独有的节点'),
      stat('覆盖更新', c.willOverwrite, '双方都有的节点'),
      stat('本地独有', c.localOnly, '包内不存在', true),
    ].join('');

    $('previewWarnings').innerHTML = (pv.warnings || [])
      .map((w) => `<div class="warn-item">${esc(w)}</div>`)
      .join('');

    $('localOnlyCount').textContent = String(pv.localOnlyList.length);
    $('localOnlyList').innerHTML = pv.localOnlyList.length
      ? pv.localOnlyList.map((p) => `<li>${esc(p.name)}</li>`).join('')
      : '<li>无</li>';
  }

  function stat(label, value, sub, danger) {
    return `<div class="stat${danger ? ' danger' : ''}"><b>${esc(value)}</b><span>${esc(label)}${sub ? ' · ' + esc(sub) : ''}</span></div>`;
  }

  function gotoConfirm() {
    setWizardStep(3);
    $('wizardNext').textContent = '执行替换';
    $('wizardNext').disabled = true;
    $('confirmName').textContent = `「${state.wizard.anchor.name}」`;
    setTimeout(() => $('confirmInput').focus(), 30);
  }

  async function executeImport() {
    $('wizardNext').disabled = true;
    $('wizardNext').textContent = '执行中…';
    try {
      const res = await api.invoke('importExecute', {
        anchorUuid: state.wizard.anchor.uuid,
        text: state.wizard.text,
      });
      state.wizard.batchId = res.batchId;

      const s = res.stats || {};
      $('doneStats').innerHTML = [
        stat('删除', s.deleted ?? 0, '旧节点', true),
        stat('新增', s.inserted ?? 0, '包内节点'),
        stat('重挂', s.relinked ?? 0, '父级子嗣关系'),
        stat('解婚', s.unionsBroken ?? 0, '外支配偶仅解婚'),
      ].join('');
      $('backupPath').textContent = res.backupPath ? `执行前已备份：${res.backupPath}` : '';

      show('confirmBox', false);
      show('doneBox', true);
      show('wizardNext', false);
      show('wizardChoose', false);
      $('wizardCancel').textContent = '关闭';

      await loadTree({ rootUuid: null });
      await refreshBootstrap();
      // 锚点身份已换成包内 UUID，重新定位到新根
      const newRoot = res.newRootUuid || state.wizard.anchor.uuid;
      await selectPerson(newRoot, { center: true });
      toast('导入完成，可在底部「导入记录」里撤销');
    } catch (e) {
      toast(e.message, 'error');
      $('wizardNext').textContent = '执行替换';
      $('wizardNext').disabled = false;
    }
  }

  async function undoBatch(batchId, { silent = false } = {}) {
    if (!silent && !window.confirm('撤销这次导入？\n\n只会回滚该次导入带来的变化，之后你自己录入的内容不受影响。')) return;
    try {
      const res = await api.invoke('revert', { batchId: Number(batchId) });
      await loadTree({ rootUuid: null });
      await refreshBootstrap();
      toast(`已撤销：复活 ${res.restored} 人，移除 ${res.removed} 人`);
      if (state.person) selectPerson(state.person.uuid);
      closeModal('importMask');
      closeModal('batchesMask');
      renderBatches();
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function renderBatches() {
    const list = await api.invoke('batches');
    const ul = $('batchList');
    if (!list.length) {
      ul.innerHTML = '<li class="muted">还没有导入记录。</li>';
      return;
    }
    ul.innerHTML = '';
    for (const b of list) {
      const li = document.createElement('li');
      li.className = 'batch-item' + (b.reverted ? ' reverted' : '');
      const st = b.stats || {};
      li.innerHTML = `
        <div class="batch-title">
          <b>#${b.id}</b>
          <span>${esc(b.source_device || '未知来源')}</span>
          <span class="pill">${b.reverted ? '已撤销' : '有效'}</span>
          <span class="spacer" style="flex:1"></span>
          <span class="muted">${fmtTime(b.imported_at)}</span>
        </div>
        <div class="muted">删除 ${st.deleted ?? 0} · 新增 ${st.inserted ?? 0} · 重挂 ${st.relinked ?? 0} · 解婚 ${st.unionsBroken ?? 0}</div>
      `;
      if (!b.reverted) {
        const btn = document.createElement('button');
        btn.className = 'link-btn';
        btn.textContent = '撤销这次导入';
        btn.style.justifySelf = 'start';
        btn.onclick = () => undoBatch(b.id);
        li.appendChild(btn);
      }
      ul.appendChild(li);
    }
  }

  // ── 其它 ─────────────────────────────────────────────

  async function doBackup() {
    try {
      const res = await api.invoke('backup');
      toast(res.path ? `已备份到 ${res.path}` : '备份失败：数据文件尚未生成');
    } catch (e) {
      toast(e.message, 'error');
    }
  }

  async function focusRoot() {
    if (!state.selected) return;
    await loadTree({ rootUuid: state.selected });
    view.fit();
    $('statusLeft').textContent = `正在只看「${state.person ? state.person.name : ''}」这一支 · 点「全谱」返回`;
  }

  async function resetRoot() {
    await loadTree({ rootUuid: null });
    view.fit();
    $('statusLeft').textContent = `数据文件：${state.boot.dataPath}（${state.boot.driver}）`;
  }

  function closeModal(id) {
    show(id, false);
  }

  function closeAllModals() {
    ['miniMask', 'importMask', 'batchesMask', 'exportMask', 'deleteMask'].forEach((id) => show(id, false));
  }

  // ── 事件绑定 ─────────────────────────────────────────

  function bind() {
    $('btnExport').onclick = openExport;
    $('btnExportBranch').onclick = openExport;
    $('btnImport').onclick = openImport;
    $('btnAddChild').onclick = () => openMini('child');
    $('btnAddChild2').onclick = () => openMini('child');
    $('btnAddSpouse').onclick = () => openMini('spouse');
    $('btnAddSpouse2').onclick = () => openMini('spouse');
    $('btnRoot').onclick = resetRoot;
    $('btnFocusRoot').onclick = focusRoot;
    $('btnDelete').onclick = deletePerson;

    // 照片：上传即时入库（不用点「保存」），下载走选位置链路
    $('photoFile').onchange = onPhotoChosen;
    $('photoDownload').onclick = onPhotoDownload;
    $('photoRemove').onclick = onPhotoRemove;
    $('photoImg').onclick = openPhotoLight;
    $('btnSave').onclick = (e) => {
      e.preventDefault();
      savePerson();
    };
    $('personForm').onsubmit = (e) => {
      e.preventDefault();
      savePerson();
    };

    // 年份 → 干支自动填；手改干支后不再覆盖
    $('fBirthYear').oninput = () => syncGanzhi('birth');
    $('fDeathYear').oninput = () => syncGanzhi('death');
    $('fBirthGz').oninput = () => {
      state.gzDirty.birth = true;
    };
    $('fDeathGz').oninput = () => {
      state.gzDirty.death = true;
    };
    $('fBirth').oninput = () => guessGanzhiFromText('birth');
    $('fDeath').oninput = () => guessGanzhiFromText('death');

    $('delCancel').onclick = () => show('deleteMask', false);
    $('delConfirm').onchange = (e) => {
      $('delOk').disabled = !e.target.checked;
    };
    $('delOk').onclick = confirmDelete;

    $('btnOrient').onclick = () => {
      applyOrient(state.orient === 'v' ? 'h' : 'v', { persist: true });
      toast(state.orient === 'h' ? '已切换为横向（自左向右看，适合投屏）' : '已切换为纵向（自上而下看，适合打印）');
    };

    $('btnZoomIn').onclick = () => view.zoomBy(1.2);
    $('btnZoomOut').onclick = () => view.zoomBy(1 / 1.2);
    $('btnFit').onclick = () => view.fit();

    $('expFormat').onchange = syncExportForm;
    $('expCancel').onclick = () => show('exportMask', false);
    $('expOk').onclick = doExport;

    $('expChangeDir').onclick = async () => {
      try {
        const r = await api.chooseExportDir(lastExportDir);
        if (r && r.chosen) {
          lastExportDir = r.dir;
          $('expDirText').textContent = r.dir;
          toast('以后导出默认打开这个文件夹');
        }
      } catch (e) {
        toast(e.message, 'error');
      }
    };
    $('expOpenFolder').onclick = () => {
      if (lastExportPath && api.showItemInFolder) api.showItemInFolder(lastExportPath);
    };

    $('miniCancel').onclick = () => show('miniMask', false);
    $('miniOk').onclick = submitMini;
    $('miniGiven').onkeydown = (e) => {
      if (e.key === 'Enter') submitMini();
    };

    $('wizardCancel').onclick = () => show('importMask', false);
    $('wizardChoose').onclick = choosePackage;
    $('wizardNext').onclick = () => {
      const step = state.wizard.step;
      if (step === 1) return gotoPreview();
      if (step === 2) return gotoConfirm();
      if (step === 3) return executeImport();
    };
    $('confirmInput').oninput = (e) => {
      const ok = e.target.value.trim() === (state.wizard.anchor ? state.wizard.anchor.name : '');
      $('wizardNext').disabled = !ok;
    };
    $('btnUndoNow').onclick = () => undoBatch(state.wizard.batchId);

    $('localOnlyToggle').onclick = () => {
      const body = $('localOnlyList');
      body.hidden = !body.hidden;
    };

    $('btnBatches').onclick = async () => {
      await renderBatches();
      show('batchesMask', true);
    };
    $('batchesClose').onclick = () => show('batchesMask', false);
    $('btnBackup').onclick = doBackup;

    // 点击遮罩关闭
    ['miniMask', 'importMask', 'batchesMask', 'exportMask', 'deleteMask'].forEach((id) => {
      $(id).addEventListener('click', (e) => {
        if (e.target.id === id) show(id, false);
      });
    });
  }

  window.addEventListener('DOMContentLoaded', () => {
    init().catch((e) => {
      console.error(e);
      toast(`启动失败：${e.message}`, 'error');
    });
  });
})();
