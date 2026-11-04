'use strict';

/**
 * 干支 / 年份 / 中文数字
 * ------------------------------------------------------------
 * 浏览器与 Node 共用同一份实现：
 *   - 渲染层 <script src="ganzhi.js"> → window.ZupuGanzhi
 *   - 服务端 require('../renderer/ganzhi.js')（导出 Excel 时要用）
 * 放两份一定会算出不一样的结果，所以只保留这一份。
 */

(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.ZupuGanzhi = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];
  const ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];
  const CN = ['〇', '一', '二', '三', '四', '五', '六', '七', '八', '九'];

  /**
   * 年号 → 起止公元年（含首尾）。
   * ------------------------------------------------------------
   * 老谱上的生卒几乎全是「康熙戊寅」「乾隆三十七年」这种写法，只抄干支没有
   * 年号，干支六十年一轮、根本定不了年。有了这张表才能把原文反推回公元年。
   * 只收明清与民国——再往上（唐宋元）各朝年号重名极多，容易算错，
   * 与其猜错不如留空让人自己填。
   */
  const ERAS = [
    ['洪武', 1368, 1398],
    ['建文', 1399, 1402],
    ['永乐', 1403, 1424],
    ['洪熙', 1425, 1425],
    ['宣德', 1426, 1435],
    ['正统', 1436, 1449],
    ['景泰', 1450, 1457],
    ['天顺', 1457, 1464],
    ['成化', 1465, 1487],
    ['弘治', 1488, 1505],
    ['正德', 1506, 1521],
    ['嘉靖', 1522, 1566],
    ['隆庆', 1567, 1572],
    ['万历', 1573, 1620],
    ['泰昌', 1620, 1620],
    ['天启', 1621, 1627],
    ['崇祯', 1628, 1644],
    ['顺治', 1644, 1661],
    ['康熙', 1662, 1722],
    ['雍正', 1723, 1735],
    ['乾隆', 1736, 1795],
    ['嘉庆', 1796, 1820],
    ['道光', 1821, 1850],
    ['咸丰', 1851, 1861],
    ['同治', 1862, 1874],
    ['光绪', 1875, 1908],
    ['宣统', 1909, 1911],
    ['民国', 1912, 1949],
  ];

  /** 公元年 → 六十甲子序号。公元 4 年为甲子年，因此以 4 为基准取模。 */
  function indexOfYear(year) {
    const y = Number(year);
    if (!Number.isFinite(y)) return null;
    return (((y - 4) % 60) + 60) % 60;
  }

  /** 公元年 → 干支，如 1735 → 乙卯。支持公元前（负数）。 */
  function ganzhiOfYear(year) {
    const i = indexOfYear(year);
    return i == null ? null : GAN[i % 10] + ZHI[i % 12];
  }

  /** 干支 → 距离 around 年最近的那一年（干支单独无法唯一定年，只用于提示） */
  function yearOfGanzhi(ganzhi, around) {
    const g = String(ganzhi || '').trim();
    if (g.length !== 2 || !GAN.includes(g[0]) || !ZHI.includes(g[1])) return null;
    const target = g[0] + g[1];
    const base = Number.isFinite(Number(around)) ? Number(around) : new Date().getFullYear();
    for (let d = 0; d <= 60; d += 1) {
      for (const sign of d === 0 ? [1] : [1, -1]) {
        const y = base + d * sign;
        if (ganzhiOfYear(y) === target) return y;
      }
    }
    return null;
  }

  /** 从「乾隆壬寅」这类原文里抠出干支 */
  function findGanzhi(text) {
    const s = String(text || '');
    for (let i = 0; i < s.length - 1; i += 1) {
      if (GAN.includes(s[i]) && ZHI.includes(s[i + 1])) return s[i] + s[i + 1];
    }
    return null;
  }

  /** 中文数字 → 整数（年号纪年用：元 = 1、十二 = 12、三十七 = 37） */
  function cnToInt(str) {
    const s = String(str == null ? '' : str).trim();
    if (!s) return null;
    if (s === '元') return 1;
    if (/^[0-9]+$/.test(s)) return Number(s);
    const D = { '〇': 0, 零: 0, 一: 1, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9 };
    let total = 0;
    let cur = 0;
    for (const ch of s) {
      if (D[ch] !== undefined) cur = D[ch];
      else if (ch === '十') {
        total += (cur || 1) * 10;
        cur = 0;
      } else if (ch === '百') {
        total += (cur || 1) * 100;
        cur = 0;
      } else return null;
    }
    return total + cur;
  }

  /** 找出原文里最先出现的年号（一段话里有两个年号时，按书写顺序取第一个） */
  function eraAt(text) {
    const s = String(text || '');
    let best = null;
    for (const [name, from, to] of ERAS) {
      const at = s.indexOf(name);
      if (at < 0) continue;
      if (!best || at < best.at) best = { name, from, to, at };
    }
    return best;
  }

  /**
   * 从原文里抠出公元年。三层，从可信到推测：
   *   1. 明写的四位数年份：乾隆壬寅（1735）→ 1735
   *   2. 年号 + 年数：康熙三十七年 → 1698、民国二十五年 → 1936
   *   3. 年号 + 干支：康熙戊寅 → 康熙年间唯一的戊寅年 = 1698
   * 三条都对不上就返回 null——宁可空着，也不给一个错年份。
   */
  function findYear(text) {
    const s = String(text || '');
    const m = /(1[0-9]{3}|20[0-9]{2})/.exec(s);
    if (m) return Number(m[1]);

    const era = eraAt(s);
    if (!era) return null;
    const rest = s.slice(era.at + era.name.length);

    // 年号 + 年数
    const num = /^([元〇零一二三四五六七八九十百0-9]{1,6})年/.exec(rest);
    if (num) {
      const n = cnToInt(num[1]);
      // 年号实际用过的年数不会超过 to - from + 1，超了多半是抄错
      if (n && n >= 1 && n <= era.to - era.from + 1) return era.from + n - 1;
    }

    // 年号 + 干支
    const gz = findGanzhi(rest);
    if (gz) {
      const hits = [];
      for (let y = era.from; y <= era.to; y += 1) if (ganzhiOfYear(y) === gz) hits.push(y);
      // 超过六十年的年号（只有康熙）同一干支可能撞两次，定不了就留空
      return hits.length === 1 ? hits[0] : null;
    }

    return null;
  }

  /** 0-99 → 中文数字（谱牒世次写法：一、十二、二十三） */
  function cnNumber(n) {
    const v = Math.trunc(Number(n));
    if (!Number.isFinite(v) || v < 0) return String(n == null ? '' : n);
    if (v < 10) return CN[v];
    if (v === 10) return '十';
    if (v < 20) return `十${CN[v % 10]}`;
    if (v < 100) {
      const t = Math.floor(v / 10);
      const r = v % 10;
      return `${CN[t]}十${r ? CN[r] : ''}`;
    }
    return String(v);
  }

  /** 世次标签：3 → 三世 */
  function shiLabel(gen) {
    const v = Number(gen);
    if (!Number.isFinite(v) || v <= 0) return '';
    return `${cnNumber(v)}世`;
  }

  /** 世次标签（带「第」）：3 → 第三世，用于面板与导出 */
  function shiLabelFull(gen) {
    const v = Number(gen);
    if (!Number.isFinite(v) || v <= 0) return '';
    return `第${cnNumber(v)}世`;
  }

  /** 归一化：年份与干支互相补齐，三者（年份 / 干支 / 原文）都保留 */
  function normalize({ text, year, ganzhi } = {}) {
    let t = String(text == null ? '' : text).trim();
    let y = Number.isFinite(Number(year)) && String(year).trim() !== '' ? Number(year) : null;
    let g = String(ganzhi == null ? '' : ganzhi).trim();

    // 优先级：手填干支 > 手填年份推算 > 从原文里抠。
    // 手填的是人的判断，推算只是补位；原文里可能同时抄了生卒两个干支
    //（如「康熙戊寅生，乾隆庚戌卒」），不能让它盖掉明确的年份。
    if (y == null) y = findYear(t);
    if (!g && y != null) g = ganzhiOfYear(y) || '';
    if (!g) g = findGanzhi(t) || '';

    // 原文保持用户原样，不拿年份或干支去「编」一段原文——
    // 谱上的原文是史料，程序代填的年份不是。
    return { text: t, year: y, ganzhi: g };
  }

  return {
    GAN,
    ZHI,
    ERAS,
    ganzhiOfYear,
    indexOfYear,
    yearOfGanzhi,
    findGanzhi,
    findYear,
    eraAt,
    cnToInt,
    cnNumber,
    shiLabel,
    shiLabelFull,
    normalize,
  };
});
