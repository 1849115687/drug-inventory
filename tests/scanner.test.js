/**
 * scanner.js 单元测试 —— 纯函数 + 扫码会话（注入测试环境，design.md §3.7）
 * 覆盖：BarcodeDetector 可用性判断、码值归一化、条码匹配、CDN 懒加载降级分支、
 *       原生/降级两条扫码路径的命中与停止、错误分支（权限/无摄像头/容器不可用）
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

/* ---------- supportsNative（BarcodeDetector 可用性判断） ---------- */

test('supportsNative：有 BarcodeDetector → true；无 → false', () => {
  assert.strictEqual(Scanner.supportsNative({}), false);
  assert.strictEqual(Scanner.supportsNative({ BarcodeDetector: undefined }), false);
  assert.strictEqual(Scanner.supportsNative({ BarcodeDetector: class {} }), true);
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
