/**
 * scanner.js — 条码扫码封装（design.md §3.7，US-15）
 *
 * 纯本地方案（D22）：
 *   - 原生 BarcodeDetector 优先（Android Chrome 支持）；不可用时 CDN 懒加载 html5-qrcode 降级；
 *   - 只匹配库存中的 barcode 字段，不联网、不查外部药品库（N6）；
 *   - 扫码画面仅本地处理，不上传。
 *
 * 状态机（§3.7）：idle → loading（懒加载引擎，仅降级路径）→ scanning（摄像头取景）
 *                 → 命中 onDetected（自动停止）→ idle
 *                 └─ 权限拒绝 / 无摄像头 / 引擎加载失败 → onError（手动输入条码兜底）
 *
 * 可单测的纯函数：supportsNative / normalizeCode / matchByBarcode / loadFallback（可注入 document）。
 * 扫码会话（startNative / startFallback）通过 opts.env 注入测试环境（BarcodeDetector、
 * navigator.mediaDevices、document、setTimeout 等），node 中可单测。
 *
 * 浏览器中通过 <script> 加载，暴露全局 Scanner；node 中可 require。
 */
(function (global) {
  'use strict';

  /** 主 CDN 与备用 CDN（风险缓解：弱网/网络环境受限时切换，design.md §7） */
  var PRIMARY_CDN = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  var FALLBACK_CDN = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';

  var active = null; // 当前活动的扫码会话 { stop }；null = idle

  function envTimer(env, name) {
    return (env && env[name]) || global[name];
  }

  /** 原生 BarcodeDetector 是否可用（§3.7 原生优先）。env 可注入（测试）。 */
  function supportsNative(env) {
    env = env || global;
    return typeof env.BarcodeDetector === 'function';
  }

  /** 码值归一化：去首尾空白；空 → null（统一存字符串，design.md §3.2）。 */
  function normalizeCode(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /**
   * 按条码精确匹配库存药品（纯本地，§3.7；未收录 → null）。
   * @param {Array} drugs 药品数组（含 barcode 字段）
   * @param {string} code 扫码读出的码值
   * @returns {object|null}
   */
  function matchByBarcode(drugs, code) {
    var c = normalizeCode(code);
    if (!c || !Array.isArray(drugs)) return null;
    for (var i = 0; i < drugs.length; i++) {
      var d = drugs[i];
      if (d && normalizeCode(d.barcode) === c) return d;
    }
    return null;
  }

  function loadScript(src, doc) {
    return new Promise(function (resolve, reject) {
      var s = doc.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () {
        try { s.remove(); } catch (e) { /* ignore */ }
        reject(new Error('扫码引擎脚本加载失败：' + src));
      };
      doc.head.appendChild(s);
    });
  }

  /**
   * 加载降级引擎（html5-qrcode CDN 懒加载；主 CDN 失败自动切换备用）。
   * @param {object} [env] 测试注入：{ document, Html5Qrcode }
   * @returns {Promise<function>} Html5Qrcode 类
   */
  function loadFallback(env) {
    env = env || global;
    if (typeof env.Html5Qrcode === 'function') return Promise.resolve(env.Html5Qrcode);
    var doc = env.document;
    if (!doc || typeof doc.createElement !== 'function') {
      return Promise.reject(new Error('当前环境不支持扫码（需 HTTPS 与摄像头权限）'));
    }
    return loadScript(PRIMARY_CDN, doc)
      .catch(function () { return loadScript(FALLBACK_CDN, doc); })
      .then(function () {
        if (typeof env.Html5Qrcode !== 'function') {
          throw new Error('扫码引擎不可用（html5-qrcode 未加载成功）');
        }
        return env.Html5Qrcode;
      });
  }

  /** 停止当前扫码会话（释放摄像头；幂等）。 */
  function stop() {
    if (!active) return;
    var sess = active;
    active = null;
    try { sess.stop(); } catch (e) { /* ignore */ }
  }

  /** 从 BarcodeDetector.detect() 结果中取第一个码值（归一化）。 */
  function extractCode(codes) {
    if (!Array.isArray(codes) || !codes.length) return null;
    var first = codes[0];
    return normalizeCode(first && (first.rawValue != null ? first.rawValue : first.value));
  }

  /** 原生 BarcodeDetector 扫码会话（§3.7 原生优先）。 */
  function startNative(env, element, onDetected, onState, onError) {
    var navigatorObj = env.navigator || (typeof navigator !== 'undefined' ? navigator : null);
    var mediaDevices = navigatorObj && navigatorObj.mediaDevices;
    if (!mediaDevices || typeof mediaDevices.getUserMedia !== 'function') {
      onError(new Error('当前环境不支持摄像头（需 HTTPS 与摄像头权限），请手动输入条码'));
      return;
    }
    var detector;
    try {
      detector = new env.BarcodeDetector();
    } catch (e) {
      onError(new Error('无法初始化条码识别，请改用支持扫码的浏览器或手动输入条码'));
      return;
    }

    var stopped = false;
    var timer = null;
    var video = null;
    var streamRef = null;
    var sess = {
      stop: function () {
        stopped = true;
        if (timer != null && envTimer(env, 'clearTimeout')) envTimer(env, 'clearTimeout')(timer);
        if (streamRef) {
          try { streamRef.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        }
        if (video && video.parentNode) video.parentNode.removeChild(video);
      }
    };
    active = sess;

    onState('loading', '正在启动摄像头…');
    mediaDevices.getUserMedia({ video: { facingMode: 'environment' } }).then(function (stream) {
      if (stopped) {
        try { stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) { /* ignore */ }
        return;
      }
      streamRef = stream;
      video = env.document.createElement('video');
      video.setAttribute('autoplay', '');
      video.setAttribute('muted', '');
      video.setAttribute('playsinline', '');
      video.srcObject = stream;
      var p = video.play();
      if (p && typeof p.catch === 'function') p.catch(function () { /* 自动播放限制：忽略 */ });
      element.appendChild(video);

      function loop() {
        if (stopped) return;
        detector.detect(video).then(function (codes) {
          if (stopped) return;
          var code = extractCode(codes);
          if (code) {
            stop();
            onDetected(code);
            return;
          }
          timer = envTimer(env, 'setTimeout')(loop, 120);
        }).catch(function () {
          if (!stopped) timer = envTimer(env, 'setTimeout')(loop, 120); // 单帧识别失败忽略，继续
        });
      }
      timer = envTimer(env, 'setTimeout')(loop, 120);
      onState('scanning', '正在扫描…请将条码对准取景框');
    }).catch(function () {
      stop();
      onError(new Error('无法访问摄像头（权限被拒绝或无摄像头），请手动输入条码'));
    });
  }

  /** html5-qrcode 降级扫码会话（CDN 懒加载，§3.7）。 */
  function startFallback(env, element, onDetected, onState, onError) {
    onState('loading', '正在加载扫码引擎…');
    loadFallback(env).then(function (Html5Qrcode) {
      var qr;
      try {
        qr = new Html5Qrcode(element); // element 为容器元素或 id（html5-qrcode 2.x）
      } catch (e) {
        onError(new Error('扫码引擎初始化失败，请手动输入条码'));
        return;
      }
      var sess = {
        stop: function () {
          if (qr) {
            qr.stop().then(function () {
              try { qr.clear(); } catch (e) { /* ignore */ }
            }).catch(function () {
              try { qr.clear(); } catch (e) { /* ignore */ }
            });
          }
        }
      };
      active = sess;

      onState('loading', '正在启动摄像头…');
      qr.start(
        { facingMode: 'environment' },
        { fps: 10, qrbox: { width: 250, height: 150 } },
        function (text) {
          stop();
          onDetected(normalizeCode(text));
        },
        function () { /* 单帧解码失败忽略 */ }
      ).then(function () {
        if (active === sess) onState('scanning', '正在扫描…请将条码对准取景框');
      }).catch(function () {
        stop();
        onError(new Error('无法启动摄像头（权限被拒绝或无摄像头），请手动输入条码'));
      });
    }).catch(function (err) {
      onError(err instanceof Error ? err : new Error(String(err)));
    });
  }

  /**
   * 启动扫码（§3.7 状态机）。
   * @param {object} opts
   *   element: DOM 容器（扫码取景区）
   *   env:     可选注入（测试）：{ BarcodeDetector, navigator, document, Html5Qrcode, setTimeout, clearTimeout }
   * @param {object} callbacks
   *   onDetected(code)  读到码值（单次命中后自动停止）
   *   onState(state, msg) 'loading' | 'scanning'
   *   onError(err)       权限拒绝/无摄像头/引擎加载失败
   * @returns {{stop:function}} 会话控制（关闭弹层时调用以释放摄像头）
   */
  function start(opts, callbacks) {
    opts = opts || {};
    callbacks = callbacks || {};
    var env = opts.env || global;
    var element = opts.element;
    var onDetected = callbacks.onDetected || function () {};
    var onState = callbacks.onState || function () {};
    var onError = callbacks.onError || function () {};

    stop(); // 防重复启动

    if (!element || !env.document) {
      onError(new Error('扫码容器不可用，请重试'));
      return { stop: stop };
    }

    if (supportsNative(env)) {
      startNative(env, element, onDetected, onState, onError);
    } else {
      startFallback(env, element, onDetected, onState, onError);
    }
    return { stop: stop };
  }

  var Scanner = {
    PRIMARY_CDN: PRIMARY_CDN,
    FALLBACK_CDN: FALLBACK_CDN,
    supportsNative: supportsNative,
    normalizeCode: normalizeCode,
    matchByBarcode: matchByBarcode,
    loadFallback: loadFallback,
    start: start,
    stop: stop,
    isScanning: function () { return !!active; }
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Scanner;
  }
  global.Scanner = Scanner;
})(typeof window !== 'undefined' ? window : globalThis);
