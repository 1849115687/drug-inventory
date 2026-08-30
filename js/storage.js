/**
 * storage.js — localStorage 读写（纯逻辑，不依赖 DOM）
 *
 * schema 严格按 design.md §3.2（v4，D15~D25）：
 *   drugInventory.drugs        药品数组（spec 可空→null、barcode 可空且全局唯一、
 *                               priceCost/priceSell 可 null；expiryDate 有效期 YYYY-MM-DD 或 null）
 *   drugInventory.consumables  耗材数组（name/unit/stock/threshold/initialStock/价格；初始存量创建时写入、编辑只读）
 *   drugInventory.sales        销售记录数组（type: 'drug'|'consumable'；drugId/consumableId 互斥，另一者为 null）
 *   drugInventory.ops          医疗操作数组（只增不改不删；items 为耗材使用明细快照）
 *   drugInventory.settings     设置 { formatVersion, lastImportAt }
 * 备份格式：formatVersion 4（D25）；导入同时接受 v1/v2/v3/v4（旧文件新增字段补空：
 *   价格→null、expiryDate→null、barcode→null、spec 空字符串→null、consumables/ops→[]、销售 type→'drug'/consumableId→null）。
 * 加载时归一化：以 v4 代码读取既有 localStorage 数据时缺键→[]、缺字段→默认值，
 *   settings.formatVersion 原地升级为 4（getSettings / normalize 触发）。
 *
 * 依赖方向：app.js → storage.js；本模块不依赖 DOM 与其他模块（可在 node 中单测，
 * 通过构造函数注入 localStorage mock）。
 *
 * 浏览器中通过 <script> 加载，暴露全局 DrugStorage；node 中可 require。
 */
(function (global) {
  'use strict';

  var PREFIX = 'drugInventory.';
  var KEY_DRUGS = PREFIX + 'drugs';
  var KEY_CONSUMABLES = PREFIX + 'consumables';
  var KEY_SALES = PREFIX + 'sales';
  var KEY_OPS = PREFIX + 'ops';
  var KEY_SETTINGS = PREFIX + 'settings';
  var FORMAT_VERSION = 4; // 备份文件格式版本号（v4：单位自定义/规格可空/条码，D20~D25）

  /**
   * 规格归一化（US-14 / D21）：空字符串 "" 归一化为 null；其余去首尾空白后保留。
   */
  function normalizeSpec(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /**
   * 条码归一化（US-15 / design.md §3.2）：空 → null；其余去首尾空白后存字符串。
   */
  function normalizeBarcode(v) {
    if (v === null || v === undefined) return null;
    var s = String(v).trim();
    return s === '' ? null : s;
  }

  /**
   * 价格归一化（US-7 / design.md §3.2）：
   *   null / undefined / '' → null（未设置）；数字 → 四舍五入到两位小数；
   *   负数或非法值 → null。旧数据（无价格字段）等价于 null。
   */
  function normalizePrice(v) {
    if (v === null || v === undefined || v === '') return null;
    var n = Number(v);
    if (!isFinite(n) || n < 0) return null;
    return Math.round(n * 100) / 100;
  }

  /**
   * 有效期归一化（US-12）：仅接受 'YYYY-MM-DD' 或空（→ null）；其余非法值 → null。
   */
  function normalizeExpiryDate(v) {
    if (v === null || v === undefined || v === '') return null;
    var s = String(v).trim();
    if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
    return s;
  }

  function isPlainObject(v) {
    return v !== null && typeof v === 'object' && !Array.isArray(v);
  }

  function readJSON(key, fallback, backend) {
    try {
      var raw = backend.getItem(key);
      if (raw === null || raw === undefined) return fallback;
      return JSON.parse(raw);
    } catch (e) {
      return fallback;
    }
  }

  function writeJSON(key, val, backend) {
    backend.setItem(key, JSON.stringify(val));
  }

  function genId(prefix) {
    return prefix + '_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  }

  function numOr(v, def) {
    var n = Number(v);
    return isFinite(n) ? n : def;
  }

  /**
   * 有效期状态（US-12 / AC40~AC41，design.md §7 时区风险）：
   * 以本地时区当日 0 点为基准判断，到期日 < 今天 → expired；距到期 ≤ 90 天（含今天）→ expiring；
   * 无有效期或日期非法 → none；其余 → ok。
   * @param {string} expiryDate YYYY-MM-DD 或 null
   * @param {number} [now] 基准时间戳（测试可注入；缺省取当前时间）
   * @returns {{status:'none'|'expiring'|'expired'|'ok', daysLeft:number|null}}
   */
  function expiryStatus(expiryDate, now) {
    if (expiryDate == null || expiryDate === '') return { status: 'none', daysLeft: null };
    var p = String(expiryDate).split('-');
    if (p.length !== 3) return { status: 'none', daysLeft: null };
    var y = Number(p[0]);
    var m = Number(p[1]);
    var d = Number(p[2]);
    if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return { status: 'none', daysLeft: null };
    var exp = new Date(y, m - 1, d);
    // 无效日期（如 2026-02-31）会被 Date 自动进位，回读校验不一致 → 视为无有效期
    if (exp.getFullYear() !== y || exp.getMonth() !== m - 1 || exp.getDate() !== d) {
      return { status: 'none', daysLeft: null };
    }
    var today = new Date(now == null ? Date.now() : now);
    today.setHours(0, 0, 0, 0);
    var days = Math.round((exp.getTime() - today.getTime()) / 86400000);
    if (days < 0) return { status: 'expired', daysLeft: days };
    if (days <= 90) return { status: 'expiring', daysLeft: days };
    return { status: 'ok', daysLeft: days };
  }

  /**
   * @param {object} backend localStorage 兼容对象（getItem/setItem/removeItem）。
   *   缺省时使用 window.localStorage。
   */
  function Storage(backend) {
    this.backend = backend || (typeof localStorage !== 'undefined' ? localStorage : null);
    if (!this.backend) {
      throw new Error('无可用存储：当前环境不支持 localStorage');
    }
  }

  Storage.FORMAT_VERSION = FORMAT_VERSION;
  Storage.expiryStatus = expiryStatus;
  Storage.normalizeExpiryDate = normalizeExpiryDate;
  Storage.normalizeSpec = normalizeSpec;
  Storage.normalizeBarcode = normalizeBarcode;

  /* ---------- 读取（读取时归一化缺省字段，不写回；写回见 normalize） ---------- */

  Storage.prototype.listDrugs = function () {
    var list = readJSON(KEY_DRUGS, [], this.backend);
    if (!Array.isArray(list)) return [];
    return list.map(function (d) {
      return Object.assign({}, d, {
        spec: normalizeSpec(d.spec),
        barcode: normalizeBarcode(d.barcode),
        priceCost: normalizePrice(d.priceCost),
        priceSell: normalizePrice(d.priceSell),
        expiryDate: normalizeExpiryDate(d.expiryDate)
      });
    });
  };

  Storage.prototype.listConsumables = function () {
    var list = readJSON(KEY_CONSUMABLES, [], this.backend);
    if (!Array.isArray(list)) return [];
    return list.map(function (c) {
      return Object.assign({}, c, {
        stock: numOr(c.stock, 0),
        threshold: numOr(c.threshold, 5),
        initialStock: c.initialStock != null ? numOr(c.initialStock, 0) : null,
        priceCost: normalizePrice(c.priceCost),
        priceSell: normalizePrice(c.priceSell)
      });
    });
  };

  Storage.prototype.listSales = function () {
    var list = readJSON(KEY_SALES, [], this.backend);
    if (!Array.isArray(list)) return [];
    return list.map(function (s) {
      var type = s.type === 'consumable' ? 'consumable' : 'drug'; // 旧记录无 type → 药品
      return Object.assign({}, s, {
        type: type,
        drugId: type === 'drug' ? (s.drugId != null ? s.drugId : null) : null,
        consumableId: type === 'consumable' ? (s.consumableId != null ? s.consumableId : null) : null,
        spec: type === 'consumable' ? null : normalizeSpec(s.spec),
        priceSell: normalizePrice(s.priceSell)
      });
    });
  };

  Storage.prototype.listOps = function () {
    var list = readJSON(KEY_OPS, [], this.backend);
    if (!Array.isArray(list)) return [];
    return list.map(function (op) {
      return Object.assign({}, op, {
        type: String(op.type || ''),
        note: String(op.note || ''),
        items: Array.isArray(op.items) ? op.items.map(function (it) {
          return {
            consumableId: it && it.consumableId != null ? it.consumableId : null,
            name: String(it && it.name || ''),
            unit: String(it && it.unit || ''),
            qty: numOr(it && it.qty, 0)
          };
        }) : []
      });
    });
  };

  Storage.prototype.getSettings = function () {
    var s = readJSON(KEY_SETTINGS, {}, this.backend);
    if (!isPlainObject(s)) s = {};
    // 旧字段 version → formatVersion（v4 schema，D25）
    if (s.formatVersion === undefined && s.version !== undefined) s.formatVersion = s.version;
    var out = Object.assign({ formatVersion: FORMAT_VERSION, lastImportAt: null }, s);
    if (s.formatVersion !== FORMAT_VERSION) {
      // 原地升级：首次以 v4 代码读取旧 settings 时写回 formatVersion=4
      writeJSON(KEY_SETTINGS, Object.assign({}, out, { formatVersion: FORMAT_VERSION }), this.backend);
    }
    return Object.assign({}, out, { formatVersion: FORMAT_VERSION });
  };

  Storage.prototype.setSettings = function (patch) {
    var s = this.getSettings();
    Object.assign(s, isPlainObject(patch) ? patch : {});
    writeJSON(KEY_SETTINGS, s, this.backend);
    return s;
  };

  /**
   * 加载时归一化（D25）：把既有 localStorage 数据补默认值并整体写回
   * （缺键→[]、缺字段→默认值、settings.formatVersion 原地升级为 4）。
   * 应用启动时调用一次；幂等。
   */
  Storage.prototype.normalize = function () {
    writeJSON(KEY_DRUGS, this.listDrugs(), this.backend);
    writeJSON(KEY_CONSUMABLES, this.listConsumables(), this.backend);
    writeJSON(KEY_SALES, this.listSales(), this.backend);
    writeJSON(KEY_OPS, this.listOps(), this.backend);
    this.getSettings(); // 触发 settings 原地升级
    return true;
  };

  /* ---------- 药品 ---------- */

  /**
   * 添加药品。唯一键 名称+规格（US-1，空规格视为一种取值，US-14）；
   * 非空条码全局唯一（US-15，一药一码）。
   * @returns {{ok:boolean, error?:string, drug?:object}}
   */
  Storage.prototype.addDrug = function (data) {
    data = isPlainObject(data) ? data : {};
    var name = String(data.name || '').trim();
    var spec = normalizeSpec(data.spec);
    if (!name) {
      return { ok: false, error: '请输入药品名称' };
    }
    var drugs = this.listDrugs();
    var dup = drugs.some(function (d) {
      return String(d.name || '') === name && (d.spec || null) === spec;
    });
    if (dup) {
      return { ok: false, error: '该药品已存在（名称+规格相同）' };
    }
    var barcode = normalizeBarcode(data.barcode);
    if (barcode) {
      var bdup = drugs.some(function (d) { return d.barcode === barcode; });
      if (bdup) return { ok: false, error: '该条码已收录：一药一码，请核对' };
    }
    var now = Date.now();
    var drug = {
      id: genId('d'),
      name: name,
      spec: spec,
      unit: data.unit || '盒',
      stock: Number(data.stock) || 0,
      threshold: Number(data.threshold) || 5,
      barcode: barcode,
      priceCost: normalizePrice(data.priceCost),
      priceSell: normalizePrice(data.priceSell),
      expiryDate: normalizeExpiryDate(data.expiryDate),
      createdAt: now,
      updatedAt: now
    };
    drugs.push(drug);
    writeJSON(KEY_DRUGS, drugs, this.backend);
    return { ok: true, drug: drug };
  };

  /**
   * 更新药品（库存量可在编辑弹层修改；有效期/条码可编辑，US-12/US-15）。
   * @returns {{ok:boolean, error?:string, drug?:object}}
   */
  Storage.prototype.updateDrug = function (id, patch) {
    var drugs = this.listDrugs();
    var idx = -1;
    for (var i = 0; i < drugs.length; i++) {
      if (drugs[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: '药品不存在' };

    patch = isPlainObject(patch) ? patch : {};
    var name = patch.name !== undefined ? String(patch.name).trim() : drugs[idx].name;
    var spec = patch.spec !== undefined ? normalizeSpec(patch.spec) : drugs[idx].spec;
    if (!name) return { ok: false, error: '请输入药品名称' };

    // 重名校验（排除自身；空规格视为一种取值）
    for (var j = 0; j < drugs.length; j++) {
      if (j !== idx && String(drugs[j].name || '') === name && (drugs[j].spec || null) === spec) {
        return { ok: false, error: '该药品已存在（名称+规格相同）' };
      }
    }

    // 条码唯一校验（排除自身；空条码跳过，US-15）
    var barcode = patch.barcode !== undefined ? normalizeBarcode(patch.barcode) : drugs[idx].barcode;
    if (barcode) {
      for (var k = 0; k < drugs.length; k++) {
        if (k !== idx && drugs[k].barcode === barcode) {
          return { ok: false, error: '该条码已收录：一药一码，请核对' };
        }
      }
    }

    var prev = drugs[idx];
    var patch2 = Object.assign({}, patch);
    if ('priceCost' in patch2) patch2.priceCost = normalizePrice(patch2.priceCost);
    if ('priceSell' in patch2) patch2.priceSell = normalizePrice(patch2.priceSell);
    if ('expiryDate' in patch2) patch2.expiryDate = normalizeExpiryDate(patch2.expiryDate);
    var next = Object.assign({}, prev, patch2, {
      name: name,
      spec: spec,
      barcode: barcode,
      updatedAt: Date.now()
    });
    drugs[idx] = next;
    writeJSON(KEY_DRUGS, drugs, this.backend);
    return { ok: true, drug: next };
  };

  /** 删除药品；销售记录保留（快照字段保证可追溯，US-5）。 */
  Storage.prototype.deleteDrug = function (id) {
    var drugs = this.listDrugs();
    var next = drugs.filter(function (d) { return d.id !== id; });
    if (next.length === drugs.length) return { ok: false, error: '药品不存在' };
    writeJSON(KEY_DRUGS, next, this.backend);
    return { ok: true };
  };

  /* ---------- 耗材（US-9） ---------- */

  /**
   * 添加耗材。名称唯一（重名提示，design.md §3.2）；初始存量创建时写入 initialStock。
   * @returns {{ok:boolean, error?:string, consumable?:object}}
   */
  Storage.prototype.addConsumable = function (data) {
    data = isPlainObject(data) ? data : {};
    var name = String(data.name || '').trim();
    var unit = String(data.unit || '').trim();
    if (!name) return { ok: false, error: '请输入耗材名称' };
    if (!unit) return { ok: false, error: '请选择耗材单位' };
    var list = this.listConsumables();
    var dup = list.some(function (c) { return String(c.name || '') === name; });
    if (dup) return { ok: false, error: '该耗材已存在（名称相同）' };
    var now = Date.now();
    var stock = numOr(data.stock, 0);
    var consumable = {
      id: genId('c'),
      name: name,
      unit: unit,
      stock: stock,
      threshold: numOr(data.threshold, 5),
      initialStock: stock,
      priceCost: normalizePrice(data.priceCost),
      priceSell: normalizePrice(data.priceSell),
      createdAt: now,
      updatedAt: now
    };
    list.push(consumable);
    writeJSON(KEY_CONSUMABLES, list, this.backend);
    return { ok: true, consumable: consumable };
  };

  /**
   * 更新耗材（名称/单位/阈值/价格可改；initialStock 只读，忽略传入值，US-9）。
   * @returns {{ok:boolean, error?:string, consumable?:object}}
   */
  Storage.prototype.updateConsumable = function (id, patch) {
    var list = this.listConsumables();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: '耗材不存在' };

    patch = isPlainObject(patch) ? patch : {};
    var name = patch.name !== undefined ? String(patch.name).trim() : list[idx].name;
    var unit = patch.unit !== undefined ? String(patch.unit).trim() : list[idx].unit;
    if (!name) return { ok: false, error: '请输入耗材名称' };
    if (!unit) return { ok: false, error: '请选择耗材单位' };

    for (var j = 0; j < list.length; j++) {
      if (j !== idx && String(list[j].name || '') === name) {
        return { ok: false, error: '该耗材已存在（名称相同）' };
      }
    }

    var prev = list[idx];
    var patch2 = Object.assign({}, patch);
    delete patch2.initialStock; // 初始存量只读（US-9）
    if ('priceCost' in patch2) patch2.priceCost = normalizePrice(patch2.priceCost);
    if ('priceSell' in patch2) patch2.priceSell = normalizePrice(patch2.priceSell);
    var next = Object.assign({}, prev, patch2, {
      name: name,
      unit: unit,
      updatedAt: Date.now()
    });
    list[idx] = next;
    writeJSON(KEY_CONSUMABLES, list, this.backend);
    return { ok: true, consumable: next };
  };

  /**
   * 进货/调整存量（US-9 / AC33）：mode 'set' → 新存量（≥0 整数）；
   * mode 'add' → 增加量（整数，可为负用于修正）。调整后列表即时更新。
   * @returns {{ok:boolean, error?:string, consumable?:object}}
   */
  Storage.prototype.adjustConsumableStock = function (id, data) {
    var list = this.listConsumables();
    var idx = -1;
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) { idx = i; break; }
    }
    if (idx < 0) return { ok: false, error: '耗材不存在' };

    data = isPlainObject(data) ? data : {};
    var mode = data.mode === 'add' ? 'add' : 'set';
    var v = Number(data.value);
    if (!isFinite(v) || !Number.isInteger(v)) {
      return { ok: false, error: mode === 'add' ? '增加量必须为整数' : '新存量必须为 ≥0 的整数' };
    }
    if (mode === 'set') {
      if (v < 0) return { ok: false, error: '新存量必须为 ≥0 的整数' };
      list[idx].stock = v;
    } else {
      list[idx].stock = list[idx].stock + v; // 允许负数修正
    }
    list[idx].updatedAt = Date.now();
    writeJSON(KEY_CONSUMABLES, list, this.backend);
    return { ok: true, consumable: list[idx] };
  };

  /** 删除耗材；历史销售/操作记录保留（US-9）。 */
  Storage.prototype.deleteConsumable = function (id) {
    var list = this.listConsumables();
    var next = list.filter(function (c) { return c.id !== id; });
    if (next.length === list.length) return { ok: false, error: '耗材不存在' };
    writeJSON(KEY_CONSUMABLES, next, this.backend);
    return { ok: true };
  };

  /* ---------- 医疗操作（US-10） ---------- */

  /**
   * 确认医疗操作：校验通过后批量扣减耗材存量（允许负数，AC37）+ 追加 op 记录
   * （items 保存耗材名称/单位快照，只增不改不删）。确认是唯一写入开关（AC36）。
   * @param {{type:string, note?:string, items:Array<{consumableId:string, qty:number}>}} data
   * @returns {{ok:boolean, error?:string, op?:object}}
   */
  Storage.prototype.applyOp = function (data) {
    data = isPlainObject(data) ? data : {};
    var type = String(data.type || '').trim();
    if (!type) return { ok: false, error: '请输入操作类型' };

    var items = Array.isArray(data.items) ? data.items : [];
    var consumables = this.listConsumables();
    var byId = {};
    consumables.forEach(function (c) { byId[c.id] = c; });

    // 先全部校验，全部通过后才写入（确认是唯一写入开关）
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      if (!it || !byId[it.consumableId]) {
        return { ok: false, error: '明细中包含已不存在的耗材，请重新选择' };
      }
      var qty = Math.floor(Number(it.qty));
      if (!isFinite(qty) || qty <= 0) {
        return { ok: false, error: '耗材数量必须为正整数' };
      }
    }

    var now = Date.now();
    var snapshot = items.map(function (it) {
      var c = byId[it.consumableId];
      var q = Math.floor(Number(it.qty));
      c.stock = c.stock - q; // 扣减允许负数（AC37）
      c.updatedAt = now;
      return { consumableId: c.id, name: c.name, unit: c.unit, qty: q };
    });
    var op = {
      id: genId('o'),
      type: type,
      note: String(data.note || '').trim(),
      items: snapshot,
      createdAt: now
    };
    var ops = this.listOps();
    ops.push(op);
    writeJSON(KEY_CONSUMABLES, consumables, this.backend);
    writeJSON(KEY_OPS, ops, this.backend);
    return { ok: true, op: op };
  };

  /* ---------- 销售 ---------- */

  /**
   * 批量扣减库存/存量 + 追加销售记录（一次读、一次写，OCR 批量确认与手动登记共用，AC43）。
   * 条目按字段区分类型：含 consumableId → 耗材（type=consumable、drugId=null、spec=null）；
   * 否则按 drugId → 药品（type=drug、consumableId=null）。扣减允许负数（US-3）。
   * 销售记录保存名称/规格/单位/卖出价快照（D8/D12）：未显式传 priceSell 时取条目当前卖价。
   * @param {Array<{drugId?:string, consumableId?:string, qty:number, source:'manual'|'ocr', note?:string, priceSell?:number|null}>} items
   * @returns {{ok:boolean, records:Array}}
   */
  Storage.prototype.applySales = function (items) {
    var drugs = this.listDrugs();
    var consumables = this.listConsumables();
    var sales = this.listSales();
    var byId = {};
    drugs.forEach(function (d) { byId[d.id] = d; });
    var byCid = {};
    consumables.forEach(function (c) { byCid[c.id] = c; });
    var now = Date.now();
    var records = [];
    (Array.isArray(items) ? items : []).forEach(function (it) {
      var qty = Math.floor(Number(it.qty));
      if (!isFinite(qty) || qty <= 0) return;
      var rec;
      if (it.consumableId != null && byCid[it.consumableId]) {
        // 耗材售卖：扣减耗材存量（AC43）
        var c = byCid[it.consumableId];
        c.stock = c.stock - qty;
        c.updatedAt = now;
        rec = {
          id: genId('s'),
          type: 'consumable',
          drugId: null,
          consumableId: c.id,
          name: c.name,
          spec: null,
          unit: c.unit,
          qty: qty,
          priceSell: normalizePrice(it.priceSell !== undefined ? it.priceSell : c.priceSell),
          source: it.source === 'ocr' ? 'ocr' : 'manual',
          note: String(it.note || '').trim(),
          createdAt: now
        };
      } else if (it.drugId != null && byId[it.drugId]) {
        var d = byId[it.drugId];
        d.stock = d.stock - qty;
        d.updatedAt = now;
        rec = {
          id: genId('s'),
          type: 'drug',
          drugId: d.id,
          consumableId: null,
          name: d.name,
          spec: d.spec,
          unit: d.unit,
          qty: qty,
          priceSell: normalizePrice(it.priceSell !== undefined ? it.priceSell : d.priceSell),
          source: it.source === 'ocr' ? 'ocr' : 'manual',
          note: String(it.note || '').trim(),
          createdAt: now
        };
      } else {
        return; // 条目已被删除等异常情况：跳过
      }
      sales.push(rec);
      records.push(rec);
    });
    writeJSON(KEY_DRUGS, drugs, this.backend);
    writeJSON(KEY_CONSUMABLES, consumables, this.backend);
    writeJSON(KEY_SALES, sales, this.backend);
    return { ok: true, records: records };
  };

  /* ---------- 导出 / 导入 ---------- */

  /** 导出全部数据（含格式版本号 4 与 consumables/ops/expiryDate/barcode/销售类型，D11/D25）。 */
  Storage.prototype.exportData = function () {
    return {
      formatVersion: FORMAT_VERSION,
      exportedAt: Date.now(),
      drugs: this.listDrugs(),
      consumables: this.listConsumables(),
      sales: this.listSales(),
      ops: this.listOps(),
      settings: this.getSettings()
    };
  };

  /**
   * 导入校验：JSON 结构 + 格式版本号。接受 v1/v2/v3/v4（D25）；未知/更高版本拒绝（D11）。
   * @returns {{ok:boolean, error?:string, summary?:{drugs:number, consumables:number, sales:number, ops:number}}}
   */
  Storage.prototype.validateImport = function (obj) {
    if (!isPlainObject(obj)) {
      return { ok: false, error: '文件格式不正确：顶层应为 JSON 对象' };
    }
    if (obj.formatVersion === undefined || obj.formatVersion === null) {
      return { ok: false, error: '备份文件缺少格式版本号，无法确认兼容性' };
    }
    var v = Number(obj.formatVersion);
    if (v !== 1 && v !== 2 && v !== 3 && v !== 4) {
      // 向后兼容：接受 v1（无价格）/v2（含价格）/v3（耗材/操作/有效期）/v4（条码/规格可空）；未知或更高版本拒绝
      return { ok: false, error: '备份文件版本不兼容：当前版本 ' + FORMAT_VERSION + '，文件版本 ' + obj.formatVersion + '，已拒绝导入' };
    }
    if (!Array.isArray(obj.drugs) || !Array.isArray(obj.sales)) {
      return { ok: false, error: '备份文件缺少 drugs/sales 数据' };
    }
    return {
      ok: true,
      summary: {
        drugs: obj.drugs.length,
        consumables: Array.isArray(obj.consumables) ? obj.consumables.length : 0,
        sales: obj.sales.length,
        ops: Array.isArray(obj.ops) ? obj.ops.length : 0
      }
    };
  };

  /**
   * 整体覆盖导入（D6：导入 = 备份恢复）。调用前需先 validateImport。
   * v1/v2/v3 旧文件新增字段补空：价格→null、expiryDate→null、barcode→null、
   * spec 空字符串→null、consumables/ops→[]、销售 type→'drug'/consumableId→null（D25）。
   * @returns {{ok:boolean, error?:string, summary?:{drugs:number, consumables:number, sales:number, ops:number}}}
   */
  Storage.prototype.importData = function (obj) {
    var v = this.validateImport(obj);
    if (!v.ok) return v;

    var drugs = (obj.drugs || []).map(function (d) {
      return Object.assign({}, d, {
        spec: normalizeSpec(d.spec),
        barcode: normalizeBarcode(d.barcode),
        priceCost: normalizePrice(d.priceCost),
        priceSell: normalizePrice(d.priceSell),
        expiryDate: normalizeExpiryDate(d.expiryDate)
      });
    });
    var consumables = (obj.consumables || []).map(function (c) {
      var stock = numOr(c.stock, 0);
      return Object.assign({}, c, {
        stock: stock,
        threshold: numOr(c.threshold, 5),
        initialStock: c.initialStock != null ? numOr(c.initialStock, 0) : stock,
        priceCost: normalizePrice(c.priceCost),
        priceSell: normalizePrice(c.priceSell)
      });
    });
    var sales = (obj.sales || []).map(function (s) {
      var type = s.type === 'consumable' ? 'consumable' : 'drug';
      return Object.assign({}, s, {
        type: type,
        drugId: type === 'drug' ? (s.drugId != null ? s.drugId : null) : null,
        consumableId: type === 'consumable' ? (s.consumableId != null ? s.consumableId : null) : null,
        spec: type === 'consumable' ? null : normalizeSpec(s.spec),
        priceSell: normalizePrice(s.priceSell)
      });
    });
    var ops = (obj.ops || []).map(function (op) {
      return Object.assign({}, op, {
        type: String(op.type || ''),
        note: String(op.note || ''),
        items: Array.isArray(op.items) ? op.items.map(function (it) {
          return {
            consumableId: it && it.consumableId != null ? it.consumableId : null,
            name: String(it && it.name || ''),
            unit: String(it && it.unit || ''),
            qty: numOr(it && it.qty, 0)
          };
        }) : []
      });
    });

    writeJSON(KEY_DRUGS, drugs, this.backend);
    writeJSON(KEY_CONSUMABLES, consumables, this.backend);
    writeJSON(KEY_SALES, sales, this.backend);
    writeJSON(KEY_OPS, ops, this.backend);
    writeJSON(KEY_SETTINGS, {
      formatVersion: FORMAT_VERSION,
      lastImportAt: Date.now()
    }, this.backend);
    return { ok: true, summary: v.summary };
  };

  /* ---------- 导出（浏览器 / node 双环境） ---------- */
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Storage;
  }
  global.DrugStorage = Storage;
})(typeof window !== 'undefined' ? window : globalThis);
