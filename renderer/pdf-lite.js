'use strict';

/**
 * 极简 PDF 生成器（约 100 行，零依赖）
 * ------------------------------------------------------------
 * 只做一件事：把一张整版 JPEG 封进单页 PDF。
 *
 * 为什么不引 jsPDF：这个应用要求离线可用、十年后还能跑，
 * 多一个第三方库就多一个将来失效的地方。而 PDF 里嵌 JPEG
 * 本身只需要一个 Image XObject + 一个 cm 变换矩阵，标准写得清清楚楚。
 *
 * 限制（必须知道）：页面里是一张位图，不是可选中的文字。
 * 这是「图页」，用于打印/存档；等做谱书排版时再换成文字版。
 */

(function () {
  const encoder = new TextEncoder();

  // 单位：pt（1pt = 1/72 英寸）。横向出图，与世系图的长宽比相配。
  const PAGE = {
    a4: [841.89, 595.28],
    a3: [1190.55, 841.89],
    a2: [1683.78, 1190.55],
  };

  class Buf {
    constructor() {
      this.parts = [];
      this.len = 0;
    }
    bytes(b) {
      this.parts.push(b);
      this.len += b.length;
    }
    text(s) {
      this.bytes(encoder.encode(s));
    }
  }

  /**
   * @param {Uint8Array} jpeg  JPEG 字节（DCTDecode 可直接嵌入）
   * @param {{page?: string, margin?: number, imgW: number, imgH: number}} opts
   */
  function build(jpeg, { page = 'a3', margin = 24, imgW, imgH } = {}) {
    if (!jpeg || !jpeg.length) throw new Error('PDF_EMPTY_IMAGE');
    if (!imgW || !imgH) throw new Error('PDF_MISSING_SIZE');

    const [pw, ph] = PAGE[page] || PAGE.a3;
    const k = Math.min((pw - margin * 2) / imgW, (ph - margin * 2) / imgH);
    const w = imgW * k;
    const h = imgH * k;
    const x = (pw - w) / 2;
    const y = (ph - h) / 2;

    const content = `q\n${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm\n/Im0 Do\nQ\n`;

    const out = new Buf();
    const offsets = [];

    // 文件头 + 建议的二进制标记（告诉工具这不是纯文本 PDF）
    out.bytes(
      new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34, 0x0a, 0x25, 0xe2, 0xe3, 0xcf, 0xd3, 0x0a])
    );

    const obj = (n, body) => {
      offsets[n] = out.len;
      out.text(`${n} 0 obj\n${body}\nendobj\n`);
    };

    obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
    obj(2, '<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
    obj(
      3,
      `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw.toFixed(2)} ${ph.toFixed(2)}] ` +
        `/Resources << /XObject << /Im0 4 0 R >> >> /Contents 5 0 R >>`
    );

    offsets[4] = out.len;
    out.text(
      `4 0 obj\n<< /Type /XObject /Subtype /Image /Width ${imgW} /Height ${imgH} ` +
        `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpeg.length} >>\nstream\n`
    );
    out.bytes(jpeg);
    out.text('\nendstream\nendobj\n');

    offsets[5] = out.len;
    const cbytes = encoder.encode(content);
    out.text(`5 0 obj\n<< /Length ${cbytes.length} >>\nstream\n`);
    out.bytes(cbytes);
    out.text('\nendstream\nendobj\n');

    const xrefPos = out.len;
    let xref = 'xref\n0 6\n0000000000 65535 f \n';
    for (let i = 1; i <= 5; i += 1) xref += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
    xref += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xrefPos}\n%%EOF\n`;
    out.text(xref);

    const buf = new Uint8Array(out.len);
    let p = 0;
    for (const part of out.parts) {
      buf.set(part, p);
      p += part.length;
    }
    return buf;
  }

  function toBase64(bytes) {
    let s = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      s += String.fromCharCode.apply(null, bytes.subarray(i, i + chunk));
    }
    return btoa(s);
  }

  function canvasToJpeg(canvas, quality = 0.94) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(
        (blob) => {
          if (!blob) return reject(new Error('JPEG_ENCODE_FAILED'));
          blob.arrayBuffer().then((b) => resolve(new Uint8Array(b)), reject);
        },
        'image/jpeg',
        quality
      );
    });
  }

  window.ZupuPdf = { build, toBase64, canvasToJpeg, PAGE };
})();
