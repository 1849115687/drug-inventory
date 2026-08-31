/**
 * scanner.js — 条码扫码封装（design.md §3.7，US-15）
 *
 * 纯本地方案（D22/D26）：
 *   - APK/Cordova 环境（WebView 无 BarcodeDetector、getUserMedia 不可用，实测确认）
 *     → 调用原生扫码插件 cordova-plugin-barcodescanner 的系统摄像头（D26，ZXing 随插件内置打包，
 *       无 JitPack/Google Play 服务依赖）；
 *   - 浏览器：原生 BarcodeDetector 优先（Android Chrome 支持）；不可用时 CDN 懒加载 html5-qrcode 降级；
 *   - 只匹配库存中的 barcode 字段，不联网、不查外部药品库（N6）；
 *   - 扫码画面仅本地处理，不上传。
 *
 * 状态机（§3.7）：idle → loading（懒加载引擎 / 等待原生插件就绪）→ scanning（摄像头取景）
 *                 → 命中 onDetected（自动停止）→ idle
 *                 └─ 取消（系统返回键，cancelled）→ 回到 idle（不报错）
 *                 └─ 权限拒绝 / 无摄像头 / 引擎加载失败 / 原生插件不可用 → onError（手动输入条码兜底）
 *
 * 可单测的纯函数：isCordova / isNativeCapacitor / supportsNative / normalizeCode / matchByBarcode / loadFallback（可注入环境）。
 * 扫码会话（startCordova / startNative / startFallback）通过 opts.env 注入测试环境
 * （cordova、BarcodeDetector、navigator.mediaDevices、document、setTimeout 等），node 中可单测。
 *
 * 浏览器中通过 <script> 加载，暴露全局 Scanner；node 中可 require。
 */
(function (global) {
  'use strict';

  /** 主 CDN 与备用 CDN（风险缓解：弱网/网络环境受限时切换，design.md §7） */
  var PRIMARY_CDN = 'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js';
  var FALLBACK_CDN = 'https://cdn.jsdelivr.net/npm/html5-qrcode@2.3.8/html5-qrcode.min.js';

  /** APK 原生插件就绪轮询（startCordovaPath，§3.7）：每 200ms 检查一次，上限 40 次 ≈ 8s */
  var PLUGIN_POLL_INTERVAL_MS = 200;
  var PLUGIN_POLL_MAX_ATTEMPTS = 40;

  var active = null; // 当前活动的扫码会话 { stop }；null = idle

  function envTimer(env, name) {
    return (env && env[name]) || global[name];
  }

  /** 原生 BarcodeDetector 是否可用（§3.7 原生优先）。env 可注入（测试）。 */
  function supportsNative(env) {
    env = env || global;
    return typeof env.BarcodeDetector === 'function';
  }

  /**
   * Cordova 原生环境检测（APK，D26）。纯函数、无 DOM 依赖，可单测。
   *
   * APK 内 Capacitor 的 cordova 兼容层会注入 window.cordova（含 cordova.plugins）——
   * cordova 对象存在即原生环境；再检查原生扫码插件 cordova.plugins.barcodeScanner
   * （cordova-plugin-barcodescanner 的 clobbers 注册目标）是否已就绪。
   *
   * 浏览器网页版不注入 window.cordova → 返回 false，行为不变。
   *
   * @param {object} [env] 测试注入：{ cordova: { plugins: { barcodeScanner } } }
   * @returns {boolean}
   */
  function isCordova(env) {
    env = env || global;
    try {
      var cordova = env.cordova;
      return !!(cordova && cordova.plugins && cordova.plugins.barcodeScanner);
    } catch (e) { /* 检测异常视为非原生环境，不中断 */ }
    return false;
  }

  /**
   * Capacitor 原生环境检测（APK，D26）——比 cordova.js 更早可用。
   *
   * APK 内 Capacitor 原生桥始终注入 window.Capacitor（isNativePlatform() === true），
   * 而 cordova 兼容层与插件注册在应用启动后异步完成——本函数用于在 cordova.js 尚未加载
   * 时就识别出 APK 原生环境，从而进入原生扫码路径并等待插件就绪（startCordovaPath）。
   *
   * 浏览器网页版不注入 Capacitor（或 isNativePlatform() 返回 false）→ 返回 false，行为不变。
   *
   * @param {object} [env] 测试注入：{ Capacitor: { isNativePlatform() } }
   * @returns {boolean}
   */
  function isNativeCapacitor(env) {
    env = env || global;
    try {
      var cap = env.Capacitor;
      return !!(cap && typeof cap.isNativePlatform === 'function' && cap.isNativePlatform() === true);
    } catch (e) { /* 检测异常视为非原生环境，不中断 */ }
    return false;
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
   * Cordova 原生扫码会话（APK，D26；cordova-plugin-barcodescanner，PhoneGap 老牌插件）。
   *
   * 与浏览器路径不同：调用原生插件打开系统摄像头全屏扫码（模态 Activity），不依赖 DOM
   * 取景元素；成功/取消后插件自动关闭扫码界面并回调结果。隐私同 D22：画面与码值仅本地处理。
   *
   * 实现要点：
   *   - JS API：cordova.plugins.barcodeScanner.scan(success, err, config)；
   *     success 回调 result = { text, format, cancelled }（ZXing 解码）；
   *   - ZXing 随插件打包（captureactivity.jar + LibraryProject 源码），无需 JitPack/Google Play
   *     服务（国内手机无 GMS 也可用）；相机权限由原生扫码 Activity 自行申请；
   *   - result.cancelled === true（用户按系统返回键取消）→ 回到 idle，不报错（§3.7）；
   *   - 原生会话是模态 Activity，无法通过桥接取消：stop() 仅置标记，迟到结果被忽略（幂等安全）；
   *   - 返回的会话对象与 start() 约定一致（关闭弹层时调用 Scanner.stop()）。
   *
   * @param {object} env   含 cordova（测试注入）
   * @param {function} onDetected(code)  读到码值（单次命中后自动结束）
   * @param {function} onState(state, msg)
   * @param {function} onError(err)
   */
  function startCordova(env, onDetected, onState, onError) {
    var cordova = env.cordova || {};
    var barcodeScanner = (cordova.plugins || {}).barcodeScanner;
    if (!barcodeScanner || typeof barcodeScanner.scan !== 'function') {
      onError(new Error('当前环境不支持原生扫码（未找到扫码插件），请手动输入条码'));
      return;
    }

    var stopped = false;
    var sess = {
      stop: function () { stopped = true; } // 模态 Activity 无法桥接取消，仅标记；系统返回键/完成即关闭
    };
    active = sess;

    onState('scanning', '正在扫描…请将条码对准取景框');
    try {
      barcodeScanner.scan(function (result) {
        if (stopped) return;                // stop() 后忽略迟到结果
        stop();                             // 单次命中/取消即结束会话
        result = result || {};
        if (result.cancelled === true) return; // 用户按系统返回键取消：回到 idle，不报错
        var code = normalizeCode(result.text);
        if (!code) {
          onError(new Error('未读取到条码内容，请重试或手动输入条码'));
          return;
        }
        onDetected(code);
      }, function (err) {
        if (stopped) return;
        stop();
        var msg = err && err.message ? err.message : '';
        onError(new Error('扫码失败' + (msg ? '（' + msg + '）' : '') + '，请手动输入条码'));
      }, {
        formats: 'EAN_13,EAN_8,CODE_128,CODE_39,QR_CODE,UPC_A,UPC_E',
        showTorchButton: true,
        showFlipCameraButton: true
      });
    } catch (e) {
      // 桥接同步抛异常（而非调用 err 回调）时兜底，与 err 回调同语义
      stop();
      onError(new Error('扫码失败（' + (e && e.message ? e.message : '未知原因') + '），请手动输入条码'));
    }
  }

  /**
   * APK/Capacitor 原生扫码路径（§3.7）：插件就绪则直接 startCordova，未就绪则轮询等待。
   *
   * cordova 插件注册在应用启动后异步完成：用户启动 APK 后立即点「扫码」时，
   * window.cordova 已存在而 cordova.plugins.barcodeScanner 尚未注册（实测）。
   * APK WebView 中 BarcodeDetector/getUserMedia 均不可用 → 不降级浏览器路径，
   * 等待插件注册；等待期间用户关闭扫码弹层（Scanner.stop()）→ 取消轮询、绝不起动摄像头。
   *
   * @param {object} env 含 Capacitor / cordova（测试注入）
   * @param {function} onDetected(code)
   * @param {function} onState(state, msg)
   * @param {function} onError(err)
   */
  function startCordovaPath(env, onDetected, onState, onError) {
    if (isCordova(env)) {
      // 插件已就绪：直接走原生扫码（系统摄像头全屏扫码，D26）
      startCordova(env, onDetected, onState, onError);
      return;
    }

    // 插件未就绪（cordova.js 已注入、插件尚未注册）：轮询等待（≤8s，可取消）
    var cancelled = false;
    var attempts = 0;
    var timer = null;
    var sess = {
      stop: function () {
        cancelled = true;
        if (timer != null && envTimer(env, 'clearTimeout')) envTimer(env, 'clearTimeout')(timer);
      }
    };
    active = sess; // 等待期间注册会话，使 Scanner.stop() 可取消等待
    onState('loading', '正在初始化扫码…');

    function poll() {
      if (cancelled) return; // 等待被取消：直接放弃，绝不起动摄像头
      if (isCordova(env)) {
        active = null; // 插件就绪：交由 startCordova 接管会话
        startCordova(env, onDetected, onState, onError);
        return;
      }
      attempts++;
      if (attempts >= PLUGIN_POLL_MAX_ATTEMPTS) {
        active = null;
        onError(new Error('未找到扫码插件，请手动输入条码'));
        return;
      }
      timer = envTimer(env, 'setTimeout')(poll, PLUGIN_POLL_INTERVAL_MS);
    }
    timer = envTimer(env, 'setTimeout')(poll, PLUGIN_POLL_INTERVAL_MS);
  }

  /**
   * 启动扫码（§3.7 状态机；APK 走 cordova 原生插件，D26）。
   * @param {object} opts
   *   element: DOM 容器（扫码取景区；cordova 原生路径不使用）
   *   env:     可选注入（测试）：{ Capacitor, cordova, BarcodeDetector, navigator, document, Html5Qrcode, setTimeout, clearTimeout }
   * @param {object} callbacks
   *   onDetected(code)  读到码值（单次命中后自动停止）
   *   onState(state, msg) 'loading' | 'scanning'
   *   onError(err)       权限拒绝/无摄像头/引擎加载失败/原生插件不可用
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

    if (isNativeCapacitor(env) || env.cordova) {
      // APK/Capacitor 原生环境（原生桥恒注入，或 cordova 兼容层已加载）：
      // 走原生扫码路径——插件就绪立即扫码，未就绪轮询等待（≤8s，可取消，§3.7）
      startCordovaPath(env, onDetected, onState, onError);
    } else if (supportsNative(env)) {
      // 浏览器：原生 BarcodeDetector 优先（§3.7）
      startNative(env, element, onDetected, onState, onError);
    } else {
      // 浏览器：html5-qrcode CDN 懒加载降级
      startFallback(env, element, onDetected, onState, onError);
    }
    return { stop: stop };
  }

  var Scanner = {
    PRIMARY_CDN: PRIMARY_CDN,
    FALLBACK_CDN: FALLBACK_CDN,
    isCordova: isCordova,
    isNativeCapacitor: isNativeCapacitor,
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
