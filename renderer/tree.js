'use strict';

/**
 * 世系图渲染器（Canvas 2D）
 * ------------------------------------------------------------
 * 为什么用 Canvas 而不是 DOM/SVG：
 *   几千个节点下 DOM 布局与重绘会直接卡死，Canvas 只画视野内的东西。
 *
 * 布局：改良的 tidy tree（变宽节点）。同一父节点下按「排行 seq」左右排列，
 *      一人多父（嗣子、兼祧）时只在主父下面占位，其余父关系用虚线示意。
 *
 * 交互：拖拽平移、滚轮以光标为中心缩放、单击选中、双击编辑。
 */

(function () {
  const NODE_W = 136;
  const NODE_H = 58;
  const NODE_R = 9;
  const SPOUSE_W = 94;
  const SPOUSE_H = 44;
  const SPOUSE_GAP = 12;
  const SPOUSE_SPACING = 8;
  const H_GAP = 30; // 纵向布局：同辈之间的横向间隔
  const V_GAP = 88; // 纵向布局：父子之间的纵向间隔
  const ROW_H = NODE_H + V_GAP;
  const COL_W = NODE_W + 116; // 横向布局：父子之间的横向间隔
  const V_GAP_SIB = 22; // 横向布局：同辈之间的纵向间隔

  const COLOR = {
    paper: '#fffdf8',
    paperSoft: '#f8f5ee',
    ink: '#221f1b',
    ink2: '#4c463b',
    ink3: '#8a8172',
    line: '#d8cdb8',
    lineSoft: '#c9bda5',
    cinnabar: '#a4342c',
    cinnabarSoft: '#fbf0ec',
    jade: '#2f6b56',
  };

  const NAME_FONT = '"Songti SC", "STSong", "SimSun", "Noto Serif CJK SC", serif';
  const UI_FONT = '"PingFang SC", "Microsoft YaHei", system-ui, sans-serif';

  // 世次标签用中文数字（三世、十二世），单独放在 ganzhi.js 里和导出共用
  const Ganzhi = (typeof window !== 'undefined' && window.ZupuGanzhi) || {
    shiLabel: (g) => (g ? `第${g}世` : ''),
  };

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  function fitFont(ctx, text, maxWidth, baseSize, family, minSize) {
    let size = baseSize;
    const min = minSize || 10;
    ctx.font = `${size}px ${family}`;
    while (size > min && ctx.measureText(text).width > maxWidth) {
      size -= 1;
      ctx.font = `${size}px ${family}`;
    }
    return size;
  }

  class ZupuTree {
    constructor(canvas, opts) {
      this.canvas = canvas;
      this.ctx = canvas.getContext('2d');
      this.opts = opts || {};
      this.data = { nodes: [], edges: [], roots: [] };
      this.pos = new Map();
      this.spousePos = new Map();
      this.bbox = { x: 0, y: 0, w: 1, h: 1 };
      this.scale = 1;
      this.tx = 0;
      this.ty = 0;
      this.selected = null;
      this.hover = null;
      this.dpr = window.devicePixelRatio || 1;
      this.orient = this.opts.orient === 'h' ? 'h' : 'v'; // v 纵向生长 / h 横向生长
      this.levels = [];
      this.depthStep = ROW_H;
      this._drag = null;
      this._userAdjusted = false;
      this._bind();
      this.resize();
    }

    // ── 数据 ────────────────────────────────────────────

    setData(tree, { keepView = false } = {}) {
      this.data = tree || { nodes: [], edges: [], roots: [] };
      this.computeLayout();
      if (!keepView) this.fit();
      else this.draw();
    }

    /** 纵向 ↔ 横向：只换布局方向，数据一个字节都不用动 */
    setOrient(orient) {
      const next = orient === 'h' ? 'h' : 'v';
      if (next === this.orient) return;
      this.orient = next;
      this.computeLayout();
      this.fit();
    }

    toggleOrient() {
      this.setOrient(this.orient === 'v' ? 'h' : 'v');
      return this.orient;
    }

    computeLayout() {
      const { nodes, edges } = this.data;
      const byId = new Map(nodes.map((n) => [n.uuid, n]));

      // 主父：优先 is_primary，其次先出现的
      const primary = new Map();
      for (const e of edges) {
        if (!byId.has(e.parent) || !byId.has(e.child)) continue;
        const cur = primary.get(e.child);
        if (!cur || (!cur.isPrimary && e.isPrimary)) primary.set(e.child, e);
      }

      const children = new Map();
      for (const [child, e] of primary) {
        if (!children.has(e.parent)) children.set(e.parent, []);
        children.get(e.parent).push({ uuid: child, seq: e.seq ?? 0, kind: e.kind });
      }
      for (const arr of children.values()) arr.sort((a, b) => a.seq - b.seq);

      // ── 配偶配对 ──
      // 婚姻是双向的（A 的配偶里有 B，B 的配偶里也有 A），如果不按「对」去重，
      // 所有已婚者都会被打上「是某人的配偶」标记，真正的根节点会被筛掉，图画不出来。
      // 规则：一对夫妻只保留一个人当节点，另一个画成右侧的配偶框；
      //       两人都在本支内（近亲联姻、童养媳入谱）时，两人都当节点画。
      const nodeSet = new Set(nodes.map((n) => n.uuid));
      const seenPair = new Set();
      const spouseBoxOf = new Map(); // 本人 uuid → 要贴在右侧的配偶 uuid[]
      const boxedIds = new Set();

      for (const n of nodes) {
        for (const s of n.spouses || []) {
          if (!nodeSet.has(s.uuid) || s.uuid === n.uuid) continue;
          const key = n.uuid < s.uuid ? `${n.uuid}|${s.uuid}` : `${s.uuid}|${n.uuid}`;
          if (seenPair.has(key)) continue;
          seenPair.add(key);

          const partner = byId.get(s.uuid);
          const selfHasParent = primary.has(n.uuid);
          const partnerHasParent = primary.has(partner.uuid);

          let boxedId = null;
          let ownerId = null;

          if (selfHasParent !== partnerHasParent) {
            // 一个是本支成员、一个是外来配偶 → 外来者画框
            boxedId = selfHasParent ? partner.uuid : n.uuid;
            ownerId = selfHasParent ? n.uuid : partner.uuid;
          } else if (!selfHasParent && !partnerHasParent) {
            // 一对始祖夫妇（都没有父辈记录）：男左女右
            boxedId = n.gender === 1 ? partner.uuid : partner.gender === 1 ? n.uuid : partner.uuid;
            ownerId = boxedId === partner.uuid ? n.uuid : partner.uuid;
          }
          if (!boxedId) continue; // 双方都在本支：都当节点画，避免重复

          boxedIds.add(boxedId);
          if (!spouseBoxOf.has(ownerId)) spouseBoxOf.set(ownerId, []);
          if (!spouseBoxOf.get(ownerId).includes(boxedId)) spouseBoxOf.get(ownerId).push(boxedId);
        }
      }

      const orient = this.orient;
      const boxCount = (uuid) => Math.min((spouseBoxOf.get(uuid) || []).length, 2);

      // 沿「兄弟轴」的自身长度：纵向看宽度（配偶贴右侧），横向看高度（配偶贴下方）
      const ownMain = (uuid) => {
        const n = boxCount(uuid);
        if (!n) return orient === 'v' ? NODE_W : NODE_H;
        return orient === 'v'
          ? NODE_W + SPOUSE_GAP + n * SPOUSE_W + (n - 1) * SPOUSE_SPACING
          : NODE_H + SPOUSE_GAP + n * SPOUSE_H + (n - 1) * SPOUSE_SPACING;
      };

      const SIB_GAP = orient === 'v' ? H_GAP : V_GAP_SIB;
      const DEPTH_STEP = orient === 'v' ? ROW_H : COL_W;

      const mains = new Map();
      const mOf = (uuid) => {
        const m = mains.get(uuid);
        return typeof m === 'number' && Number.isFinite(m) ? m : ownMain(uuid);
      };

      const layoutNodes = nodes.filter((n) => !boxedIds.has(n.uuid));

      const measure = (uuid) => {
        if (mains.has(uuid)) return mains.get(uuid);
        mains.set(uuid, ownMain(uuid)); // 占位：万一数据成环也不会死循环
        const kids = children.get(uuid) || [];
        if (!kids.length) return mains.get(uuid);
        let total = 0;
        for (const k of kids) total += measure(k.uuid) + SIB_GAP;
        total -= SIB_GAP;
        const m = Math.max(ownMain(uuid), total);
        mains.set(uuid, m);
        return m;
      };

      const roots = layoutNodes.filter((n) => !primary.has(n.uuid)).map((n) => n.uuid);
      for (const r of roots) measure(r);

      this.pos = new Map();
      this.depthOf = new Map();
      // 沿兄弟轴的 start + 深度 → 屏幕坐标。两个方向只差最后一步映射。
      const assign = (uuid, start, depth) => {
        const kids = (children.get(uuid) || []).filter((k) => !boxedIds.has(k.uuid));
        const m = mOf(uuid);
        if (kids.length) {
          let total = 0;
          for (const k of kids) total += mOf(k.uuid) + SIB_GAP;
          total -= SIB_GAP;
          let cursor = start + Math.max(0, (m - total) / 2);
          for (const k of kids) {
            assign(k.uuid, cursor, depth + 1);
            cursor += mOf(k.uuid) + SIB_GAP;
          }
        }
        const main = start + m / 2;
        const d = depth * DEPTH_STEP;
        this.pos.set(uuid, orient === 'v' ? { x: main, y: d } : { x: d, y: main });
        this.depthOf.set(uuid, depth);
      };

      let cursor = 0;
      for (const r of roots) {
        assign(r, cursor, 0);
        cursor += mOf(r) + SIB_GAP * 2;
      }

      // 配偶框：纵向贴本人右侧，横向贴本人下方
      this.spousePos = new Map();
      for (const [ownerId, boxes] of spouseBoxOf) {
        const p = this.pos.get(ownerId);
        if (!p) continue;
        boxes.slice(0, 2).forEach((sid, i) => {
          if (orient === 'v') {
            this.spousePos.set(sid, {
              x: p.x + NODE_W / 2 + SPOUSE_GAP + i * (SPOUSE_W + SPOUSE_SPACING) + SPOUSE_W / 2,
              y: p.y,
              owner: ownerId,
            });
          } else {
            this.spousePos.set(sid, {
              x: p.x,
              y: p.y + NODE_H / 2 + SPOUSE_GAP + i * (SPOUSE_H + SPOUSE_SPACING) + SPOUSE_H / 2,
              owner: ownerId,
            });
          }
        });
      }

      // 包围盒
      let minX = Infinity;
      let maxX = -Infinity;
      let minY = Infinity;
      let maxY = -Infinity;
      const acc = (x, y, w, h) => {
        minX = Math.min(minX, x - w / 2);
        maxX = Math.max(maxX, x + w / 2);
        minY = Math.min(minY, y - h / 2);
        maxY = Math.max(maxY, y + h / 2);
      };
      for (const [uuid, p] of this.pos) acc(p.x, p.y, NODE_W, NODE_H);
      for (const [, p] of this.spousePos) acc(p.x, p.y, SPOUSE_W, SPOUSE_H);
      if (!Number.isFinite(minX)) {
        minX = 0;
        maxX = 400;
        minY = 0;
        maxY = 300;
      }
      this.bbox = { x: minX, y: minY, w: Math.max(1, maxX - minX), h: Math.max(1, maxY - minY) };

      // 世次分层：每一层对应哪一代。用绝对代次（始祖为第一世），
      // 所以「只看这一支」时算出的仍是真实世次，不会从第一世重新数。
      const levelGen = new Map();
      for (const n of nodes) {
        const d = this.depthOf.get(n.uuid);
        if (d == null) continue;
        const g = n.gen != null ? n.gen : n.relGen;
        if (g != null && !levelGen.has(d)) levelGen.set(d, g);
      }
      this.levels = [...levelGen.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([depth, gen]) => ({ depth, gen }));
      this.depthStep = DEPTH_STEP;

      this.layoutEdgeOf = new Set([...primary].map(([child, e]) => `${e.parent}>${child}`));
      this.primaryParent = primary;
      this.byId = byId;
      this._mains = mains; // 调试用：布局主轴长度缓存
    }

    // ── 视图 ────────────────────────────────────────────

    resize() {
      const rect = this.canvas.getBoundingClientRect();
      this.dpr = window.devicePixelRatio || 1;
      this.w = Math.max(1, Math.round(rect.width));
      this.h = Math.max(1, Math.round(rect.height));
      this.canvas.width = Math.round(this.w * this.dpr);
      this.canvas.height = Math.round(this.h * this.dpr);
      // 初始化时画布尺寸可能还没定下来（CSS 尚未生效），
      // 若此时就按错误尺寸居中，之后尺寸变大会让整棵树偏到右边去。
      // 所以只要用户还没手动缩放/平移过，尺寸变化就重新适配一次。
      if (!this._userAdjusted) this.fit();
      else this.draw();
    }

    fit() {
      this._userAdjusted = false; // 适配后再改窗口大小，仍应继续自动适配
      const pad = 48;
      const { w, h } = this.bbox;
      const v = this.orient === 'v';

      // 纵向：以「宽度放得下」为准，宁可让人往下滚，也不要裁掉右边那几房人。
      // 横向反过来：以「高度放得下」为准，让人往右滚。
      const along = v ? (this.w - pad * 2) / w : (this.h - pad * 2) / h;
      this.scale = Math.max(0.32, Math.min(1.15, along));

      if (v) {
        this.tx = this.w / 2 - (this.bbox.x + w / 2) * this.scale;
        const visibleHeight = h * this.scale;
        this.ty =
          visibleHeight + pad * 2 <= this.h
            ? this.h / 2 - (this.bbox.y + h / 2) * this.scale // 能整棵放下就居中
            : pad - this.bbox.y * this.scale; // 放不下就顶部对齐，从始祖往下看
      } else {
        this.ty = this.h / 2 - (this.bbox.y + h / 2) * this.scale;
        const visibleWidth = w * this.scale;
        this.tx =
          visibleWidth + pad * 2 <= this.w
            ? this.w / 2 - (this.bbox.x + w / 2) * this.scale
            : pad - this.bbox.x * this.scale; // 放不下就左边对齐，从始祖往右看
      }

      this.draw();
      this.emitZoom();
    }

    setZoom(scale, anchor) {
      this._userAdjusted = true;
      const ax = anchor ? anchor.x : this.w / 2;
      const ay = anchor ? anchor.y : this.h / 2;
      const wx = (ax - this.tx) / this.scale;
      const wy = (ay - this.ty) / this.scale;
      this.scale = Math.max(0.18, Math.min(2.6, scale));
      this.tx = ax - wx * this.scale;
      this.ty = ay - wy * this.scale;
      this.draw();
      this.emitZoom();
    }

    zoomBy(factor) {
      this.setZoom(this.scale * factor);
    }

    centerOn(uuid) {
      const p = this.pos.get(uuid);
      if (!p) return;
      this._userAdjusted = true;
      this.tx = this.w / 2 - p.x * this.scale;
      this.ty = this.h / 2 - p.y * this.scale;
      this.draw();
    }

    emitZoom() {
      if (this.opts.onZoom) this.opts.onZoom(this.scale);
    }

    select(uuid, { silent = false } = {}) {
      this.selected = uuid;
      this.draw();
      if (!silent && this.opts.onSelect) this.opts.onSelect(uuid);
    }

    // ── 绘制 ────────────────────────────────────────────

    draw() {
      const ctx = this.ctx;
      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
      ctx.setTransform(this.dpr * this.scale, 0, 0, this.dpr * this.scale, this.dpr * this.tx, this.dpr * this.ty);

      const view = {
        x0: -this.tx / this.scale,
        y0: -this.ty / this.scale,
        x1: (this.w - this.tx) / this.scale,
        y1: (this.h - this.ty) / this.scale,
      };

      this.drawEdges(ctx, view);
      this.drawSpouseLinks(ctx, view);
      this.drawNodes(ctx, view);
    }

    /**
     * 世次分层（数据，不画出来）。曾做过「每代一条淡线 + 一世/二世…」的标尺，
     * 后来按用户要求去掉了——节点框里第二行已经有「三世」标注，尺子反而显得杂。
     * 这份 levels 保留着：导出大图的分层检查、界面测试都用它。
     */

    drawEdges(ctx, view) {
      const edges = this.data.edges || [];
      const v = this.orient === 'v';
      ctx.lineCap = 'round';

      for (const e of edges) {
        const p = this.pos.get(e.parent);
        const c = this.pos.get(e.child);
        if (!p || !c) continue;

        const isLayout = this.layoutEdgeOf && this.layoutEdgeOf.has(`${e.parent}>${e.child}`);
        const inView =
          Math.min(p.x, c.x) < view.x1 &&
          Math.max(p.x, c.x) > view.x0 &&
          Math.min(p.y, c.y) < view.y1 &&
          Math.max(p.y, c.y) > view.y0;
        if (!inView) continue;

        // 起点在父节点的下方/右方，终点在子节点的上方/左方
        const sx = v ? p.x : p.x + NODE_W / 2;
        const sy = v ? p.y + NODE_H / 2 : p.y;
        const ex = v ? c.x : c.x - NODE_W / 2;
        const ey = v ? c.y - NODE_H / 2 : c.y;

        ctx.beginPath();
        if (isLayout) {
          if (v) {
            const midY = sy + Math.max(18, (ey - sy) * 0.55);
            ctx.moveTo(sx, sy);
            ctx.lineTo(sx, midY);
            ctx.lineTo(ex, midY);
            ctx.lineTo(ex, ey);
          } else {
            const midX = sx + Math.max(18, (ex - sx) * 0.55);
            ctx.moveTo(sx, sy);
            ctx.lineTo(midX, sy);
            ctx.lineTo(midX, ey);
            ctx.lineTo(ex, ey);
          }
          ctx.strokeStyle = COLOR.lineSoft;
          ctx.lineWidth = 1.5;
          ctx.setLineDash([]);
        } else {
          // 非主父（嗣子 / 兼祧的另一父）：虚线曲线，避免和主支混淆
          if (v) {
            ctx.moveTo(sx, sy);
            ctx.bezierCurveTo(sx, sy + 46, ex, ey - 46, ex, ey);
          } else {
            ctx.moveTo(sx, sy);
            ctx.bezierCurveTo(sx + 46, sy, ex - 46, ey, ex, ey);
          }
          ctx.strokeStyle = 'rgba(164, 52, 44, 0.42)';
          ctx.lineWidth = 1.3;
          ctx.setLineDash([5, 5]);
        }
        ctx.stroke();
        ctx.setLineDash([]);

        // 虚线终点画个小箭头：贴着别的方框走过去时，
        // 光看线尾很容易误判「这条线连的是谁」
        if (!isLayout) {
          ctx.beginPath();
          if (v) {
            ctx.moveTo(ex - 4.5, ey - 8);
            ctx.lineTo(ex, ey - 1);
            ctx.lineTo(ex + 4.5, ey - 8);
          } else {
            ctx.moveTo(ex - 8, ey - 4.5);
            ctx.lineTo(ex - 1, ey);
            ctx.lineTo(ex - 8, ey + 4.5);
          }
          ctx.strokeStyle = 'rgba(164,52,44,0.8)';
          ctx.lineWidth = 1.5;
          ctx.stroke();
        }

        if (!isLayout && e.kind && e.kind !== '生') {
          ctx.save();
          ctx.font = `11px ${UI_FONT}`;
          ctx.fillStyle = COLOR.cinnabar;
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          if (v) ctx.fillText(e.kind, (sx + ex) / 2, (sy + ey) / 2 - 4);
          else ctx.fillText(e.kind, (sx + ex) / 2, (sy + ey) / 2 - 8);
          ctx.restore();
        }
      }
    }

    drawSpouseLinks(ctx, view) {
      const v = this.orient === 'v';
      for (const [uuid, sp] of this.spousePos) {
        const owner = this.pos.get(sp.owner);
        if (!owner) continue;
        if (sp.x < view.x0 - 200 || sp.x > view.x1 + 200) continue;
        if (sp.y < view.y0 - 200 || sp.y > view.y1 + 200) continue;
        ctx.beginPath();
        if (v) {
          ctx.moveTo(owner.x + NODE_W / 2, owner.y);
          ctx.lineTo(sp.x - SPOUSE_W / 2, sp.y);
        } else {
          ctx.moveTo(owner.x, owner.y + NODE_H / 2);
          ctx.lineTo(sp.x, sp.y - SPOUSE_H / 2);
        }
        ctx.strokeStyle = COLOR.lineSoft;
        ctx.lineWidth = 1.2;
        ctx.setLineDash([3, 3]);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    drawNodes(ctx, view) {
      const nodes = this.data.nodes || [];

      for (const n of nodes) {
        const p = this.pos.get(n.uuid);
        if (!p) continue;
        if (p.x + NODE_W < view.x0 || p.x - NODE_W > view.x1) continue;
        if (p.y + NODE_H < view.y0 || p.y - NODE_H > view.y1) continue;

        const isSel = this.selected === n.uuid;
        const isHover = this.hover === n.uuid;
        const x = p.x - NODE_W / 2;
        const y = p.y - NODE_H / 2;

        if (isSel) {
          ctx.save();
          ctx.shadowColor = 'rgba(164, 52, 44, 0.28)';
          ctx.shadowBlur = 16;
          ctx.shadowOffsetY = 3;
          roundRect(ctx, x, y, NODE_W, NODE_H, NODE_R);
          ctx.fillStyle = COLOR.cinnabarSoft;
          ctx.fill();
          ctx.restore();
        }

        roundRect(ctx, x, y, NODE_W, NODE_H, NODE_R);
        ctx.fillStyle = isSel ? COLOR.cinnabarSoft : COLOR.paper;
        ctx.fill();
        ctx.strokeStyle = isSel ? COLOR.cinnabar : isHover ? '#b9ab91' : COLOR.line;
        ctx.lineWidth = isSel ? 2.2 : 1.4;
        ctx.stroke();

        // 在世 / 已故：左侧色条
        ctx.save();
        roundRect(ctx, x, y, NODE_W, NODE_H, NODE_R);
        ctx.clip();
        ctx.fillStyle = n.alive ? 'rgba(47, 107, 86, 0.55)' : 'rgba(138, 129, 114, 0.35)';
        ctx.fillRect(x, y, 3.5, NODE_H);
        ctx.restore();

        // 姓名
        const name = n.name || '(无名)';
        const size = fitFont(ctx, name, NODE_W - 22, 18, NAME_FONT, 11);
        ctx.font = `${size}px ${NAME_FONT}`;
        ctx.fillStyle = n.alive ? COLOR.ink : COLOR.ink2;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(name, p.x, p.y - 8);

        // 世次 / 状态
        const bits = [];
        const genNo = n.gen != null ? n.gen : n.relGen;
        if (genNo != null) bits.push(Ganzhi.shiLabel(genNo));
        if (!n.alive) bits.push('已故');
        ctx.font = `11.5px ${UI_FONT}`;
        ctx.fillStyle = COLOR.ink3;
        ctx.fillText(bits.join(' · '), p.x, p.y + 14);

        // 子嗣数角标
        if (n.childCount > 0) {
          const bx = p.x + NODE_W / 2 - 8;
          const by = p.y - NODE_H / 2 + 8;
          ctx.beginPath();
          ctx.arc(bx, by, 8, 0, Math.PI * 2);
          ctx.fillStyle = '#efe7d7';
          ctx.fill();
          ctx.font = `10.5px ${UI_FONT}`;
          ctx.fillStyle = COLOR.ink2;
          ctx.fillText(String(n.childCount), bx, by + 0.5);
        }
      }

      // 配偶
      for (const [uuid, sp] of this.spousePos) {
        if (sp.x + SPOUSE_W < view.x0 || sp.x - SPOUSE_W > view.x1) continue;
        if (sp.y + SPOUSE_H < view.y0 || sp.y - SPOUSE_H > view.y1) continue;
        const s = this.byId && this.byId.get(uuid);
        if (!s) continue;
        const isSel = this.selected === uuid;

        roundRect(ctx, sp.x - SPOUSE_W / 2, sp.y - SPOUSE_H / 2, SPOUSE_W, SPOUSE_H, 7);
        ctx.fillStyle = isSel ? COLOR.cinnabarSoft : COLOR.paperSoft;
        ctx.fill();
        ctx.strokeStyle = isSel ? COLOR.cinnabar : 'rgba(201, 189, 165, 0.9)';
        ctx.lineWidth = isSel ? 2 : 1.1;
        ctx.setLineDash(isSel ? [] : [4, 3]);
        ctx.stroke();
        ctx.setLineDash([]);

        ctx.font = `13.5px ${NAME_FONT}`;
        ctx.fillStyle = s.alive ? COLOR.ink2 : COLOR.ink3;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const t = s.name || '(无名)';
        fitFont(ctx, t, SPOUSE_W - 12, 13.5, NAME_FONT, 9.5);
        ctx.fillText(t, sp.x, sp.y);
      }
    }

    // ── 导出静态图 ──────────────────────────────────────
    // 屏幕上的 canvas 只画视口内的东西，导出必须「整棵都画」，
    // 否则导出的只是当前看到的那一屏。所以另开一张离屏 canvas，
    // 用同一套绘制函数（坐标系换成世界坐标即可）。
    renderAll({ scale = 2, padding = 56, title = '', subtitle = '', note = '', legend = true } = {}) {
      const b = this.bbox;
      const headerH = title ? 150 : 0;
      const legendH = legend ? 88 : 0;
      const worldW = b.w + padding * 2;
      const worldH = b.h + padding * 2 + headerH + legendH;

      // 单边超过 12000px 浏览器会明显变慢甚至画不出来，超了就自动降倍率
      const HARD_MAX = 12000;
      const s = Math.min(scale, HARD_MAX / Math.max(worldW, worldH));

      const cv = document.createElement('canvas');
      cv.width = Math.round(worldW * s);
      cv.height = Math.round(worldH * s);
      const ctx = cv.getContext('2d');
      ctx.fillStyle = COLOR.paper;
      ctx.fillRect(0, 0, cv.width, cv.height);

      const originY = padding + headerH - b.y;
      ctx.setTransform(s, 0, 0, s, (padding - b.x) * s, originY * s);

      if (title) {
        const top = b.y - padding - headerH;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'alphabetic';
        ctx.fillStyle = COLOR.ink;
        ctx.font = `34px ${NAME_FONT}`;
        ctx.fillText(title, b.x, top + 52);

        ctx.fillStyle = COLOR.ink3;
        ctx.font = `15px ${UI_FONT}`;
        ctx.fillText(subtitle, b.x, top + 86);

        if (note) {
          ctx.font = `14px ${UI_FONT}`;
          ctx.fillText(note, b.x, top + 112);
        }

        // 右上角一条朱线，印刷时默认的版式感
        ctx.strokeStyle = 'rgba(164,52,44,0.55)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(b.x, top + 130);
        ctx.lineTo(b.x + b.w, top + 130);
        ctx.stroke();
      }

      const view = { x0: -1e7, y0: -1e7, x1: 1e7, y1: 1e7 };
      this.drawEdges(ctx, view);
      this.drawSpouseLinks(ctx, view);

      const prevSel = this.selected;
      const prevHover = this.hover;
      this.selected = null;
      this.hover = null;
      this.drawNodes(ctx, view);
      this.selected = prevSel;
      this.hover = prevHover;

      if (legend) {
        const y = b.y + b.h + 46;
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.font = `14px ${UI_FONT}`;
        let x = b.x;

        const item = (draw, label) => {
          draw(x, y);
          ctx.fillStyle = COLOR.ink3;
          ctx.fillText(label, x + 52, y);
          x += 52 + ctx.measureText(label).width + 34;
        };

        item(
          (lx, ly) => {
            ctx.strokeStyle = COLOR.lineSoft;
            ctx.lineWidth = 1.6;
            ctx.setLineDash([]);
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(lx + 40, ly);
            ctx.stroke();
          },
          '父子（生）'
        );

        item(
          (lx, ly) => {
            ctx.strokeStyle = 'rgba(164,52,44,0.62)';
            ctx.lineWidth = 1.5;
            ctx.setLineDash([6, 5]);
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(lx + 40, ly);
            ctx.stroke();
            ctx.setLineDash([]);
          },
          '嗣子 / 兼祧（另一父）'
        );

        item(
          (lx, ly) => {
            ctx.strokeStyle = COLOR.lineSoft;
            ctx.lineWidth = 1.3;
            ctx.setLineDash([3, 4]);
            ctx.beginPath();
            ctx.moveTo(lx, ly);
            ctx.lineTo(lx + 40, ly);
            ctx.stroke();
            ctx.setLineDash([]);
          },
          '婚姻（配偶框）'
        );
      }

      return { canvas: cv, scale: s, width: cv.width, height: cv.height };
    }

    // ── 命中测试 ────────────────────────────────────────

    hitTest(clientX, clientY) {
      const rect = this.canvas.getBoundingClientRect();
      const wx = (clientX - rect.left - this.tx) / this.scale;
      const wy = (clientY - rect.top - this.ty) / this.scale;

      for (const [uuid, sp] of this.spousePos) {
        if (
          Math.abs(wx - sp.x) <= SPOUSE_W / 2 &&
          Math.abs(wy - sp.y) <= SPOUSE_H / 2
        ) {
          return uuid;
        }
      }
      for (const [uuid, p] of this.pos) {
        if (Math.abs(wx - p.x) <= NODE_W / 2 && Math.abs(wy - p.y) <= NODE_H / 2) return uuid;
      }
      return null;
    }

    // ── 事件 ────────────────────────────────────────────

    _bind() {
      const canvas = this.canvas;

      canvas.addEventListener('pointerdown', (e) => {
        canvas.setPointerCapture(e.pointerId);
        this._drag = { x: e.clientX, y: e.clientY, tx: this.tx, ty: this.ty, moved: false };
        canvas.classList.add('dragging');
      });

      canvas.addEventListener('pointermove', (e) => {
        if (this._drag) {
          const dx = e.clientX - this._drag.x;
          const dy = e.clientY - this._drag.y;
          if (Math.abs(dx) > 3 || Math.abs(dy) > 3) this._drag.moved = true;
          if (this._drag.moved) {
            this._userAdjusted = true;
            this.tx = this._drag.tx + dx;
            this.ty = this._drag.ty + dy;
            this.draw();
          }
          return;
        }

        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit !== this.hover) {
          this.hover = hit;
          canvas.style.cursor = hit ? 'pointer' : '';
          this.draw();
        }
      });

      const endDrag = (e) => {
        canvas.classList.remove('dragging');
        const wasClick = this._drag && !this._drag.moved;
        this._drag = null;
        if (wasClick) {
          const hit = this.hitTest(e.clientX, e.clientY);
          if (hit) this.select(hit);
        }
      };
      canvas.addEventListener('pointerup', endDrag);
      canvas.addEventListener('pointercancel', () => {
        this._drag = null;
        canvas.classList.remove('dragging');
      });

      canvas.addEventListener('dblclick', (e) => {
        const hit = this.hitTest(e.clientX, e.clientY);
        if (hit && this.opts.onEdit) this.opts.onEdit(hit);
      });

      canvas.addEventListener(
        'wheel',
        (e) => {
          e.preventDefault();
          const rect = canvas.getBoundingClientRect();
          const anchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
          const factor = Math.exp(-e.deltaY * 0.0016);
          this.setZoom(this.scale * factor, anchor);
        },
        { passive: false }
      );
    }
  }

  window.ZupuTree = ZupuTree;
})();
