/**
 * app.js — 状态管理、渲染、事件绑定、OCR 确认流程状态机
 *
 * 依赖：storage.js（全局 DrugStorage）、parser.js（全局 Parser）、
 *       ocr.js（全局 OCR）、stats.js（全局 Stats）；通过 index.html 中普通 <script> 按序加载（D2）。
 *
 * OCR 状态机（design.md §3.4）：idle → loading → error → confirming → idle
 *   写入开关唯一：只有「确认扣减」才调用 storage 写入（US-4）。
 *   候选列表同时包含药品与耗材（§3.4/§3.5，AC43）；过期药品在确认列表标记并阻止（AC41）。
 *
 * v3 新增（design.md §3.3）：医疗 Tab（耗材子视图 + 医疗操作子视图）、
 *   登记销售药品+耗材混选、统计 Tab「销售统计｜耗材使用」segment、药品有效期标记。
 * v4 新增（design.md §3.3/§3.7）：条码扫码（添加药品表单 + 登记销售，Scanner 封装）、
 *   单位输入框+常用建议（US-13）、规格可选（US-14）、桌面回车提交（US-16）。
 */
(function () {
  'use strict';

  /* ================= 状态 ================= */

  var storage = new DrugStorage();
  var state = { drugs: [], consumables: [], sales: [], ops: [], settings: null };
  var currentTab = 'inventory';

  // OCR 状态机
  var ocrState = 'idle';       // idle | loading | error | confirming
  var ocrImageDataUrl = null;  // 最近一次图片（重试用）
  var ocrRows = [];            // 确认列表（内存中修改，确认前不写 storage）

  // 编辑/删除目标（药品与耗材通用）
  var editingDrugId = null;
  var editingConsumableId = null;
  var pendingDelete = null;    // { kind:'drug'|'consumable', id }
  var adjustTargetId = null;   // 进货/调整存量目标耗材 id

  // 手动登记：当前选中的条目（药品或耗材）
  var sellSelection = null;    // { kind:'drug'|'consumable', id }
  var sellSelectedText = '';

  // 医疗操作表单：耗材明细行（内存中编辑，确认记录才写入）
  var opRows = [];             // [{ consumableId, qty }]

  var pendingImportData = null;

  // 条码扫码（US-15 / AC48~AC49，design.md §3.7 状态机 idle→loading→scanning→命中/错误）
  var scanContext = null;   // 'drug-form' | 'sell'：扫码弹层的发起场景

  /* ================= 工具 ================= */

  function $(id) { return document.getElementById(id); }

  function toast(msg, type) {
    var container = $('toast-container');
    var el = document.createElement('div');
    el.className = 'toast' + (type ? ' ' + type : '');
    el.textContent = msg;
    container.appendChild(el);
    setTimeout(function () {
      if (el.parentNode) el.parentNode.removeChild(el);
    }, 2600);
  }

  function fmtTime(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
      ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  /** 金额展示（分 → 元，负数显示为 -¥xx.xx） */
  function fmtMoney(cents) {
    var c = Math.round(Number(cents) || 0);
    return (c < 0 ? '-¥' : '¥') + Stats.fmtYuan(Math.abs(c));
  }

  /**
   * 价格解析（US-7 / AC24）：空 → null（未设置）；否则必须为
   * ≥0 的数字、最多两位小数，返回两位小数后的数值。
   */
  function parsePrice(v) {
    var s = String(v == null ? '' : v).trim();
    if (s === '') return { ok: true, value: null };
    if (!/^\d+(\.\d{1,2})?$/.test(s)) {
      return { ok: false, error: '价格必须为 ≥0 的数字，最多两位小数' };
    }
    return { ok: true, value: Math.round(Number(s) * 100) / 100 };
  }

  function fmtDate() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function isNonNegInt(v) {
    if (v === '' || v === null || v === undefined) return false;
    var n = Number(v);
    return Number.isInteger(n) && n >= 0;
  }

  function isPosInt(v) {
    if (v === '' || v === null || v === undefined) return false;
    var n = Number(v);
    return Number.isInteger(n) && n > 0;
  }

  function openModal(id) { $(id).hidden = false; }
  function closeModal(id) { $(id).hidden = true; }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /** 有效期状态包装（US-12）：返回 { status, label, daysLeft } */
  function expiryInfo(expiryDate) {
    var st = DrugStorage.expiryStatus(expiryDate);
    var label = st.status === 'expired' ? '已过期' : (st.status === 'expiring' ? '临期' : '');
    return { status: st.status, label: label, daysLeft: st.daysLeft };
  }

  /** 条目是否过期药品（耗材无有效期 → 永不拦截，AC41） */
  function isExpiredItem(item) {
    return DrugStorage.expiryStatus(item.expiryDate).status === 'expired';
  }

  /** 按 id 查找条目（药品或耗材），返回 { kind, item } 或 null */
  function findItem(id) {
    if (!id) return null;
    for (var i = 0; i < state.drugs.length; i++) {
      if (state.drugs[i].id === id) return { kind: 'drug', item: state.drugs[i] };
    }
    for (var j = 0; j < state.consumables.length; j++) {
      if (state.consumables[j].id === id) return { kind: 'consumable', item: state.consumables[j] };
    }
    return null;
  }

  /** 条目展示名：药品「名称 规格」；耗材「名称」；规格为空不追加空白（US-14） */
  function itemDisplayName(it) {
    return it.kind === 'drug'
      ? it.item.name + (it.item.spec ? ' ' + it.item.spec : '')
      : it.item.name;
  }

  function reloadState() {
    state.drugs = storage.listDrugs();
    state.consumables = storage.listConsumables();
    state.sales = storage.listSales();
    state.ops = storage.listOps();
    state.settings = storage.getSettings();
  }

  /** 数据变更后统一刷新（库存/耗材/操作/记录/销售下拉/操作明细/统计） */
  function refreshAll() {
    renderInventory();
    renderConsumables();
    renderOpHistory();
    renderRecords();
    refreshSellSelection();
    renderOpRows();
    if (currentTab === 'stats') renderStats();
  }

  /* ================= Tab 切换 ================= */

  function switchTab(tab) {
    currentTab = tab;
    var panels = ['inventory', 'sell', 'medical', 'records', 'stats'];
    panels.forEach(function (t) {
      $('tab-' + t).hidden = (t !== tab);
    });
    var btns = document.querySelectorAll('#tabbar button[data-tab]');
    btns.forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-tab') === tab);
    });
    closeMenu();
    $('sell-drug-list').hidden = true;
    if (tab === 'records') renderRecords();
    if (tab === 'stats') renderStats();
  }

  /* ================= 库存渲染（药品） ================= */

  function renderInventory() {
    var list = $('inventory-list');
    if (!state.drugs.length) {
      list.innerHTML =
        '<div class="empty"><span class="empty-icon">📦</span>' +
        '<p>还没有药品<br>点击右上角「＋」添加第一个药品</p></div>';
      return;
    }
    var html = '';
    state.drugs.forEach(function (d) {
      var low = d.stock <= d.threshold;
      var owe = d.stock < 0 ? '<span class="owe-badge">欠 ' + Math.abs(d.stock) + '</span>' : '';
      var exp = expiryInfo(d.expiryDate);
      var expiryHtml = exp.status === 'none'
        ? '<div class="card-expiry"><span class="expiry-date">有效期 —</span></div>'
        : '<div class="card-expiry"><span class="expiry-date">有效期 ' + esc(d.expiryDate) + '</span>' +
          (exp.label ? '<span class="expiry-tag ' + exp.status + '">' + exp.label + '</span>' : '') +
          '</div>';
      html +=
        '<article class="card' + (low ? ' low' : '') + '" data-id="' + d.id + '">' +
          '<div class="card-main" data-action="edit">' +
            '<div class="card-top">' +
              '<h3 class="name">' + esc(d.name) + '</h3>' +
              '<span class="stock">' + d.stock + '<small>&nbsp;' + esc(d.unit) + '</small>' + owe + '</span>' +
            '</div>' +
            '<div class="card-sub">' +
              '<span class="spec">' + esc(d.spec || '—') + '</span>' +
              '<span class="card-price">' + (d.priceSell != null ? '售价 ¥' + Stats.fmtYuan(Stats.toCents(d.priceSell)) : '售价 —') + '</span>' +
              '<span class="threshold">阈值 ' + d.threshold + '</span>' +
            '</div>' +
            expiryHtml +
          '</div>' +
          '<button type="button" class="card-del" data-action="delete" aria-label="删除">🗑</button>' +
        '</article>';
    });
    list.innerHTML = html;
  }

  /* ================= 添加 / 编辑药品 ================= */

  function openDrugModal(drug) {
    editingDrugId = drug ? drug.id : null;
    $('drug-modal-title').textContent = drug ? '编辑药品' : '添加药品';
    $('drug-name').value = drug ? drug.name : '';
    $('drug-spec').value = drug ? drug.spec : '';
    $('drug-stock').value = drug ? String(drug.stock) : '';
    $('drug-unit').value = drug ? drug.unit : '盒';
    $('drug-threshold').value = drug ? String(drug.threshold) : '5';
    $('drug-price-cost').value = drug && drug.priceCost != null ? String(drug.priceCost) : '';
    $('drug-price-sell').value = drug && drug.priceSell != null ? String(drug.priceSell) : '';
    $('drug-expiry').value = drug && drug.expiryDate ? drug.expiryDate : '';
    $('drug-barcode').value = drug && drug.barcode ? drug.barcode : '';
    ['drug-name-error', 'drug-spec-error', 'drug-unit-error', 'drug-stock-error', 'drug-threshold-error',
      'drug-barcode-error', 'drug-price-cost-error', 'drug-price-sell-error', 'drug-expiry-error'].forEach(function (id) {
      $(id).hidden = true;
      $(id).textContent = '';
    });
    openModal('modal-drug');
  }

  function submitDrugForm() {
    var name = String($('drug-name').value || '').trim();
    var spec = String($('drug-spec').value || '').trim(); // 可选（US-14）：空字符串由 storage 归一化为 null
    var stockVal = String($('drug-stock').value || '').trim();
    var unit = String($('drug-unit').value || '').trim(); // 必填（US-13）：可输入任意单位
    var thresholdVal = String($('drug-threshold').value || '').trim();

    var nameErr = $('drug-name-error');
    var specErr = $('drug-spec-error');
    var unitErr = $('drug-unit-error');
    var stockErr = $('drug-stock-error');
    var thresholdErr = $('drug-threshold-error');
    var barcodeErr = $('drug-barcode-error');
    var costErr = $('drug-price-cost-error');
    var sellErr = $('drug-price-sell-error');
    var expiryErr = $('drug-expiry-error');

    function show(el, msg) { el.textContent = msg; el.hidden = false; }
    function clear(el) { el.textContent = ''; el.hidden = true; }

    var ok = true;
    clear(nameErr); clear(specErr); clear(unitErr); clear(stockErr); clear(thresholdErr);
    clear(barcodeErr); clear(costErr); clear(sellErr); clear(expiryErr);

    if (!name) { show(nameErr, '请输入药品名称'); ok = false; }
    if (!unit) { show(unitErr, '请输入单位（可手动输入任意单位）'); ok = false; }

    // 库存量：可为空（默认 0）或 非负整数
    var stock = 0;
    if (stockVal !== '') {
      if (!isNonNegInt(stockVal)) { show(stockErr, '库存量必须为 ≥0 的整数'); ok = false; }
      else stock = Number(stockVal);
    }

    // 预警阈值：可为空（默认 5）或 非负整数
    var threshold = 5;
    if (thresholdVal !== '') {
      if (!isNonNegInt(thresholdVal)) { show(thresholdErr, '预警阈值必须为 ≥0 的整数'); ok = false; }
      else threshold = Number(thresholdVal);
    }

    // 进价/卖出价：可留空（null）；填写须为 ≥0 且最多两位小数（AC24）
    var priceCost = parsePrice($('drug-price-cost').value);
    var priceSell = parsePrice($('drug-price-sell').value);
    if (!priceCost.ok) { show(costErr, priceCost.error); ok = false; }
    if (!priceSell.ok) { show(sellErr, priceSell.error); ok = false; }

    // 有效期至：可留空（null）；填写须为 YYYY-MM-DD（US-12，HTML date 输入已约束，防御性校验）
    var expiryVal = String($('drug-expiry').value || '').trim();
    if (expiryVal !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(expiryVal)) {
      show(expiryErr, '有效期格式不正确（应为 YYYY-MM-DD）');
      ok = false;
    }

    if (!ok) return;

    var payload = {
      name: name, spec: spec, stock: stock, unit: unit, threshold: threshold,
      barcode: $('drug-barcode').value,
      priceCost: priceCost.value, priceSell: priceSell.value,
      expiryDate: expiryVal === '' ? null : expiryVal
    };
    var res;
    if (editingDrugId) {
      res = storage.updateDrug(editingDrugId, payload);
    } else {
      res = storage.addDrug(payload);
    }
    if (!res.ok) {
      // 行内错误：条码唯一性冲突显示在条码字段，其余（名称+规格重复等）显示在名称字段（AC2/AC47）
      if (res.error.indexOf('条码') >= 0) show(barcodeErr, res.error);
      else show(nameErr, res.error);
      return;
    }
    toast(editingDrugId ? '已保存修改' : '已添加药品：' + name, 'success');
    closeModal('modal-drug');
    reloadState();
    refreshAll();
  }

  /* ================= 删除（药品 / 耗材通用） ================= */

  function askDelete(kind, id) {
    if (kind === 'consumable') {
      var c = state.consumables.find(function (x) { return x.id === id; });
      if (!c) return;
      pendingDelete = { kind: 'consumable', id: id };
      $('delete-modal-title').textContent = '删除耗材';
      $('delete-text').textContent = '确定删除「' + c.name + '」吗？删除后其历史销售/操作记录仍会保留。';
    } else {
      var d = state.drugs.find(function (x) { return x.id === id; });
      if (!d) return;
      pendingDelete = { kind: 'drug', id: id };
      $('delete-modal-title').textContent = '删除药品';
      $('delete-text').textContent = '确定删除「' + d.name + (d.spec ? ' ' + d.spec : '') + '」吗？删除后其历史销售记录仍会保留。';
    }
    openModal('modal-delete');
  }

  function confirmDelete() {
    if (!pendingDelete) return;
    if (pendingDelete.kind === 'consumable') {
      storage.deleteConsumable(pendingDelete.id);
      toast('已删除耗材', 'success');
    } else {
      storage.deleteDrug(pendingDelete.id);
      toast('已删除药品', 'success');
    }
    pendingDelete = null;
    closeModal('modal-delete');
    reloadState();
    refreshAll();
  }

  /* ================= 手动登记销售（药品 + 耗材混选，AC43） ================= */

  function renderSellList(keyword) {
    var ul = $('sell-drug-list');
    var kw = (keyword || '').trim().toLowerCase();
    var rows = [];
    state.drugs.forEach(function (d) {
      if (kw && d.name.toLowerCase().indexOf(kw) < 0 && (d.spec || '').toLowerCase().indexOf(kw) < 0) return;
      rows.push({ kind: 'drug', item: d });
    });
    state.consumables.forEach(function (c) {
      if (kw && c.name.toLowerCase().indexOf(kw) < 0) return;
      rows.push({ kind: 'consumable', item: c });
    });
    if (!rows.length) {
      ul.innerHTML = '<li class="d-empty">' + ((state.drugs.length || state.consumables.length) ? '无匹配条目' : '暂无药品/耗材，请先到「库存」「医疗」页添加') + '</li>';
      ul.hidden = false;
      return;
    }
    var html = '';
    rows.forEach(function (r) {
      var item = r.item;
      var expired = r.kind === 'drug' && isExpiredItem(item);
      var priceHtml = expired
        ? '<span class="d-expired">已过期</span>'
        : (item.priceSell != null ? '¥' + Stats.fmtYuan(Stats.toCents(item.priceSell)) : '无价格');
      html += '<li data-id="' + item.id + '" data-kind="' + r.kind + '"' + (expired ? ' class="disabled"' : '') + '>' +
        '<span class="d-type ' + r.kind + '">' + (r.kind === 'consumable' ? '耗材' : '药品') + '</span>' +
        '<span class="d-name">' + esc(item.name) + '</span>' +
        (r.kind === 'drug' ? '<span class="d-spec">' + esc(item.spec || '—') + '</span>' : '<span class="d-spec"></span>') +
        '<span class="d-stock">' + (r.kind === 'consumable' ? '存量' : '库存') + ' ' + item.stock + ' ' + esc(item.unit) + '</span>' +
        '<span class="d-price">' + priceHtml + '</span>' +
        '</li>';
    });
    ul.innerHTML = html;
    ul.hidden = false;
  }

  /** 同步卖出价输入框（AC26：选药后自动带出当前卖价，可修改） */
  function syncSellPrice(it) {
    if (it && it.item.priceSell != null) {
      $('sell-price').value = String(it.item.priceSell);
      $('sell-price-hint').textContent = '当前卖价 ¥' + Stats.fmtYuan(Stats.toCents(it.item.priceSell)) + '，可修改';
    } else {
      $('sell-price').value = '';
      $('sell-price-hint').textContent = it ? '该条目未设置卖价，可填写（留空则不记价格）' : '';
    }
  }

  function selectSellItem(kind, id) {
    var it = findItem(id);
    if (!it || it.kind !== kind) return;
    var item = it.item;
    if (it.kind === 'drug' && isExpiredItem(item)) {
      toast('该药品已过期，无法销售，请先处理库存', 'error');
      return;
    }
    sellSelection = { kind: it.kind, id: item.id };
    sellSelectedText = itemDisplayName(it);
    $('sell-drug-input').value = sellSelectedText;
    $('sell-drug-hint').textContent = (it.kind === 'consumable' ? '当前存量：' : '当前库存：') +
      item.stock + ' ' + item.unit + '（预警阈值 ' + item.threshold + '）';
    $('sell-drug-error').hidden = true;
    $('sell-drug-list').hidden = true;
    syncSellPrice(it);
  }

  function refreshSellSelection() {
    if (!sellSelection) return;
    var it = findItem(sellSelection.id);
    if (!it) {
      // 条目已被删除：清除选择
      sellSelection = null;
      sellSelectedText = '';
      $('sell-drug-input').value = '';
      $('sell-drug-hint').textContent = '';
      syncSellPrice(null);
      return;
    }
    $('sell-drug-hint').textContent = (it.kind === 'consumable' ? '当前存量：' : '当前库存：') +
      it.item.stock + ' ' + it.item.unit + '（预警阈值 ' + it.item.threshold + '）';
    syncSellPrice(it);
  }

  function submitSellForm() {
    var it = sellSelection ? findItem(sellSelection.id) : null;
    var item = it ? it.item : null;
    var qtyVal = String($('sell-qty').value || '').trim();
    var note = String($('sell-note').value || '').trim();
    var drugErr = $('sell-drug-error');
    var qtyErr = $('sell-qty-error');
    var priceErr = $('sell-price-error');
    drugErr.hidden = true;
    qtyErr.hidden = true;
    priceErr.hidden = true;

    if (!item) {
      drugErr.textContent = '请从列表中选择药品或耗材';
      drugErr.hidden = false;
      return;
    }
    if (it.kind === 'drug' && isExpiredItem(item)) {
      drugErr.textContent = '该药品已过期，无法销售，请先处理库存';
      drugErr.hidden = false;
      return;
    }
    if (!isPosInt(qtyVal)) {
      qtyErr.textContent = '数量必须为正整数';
      qtyErr.hidden = false;
      return;
    }
    var qty = Number(qtyVal);

    // 卖出价：可留空（null）；填写须为 ≥0 且最多两位小数
    var price = parsePrice($('sell-price').value);
    if (!price.ok) {
      priceErr.textContent = price.error;
      priceErr.hidden = false;
      return;
    }

    if (qty > item.stock) {
      toast('库存不足（当前 ' + item.stock + '），将扣为负数', 'error');
    }

    var payload = it.kind === 'consumable'
      ? [{ consumableId: item.id, qty: qty, source: 'manual', note: note, priceSell: price.value }]
      : [{ drugId: item.id, qty: qty, source: 'manual', note: note, priceSell: price.value }];
    var res = storage.applySales(payload);
    // 用扣减后的库存提示（含剩余库存与金额，design.md §3.3 / AC26）
    reloadState();
    var after = it.kind === 'consumable'
      ? state.consumables.find(function (x) { return x.id === item.id; })
      : state.drugs.find(function (x) { return x.id === item.id; });
    var amountInfo = price.value != null ? '，金额 ' + fmtMoney(Stats.toCents(price.value) * qty) : '';
    toast('已扣减：' + item.name + ' ×' + qty + amountInfo + '，' +
      (it.kind === 'consumable' ? '剩余存量 ' : '剩余库存 ') + after.stock + ' ' + after.unit, 'success');
    // 表单重置
    $('sell-form').reset();
    $('sell-drug-hint').textContent = '';
    $('sell-price-hint').textContent = '';
    sellSelection = null;
    sellSelectedText = '';
    refreshAll();
  }

  /* ================= 医疗（耗材管理，US-9 / AC32~AC34） ================= */

  function switchMedicalView(view) {
    $('medical-view-consumable').hidden = (view !== 'consumable');
    $('medical-view-op').hidden = (view !== 'op');
    document.querySelectorAll('.seg-tab[data-medical-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-medical-view') === view);
    });
  }

  function renderConsumables() {
    var list = $('consumable-list');
    if (!state.consumables.length) {
      list.innerHTML =
        '<div class="empty"><span class="empty-icon">🩹</span>' +
        '<p>还没有耗材<br>点击右上角「＋」添加第一个耗材</p></div>';
      return;
    }
    var html = '';
    state.consumables.forEach(function (c) {
      var low = c.stock <= c.threshold;
      var owe = c.stock < 0 ? '<span class="owe-badge">欠 ' + Math.abs(c.stock) + '</span>' : '';
      html +=
        '<article class="card' + (low ? ' low' : '') + '" data-id="' + c.id + '">' +
          '<div class="card-main" data-action="edit">' +
            '<div class="card-top">' +
              '<h3 class="name">' + esc(c.name) + '</h3>' +
              '<span class="stock">' + c.stock + '<small>&nbsp;' + esc(c.unit) + '</small>' + owe + '</span>' +
            '</div>' +
            '<div class="card-sub">' +
              '<span class="spec">耗材</span>' +
              '<span class="card-price">' + (c.priceSell != null ? '售价 ¥' + Stats.fmtYuan(Stats.toCents(c.priceSell)) : '售价 —') + '</span>' +
              '<span class="threshold">阈值 ' + c.threshold + '</span>' +
            '</div>' +
          '</div>' +
          '<div class="card-actions">' +
            '<button type="button" class="btn-mini" data-action="restock">进货</button>' +
            '<button type="button" class="card-del" data-action="delete" aria-label="删除">🗑</button>' +
          '</div>' +
        '</article>';
    });
    list.innerHTML = html;
  }

  function openConsumableModal(c) {
    editingConsumableId = c ? c.id : null;
    $('consumable-modal-title').textContent = c ? '编辑耗材' : '添加耗材';
    $('cons-name').value = c ? c.name : '';
    $('cons-unit').value = c ? c.unit : '片';
    $('cons-initial').value = c ? String(c.initialStock != null ? c.initialStock : c.stock) : '';
    $('cons-initial').disabled = !!c; // 编辑页初始存量只读（US-9）
    $('cons-initial-hint').textContent = c ? '初始存量创建时确定，仅可查看' : '创建后当前存量 = 初始存量；之后用「进货」调整';
    $('cons-threshold').value = c ? String(c.threshold) : '5';
    $('cons-price-cost').value = c && c.priceCost != null ? String(c.priceCost) : '';
    $('cons-price-sell').value = c && c.priceSell != null ? String(c.priceSell) : '';
    ['cons-name-error', 'cons-unit-error', 'cons-initial-error', 'cons-threshold-error',
      'cons-price-cost-error', 'cons-price-sell-error'].forEach(function (id) {
      $(id).hidden = true;
      $(id).textContent = '';
    });
    openModal('modal-consumable');
  }

  function submitConsumableForm() {
    var name = String($('cons-name').value || '').trim();
    var unit = String($('cons-unit').value || '').trim();
    var initialVal = String($('cons-initial').value || '').trim();
    var thresholdVal = String($('cons-threshold').value || '').trim();

    var nameErr = $('cons-name-error');
    var unitErr = $('cons-unit-error');
    var initialErr = $('cons-initial-error');
    var thresholdErr = $('cons-threshold-error');
    var costErr = $('cons-price-cost-error');
    var sellErr = $('cons-price-sell-error');

    function show(el, msg) { el.textContent = msg; el.hidden = false; }
    function clear(el) { el.textContent = ''; el.hidden = true; }

    var ok = true;
    clear(nameErr); clear(unitErr); clear(initialErr); clear(thresholdErr); clear(costErr); clear(sellErr);

    if (!name) { show(nameErr, '请输入耗材名称'); ok = false; }
    if (!unit) { show(unitErr, '请输入耗材单位（可手动输入任意单位）'); ok = false; }

    var initial = 0;
    // 初始存量：仅添加时校验；编辑时忽略（只读）
    if (!editingConsumableId) {
      if (initialVal !== '' && !isNonNegInt(initialVal)) {
        show(initialErr, '初始存量必须为 ≥0 的整数');
        ok = false;
      } else if (initialVal !== '') {
        initial = Number(initialVal);
      }
    }

    var threshold = 5;
    if (thresholdVal !== '') {
      if (!isNonNegInt(thresholdVal)) { show(thresholdErr, '预警阈值必须为 ≥0 的整数'); ok = false; }
      else threshold = Number(thresholdVal);
    }

    var priceCost = parsePrice($('cons-price-cost').value);
    var priceSell = parsePrice($('cons-price-sell').value);
    if (!priceCost.ok) { show(costErr, priceCost.error); ok = false; }
    if (!priceSell.ok) { show(sellErr, priceSell.error); ok = false; }

    if (!ok) return;

    var res;
    if (editingConsumableId) {
      res = storage.updateConsumable(editingConsumableId, {
        name: name, unit: unit, threshold: threshold,
        priceCost: priceCost.value, priceSell: priceSell.value
      });
    } else {
      res = storage.addConsumable({
        name: name, unit: unit, stock: initial, threshold: threshold,
        priceCost: priceCost.value, priceSell: priceSell.value
      });
    }
    if (!res.ok) {
      show(nameErr, res.error);
      return;
    }
    toast(editingConsumableId ? '已保存修改' : '已添加耗材：' + name, 'success');
    closeModal('modal-consumable');
    reloadState();
    refreshAll();
  }

  /* 进货 / 调整存量（US-9 / AC33） */

  function openAdjustModal(c) {
    adjustTargetId = c.id;
    $('adjust-name').textContent = '耗材：' + c.name + '（当前存量 ' + c.stock + ' ' + c.unit + '）';
    $('adjust-value').value = '';
    $('adjust-error').hidden = true;
    document.querySelectorAll('input[name="adjust-mode"]').forEach(function (r) {
      r.checked = (r.value === 'set');
    });
    updateAdjustLabel();
    openModal('modal-adjust');
  }

  function updateAdjustLabel() {
    var mode = document.querySelector('input[name="adjust-mode"]:checked');
    var isSet = !mode || mode.value !== 'add';
    $('adjust-value-label').textContent = isSet ? '新存量（整数，≥0）' : '增加量（整数，可为负修正）';
    $('adjust-value').placeholder = isSet ? '例如 20' : '例如 10';
  }

  function submitAdjustForm() {
    var modeEl = document.querySelector('input[name="adjust-mode"]:checked');
    var mode = modeEl && modeEl.value === 'add' ? 'add' : 'set';
    var v = String($('adjust-value').value || '').trim();
    var err = $('adjust-error');
    err.hidden = true;
    if (v === '' || !Number.isInteger(Number(v))) {
      err.textContent = mode === 'add' ? '增加量必须为整数' : '新存量必须为 ≥0 的整数';
      err.hidden = false;
      return;
    }
    var res = storage.adjustConsumableStock(adjustTargetId, { mode: mode, value: Number(v) });
    if (!res.ok) {
      err.textContent = res.error;
      err.hidden = false;
      return;
    }
    toast(mode === 'add'
      ? '已增加 ' + v + '，当前存量 ' + res.consumable.stock + ' ' + res.consumable.unit
      : '已设置新存量 ' + res.consumable.stock + ' ' + res.consumable.unit, 'success');
    closeModal('modal-adjust');
    reloadState();
    refreshAll();
  }

  /* ================= 医疗操作（US-10 / AC35~AC37） ================= */

  function renderOpRows() {
    var box = $('op-items');
    if (!opRows.length) {
      box.innerHTML = '<p class="hint" style="padding: 0 2px;">本次未使用耗材可留空；点击下方「＋添加耗材」添加明细</p>';
      return;
    }
    var html = '';
    opRows.forEach(function (row, i) {
      var opts = '<option value="">— 选择耗材 —</option>';
      state.consumables.forEach(function (c) {
        var sel = row.consumableId === c.id ? ' selected' : '';
        opts += '<option value="' + c.id + '"' + sel + '>' + esc(c.name) + '（存量 ' + c.stock + ' ' + esc(c.unit) + '）</option>';
      });
      html +=
        '<div class="op-item" data-index="' + i + '">' +
          '<select class="select" data-field="consumable">' + opts + '</select>' +
          '<input class="qty-input" type="number" min="1" step="1" inputmode="numeric" placeholder="数量" value="' + (row.qty != null && row.qty !== '' ? row.qty : '') + '" data-field="qty">' +
          '<button type="button" class="row-del" data-field="del" aria-label="删除该行">✕</button>' +
        '</div>';
    });
    box.innerHTML = html;
  }

  function addOpRow() {
    opRows.push({ consumableId: null, qty: '' });
    renderOpRows();
  }

  function onOpRowChange(target) {
    var rowEl = target.closest('.op-item');
    if (!rowEl) return;
    var i = Number(rowEl.getAttribute('data-index'));
    var field = target.getAttribute('data-field');
    if (field === 'consumable') {
      opRows[i].consumableId = target.value || null;
    } else if (field === 'qty') {
      opRows[i].qty = target.value;
    } else if (field === 'del') {
      opRows.splice(i, 1);
      renderOpRows();
    }
  }

  function submitOpForm() {
    var type = String($('op-type').value || '').trim();
    var note = String($('op-note').value || '').trim();
    var typeErr = $('op-type-error');
    typeErr.hidden = true;
    if (!type) {
      typeErr.textContent = '请输入操作类型';
      typeErr.hidden = false;
      return;
    }
    // 明细：未选择耗材的空行忽略；已选择的行数量必须为正整数（AC36）
    var items = [];
    for (var i = 0; i < opRows.length; i++) {
      var row = opRows[i];
      if (!row.consumableId) continue;
      if (!isPosInt(row.qty)) {
        toast('第 ' + (i + 1) + ' 行数量必须为正整数', 'error');
        return;
      }
      items.push({ consumableId: row.consumableId, qty: Number(row.qty) });
    }
    var res = storage.applyOp({ type: type, note: note, items: items });
    if (!res.ok) {
      toast(res.error, 'error');
      return;
    }
    toast('已记录操作' + (items.length ? '，扣减耗材 ' + items.length + ' 项' : ''), 'success');
    $('op-form').reset();
    opRows = [];
    renderOpRows();
    reloadState();
    refreshAll();
  }

  function renderOpHistory() {
    // 类型筛选下拉：由既有操作类型重建（保留当前选择）
    var sel = $('op-filter-type');
    var cur = sel.value;
    var types = [];
    state.ops.forEach(function (op) {
      if (op.type && types.indexOf(op.type) < 0) types.push(op.type);
    });
    types.sort();
    var optsHtml = '<option value="">全部类型</option>' +
      types.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
    sel.innerHTML = optsHtml;
    if (types.indexOf(cur) >= 0) sel.value = cur; else sel.value = '';

    var rows = state.ops.slice().sort(function (a, b) {
      if (b.createdAt !== a.createdAt) return b.createdAt - a.createdAt;
      return 0;
    });
    if (sel.value) rows = rows.filter(function (op) { return op.type === sel.value; });

    var list = $('op-history');
    if (!rows.length) {
      list.innerHTML = '<div class="empty"><span class="empty-icon">🏥</span><p>' +
        (state.ops.length ? '没有符合条件的操作记录' : '还没有医疗操作记录') + '</p></div>';
      return;
    }
    var html = '';
    rows.forEach(function (op) {
      var itemsHtml = (op.items && op.items.length)
        ? '<div class="op-items">使用耗材：' + op.items.map(function (it) {
            return esc(it.name) + ' ×' + it.qty + ' ' + esc(it.unit);
          }).join('、') + '</div>'
        : '';
      html +=
        '<div class="op-item-card">' +
          '<div class="op-head">' +
            '<span class="op-type">' + esc(op.type) + '</span>' +
            '<span class="op-time">' + fmtTime(op.createdAt) + '</span>' +
          '</div>' +
          itemsHtml +
          (op.note ? '<div class="op-note">备注：' + esc(op.note) + '</div>' : '') +
        '</div>';
    });
    list.innerHTML = html;
  }

  /* ================= 销售记录 ================= */

  function renderRecords() {
    var kw = $('rec-keyword').value.trim().toLowerCase();
    var src = $('rec-source').value;
    var list = $('records-list');

    var rows = state.sales
      .map(function (rec, i) { return { rec: rec, i: i }; })
      .filter(function (x) {
        var name = (x.rec.name || '').toLowerCase();
        var spec = (x.rec.spec || '').toLowerCase();
        if (kw && name.indexOf(kw) < 0 && spec.indexOf(kw) < 0) return false;
        if (src && x.rec.source !== src) return false;
        return true;
      })
      .sort(function (a, b) {
        if (b.rec.createdAt !== a.rec.createdAt) return b.rec.createdAt - a.rec.createdAt;
        return b.i - a.i; // 同一时间：后添加的在前
      });

    if (!rows.length) {
      list.innerHTML = '<div class="empty"><span class="empty-icon">📋</span><p>' +
        (state.sales.length ? '没有符合条件的记录' : '还没有销售记录') + '</p></div>';
      return;
    }
    var html = '';
    rows.forEach(function (x) {
      var rec = x.rec;
      html +=
        '<div class="rec-item">' +
          '<div class="rec-head">' +
            '<span class="rec-time">' + fmtTime(rec.createdAt) + '</span>' +
            '<span class="rec-source ' + rec.source + '">' + (rec.source === 'ocr' ? 'OCR' : '手动') + '</span>' +
            '<span class="rec-type ' + rec.type + '">' + (rec.type === 'consumable' ? '耗材' : '药品') + '</span>' +
          '</div>' +
          '<div class="rec-body">' +
            '<div><div class="rec-name">' + esc(rec.name) + '</div>' +
            '<div class="rec-spec">' + esc(rec.spec || '—') + '</div></div>' +
            '<span class="rec-qty">×' + rec.qty + ' <small>' + esc(rec.unit) + '</small></span>' +
          '</div>' +
          '<div class="rec-price">' +
            (rec.priceSell != null
              ? '<span>单价 ¥' + Stats.fmtYuan(Stats.toCents(rec.priceSell)) + '</span>' +
                '<span class="rec-amount">金额 ¥' + Stats.fmtYuan(Stats.toCents(rec.priceSell) * rec.qty) + '</span>'
              : '<span class="rec-noprice">未设置价格</span>') +
          '</div>' +
          (rec.note ? '<div class="rec-note">备注：' + esc(rec.note) + '</div>' : '') +
        '</div>';
    });
    list.innerHTML = html;
  }

  /* ================= 统计（US-8 / US-11 / AC27~AC29 / AC38 / AC44） ================= */

  var statsSegment = 'sales';       // sales | usage
  var statsItemSortKey = 'salesCents'; // 销售按条目视图排序：key + 方向
  var statsItemSortDesc = true;
  var usageItemSortKey = 'qty';     // 耗材使用按耗材视图排序
  var usageItemSortDesc = true;

  function statsToday() {
    var d = new Date();
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  function statsMonth() { return statsToday().slice(0, 7); }
  function statsFirstDayOfMonth() { return statsMonth() + '-01'; }

  /** 'YYYY-MM-DD' → 当日 00:00 的本地时间戳 */
  function statsDayStart(dateStr) {
    var p = String(dateStr).split('-');
    return new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2])).getTime();
  }

  /** 依据当前筛选模式计算统计区间（毫秒时间戳；null = 不设边界） */
  function statsDateRange() {
    var period = $('stat-period').value;
    if (period === 'day') {
      var day = $('stat-date-day').value || statsToday();
      var start = statsDayStart(day);
      return { start: start, end: start + 86400000 - 1 };
    }
    if (period === 'month') {
      var m = $('stat-date-month').value || statsMonth();
      var p = String(m).split('-');
      var start = new Date(Number(p[0]), Number(p[1]) - 1, 1).getTime();
      return { start: start, end: new Date(Number(p[0]), Number(p[1]), 1).getTime() - 1 };
    }
    // 自定义区间：[起始日 00:00, 结束日 23:59:59]（含首尾，AC28）
    var s = $('stat-date-start').value;
    var e = $('stat-date-end').value;
    return {
      start: s ? statsDayStart(s) : null,
      end: e ? statsDayStart(e) + 86400000 - 1 : null
    };
  }

  function switchStatsSegment(seg) {
    statsSegment = seg;
    $('stats-segment-sales').hidden = (seg !== 'sales');
    $('stats-segment-usage').hidden = (seg !== 'usage');
    document.querySelectorAll('.seg-tab[data-stats-segment]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-stats-segment') === seg);
    });
    renderStats();
  }

  function renderStats() {
    var range = statsDateRange();

    // 销售统计（含耗材售卖，AC44）
    var filteredSales = Stats.filterByDate(state.sales, range.start, range.end);
    var sum = Stats.summary(filteredSales, state.drugs, state.consumables);
    $('stat-sales').textContent = fmtMoney(sum.salesCents);
    $('stat-cost').textContent = fmtMoney(sum.costCents);
    $('stat-profit').textContent = fmtMoney(sum.profitCents);
    $('stat-margin').textContent = sum.margin == null ? '—' : (sum.margin * 100).toFixed(1) + '%';
    renderSalesDateList(filteredSales);
    renderSalesItemList(filteredSales);

    // 耗材使用（US-11 / AC38）
    var filteredOps = Stats.filterByDate(state.ops, range.start, range.end);
    $('usage-total').textContent = Stats.consumableUsage(filteredOps);
    $('usage-count').textContent = filteredOps.length;
    renderUsageDateList(filteredOps);
    renderUsageItemList(filteredOps);
  }

  /* -- 销售统计：按日期 / 按条目 -- */

  function renderSalesDateList(records) {
    var box = $('sales-date-list');
    var rows = Stats.groupByDay(records, state.drugs, state.consumables);
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><span class="empty-icon">📊</span><p>该区间没有销售记录</p></div>';
      return;
    }
    var html = '<div class="stat-table">' +
      '<div class="stat-row stat-head"><span>日期</span><span>销量</span><span>销售额</span><span>成本</span><span>毛利</span></div>';
    rows.forEach(function (r) {
      html += '<div class="stat-row">' +
        '<span>' + r.day + '</span>' +
        '<span>' + r.qty + '</span>' +
        '<span>' + fmtMoney(r.salesCents) + '</span>' +
        '<span>' + fmtMoney(r.costCents) + '</span>' +
        '<span>' + fmtMoney(r.profitCents) + '</span>' +
        '</div>';
    });
    box.innerHTML = html + '</div>';
  }

  function renderSalesItemList(records) {
    var box = $('sales-item-wrap');
    var rows = Stats.sortBy(Stats.groupByItem(records, state.drugs, state.consumables), statsItemSortKey, statsItemSortDesc);
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><span class="empty-icon">💊</span><p>该区间没有销售记录</p></div>';
      return;
    }
    function arrow(k) { return statsItemSortKey === k ? (statsItemSortDesc ? ' ↓' : ' ↑') : ''; }
    var html = '<div class="stat-table">' +
      '<div class="stat-row stat-head stat-head-sort">' +
        '<span data-key="name">条目</span>' +
        '<span data-key="qty">销量' + arrow('qty') + '</span>' +
        '<span data-key="salesCents">销售额' + arrow('salesCents') + '</span>' +
        '<span data-key="costCents">成本' + arrow('costCents') + '</span>' +
        '<span data-key="profitCents">毛利' + arrow('profitCents') + '</span>' +
      '</div>';
    rows.forEach(function (r) {
      html += '<div class="stat-row">' +
        '<span class="stat-drug"><span class="stat-type ' + r.type + '">' + (r.type === 'consumable' ? '耗材' : '药品') + '</span>' +
          esc(r.name) + (r.type === 'drug' ? (r.spec ? ' ' + esc(r.spec) : ' <small class="stat-spec">—</small>') : '') +
          (r.hasCost ? '' : ' <small class="stat-tag">（无进价/已删除）</small>') +
        '</span>' +
        '<span>' + r.qty + ' ' + esc(r.unit) + '</span>' +
        '<span>' + fmtMoney(r.salesCents) + '</span>' +
        '<span>' + (r.hasCost ? fmtMoney(r.costCents) : '—') + '</span>' +
        '<span>' + (r.profitCents == null ? '—' : fmtMoney(r.profitCents)) + '</span>' +
        '</div>';
    });
    box.innerHTML = html + '</div>';
  }

  function switchSalesView(view) {
    $('sales-view-date').hidden = (view !== 'date');
    $('sales-view-item').hidden = (view !== 'item');
    document.querySelectorAll('.stats-tab[data-sales-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-sales-view') === view);
    });
  }

  /* -- 耗材使用：按日期 / 按耗材 -- */

  function renderUsageDateList(ops) {
    var box = $('usage-date-list');
    var rows = Stats.groupUsageByDay(ops);
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><span class="empty-icon">🩹</span><p>该区间没有医疗操作记录</p></div>';
      return;
    }
    var html = '<div class="stat-table">' +
      '<div class="stat-row stat-head"><span>日期</span><span>使用量</span></div>';
    rows.forEach(function (r) {
      html += '<div class="stat-row">' +
        '<span>' + r.day + '</span>' +
        '<span>' + r.qty + '</span>' +
        '</div>';
    });
    box.innerHTML = html + '</div>';
  }

  function renderUsageItemList(ops) {
    var box = $('usage-item-wrap');
    var rows = Stats.sortBy(Stats.groupUsageByItem(ops, state.consumables), usageItemSortKey, usageItemSortDesc);
    if (!rows.length) {
      box.innerHTML = '<div class="empty"><span class="empty-icon">🩹</span><p>该区间没有耗材使用记录</p></div>';
      return;
    }
    function arrow(k) { return usageItemSortKey === k ? (usageItemSortDesc ? ' ↓' : ' ↑') : ''; }
    var html = '<div class="stat-table">' +
      '<div class="stat-row stat-head stat-head-sort">' +
        '<span data-key="name">耗材</span>' +
        '<span data-key="qty">使用量' + arrow('qty') + '</span>' +
      '</div>';
    rows.forEach(function (r) {
      html += '<div class="stat-row">' +
        '<span class="stat-drug">' + esc(r.name) + '</span>' +
        '<span>' + r.qty + ' ' + esc(r.unit) + '</span>' +
        '</div>';
    });
    box.innerHTML = html + '</div>';
  }

  function switchUsageView(view) {
    $('usage-view-date').hidden = (view !== 'date');
    $('usage-view-item').hidden = (view !== 'item');
    document.querySelectorAll('.stats-tab[data-usage-view]').forEach(function (b) {
      b.classList.toggle('active', b.getAttribute('data-usage-view') === view);
    });
  }

  function updateStatsPeriodUI() {
    var p = $('stat-period').value;
    $('stat-date-day').hidden = (p !== 'day');
    $('stat-date-month').hidden = (p !== 'month');
    $('stat-date-start').hidden = (p !== 'range');
    $('stat-date-end').hidden = (p !== 'range');
    $('stat-range-sep').hidden = (p !== 'range');
    renderStats();
  }

  /* ================= 导出 / 导入 ================= */

  function exportData() {
    var data = storage.exportData();
    var blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = '药品库存备份_' + fmtDate() + '.json';
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    toast('已导出备份文件', 'success');
  }

  function onImportFile(file) {
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      var obj;
      try {
        obj = JSON.parse(reader.result);
      } catch (e) {
        toast('导入失败：文件不是有效的 JSON', 'error');
        return;
      }
      var v = storage.validateImport(obj);
      if (!v.ok) {
        toast('导入失败：' + v.error, 'error');
        return;
      }
      pendingImportData = obj;
      $('import-summary').innerHTML =
        '备份文件有效，将导入：<br>' +
        '· 药品 <strong>' + v.summary.drugs + '</strong> 个<br>' +
        '· 耗材 <strong>' + v.summary.consumables + '</strong> 个<br>' +
        '· 销售记录 <strong>' + v.summary.sales + '</strong> 条<br>' +
        '· 医疗操作 <strong>' + v.summary.ops + '</strong> 条';
      openModal('modal-import');
    };
    reader.onerror = function () { toast('导入失败：文件读取失败', 'error'); };
    reader.readAsText(file);
  }

  function confirmImport() {
    if (!pendingImportData) return;
    var r = storage.importData(pendingImportData);
    pendingImportData = null;
    closeModal('modal-import');
    if (!r.ok) {
      toast('导入失败：' + r.error, 'error');
      return;
    }
    toast('导入成功：' + r.summary.drugs + ' 个药品、' + r.summary.consumables + ' 个耗材、' +
      r.summary.sales + ' 条记录、' + r.summary.ops + ' 条操作', 'success');
    setTimeout(function () { location.reload(); }, 900); // 整体覆盖后刷新全页（D6）
  }

  /* ================= OCR 状态机 ================= */

  function resetOcr() {
    ocrState = 'idle';
    ocrImageDataUrl = null;
    ocrRows = [];
    closeModal('modal-ocr');
    closeModal('modal-ocr-loading');
    closeModal('modal-ocr-error');
  }

  function startOcr(kind) {
    // 懒加载入口：点击时若引擎未就绪，加载进度在 loading 弹层展示（AC11）
    var input = kind === 'camera' ? $('file-camera') : $('file-album');
    input.value = '';
    input.click();
  }

  function onOcrFile(kind) {
    var input = kind === 'camera' ? $('file-camera') : $('file-album');
    var file = input.files && input.files[0];
    if (!file) return;
    var reader = new FileReader();
    reader.onload = function () {
      ocrImageDataUrl = reader.result;
      runOcr();
    };
    reader.onerror = function () {
      toast('图片读取失败，请重试', 'error');
    };
    reader.readAsDataURL(file);
  }

  /** OCR 匹配候选：药品 + 耗材 合并（§3.4/§3.5，AC43）；parser 规则不变 */
  function ocrCandidates() {
    return state.drugs.concat(state.consumables);
  }

  function runOcr() {
    if (!ocrImageDataUrl) return;
    ocrState = 'loading';
    openModal('modal-ocr-loading');
    $('ocr-loading-bar').style.width = '0%';
    $('ocr-loading-text').textContent = '正在准备识别引擎…';

    OCR.recognize(ocrImageDataUrl, function (text, progress) {
      $('ocr-loading-text').textContent = text;
      $('ocr-loading-bar').style.width = Math.round(progress * 100) + '%';
    }).then(function (rawText) {
      if (ocrState !== 'loading') return; // 已被放弃
      ocrRows = Parser.parseSalesText(rawText, ocrCandidates());
      ocrState = 'confirming';
      closeModal('modal-ocr-loading');
      renderOcrRows();
      openModal('modal-ocr');
    }).catch(function (err) {
      if (ocrState !== 'loading') return;
      ocrState = 'error';
      closeModal('modal-ocr-loading');
      $('ocr-error-text').textContent = '识别失败：' + (err && err.message ? err.message : '未知错误');
      openModal('modal-ocr-error');
    });
  }

  function retryOcr() {
    OCR.reset(); // 终止旧 worker，重新初始化
    closeModal('modal-ocr-error');
    runOcr();
  }

  function abandonOcr() {
    resetOcr();
  }

  function renderOcrRows() {
    var box = $('ocr-rows');
    var matchedCount = ocrRows.filter(function (r) { return r.matched; }).length;
    $('ocr-summary').textContent = '共 ' + ocrRows.length + ' 行，其中 ' + matchedCount + ' 行已自动匹配条目。请核对并修正后点击「确认扣减」。';

    if (!ocrRows.length) {
      box.innerHTML = '<p class="hint">识别结果为空，无可扣减的行。</p>';
      $('btn-ocr-confirm').disabled = true;
      return;
    }
    $('btn-ocr-confirm').disabled = false;

    var html = '';
    ocrRows.forEach(function (row, i) {
      var opts = '<option value="">— 请选择条目 —</option>';
      state.drugs.forEach(function (d) {
        var sel = row.drugId === d.id ? ' selected' : '';
        var expired = isExpiredItem(d);
        opts += '<option value="' + d.id + '"' + sel + (expired ? ' disabled' : '') + '>[药品] ' + esc(d.name) + (d.spec ? ' ' + esc(d.spec) : '') +
          '（库存 ' + d.stock + ' ' + esc(d.unit) + '）' + (expired ? '（已过期）' : '') + '</option>';
      });
      state.consumables.forEach(function (c) {
        var sel = row.drugId === c.id ? ' selected' : '';
        opts += '<option value="' + c.id + '"' + sel + '>[耗材] ' + esc(c.name) +
          '（存量 ' + c.stock + ' ' + esc(c.unit) + '）</option>';
      });
      // 当前选中条目为过期药品 → 行内阻止标记（AC41）
      var selItem = row.drugId ? findItem(row.drugId) : null;
      var expiredBlock = selItem && selItem.kind === 'drug' && isExpiredItem(selItem.item)
        ? '<div class="ocr-row-expired">⚠ 该药品已过期，禁止扣减（先处理库存或删除该行）</div>'
        : '';
      html +=
        '<div class="ocr-row" data-index="' + i + '">' +
          (row.matched ? '' : '<div class="ocr-row-raw">未匹配：' + esc(row.raw) + '</div>') +
          '<div class="ocr-row-fields">' +
            '<select class="select" data-field="drug">' + opts + '</select>' +
            '<input class="qty-input" type="number" min="1" step="1" inputmode="numeric" value="' + row.qty + '" data-field="qty">' +
            '<button type="button" class="row-del" data-field="del" aria-label="删除该行">✕</button>' +
          '</div>' +
          expiredBlock +
        '</div>';
    });
    box.innerHTML = html;
  }

  function onOcrRowChange(target) {
    var rowEl = target.closest('.ocr-row');
    if (!rowEl) return;
    var i = Number(rowEl.getAttribute('data-index'));
    var field = target.getAttribute('data-field');
    if (field === 'drug') {
      var id = target.value;
      ocrRows[i].drugId = id || null;
      ocrRows[i].matched = !!id; // 取消选择 → 回到未匹配态，重新显示原始文本
      if (id) {
        var it = findItem(id);
        ocrRows[i].name = it ? it.item.name : '';
        ocrRows[i].spec = it && it.kind === 'drug' ? it.item.spec : '';
        ocrRows[i].unit = it ? it.item.unit : '';
      }
      renderOcrRows();
    } else if (field === 'qty') {
      ocrRows[i].qty = target.value;
    } else if (field === 'del') {
      ocrRows.splice(i, 1);
      renderOcrRows();
    }
  }

  function confirmOcr() {
    var items = [];
    for (var i = 0; i < ocrRows.length; i++) {
      var row = ocrRows[i];
      var it = findItem(row.drugId);
      if (!it) {
        toast('第 ' + (i + 1) + ' 行未选择条目，请补选或删除该行', 'error');
        return;
      }
      if (it.kind === 'drug' && isExpiredItem(it.item)) {
        toast('第 ' + (i + 1) + ' 行药品「' + it.item.name + '」已过期，禁止扣减，请先处理库存', 'error');
        return;
      }
      if (!isPosInt(row.qty)) {
        toast('第 ' + (i + 1) + ' 行数量必须为正整数', 'error');
        return;
      }
      items.push(it.kind === 'consumable'
        ? { consumableId: it.item.id, qty: Number(row.qty), source: 'ocr', note: '' }
        : { drugId: it.item.id, qty: Number(row.qty), source: 'ocr', note: '' });
    }
    if (!items.length) {
      toast('没有可扣减的行', 'error');
      return;
    }
    var res = storage.applySales(items);
    var total = res.records.reduce(function (s, r) { return s + r.qty; }, 0);
    toast('已扣减 ' + res.records.length + ' 项，共 ' + total + ' 件', 'success');
    resetOcr();
    reloadState();
    refreshAll();
  }

  /* ================= 条码扫码（US-15 / AC48~AC49，§3.7 状态机） ================= */

  /** 打开扫码弹层并启动扫码（idle → loading → scanning；命中/错误回到 idle） */
  function openScan(context) {
    scanContext = context;
    $('scan-status').textContent = '正在启动摄像头…';
    $('scan-status').className = 'scan-status';
    $('scan-fallback').hidden = true;
    $('scan-viewport').innerHTML = ''; // 清空上次会话残留的取景元素
    openModal('modal-scan');
    Scanner.start(
      { element: $('scan-viewport') },
      {
        onDetected: onScanDetected,
        onState: function (st, msg) {
          $('scan-status').textContent = msg || (st === 'scanning' ? '正在扫描…请将条码对准取景框' : '正在启动摄像头…');
        },
        onError: function (err) {
          $('scan-status').textContent = (err && err.message) || '扫码失败，请重试';
          $('scan-status').className = 'scan-status error';
          $('scan-fallback').hidden = false; // 手动输入条码兜底（§3.7）
        }
      }
    );
  }

  /** 关闭扫码弹层并释放摄像头（Scanner.stop 幂等，§3.7） */
  function closeScan() {
    Scanner.stop();
    closeModal('modal-scan');
  }

  /** 扫码命中（单次命中后 scanner 已自动停止） */
  function onScanDetected(code) {
    closeScan();
    if (!code) {
      toast('未读取到条码，请重试', 'error');
      scanContext = null;
      return;
    }
    if (scanContext === 'drug-form') {
      // 添加药品表单：自动填入条码字段；码已收录 → 提示对应药品（AC48）
      $('drug-barcode').value = code;
      var d = Scanner.matchByBarcode(state.drugs, code);
      if (d) {
        toast('该条码已收录：' + d.name + (d.spec ? ' ' + d.spec : '') + '（名称/规格仍需手动输入）', 'error');
      } else {
        toast('已填入条码：' + code, 'success');
      }
    } else if (scanContext === 'sell') {
      // 登记销售：命中 → 自动选中；命中药品已过期 → 阻止并提示（AC41）；未收录 → 提示先添加（AC49）
      var matched = Scanner.matchByBarcode(state.drugs, code);
      if (!matched) {
        toast('未收录该条码（' + code + '），请先到「库存」页添加药品并录入条码', 'error');
        scanContext = null;
        return;
      }
      if (isExpiredItem(matched)) {
        toast('该药品已过期，无法销售，请先处理库存', 'error');
        scanContext = null;
        return;
      }
      selectSellItem('drug', matched.id);
      toast('已匹配并选中：' + matched.name + (matched.spec ? ' ' + matched.spec : ''), 'success');
    }
    scanContext = null;
  }

  /** 手动输入条码兜底入口（§3.7：扫码失败/无摄像头时改用） */
  function scanManualFallback() {
    var ctx = scanContext;
    closeScan();
    if (ctx === 'drug-form') {
      $('drug-barcode').focus();
    } else if (ctx === 'sell') {
      toast('未收录的药品请先到「库存」页添加并录入条码', 'error');
    }
    scanContext = null;
  }

  /* ================= 菜单 ================= */

  function openMenu() { $('menu-popup').hidden = false; }
  function closeMenu() { $('menu-popup').hidden = true; }

  /* ================= 事件绑定 ================= */

  function bindEvents() {
    // Tab 切换
    document.querySelectorAll('#tabbar button[data-tab]').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.getAttribute('data-tab')); });
    });

    // 库存页顶栏
    $('btn-add').addEventListener('click', function () { openDrugModal(null); });
    $('btn-menu').addEventListener('click', function (e) {
      e.stopPropagation();
      $('menu-popup').hidden ? openMenu() : closeMenu();
    });
    document.addEventListener('click', function (e) {
      if (!$('menu-popup').hidden && !e.target.closest('#menu-popup') && !e.target.closest('#btn-menu')) {
        closeMenu();
      }
    });
    document.querySelectorAll('#menu-popup button').forEach(function (b) {
      b.addEventListener('click', function () {
        var action = b.getAttribute('data-action');
        closeMenu();
        if (action === 'export') exportData();
        else if (action === 'import') { $('file-import').value = ''; $('file-import').click(); }
        else if (action === 'about') openModal('modal-about');
      });
    });

    // 库存列表（药品）：编辑 / 删除
    $('inventory-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var card = e.target.closest('.card');
      if (!card) return;
      var id = card.getAttribute('data-id');
      if (btn.getAttribute('data-action') === 'edit') {
        var d = state.drugs.find(function (x) { return x.id === id; });
        if (d) openDrugModal(d);
      } else if (btn.getAttribute('data-action') === 'delete') {
        askDelete('drug', id);
      }
    });

    // 药品表单
    $('drug-form').addEventListener('submit', function (e) { e.preventDefault(); submitDrugForm(); });

    // 条码扫码（US-15 / AC48~AC49）
    $('btn-scan-drug').addEventListener('click', function () { openScan('drug-form'); });
    $('btn-scan-sell').addEventListener('click', function () { openScan('sell'); });
    $('btn-scan-close').addEventListener('click', closeScan);
    $('btn-scan-manual').addEventListener('click', scanManualFallback);

    // 桌面：表单回车提交（US-16 / AC51）——输入框内 Enter 统一走 submit 事件
    document.querySelectorAll('form').forEach(function (f) {
      f.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' && e.target && e.target.tagName === 'INPUT') {
          e.preventDefault();
          if (f.requestSubmit) f.requestSubmit(); else f.submit();
        }
      });
    });

    // 删除确认（药品 / 耗材通用）
    $('btn-delete-confirm').addEventListener('click', confirmDelete);

    // 手动登记：可搜索下拉（药品 + 耗材混选）
    var sellInput = $('sell-drug-input');
    sellInput.addEventListener('focus', function () { renderSellList(sellInput.value); });
    sellInput.addEventListener('input', function () {
      if (sellInput.value !== sellSelectedText) {
        sellSelection = null;
        $('sell-drug-hint').textContent = '';
      }
      renderSellList(sellInput.value);
    });
    $('sell-drug-list').addEventListener('click', function (e) {
      var li = e.target.closest('li[data-id]');
      if (li && !li.classList.contains('disabled')) {
        selectSellItem(li.getAttribute('data-kind'), li.getAttribute('data-id'));
      } else if (li && li.classList.contains('disabled')) {
        toast('该药品已过期，无法销售', 'error');
      }
    });
    document.addEventListener('click', function (e) {
      if (!e.target.closest('.combobox')) $('sell-drug-list').hidden = true;
    });
    $('sell-form').addEventListener('submit', function (e) { e.preventDefault(); submitSellForm(); });

    // 医疗：segment 切换 + 耗材管理
    document.querySelectorAll('.seg-tab[data-medical-view]').forEach(function (b) {
      b.addEventListener('click', function () { switchMedicalView(b.getAttribute('data-medical-view')); });
    });
    $('btn-add-consumable').addEventListener('click', function () { openConsumableModal(null); });
    $('consumable-list').addEventListener('click', function (e) {
      var btn = e.target.closest('[data-action]');
      if (!btn) return;
      var card = e.target.closest('.card');
      if (!card) return;
      var id = card.getAttribute('data-id');
      var action = btn.getAttribute('data-action');
      if (action === 'edit') {
        var c = state.consumables.find(function (x) { return x.id === id; });
        if (c) openConsumableModal(c);
      } else if (action === 'restock') {
        var c2 = state.consumables.find(function (x) { return x.id === id; });
        if (c2) openAdjustModal(c2);
      } else if (action === 'delete') {
        askDelete('consumable', id);
      }
    });
    $('consumable-form').addEventListener('submit', function (e) { e.preventDefault(); submitConsumableForm(); });

    // 进货 / 调整存量
    document.querySelectorAll('input[name="adjust-mode"]').forEach(function (r) {
      r.addEventListener('change', updateAdjustLabel);
    });
    $('adjust-form').addEventListener('submit', function (e) { e.preventDefault(); submitAdjustForm(); });

    // 医疗操作：明细行 + 历史筛选
    $('btn-add-op-item').addEventListener('click', addOpRow);
    $('op-items').addEventListener('change', function (e) {
      if (e.target.closest('.op-item')) onOpRowChange(e.target);
    });
    $('op-items').addEventListener('click', function (e) {
      if (e.target.getAttribute && e.target.getAttribute('data-field') === 'del') onOpRowChange(e.target);
    });
    $('op-form').addEventListener('submit', function (e) { e.preventDefault(); submitOpForm(); });
    $('op-filter-type').addEventListener('change', renderOpHistory);

    // 销售记录筛选
    $('rec-keyword').addEventListener('input', renderRecords);
    $('rec-source').addEventListener('change', renderRecords);

    // 统计：segment / 筛选 / 排序（销售统计 + 耗材使用）
    document.querySelectorAll('.seg-tab[data-stats-segment]').forEach(function (b) {
      b.addEventListener('click', function () { switchStatsSegment(b.getAttribute('data-stats-segment')); });
    });
    $('stat-period').addEventListener('change', updateStatsPeriodUI);
    ['stat-date-day', 'stat-date-month', 'stat-date-start', 'stat-date-end'].forEach(function (id) {
      $(id).addEventListener('change', renderStats);
    });
    document.querySelectorAll('.stats-tab[data-sales-view]').forEach(function (b) {
      b.addEventListener('click', function () { switchSalesView(b.getAttribute('data-sales-view')); });
    });
    document.querySelectorAll('.stats-tab[data-usage-view]').forEach(function (b) {
      b.addEventListener('click', function () { switchUsageView(b.getAttribute('data-usage-view')); });
    });
    $('sales-item-wrap').addEventListener('click', function (e) {
      var th = e.target.closest('[data-key]');
      if (!th) return;
      var key = th.getAttribute('data-key');
      if (statsItemSortKey === key) {
        statsItemSortDesc = !statsItemSortDesc;
      } else {
        statsItemSortKey = key;
        statsItemSortDesc = (key !== 'name');
      }
      renderStats();
    });
    $('usage-item-wrap').addEventListener('click', function (e) {
      var th = e.target.closest('[data-key]');
      if (!th) return;
      var key = th.getAttribute('data-key');
      if (usageItemSortKey === key) {
        usageItemSortDesc = !usageItemSortDesc;
      } else {
        usageItemSortKey = key;
        usageItemSortDesc = (key !== 'name');
      }
      renderStats();
    });

    // OCR 入口
    $('btn-camera').addEventListener('click', function () { startOcr('camera'); });
    $('btn-album').addEventListener('click', function () { startOcr('album'); });
    $('file-camera').addEventListener('change', function () { onOcrFile('camera'); });
    $('file-album').addEventListener('change', function () { onOcrFile('album'); });

    // OCR 确认列表交互
    $('ocr-rows').addEventListener('change', function (e) {
      if (e.target.closest('.ocr-row')) onOcrRowChange(e.target);
    });
    $('ocr-rows').addEventListener('click', function (e) {
      if (e.target.getAttribute && e.target.getAttribute('data-field') === 'del') onOcrRowChange(e.target);
    });
    $('btn-ocr-confirm').addEventListener('click', confirmOcr);
    $('btn-ocr-abandon').addEventListener('click', abandonOcr);
    $('btn-ocr-error-retry').addEventListener('click', retryOcr);
    $('btn-ocr-error-abandon').addEventListener('click', abandonOcr);

    // 导入
    $('file-import').addEventListener('change', function () { onImportFile($('file-import').files[0]); });
    $('btn-import-confirm').addEventListener('click', confirmImport);

    // 通用：data-close 关闭弹层
    document.querySelectorAll('[data-close]').forEach(function (b) {
      b.addEventListener('click', function () {
        var id = b.getAttribute('data-close');
        if (id === 'modal-ocr') { abandonOcr(); return; } // 关闭确认列表 = 放弃
        if (id === 'modal-scan') { closeScan(); return; } // 关闭扫码弹层 = 停止摄像头
        closeModal(id);
      });
    });

    // 遮罩点击关闭（删除/导入/加载/错误弹层除外——破坏性操作需显式按钮）
    document.querySelectorAll('.modal').forEach(function (m) {
      m.addEventListener('click', function (e) {
        if (e.target !== m) return;
        var id = m.id;
        if (id === 'modal-ocr') { abandonOcr(); return; }
        if (id === 'modal-scan') { closeScan(); return; }
        if (id === 'modal-drug' || id === 'modal-consumable' || id === 'modal-adjust' || id === 'modal-about') closeModal(id);
      });
    });

    // 微信提示
    $('wechat-banner-close').addEventListener('click', function () {
      $('wechat-banner').hidden = true;
    });
  }

  /* ================= 启动 ================= */

  function init() {
    storage.normalize(); // 加载时归一化：补默认值 + settings.formatVersion 原地升级为 4（D25）
    reloadState();
    bindEvents();
    renderInventory();
    renderConsumables();
    renderOpHistory();
    renderRecords();
    renderOpRows();

    // 统计默认区间：日=今天、月=当月、自定义=本月首日至今天
    $('stat-date-day').value = statsToday();
    $('stat-date-month').value = statsMonth();
    $('stat-date-start').value = statsFirstDayOfMonth();
    $('stat-date-end').value = statsToday();

    // 微信内置浏览器提示（N7 / AC23）
    if (/micromessenger/i.test(navigator.userAgent || '')) {
      $('wechat-banner').hidden = false;
    }

    // Service Worker：仅 HTTPS 或 localhost 注册（design.md §3.6）
    if ('serviceWorker' in navigator) {
      var proto = location.protocol;
      var host = location.hostname;
      var isLocal = host === 'localhost' || host === '127.0.0.1';
      if (proto === 'https:' || isLocal) {
        navigator.serviceWorker.register('sw.js').catch(function () { /* 注册失败不影响使用 */ });
      }
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
