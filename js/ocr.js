/**
 * ocr.js — Tesseract.js CDN 懒加载 + 图片预处理 + recognize（依赖 DOM，仅浏览器）
 *
 * 设计约束（design.md §3.4 / D10 / N5）：
 *   - 只在用户点击「拍照识别/相册识别」时懒加载（核心 + chi_sim 语言包）；
 *   - 显示加载进度（核心/语言包/初始化/识别各阶段）；
 *   - 加载失败可重试/放弃（错误通过回调上报，由 app.js 呈现）；
 *   - 优先 Tesseract v5 createWorker API；若 CDN 返回 v4 则走 worker.create 兼容路径。
 *
 * 浏览器中通过 <script> 加载，暴露全局 OCR。
 */
(function (global) {
  'use strict';

  /** 主 CDN 与备用 CDN（风险缓解：弱网/网络环境受限时切换，design.md §7） */
  var PRIMARY_CDN = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
  var FALLBACK_CDN = 'https://unpkg.com/tesseract.js@5/dist/tesseract.min.js';

  var LANG = 'chi_sim';
  var worker = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        s.remove();
        reject(new Error('OCR 引擎脚本加载失败：' + src));
      };
      document.head.appendChild(s);
    });
  }

  /** 状态 → 中文进度文案 */
  function statusText(status) {
    var s = String(status || '');
    if (s.indexOf('core') >= 0) return '正在加载识别引擎…';
    if (s.indexOf('language') >= 0 || s.indexOf('traineddata') >= 0) return '正在加载中文语言包…';
    if (s.indexOf('initializ') >= 0) return '正在初始化识别引擎…';
    if (s.indexOf('recogniz') >= 0) return '正在识别文字…';
    return '处理中…';
  }

  /**
   * 初始化 Tesseract（懒加载脚本 + 语言包）。
   * @param {function(string, number)} progressCb (阶段文案, 0~1)
   * @returns {Promise<object>} worker
   */
  function init(progressCb) {
    if (worker) return Promise.resolve(worker);

    var scriptPromise = global.Tesseract
      ? Promise.resolve()
      : loadScript(PRIMARY_CDN).catch(function () { return loadScript(FALLBACK_CDN); });

    return scriptPromise.then(function () {
      var T = global.Tesseract;
      if (!T) throw new Error('OCR 引擎不可用（Tesseract 未加载成功）');

      var logger = function (m) {
        if (m && typeof m.progress === 'number' && progressCb) {
          progressCb(statusText(m.status), m.progress);
        }
      };

      if (typeof T.createWorker === 'function') {
        // v5 worker API：createWorker(langs, oem, options)，语言包随初始化加载
        return T.createWorker(LANG, 1, { logger: logger }).then(function (w) {
          worker = w;
          return w;
        });
      }
      if (T.worker && typeof T.worker.create === 'function') {
        // v4 兼容路径
        return T.worker.create({ logger: logger }).then(function (w) {
          return w.loadLanguage(LANG).then(function () {
            return w.initialize(LANG);
          }).then(function () {
            worker = w;
            return w;
          });
        });
      }
      throw new Error('不支持的 Tesseract 版本（未找到 createWorker / worker.create）');
    });
  }

  /**
   * 图片预处理：缩放至最长边 ≤2000px（转 canvas），减小识别耗时与内存。
   * @param {string} dataUrl 图片 data URL
   * @returns {Promise<HTMLCanvasElement>}
   */
  function preprocess(dataUrl) {
    return new Promise(function (resolve, reject) {
      var img = new Image();
      img.onload = function () {
        var maxSide = 2000;
        var scale = Math.min(1, maxSide / Math.max(img.width, img.height));
        var w = Math.max(1, Math.round(img.width * scale));
        var h = Math.max(1, Math.round(img.height * scale));
        var canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        var ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        resolve(canvas);
      };
      img.onerror = function () {
        reject(new Error('图片读取失败，请重试或换一张图片'));
      };
      img.src = dataUrl;
    });
  }

  /**
   * 识别：懒加载 → 预处理 → recognize。
   * @param {string} dataUrl 图片 data URL
   * @param {function(string, number)} [progressCb] 识别阶段进度
   * @returns {Promise<string>} 识别出的原始文本
   */
  function recognize(dataUrl, progressCb) {
    return init(progressCb).then(function (w) {
      return preprocess(dataUrl).then(function (canvas) {
        return w.recognize(canvas).then(function (res) {
          return (res && res.data && res.data.text) || '';
        });
      });
    });
  }

  /** 重置 worker（重试/版本切换场景使用）。 */
  function reset() {
    if (worker && typeof worker.terminate === 'function') {
      try { worker.terminate(); } catch (e) { /* ignore */ }
    }
    worker = null;
  }

  global.OCR = {
    PRIMARY_CDN: PRIMARY_CDN,
    FALLBACK_CDN: FALLBACK_CDN,
    init: init,
    recognize: recognize,
    preprocess: preprocess,
    reset: reset,
    isLoaded: function () { return !!worker; }
  };
})(typeof window !== 'undefined' ? window : globalThis);
