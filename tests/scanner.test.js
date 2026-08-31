/**
 * scanner.js 单元测试 —— 纯函数 + 扫码会话（注入测试环境，design.md §3.7）
 * 覆盖：Cordova 原生环境检测与原生分支（D26，cordova-plugin-barcodescanner）、BarcodeDetector 可用性判断、
 *       码值归一化、条码匹配、CDN 懒加载降级分支、原生/降级两条扫码路径的命中与停止、错误分支
 *       （权限/无摄像头/容器不可用）
 * 运行：node --test tests/
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Scanner = require('../js/scanner.js');

/** 假 document：script（可驱动 onload/onerror）+ video（原生路径取景） */
function fakeDoc() {
  const scripts = [];
  const head = {
    appendChild(s) { scripts.push(s); }
  };
  return {
    head,
    createElement(tag) {
      if (tag === 'script') {
        // 真实 DOM 语义：脚本只在 head.appendChild 时计入一次（createElement 不挂载）
        const s = { src: '', async: false, onload: null, onerror: null, remove() { this.removed = true; } };
        return s;
      }
      if (tag === 'video') {
        return {
          _attrs: {},
          setAttribute(k, v) { this._attrs[k] = v; },
          srcObject: null,
          play() { return Promise.resolve(); },
          parentNode: null
        };
      }
      throw new Error('unexpected tag ' + tag);
    },
    _scripts: scripts
  };
}

function fakeEnv(overrides) {
  return Object.assign({
    document: fakeDoc(),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (t) => clearTimeout(t)
  }, overrides || {});
}

/**
 * 假定时器：手动推进时间（插件就绪轮询用例，避免真实等待 ~8s）。
 * 返回 { setTimeout, clearTimeout, advance(ms), getNow() }；advance 按时间顺序
 * 触发到期的定时器（回调内新排的定时器若在窗口内也会一并触发）。
 */
function fakeTimers() {
  let now = 0;
  let nextId = 1;
  const timers = new Map(); // id -> { fn, at }
  return {
    setTimeout(fn, ms) {
      const id = nextId++;
      timers.set(id, { fn, at: now + ms });
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    advance(ms) {
      const target = now + ms;
      let fired = 0;
      for (;;) {
        let bestId = -1;
        let bestAt = Infinity;
        for (const [id, t] of timers) {
          if (t.at <= target && t.at < bestAt) { bestAt = t.at; bestId = id; }
        }
        if (bestId < 0) break;
        const t = timers.get(bestId);
        timers.delete(bestId);
        now = bestAt;
        t.fn();
        fired++;
      }
      now = target;
      return fired;
    },
    getNow() { return now; }
  };
}

/* ---------- supportsNative（BarcodeDetector 可用性判断） ---------- */

test('supportsNative：有 BarcodeDetector → true；无 → false', () => {
  assert.strictEqual(Scanner.supportsNative({}), false);
  assert.strictEqual(Scanner.supportsNative({ BarcodeDetector: undefined }), false);
  assert.strictEqual(Scanner.supportsNative({ BarcodeDetector: class {} }), true);
});

/* ---------- isCordova（APK/Cordova 原生环境检测，D26） ---------- */

test('isCordova：无 cordova → false（浏览器/普通环境）；cordova 未就绪（无 plugins）→ false', () => {
  assert.strictEqual(Scanner.isCordova({}), false);
  assert.strictEqual(Scanner.isCordova({ cordova: undefined }), false);
  assert.strictEqual(Scanner.isCordova({ cordova: null }), false);
  assert.strictEqual(Scanner.isCordova({ cordova: {} }), false);           // cordova.js 已注入但 plugins 未就绪
  assert.strictEqual(Scanner.isCordova({ cordova: { plugins: undefined } }), false);
});

test('isCordova：cordova 存在但原生扫码插件缺失 → false', () => {
  assert.strictEqual(Scanner.isCordova({ cordova: { plugins: {} } }), false);
  assert.strictEqual(Scanner.isCordova({ cordova: { plugins: { barcodeScanner: undefined } } }), false);
});

test('isCordova：cordova.plugins.barcodeScanner 已注册 → true（APK 内 cordova 兼容层注入）', () => {
  assert.strictEqual(Scanner.isCordova({ cordova: { plugins: { barcodeScanner: {} } } }), true);
});

test('isCordova：检测抛异常 → false（检测不中断）', () => {
  const env = {};
  Object.defineProperty(env, 'cordova', { get() { throw new Error('bridge broken'); } });
  assert.strictEqual(Scanner.isCordova(env), false);
});

/* ---------- isNativeCapacitor（Capacitor 原生桥检测，比 cordova.js 更早可用） ---------- */

test('isNativeCapacitor：isNativePlatform 返回 true → true（APK 内原生桥恒注入）', () => {
  assert.strictEqual(Scanner.isNativeCapacitor({ Capacitor: { isNativePlatform: () => true } }), true);
});

test('isNativeCapacitor：非原生环境 → false（无 Capacitor / isNativePlatform 非函数 / 返回 false）', () => {
  assert.strictEqual(Scanner.isNativeCapacitor({}), false);
  assert.strictEqual(Scanner.isNativeCapacitor({ Capacitor: undefined }), false);
  assert.strictEqual(Scanner.isNativeCapacitor({ Capacitor: {} }), false);
  assert.strictEqual(Scanner.isNativeCapacitor({ Capacitor: { isNativePlatform: true } }), false);   // 非函数
  assert.strictEqual(Scanner.isNativeCapacitor({ Capacitor: { isNativePlatform: () => false } }), false); // 浏览器网页版
});

/* ---------- normalizeCode（码值归一化） ---------- */

test('normalizeCode：去首尾空白；空 → null；数字转字符串', () => {
  assert.strictEqual(Scanner.normalizeCode(' 6901234567890 '), '6901234567890');
  assert.strictEqual(Scanner.normalizeCode(''), null);
  assert.strictEqual(Scanner.normalizeCode('   '), null);
  assert.strictEqual(Scanner.normalizeCode(null), null);
  assert.strictEqual(Scanner.normalizeCode(undefined), null);
  assert.strictEqual(Scanner.normalizeCode(6901234567890), '6901234567890'); // 数值型码转字符串
});

/* ---------- matchByBarcode（纯本地条码匹配） ---------- */

test('matchByBarcode：精确命中 / 未收录 → null', () => {
  const drugs = [
    { id: 'd1', name: '阿莫西林胶囊', barcode: '6901234567890' },
    { id: 'd2', name: '无码药', barcode: null }
  ];
  assert.strictEqual(Scanner.matchByBarcode(drugs, '6901234567890').id, 'd1');
  assert.strictEqual(Scanner.matchByBarcode(drugs, ' 6901234567890 ').id, 'd1'); // 归一化后匹配
  assert.strictEqual(Scanner.matchByBarcode(drugs, '999'), null);                // 未收录
  assert.strictEqual(Scanner.matchByBarcode(drugs, ''), null);                   // 空码
  assert.strictEqual(Scanner.matchByBarcode(null, '6901234567890'), null);       // 非数组容错
  assert.strictEqual(Scanner.matchByBarcode([], '6901234567890'), null);
});

/* ---------- loadFallback（html5-qrcode CDN 懒加载降级） ---------- */

test('loadFallback：引擎已就绪 → 直接返回，不加载脚本', async () => {
  function Fake() {}
  const H = await Scanner.loadFallback({ Html5Qrcode: Fake });
  assert.strictEqual(H, Fake);
});

test('loadFallback：无 document（node/无 DOM）→ 拒绝', async () => {
  await assert.rejects(() => Scanner.loadFallback({}), /摄像头/);
});

test('loadFallback：主 CDN 加载成功 → 返回引擎类', async () => {
  function Fake() {}
  const doc = fakeDoc();
  const env = { document: doc }; // 初始无 Html5Qrcode → 走脚本加载
  const p = Scanner.loadFallback(env);
  assert.strictEqual(doc._scripts.length, 1);
  assert.ok(doc._scripts[0].src.indexOf('unpkg') >= 0, '主 CDN 应为 unpkg');
  env.Html5Qrcode = Fake; // 模拟脚本执行注入全局类
  doc._scripts[0].onload();
  const H = await p;
  assert.strictEqual(H, Fake);
});

test('loadFallback：主 CDN 失败 → 自动切换备用 CDN', async () => {
  function Fake() {}
  const doc = fakeDoc();
  const env = { document: doc };
  const p = Scanner.loadFallback(env);
  doc._scripts[0].onerror(); // 主 CDN 失败
  await new Promise((r) => setTimeout(r, 0)); // 等 catch 微任务把备用脚本挂载
  assert.strictEqual(doc._scripts.length, 2);
  assert.ok(doc._scripts[1].src.indexOf('jsdelivr') >= 0, '备用 CDN 应为 jsdelivr');
  env.Html5Qrcode = Fake;
  doc._scripts[1].onload();
  const H = await p;
  assert.strictEqual(H, Fake);
});

test('loadFallback：双 CDN 都失败 → 拒绝（可重试/放弃）', async () => {
  const doc = fakeDoc();
  const env = { document: doc };
  const p = Scanner.loadFallback(env);
  doc._scripts[0].onerror();
  await new Promise((r) => setTimeout(r, 0)); // 等备用脚本挂载
  doc._scripts[1].onerror();
  await assert.rejects(p, /扫码引擎脚本加载失败/);
});

/* ---------- 原生 BarcodeDetector 扫码会话 ---------- */

test('原生路径：命中码值 → 自动停止并回调归一化码值', async () => {
  let detectCalls = 0;
  class FakeDetector {
    detect() {
      detectCalls++;
      if (detectCalls < 2) return Promise.resolve([]);            // 前 1 帧无码
      return Promise.resolve([{ rawValue: ' 6901234567890 ' }]);  // 第 2 帧命中
    }
  }
  const trackStopped = { v: false };
  const env = fakeEnv({
    BarcodeDetector: FakeDetector,
    navigator: {
      mediaDevices: {
        getUserMedia() {
          return Promise.resolve({ getTracks() { return [{ stop() { trackStopped.v = true; } }]; } });
        }
      }
    }
  });
  const container = { appendChild() {} };
  const states = [];
  const detected = new Promise((resolve) => {
    Scanner.start({ element: container, env }, {
      onDetected: resolve,
      onState: (s) => states.push(s)
    });
  });
  const code = await detected;
  assert.strictEqual(code, '6901234567890'); // 码值归一化
  assert.strictEqual(trackStopped.v, true);  // 命中后释放摄像头
  assert.ok(states.indexOf('scanning') >= 0);
});

test('原生路径：摄像头权限被拒绝 → onError（手动输入条码兜底）', async () => {
  const env = fakeEnv({
    BarcodeDetector: class {},
    navigator: { mediaDevices: { getUserMedia() { return Promise.reject(new Error('Permission denied')); } } }
  });
  const err = await new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onError: resolve });
  });
  assert.ok(/摄像头/.test(err.message), '错误信息应提示摄像头/权限问题');
});

test('原生路径：无 mediaDevices（非 HTTPS/非安全上下文）→ onError', () => {
  const env = fakeEnv({ BarcodeDetector: class {}, navigator: {} });
  let errMsg = '';
  Scanner.start({ element: {}, env }, { onError: (e) => { errMsg = e.message; } });
  assert.ok(/摄像头/.test(errMsg));
});

/* ---------- html5-qrcode 降级扫码会话 ---------- */

test('降级路径：命中码值 → 自动停止并回调码值', async () => {
  const instances = [];
  let stopped = false;
  let cleared = false;
  class FakeQr {
    constructor(el) { this.el = el; this.successCb = null; instances.push(this); }
    start(camera, config, onSuccess) {
      this.successCb = onSuccess;
      return Promise.resolve();
    }
    stop() { stopped = true; return Promise.resolve(); }
    clear() { cleared = true; }
  }
  const env = fakeEnv({ Html5Qrcode: FakeQr }); // 无 BarcodeDetector → 走降级
  const detected = new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onDetected: resolve });
  });
  await new Promise((r) => setTimeout(r, 10)); // 等 loadFallback → start 完成
  assert.strictEqual(instances.length, 1);
  instances[0].successCb('6901234567890');     // 模拟引擎读到码
  const code = await detected;
  assert.strictEqual(code, '6901234567890');
  assert.strictEqual(stopped, true);           // 命中后自动停止
  assert.strictEqual(cleared, true);
});

test('降级路径：摄像头启动失败 → onError', async () => {
  class FakeQr {
    constructor() { this.successCb = null; }
    start() { return Promise.reject(new Error('camera busy')); }
    stop() { return Promise.resolve(); }
    clear() {}
  }
  const env = fakeEnv({ Html5Qrcode: FakeQr });
  const err = await new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onError: resolve });
  });
  assert.ok(/摄像头/.test(err.message));
});

/* ---------- Cordova 原生扫码分支（D26，cordova-plugin-barcodescanner） ---------- */

test('Cordova 分支：命中 → 回调归一化码值并自动结束会话（含 config 传参）', async () => {
  let scanArgs = null;
  const barcodeScanner = {
    scan(success, err, config) {
      scanArgs = { success, err, config };
      success({ text: ' 6901234567890 ', format: 'EAN_13', cancelled: false });
    }
  };
  const env = fakeEnv({ cordova: { plugins: { barcodeScanner } } });
  const states = [];
  const detected = new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onDetected: resolve, onState: (s) => states.push(s) });
  });
  const code = await detected;
  assert.strictEqual(code, '6901234567890');   // 码值归一化
  assert.ok(scanArgs, '应调用原生插件 scan(success, err, config)');
  assert.strictEqual(scanArgs.config.formats, 'EAN_13,EAN_8,CODE_128,CODE_39,QR_CODE,UPC_A,UPC_E', '限定的码型');
  assert.strictEqual(scanArgs.config.showTorchButton, true, '显示手电筒按钮');
  assert.strictEqual(scanArgs.config.showFlipCameraButton, true, '显示切换摄像头按钮');
  assert.ok(states.indexOf('scanning') >= 0, '应发出 scanning 状态');
  assert.strictEqual(Scanner.isScanning(), false, '命中后会话已结束');
});

test('Cordova 分支：取消（系统返回键，cancelled:true）→ 回到 idle，不报错', async () => {
  const barcodeScanner = {
    scan(success) { success({ text: '', format: '', cancelled: true }); }
  };
  const env = fakeEnv({ cordova: { plugins: { barcodeScanner } } });
  let detectedCalls = 0;
  let errorCalls = 0;
  Scanner.start({ element: {}, env }, { onDetected: () => { detectedCalls++; }, onError: () => { errorCalls++; } });
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(detectedCalls, 0, '取消不回调命中');
  assert.strictEqual(errorCalls, 0, '取消不报错');
  assert.strictEqual(Scanner.isScanning(), false, '取消后会话已结束（回 idle）');
});

test('Cordova 分支：权限拒绝/插件报错 → onError（手动输入兜底）', async () => {
  const barcodeScanner = {
    scan(success, err) { err(new Error('User did not grant permission')); }
  };
  const env = fakeEnv({ cordova: { plugins: { barcodeScanner } } });
  const err = await new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onError: resolve });
  });
  assert.ok(/扫码失败/.test(err.message));
  assert.ok(/手动输入条码/.test(err.message));
});

test('Cordova 分支：命中空码值 → onError', async () => {
  const barcodeScanner = {
    scan(success) { success({ text: '   ', format: '', cancelled: false }); }
  };
  const env = fakeEnv({ cordova: { plugins: { barcodeScanner } } });
  const err = await new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onError: resolve });
  });
  assert.ok(/未读取到条码/.test(err.message));
});

test('Cordova 分支：stop() 幂等；stop 后的迟到结果被忽略', async () => {
  let scanCalls = 0;
  let lateSuccess;
  const barcodeScanner = {
    scan(success) {
      scanCalls++;
      lateSuccess = success;
    }
  };
  const env = fakeEnv({ cordova: { plugins: { barcodeScanner } } });
  let detectedCalls = 0;
  Scanner.start({ element: {}, env }, { onDetected: () => { detectedCalls++; } });
  assert.strictEqual(Scanner.isScanning(), true, '原生会话进行中');
  assert.doesNotThrow(() => Scanner.stop());
  assert.doesNotThrow(() => Scanner.stop()); // 幂等
  assert.strictEqual(Scanner.isScanning(), false);
  lateSuccess({ text: '6901234567890', format: 'EAN_13', cancelled: false }); // 迟到结果：stop 后忽略
  await new Promise((r) => setTimeout(r, 0));
  assert.strictEqual(detectedCalls, 0);
  assert.strictEqual(scanCalls, 1);
});

test('Cordova 分支：scan 同步抛异常 → onError（手动输入兜底）', () => {
  const barcodeScanner = {
    scan() { throw new Error('bridge broken'); }
  };
  const env = fakeEnv({ cordova: { plugins: { barcodeScanner } } });
  let errMsg = '';
  Scanner.start({ element: {}, env }, { onError: (e) => { errMsg = e.message; } });
  assert.ok(/扫码失败/.test(errMsg));
  assert.ok(/手动输入条码/.test(errMsg));
  assert.strictEqual(Scanner.isScanning(), false, '同步异常后会话已结束');
});

test('Cordova 分支：插件始终未注册 → 轮询超时（40 次 ≈ 8s）→ onError 手动输入兜底（不降级浏览器路径）', () => {
  const ft = fakeTimers();
  const env = fakeEnv({ cordova: { plugins: {} }, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout });
  let errMsg = '';
  let detectedCalls = 0;
  let scanCalls = 0;
  Scanner.start({ element: {}, env }, {
    onDetected: () => { detectedCalls++; },
    onError: (e) => { errMsg = e.message; }
  });
  assert.strictEqual(Scanner.isScanning(), true, '插件未就绪：等待期间会话进行中');
  const fired = ft.advance(40 * 200); // 40 次轮询全部未命中 → 超时
  assert.strictEqual(fired, 40, '应恰好轮询 40 次（每 200ms 一次，共 8s）');
  assert.ok(/未找到扫码插件/.test(errMsg));
  assert.ok(/手动输入条码/.test(errMsg));
  assert.strictEqual(detectedCalls, 0, '不回调命中');
  assert.strictEqual(scanCalls, 0, '插件从未注册：原生扫码从未被调用');
  assert.strictEqual(Scanner.isScanning(), false, '超时后会话已结束（回 idle）');
});

/* ---------- 原生路径：插件就绪时序（Capacitor 桥 / cordova 延迟注册，startCordovaPath） ---------- */

test('原生路径（Capacitor 桥）：插件立即就绪 → 直接 startCordova，命中归一化', async () => {
  const barcodeScanner = {
    scan(success) { success({ text: ' 6901234567890 ', format: 'EAN_13', cancelled: false }); }
  };
  const env = fakeEnv({
    Capacitor: { isNativePlatform: () => true }, // APK 原生桥恒注入（cordova.js 未加载也能识别）
    cordova: { plugins: { barcodeScanner } }
  });
  const states = [];
  const detected = new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onDetected: resolve, onState: (s) => states.push(s) });
  });
  const code = await detected;
  assert.strictEqual(code, '6901234567890');   // 码值归一化
  assert.ok(states.indexOf('scanning') >= 0, '直接进入 scanning');
  assert.ok(states.indexOf('loading') < 0, '插件已就绪：不经过 loading 等待');
  assert.strictEqual(Scanner.isScanning(), false, '命中后会话已结束');
});

test('原生路径：插件延迟注册 → 轮询等待就绪后正常扫码', async () => {
  const ft = fakeTimers();
  const env = fakeEnv({ cordova: { plugins: {} }, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout });
  let scanCalls = 0;
  let lateSuccess;
  const barcodeScanner = {
    scan(success) { scanCalls++; lateSuccess = success; }
  };
  const states = [];
  const detected = new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onDetected: resolve, onState: (s) => states.push(s) });
  });
  assert.ok(states.indexOf('loading') >= 0, '插件未就绪：先进入 loading 等待');
  ft.advance(2 * 200); // 前 2 次轮询（400ms）仍未就绪
  assert.strictEqual(scanCalls, 0, '插件未注册前不调用原生扫码');
  env.cordova.plugins.barcodeScanner = barcodeScanner; // 模拟插件异步注册（应用启动后完成）
  ft.advance(200); // 下一次轮询（600ms）检测到就绪 → 开始扫码
  assert.strictEqual(scanCalls, 1, '插件就绪后调用原生扫码');
  assert.ok(states.indexOf('scanning') >= 0, '进入 scanning');
  lateSuccess({ text: '6901234567890', format: 'EAN_13', cancelled: false });
  const code = await detected;
  assert.strictEqual(code, '6901234567890');
  assert.strictEqual(Scanner.isScanning(), false, '命中后会话已结束');
});

test('原生路径：等待中 stop() → 取消轮询、绝不起动摄像头', () => {
  const ft = fakeTimers();
  const env = fakeEnv({ cordova: { plugins: {} }, setTimeout: ft.setTimeout, clearTimeout: ft.clearTimeout });
  let scanCalls = 0;
  let errorCalls = 0;
  let detectedCalls = 0;
  Scanner.start({ element: {}, env }, {
    onDetected: () => { detectedCalls++; },
    onError: () => { errorCalls++; }
  });
  assert.strictEqual(Scanner.isScanning(), true, '等待期间会话进行中');
  ft.advance(2 * 200); // 前 2 次轮询未就绪
  assert.strictEqual(scanCalls, 0, '尚未起动摄像头');
  Scanner.stop(); // 用户关闭扫码弹层：取消等待
  assert.strictEqual(Scanner.isScanning(), false, 'stop 后会话结束');
  env.cordova.plugins.barcodeScanner = { scan() { scanCalls++; } }; // 即使此后插件才注册
  const fired = ft.advance(40 * 200);
  assert.strictEqual(fired, 0, '定时器已被清除：不再轮询');
  assert.strictEqual(scanCalls, 0, '绝不起动摄像头（原生扫码从未被调用）');
  assert.strictEqual(errorCalls, 0, '取消等待不报错');
  assert.strictEqual(detectedCalls, 0, '不回调命中');
});

/* ---------- start 通用分支 ---------- */

test('start：容器缺失 → onError；stop 幂等', async () => {
  const err = await new Promise((resolve) => {
    Scanner.start({ env: fakeEnv() }, { onError: resolve });
  });
  assert.ok(/容器不可用/.test(err.message));
  assert.doesNotThrow(() => Scanner.stop()); // idle 时 stop 无副作用
});

test('start：无 BarcodeDetector 且引擎加载失败 → onError 提示手动输入', async () => {
  const env = fakeEnv(); // 无 Html5Qrcode → CDN 加载，驱动失败
  const p = new Promise((resolve) => {
    Scanner.start({ element: {}, env }, { onError: resolve });
  });
  await new Promise((r) => setTimeout(r, 5));
  env.document._scripts[0].onerror();         // 主 CDN 失败
  await new Promise((r) => setTimeout(r, 0)); // 等 catch 微任务挂载备用脚本
  env.document._scripts[1].onerror();         // 备用 CDN 也失败
  const err = await p;
  assert.ok(/扫码引擎/.test(err.message));
});
