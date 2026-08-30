/**
 * storage.js 单元测试 —— localStorage 用 mock 注入（design.md §3.1）
 * 覆盖：药品/耗材 CRUD、销售（药品+耗材）、医疗操作、有效期、版本兼容与加载归一化（v4）
 * 运行：node --test tests/
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const DrugStorage = require('../js/storage.js');

/** localStorage mock（内存 Map 实现） */
function createMockStorage() {
  const store = new Map();
  return {
    getItem(k) { return store.has(k) ? store.get(k) : null; },
    setItem(k, v) { store.set(k, String(v)); },
    removeItem(k) { store.delete(k); },
    key(i) { return Array.from(store.keys())[i] ?? null; },
    get length() { return store.size; },
    _store: store
  };
}

function makeStorage() {
  return new DrugStorage(createMockStorage());
}

function validDrug(overrides) {
  return Object.assign({ name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', stock: 10, threshold: 5 }, overrides || {});
}

function validConsumable(overrides) {
  return Object.assign({ name: '医用纱布', unit: '卷', stock: 20, threshold: 5 }, overrides || {});
}

function dayStr(offset) {
  const d = new Date(2026, 7, 30);
  d.setDate(d.getDate() + offset);
  const p = (n) => (n < 10 ? '0' + n : '' + n);
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
}

/* ---------- 药品 CRUD（US-1） ---------- */

test('添加药品成功并持久化', () => {
  const s = makeStorage();
  const r = s.addDrug(validDrug());
  assert.strictEqual(r.ok, true);
  assert.ok(r.drug.id.startsWith('d_'));
  assert.strictEqual(r.drug.name, '阿莫西林胶囊');
  assert.strictEqual(r.drug.stock, 10);
  assert.strictEqual(s.listDrugs().length, 1);
});

test('名称+规格重复 → 拒绝添加，不产生重复条目（AC2）', () => {
  const s = makeStorage();
  s.addDrug(validDrug());
  const r = s.addDrug(validDrug());
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('已存在'));
  assert.strictEqual(s.listDrugs().length, 1);
});

test('同名不同规格 → 允许添加（唯一键是 名称+规格）', () => {
  const s = makeStorage();
  s.addDrug(validDrug());
  const r = s.addDrug(validDrug({ spec: '0.5g*12粒' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.listDrugs().length, 2);
});

test('必填校验：名称缺失 → 拒绝；规格可空（US-14，空字符串归一化为 null）', () => {
  const s = makeStorage();
  assert.strictEqual(s.addDrug(validDrug({ name: '' })).ok, false);
  const r = s.addDrug(validDrug({ spec: '' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.drug.spec, null); // 空字符串 "" 归一化为 null（D21）
  assert.strictEqual(s.listDrugs().length, 1);
});

test('同名 + 规格都为空 → 判重（空规格视为一种取值，AC47）', () => {
  const s = makeStorage();
  assert.strictEqual(s.addDrug(validDrug({ spec: '' })).ok, true);
  const r = s.addDrug(validDrug({ spec: '' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('已存在'));
  assert.strictEqual(s.listDrugs().length, 1);
  // 空规格与显式规格视为不同取值 → 允许并存
  assert.strictEqual(s.addDrug(validDrug({ spec: '0.25g*24粒' })).ok, true);
  assert.strictEqual(s.listDrugs().length, 2);
});

test('规格空白串/undefined → null；非空规格保留原文', () => {
  const s = makeStorage();
  const a = s.addDrug(validDrug({ name: '药A', spec: '   ' })).drug;
  assert.strictEqual(a.spec, null);
  const b = s.addDrug(validDrug({ name: '药B', spec: ' 0.5g*12粒 ' })).drug;
  assert.strictEqual(b.spec, '0.5g*12粒'); // 去首尾空白
  assert.strictEqual(s.addDrug(validDrug({ name: '药C', spec: null })).drug.spec, null);
});

test('更新药品：字段更新 + updatedAt 变更；规格可清空为 null', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug());
  const before = drug.updatedAt;
  const r = s.updateDrug(drug.id, { stock: 3, threshold: 2 });
  assert.strictEqual(r.ok, true);
  const updated = s.listDrugs()[0];
  assert.strictEqual(updated.stock, 3);
  assert.strictEqual(updated.threshold, 2);
  assert.ok(updated.updatedAt >= before);
  // 规格清空 → null
  const r2 = s.updateDrug(drug.id, { spec: '' });
  assert.strictEqual(r2.ok, true);
  assert.strictEqual(s.listDrugs()[0].spec, null);
});

test('更新重名：改为其他药品的名称+规格 → 拒绝（排除自身）', () => {
  const s = makeStorage();
  const a = s.addDrug(validDrug()).drug;
  const b = s.addDrug(validDrug({ name: '布洛芬片', spec: '0.1g*24片' })).drug;
  // b 改名为 a 的名称+规格 → 拒绝
  assert.strictEqual(s.updateDrug(b.id, { name: a.name, spec: a.spec }).ok, false);
  // a 保持自身名称+规格 → 允许（排除自身）
  assert.strictEqual(s.updateDrug(a.id, { stock: 8 }).ok, true);
  // 空规格药品改名为其他空规格药品 → 拒绝（空规格视为一种取值）
  const c = s.addDrug(validDrug({ name: '维生素C片', spec: '' })).drug;
  const d = s.addDrug(validDrug({ name: '钙片', spec: '' })).drug;
  assert.strictEqual(s.updateDrug(d.id, { name: '维生素C片', spec: '' }).ok, false);
  assert.strictEqual(s.updateDrug(c.id, { name: '维生素C片', spec: '' }).ok, true); // 排除自身
});

test('删除药品：销售记录保留（US-5 / AC16）', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug());
  s.applySales([{ drugId: drug.id, qty: 2, source: 'manual' }]);
  assert.strictEqual(s.deleteDrug(drug.id).ok, true);
  assert.strictEqual(s.listDrugs().length, 0);
  assert.strictEqual(s.listSales().length, 1);
  assert.strictEqual(s.listSales()[0].name, '阿莫西林胶囊'); // 快照保留
});

/* ---------- 条码（US-15 / AC47） ---------- */

test('条码可空；非空条码全局唯一 → 重复添加拒绝（AC47）', () => {
  const s = makeStorage();
  const a = s.addDrug(validDrug({ barcode: '6901234567890' })).drug;
  assert.strictEqual(a.barcode, '6901234567890');
  // 未录条码 → null
  assert.strictEqual(s.addDrug(validDrug({ name: '无码药' })).drug.barcode, null);
  // 相同条码 → 拒绝
  const r = s.addDrug(validDrug({ name: '另一药', barcode: '6901234567890' }));
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('条码'));
  assert.strictEqual(s.listDrugs().length, 2);
  // 不同条码 → 允许
  assert.strictEqual(s.addDrug(validDrug({ name: '第三药', barcode: '6901234567891' })).ok, true);
});

test('条码空白串归一化为 null；首尾空白去除', () => {
  const s = makeStorage();
  assert.strictEqual(s.addDrug(validDrug({ name: '药X', barcode: '   ' })).drug.barcode, null);
  assert.strictEqual(s.addDrug(validDrug({ name: '药Y', barcode: ' 6900000000001 ' })).drug.barcode, '6900000000001');
});

test('更新条码：改为其他药品已有条码 → 拒绝；保持自身条码 → 允许（排除自身）', () => {
  const s = makeStorage();
  const a = s.addDrug(validDrug({ barcode: '6900000000001' })).drug;
  const b = s.addDrug(validDrug({ name: '药B', barcode: '6900000000002' })).drug;
  assert.strictEqual(s.updateDrug(b.id, { barcode: '6900000000001' }).ok, false);
  assert.strictEqual(s.updateDrug(a.id, { barcode: '6900000000001' }).ok, true);
  // 清空条码 → null
  const r = s.updateDrug(b.id, { barcode: '' });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.listDrugs().find((d) => d.id === b.id).barcode, null);
});

/* ---------- 销售扣减（US-3 / US-4） ---------- */

test('手动销售：扣减库存 + 生成 source=manual 记录（AC9）', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ stock: 10 }));
  const r = s.applySales([{ drugId: drug.id, qty: 2, source: 'manual', note: '窗口销售' }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.records.length, 1);
  assert.strictEqual(s.listDrugs()[0].stock, 8);
  const rec = s.listSales()[0];
  assert.strictEqual(rec.source, 'manual');
  assert.strictEqual(rec.qty, 2);
  assert.strictEqual(rec.note, '窗口销售');
  assert.strictEqual(rec.name, '阿莫西林胶囊'); // 快照
  assert.strictEqual(rec.type, 'drug');          // v3：药品记录类型（AC43）
  assert.strictEqual(rec.consumableId, null);
});

test('允许负库存：数量超过库存不阻止（AC8）', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ stock: 2 }));
  s.applySales([{ drugId: drug.id, qty: 5, source: 'manual' }]);
  assert.strictEqual(s.listDrugs()[0].stock, -3);
});

test('OCR 批量确认：一次扣减多行 + source=ocr（AC14）', () => {
  const s = makeStorage();
  const a = s.addDrug(validDrug({ name: '阿莫西林胶囊', stock: 10 })).drug;
  const b = s.addDrug(validDrug({ name: '布洛芬片', spec: '0.1g*24片', stock: 8 })).drug;
  const r = s.applySales([
    { drugId: a.id, qty: 2, source: 'ocr' },
    { drugId: b.id, qty: 1, source: 'ocr' }
  ]);
  assert.strictEqual(r.records.length, 2);
  const drugs = s.listDrugs();
  assert.strictEqual(drugs.find((d) => d.id === a.id).stock, 8);
  assert.strictEqual(drugs.find((d) => d.id === b.id).stock, 7);
  assert.ok(s.listSales().every((rec) => rec.source === 'ocr'));
});

test('销售记录只增不改：多次扣减累积', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ stock: 10 }));
  s.applySales([{ drugId: drug.id, qty: 1, source: 'manual' }]);
  s.applySales([{ drugId: drug.id, qty: 3, source: 'manual' }]);
  assert.strictEqual(s.listDrugs()[0].stock, 6);
  assert.strictEqual(s.listSales().length, 2);
});

test('无效条目（qty<=0 / 药品不存在）被安全跳过', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ stock: 10 }));
  const r = s.applySales([
    { drugId: drug.id, qty: 0, source: 'manual' },
    { drugId: 'd_missing', qty: 3, source: 'manual' }
  ]);
  assert.strictEqual(r.records.length, 0);
  assert.strictEqual(s.listDrugs()[0].stock, 10);
});

/* ---------- 耗材（US-9 / AC32~AC34） ---------- */

test('添加耗材：字段完整 + initialStock 写入（AC32）', () => {
  const s = makeStorage();
  const r = s.addConsumable(validConsumable({ priceCost: 3, priceSell: 5 }));
  assert.strictEqual(r.ok, true);
  assert.ok(r.consumable.id.startsWith('c_'));
  assert.strictEqual(r.consumable.name, '医用纱布');
  assert.strictEqual(r.consumable.unit, '卷');
  assert.strictEqual(r.consumable.stock, 20);
  assert.strictEqual(r.consumable.initialStock, 20);
  assert.strictEqual(r.consumable.priceSell, 5);
  assert.strictEqual(s.listConsumables().length, 1);
});

test('耗材重名 → 拒绝添加', () => {
  const s = makeStorage();
  s.addConsumable(validConsumable());
  const r = s.addConsumable(validConsumable());
  assert.strictEqual(r.ok, false);
  assert.ok(r.error.includes('已存在'));
  assert.strictEqual(s.listConsumables().length, 1);
});

test('耗材必填校验：名称/单位缺失 → 拒绝', () => {
  const s = makeStorage();
  assert.strictEqual(s.addConsumable(validConsumable({ name: '' })).ok, false);
  assert.strictEqual(s.addConsumable(validConsumable({ unit: '' })).ok, false);
  assert.strictEqual(s.listConsumables().length, 0);
});

test('更新耗材：initialStock 只读（传入值被忽略）', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  const r = s.updateConsumable(consumable.id, { name: '医用纱布（灭菌）', threshold: 3, initialStock: 999, priceSell: 6 });
  assert.strictEqual(r.ok, true);
  const c = s.listConsumables()[0];
  assert.strictEqual(c.name, '医用纱布（灭菌）');
  assert.strictEqual(c.threshold, 3);
  assert.strictEqual(c.priceSell, 6);
  assert.strictEqual(c.initialStock, 20); // 初始存量保持创建时的值
  assert.strictEqual(c.stock, 20);        // 更新不改变存量（存量走「进货」调整）
});

test('耗材更新重名 → 拒绝（排除自身）', () => {
  const s = makeStorage();
  const a = s.addConsumable(validConsumable()).consumable;
  const b = s.addConsumable(validConsumable({ name: '棉签' })).consumable;
  assert.strictEqual(s.updateConsumable(b.id, { name: a.name }).ok, false);
  assert.strictEqual(s.updateConsumable(a.id, { name: a.name }).ok, true);
});

test('进货/调整存量：set 模式与 add 模式（AC33）', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  // set：新存量
  let r = s.adjustConsumableStock(consumable.id, { mode: 'set', value: 50 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.consumable.stock, 50);
  // add：增加量
  r = s.adjustConsumableStock(consumable.id, { mode: 'add', value: 10 });
  assert.strictEqual(r.consumable.stock, 60);
  // add：负数修正
  r = s.adjustConsumableStock(consumable.id, { mode: 'add', value: -5 });
  assert.strictEqual(r.consumable.stock, 55);
  assert.strictEqual(s.listConsumables()[0].stock, 55);
});

test('进货/调整存量：非法值 → 拒绝且存量不变', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  assert.strictEqual(s.adjustConsumableStock(consumable.id, { mode: 'set', value: -3 }).ok, false);
  assert.strictEqual(s.adjustConsumableStock(consumable.id, { mode: 'set', value: 3.5 }).ok, false);
  assert.strictEqual(s.adjustConsumableStock(consumable.id, { mode: 'add', value: 3.5 }).ok, false);
  assert.strictEqual(s.adjustConsumableStock(consumable.id, { mode: 'set', value: 'abc' }).ok, false);
  assert.strictEqual(s.listConsumables()[0].stock, 20);
});

test('删除耗材：销售/操作记录保留（US-9）', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable());
  s.applySales([{ consumableId: consumable.id, qty: 2, source: 'manual' }]);
  s.applyOp({ type: '换药', items: [{ consumableId: consumable.id, qty: 1 }] });
  assert.strictEqual(s.deleteConsumable(consumable.id).ok, true);
  assert.strictEqual(s.listConsumables().length, 0);
  assert.strictEqual(s.listSales().length, 1);
  assert.strictEqual(s.listSales()[0].name, '医用纱布'); // 快照保留
  assert.strictEqual(s.listOps().length, 1);
  assert.strictEqual(s.listOps()[0].items[0].name, '医用纱布'); // 操作明细快照保留
});

/* ---------- 耗材售卖（US-3/US-9 / AC43） ---------- */

test('售卖耗材：扣减耗材存量 + type=consumable 记录（AC43）', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20, priceSell: 5 }));
  const r = s.applySales([{ consumableId: consumable.id, qty: 3, source: 'manual', priceSell: 5 }]);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.records.length, 1);
  assert.strictEqual(s.listConsumables()[0].stock, 17);
  const rec = s.listSales()[0];
  assert.strictEqual(rec.type, 'consumable');
  assert.strictEqual(rec.consumableId, consumable.id);
  assert.strictEqual(rec.drugId, null);
  assert.strictEqual(rec.spec, null);
  assert.strictEqual(rec.name, '医用纱布');
  assert.strictEqual(rec.priceSell, 5);
});

test('OCR 售卖耗材：type=consumable + source=ocr', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  s.applySales([{ consumableId: consumable.id, qty: 2, source: 'ocr' }]);
  const rec = s.listSales()[0];
  assert.strictEqual(rec.type, 'consumable');
  assert.strictEqual(rec.source, 'ocr');
  assert.strictEqual(s.listConsumables()[0].stock, 18);
});

test('混选销售：药品 + 耗材一次批量扣减（AC43）', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ stock: 10 }));
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  const r = s.applySales([
    { drugId: drug.id, qty: 2, source: 'manual' },
    { consumableId: consumable.id, qty: 3, source: 'manual' }
  ]);
  assert.strictEqual(r.records.length, 2);
  assert.strictEqual(s.listDrugs()[0].stock, 8);
  assert.strictEqual(s.listConsumables()[0].stock, 17);
  assert.strictEqual(s.listSales()[0].type, 'drug');
  assert.strictEqual(s.listSales()[1].type, 'consumable');
});

/* ---------- 医疗操作（US-10 / AC35~AC37） ---------- */

test('确认操作：批量扣减耗材 + 写 op 记录（items 快照）（AC35/AC36）', () => {
  const s = makeStorage();
  const a = s.addConsumable(validConsumable({ name: '医用纱布', stock: 20 })).consumable;
  const b = s.addConsumable(validConsumable({ name: '棉签', unit: '包', stock: 10 })).consumable;
  const r = s.applyOp({
    type: '换药',
    note: '右臂伤口',
    items: [
      { consumableId: a.id, qty: 2 },
      { consumableId: b.id, qty: 1 }
    ]
  });
  assert.strictEqual(r.ok, true);
  assert.ok(r.op.id.startsWith('o_'));
  const op = s.listOps()[0];
  assert.strictEqual(op.type, '换药');
  assert.strictEqual(op.note, '右臂伤口');
  assert.deepStrictEqual(op.items, [
    { consumableId: a.id, name: '医用纱布', unit: '卷', qty: 2 },
    { consumableId: b.id, name: '棉签', unit: '包', qty: 1 }
  ]);
  assert.strictEqual(s.listConsumables().find((c) => c.id === a.id).stock, 18);
  assert.strictEqual(s.listConsumables().find((c) => c.id === b.id).stock, 9);
});

test('操作扣减允许负数：数量超过存量不阻止（AC37）', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 2 }));
  const r = s.applyOp({ type: '清创', items: [{ consumableId: consumable.id, qty: 5 }] });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.listConsumables()[0].stock, -3);
});

test('操作校验：缺类型/数量非法/耗材不存在 → 拒绝且不写入（AC36）', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  assert.strictEqual(s.applyOp({ type: '', items: [] }).ok, false);
  assert.strictEqual(s.applyOp({ type: '换药', items: [{ consumableId: consumable.id, qty: 0 }] }).ok, false);
  assert.strictEqual(s.applyOp({ type: '换药', items: [{ consumableId: consumable.id, qty: -1 }] }).ok, false);
  assert.strictEqual(s.applyOp({ type: '换药', items: [{ consumableId: 'c_missing', qty: 1 }] }).ok, false);
  assert.strictEqual(s.listOps().length, 0);
  assert.strictEqual(s.listConsumables()[0].stock, 20);
});

test('操作记录只增不改：多次确认累积', () => {
  const s = makeStorage();
  const { consumable } = s.addConsumable(validConsumable({ stock: 20 }));
  s.applyOp({ type: '换药', items: [{ consumableId: consumable.id, qty: 1 }] });
  s.applyOp({ type: '消毒', items: [{ consumableId: consumable.id, qty: 2 }] });
  assert.strictEqual(s.listOps().length, 2);
  assert.strictEqual(s.listConsumables()[0].stock, 17);
});

test('操作可不含耗材明细（仅类型+备注）', () => {
  const s = makeStorage();
  const r = s.applyOp({ type: '检查', note: '观察' });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(s.listOps()[0].items, []);
});

/* ---------- 设置（§3.2 v4） ---------- */

test('settings 默认值：formatVersion 4', () => {
  const s = makeStorage();
  const st = s.getSettings();
  assert.strictEqual(st.formatVersion, 4);
  assert.strictEqual(st.lastImportAt, null);
});

test('setSettings 合并写入', () => {
  const s = makeStorage();
  s.setSettings({ lastImportAt: 123456 });
  assert.strictEqual(s.getSettings().lastImportAt, 123456);
  assert.strictEqual(s.getSettings().formatVersion, 4);
});

/* ---------- 导出 / 导入（US-6，D6/D11/D25） ---------- */

test('导出：formatVersion 4 且含耗材/操作/有效期/条码/销售类型（AC17 / AC50）', () => {
  const s = makeStorage();
  s.addDrug(validDrug({ priceCost: 8.5, priceSell: 15, expiryDate: '2027-06-30', barcode: '6901234567890' }));
  const c = s.addConsumable(validConsumable()).consumable;
  s.applySales([{ consumableId: c.id, qty: 1, source: 'manual' }]);
  s.applyOp({ type: '换药', items: [{ consumableId: c.id, qty: 2 }] });
  const data = s.exportData();
  assert.strictEqual(data.formatVersion, 4);
  assert.strictEqual(typeof data.exportedAt, 'number');
  assert.strictEqual(data.drugs.length, 1);
  assert.strictEqual(data.drugs[0].priceCost, 8.5);
  assert.strictEqual(data.drugs[0].expiryDate, '2027-06-30');
  assert.strictEqual(data.drugs[0].barcode, '6901234567890'); // v4：条码字段（AC50）
  assert.strictEqual(data.consumables.length, 1);
  assert.strictEqual(data.consumables[0].initialStock, 20);
  assert.strictEqual(data.sales.length, 1);
  assert.strictEqual(data.sales[0].type, 'consumable');
  assert.strictEqual(data.ops.length, 1);
  assert.ok(data.settings);
  assert.strictEqual(data.settings.formatVersion, 4);
});

test('导入校验：v1/v2/v3/v4 接受，缺版本号/未知版本/缺数据 → 拒绝（D11/D25）', () => {
  const s = makeStorage();
  assert.strictEqual(s.validateImport(null).ok, false);
  assert.strictEqual(s.validateImport([]).ok, false);
  assert.strictEqual(s.validateImport({ drugs: [], sales: [] }).ok, false); // 缺版本号
  assert.strictEqual(s.validateImport({ formatVersion: 1, drugs: [], sales: [] }).ok, true);  // v1 向后兼容
  assert.strictEqual(s.validateImport({ formatVersion: 2, drugs: [], sales: [] }).ok, true);  // v2
  assert.strictEqual(s.validateImport({ formatVersion: 3, drugs: [], sales: [] }).ok, true);  // v3
  assert.strictEqual(s.validateImport({ formatVersion: 4, drugs: [], sales: [] }).ok, true);  // 当前版本
  assert.strictEqual(s.validateImport({ formatVersion: 5, drugs: [], sales: [] }).ok, false); // 更高版本拒绝
  assert.strictEqual(s.validateImport({ formatVersion: 'abc', drugs: [], sales: [] }).ok, false);
  assert.strictEqual(s.validateImport({ formatVersion: 2, drugs: 'x', sales: [] }).ok, false); // drugs 非数组
  assert.strictEqual(s.validateImport({ formatVersion: 2, drugs: [], sales: 'x' }).ok, false); // sales 非数组
});

test('导入概要：含耗材与操作计数（v1/v2 缺键按 0 计）', () => {
  const s = makeStorage();
  const v1 = s.validateImport({ formatVersion: 1, drugs: [{}], sales: [] });
  assert.deepStrictEqual(v1.summary, { drugs: 1, consumables: 0, sales: 0, ops: 0 });
  const v3 = s.validateImport({
    formatVersion: 3, drugs: [], consumables: [{ id: 'c1' }], sales: [], ops: [{ id: 'o1' }]
  });
  assert.deepStrictEqual(v3.summary, { drugs: 0, consumables: 1, sales: 0, ops: 1 });
});

test('导入：整体覆盖写入 + 刷新后数据为导入数据（D6）', () => {
  const s = makeStorage();
  s.addDrug(validDrug({ name: '旧药品' }));
  const backup = {
    formatVersion: 1,
    exportedAt: Date.now(),
    drugs: [Object.assign(validDrug({ name: '新药品' }), { id: 'd_imp', createdAt: 1, updatedAt: 1 })],
    sales: [{ id: 's_imp', drugId: 'd_imp', name: '新药品', spec: '0.25g*24粒', unit: '盒', qty: 1, source: 'ocr', note: '', createdAt: 1 }],
    settings: { version: 1, lastImportAt: 999 }
  };
  const r = s.importData(backup);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.summary, { drugs: 1, consumables: 0, sales: 1, ops: 0 });
  assert.strictEqual(s.listDrugs().length, 1);
  assert.strictEqual(s.listDrugs()[0].name, '新药品');
  assert.strictEqual(s.listDrugs()[0].priceCost, null); // v1 导入补 null
  assert.strictEqual(s.listDrugs()[0].expiryDate, null); // v1 导入补 null
  assert.strictEqual(s.listDrugs()[0].barcode, null);    // v1 导入补 null（AC50）
  assert.strictEqual(s.listSales().length, 1);
  assert.strictEqual(s.listSales()[0].priceSell, null); // v1 导入补 null
  assert.strictEqual(s.listSales()[0].type, 'drug');    // v1 导入补 type
  assert.strictEqual(s.listConsumables().length, 0);    // v1 无耗材 → []
  assert.strictEqual(s.listOps().length, 0);            // v1 无操作 → []
  // 导入后 settings：formatVersion 保持当前格式版本、lastImportAt 更新
  assert.strictEqual(s.getSettings().formatVersion, 4);
  assert.ok(s.getSettings().lastImportAt > 0);
});

test('导入 v3 备份：耗材/操作/有效期/销售类型保留（AC42）', () => {
  const s = makeStorage();
  const v3 = {
    formatVersion: 3,
    exportedAt: 3,
    drugs: [{ id: 'd1', name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', stock: 10, threshold: 5, priceCost: 8.5, priceSell: 15, expiryDate: '2027-06-30', createdAt: 1, updatedAt: 1 }],
    consumables: [{ id: 'c1', name: '医用纱布', unit: '卷', stock: 17, threshold: 5, initialStock: 20, priceCost: 3, priceSell: 5, createdAt: 1, updatedAt: 1 }],
    sales: [{ id: 's1', type: 'consumable', drugId: null, consumableId: 'c1', name: '医用纱布', spec: null, unit: '卷', qty: 3, priceSell: 5, source: 'manual', note: '', createdAt: 1 }],
    ops: [{ id: 'o1', type: '换药', note: '', items: [{ consumableId: 'c1', name: '医用纱布', unit: '卷', qty: 2 }], createdAt: 1 }],
    settings: { formatVersion: 3, lastImportAt: null }
  };
  const r = s.importData(v3);
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.summary, { drugs: 1, consumables: 1, sales: 1, ops: 1 });
  assert.strictEqual(s.listDrugs()[0].expiryDate, '2027-06-30');
  assert.strictEqual(s.listDrugs()[0].barcode, null); // v3 无条码 → 补 null
  assert.strictEqual(s.listConsumables()[0].initialStock, 20);
  assert.strictEqual(s.listSales()[0].type, 'consumable');
  assert.strictEqual(s.listSales()[0].consumableId, 'c1');
  assert.strictEqual(s.listOps()[0].items[0].name, '医用纱布');
  // 导入后 formatVersion 升为 4
  assert.strictEqual(s.getSettings().formatVersion, 4);
});

test('导入 v4 备份：条码/空规格保留（AC50）', () => {
  const s = makeStorage();
  const v4 = {
    formatVersion: 4,
    exportedAt: 4,
    drugs: [
      { id: 'd1', name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', stock: 10, threshold: 5, barcode: '6901234567890', priceCost: 8.5, priceSell: 15, expiryDate: '2027-06-30', createdAt: 1, updatedAt: 1 },
      { id: 'd2', name: '维生素C片', spec: null, unit: '瓶', stock: 5, threshold: 5, barcode: null, priceCost: null, priceSell: null, expiryDate: null, createdAt: 1, updatedAt: 1 }
    ],
    sales: [{ id: 's1', type: 'drug', drugId: 'd1', consumableId: null, name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', qty: 2, priceSell: 15, source: 'manual', note: '', createdAt: 1 }],
    settings: { formatVersion: 4, lastImportAt: null }
  };
  assert.strictEqual(s.importData(v4).ok, true);
  assert.strictEqual(s.listDrugs()[0].barcode, '6901234567890');
  assert.strictEqual(s.listDrugs()[1].spec, null);
  assert.strictEqual(s.getSettings().formatVersion, 4);
});

test('导入失败（版本/结构损坏）：现有数据保持不变（AC31）', () => {
  const s = makeStorage();
  s.addDrug(validDrug());
  const before = JSON.stringify(s.listDrugs());
  assert.strictEqual(s.importData({ formatVersion: 5, drugs: [], sales: [] }).ok, false); // v5 拒绝
  assert.strictEqual(s.importData({ formatVersion: 2, drugs: 'x', sales: [] }).ok, false);
  assert.strictEqual(s.importData(null).ok, false);
  assert.strictEqual(JSON.stringify(s.listDrugs()), before); // 未发生任何写入
  assert.strictEqual(s.listSales().length, 0);
});

/* ---------- 加载时归一化（D25） ---------- */

test('加载归一化：旧数据缺键/缺字段补默认值，settings 升级为 4', () => {
  const mock = createMockStorage();
  // 模拟 v3 时代的 localStorage：drugs/sales 缺 barcode、spec 为空字符串、无 consumables/ops 键、settings 为旧 version
  mock.setItem('drugInventory.drugs', JSON.stringify([
    { id: 'd1', name: '阿莫西林胶囊', spec: '', unit: '盒', stock: 10, threshold: 5, priceCost: 8.5, priceSell: 15, createdAt: 1, updatedAt: 1 }
  ]));
  mock.setItem('drugInventory.sales', JSON.stringify([
    { id: 's1', drugId: 'd1', name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', qty: 2, priceSell: 15, source: 'manual', note: '', createdAt: 1 }
  ]));
  mock.setItem('drugInventory.settings', JSON.stringify({ version: 3, lastImportAt: null }));

  const s = new DrugStorage(mock);
  s.normalize();

  // 缺键 → []
  assert.deepStrictEqual(s.listConsumables(), []);
  assert.deepStrictEqual(s.listOps(), []);
  // 缺字段 → 默认值：spec 空字符串→null、barcode 补 null
  assert.strictEqual(s.listDrugs()[0].spec, null);
  assert.strictEqual(s.listDrugs()[0].barcode, null);
  assert.strictEqual(s.listDrugs()[0].expiryDate, null);
  assert.strictEqual(s.listSales()[0].type, 'drug');
  assert.strictEqual(s.listSales()[0].consumableId, null);
  // settings.formatVersion 原地升级为 4（写回）
  assert.strictEqual(s.getSettings().formatVersion, 4);
  const rawSettings = JSON.parse(mock.getItem('drugInventory.settings'));
  assert.strictEqual(rawSettings.formatVersion, 4);
});

test('getSettings 自动升级旧 settings（version → formatVersion 4）', () => {
  const mock = createMockStorage();
  mock.setItem('drugInventory.settings', JSON.stringify({ version: 3, lastImportAt: 5 }));
  const s = new DrugStorage(mock);
  const st = s.getSettings();
  assert.strictEqual(st.formatVersion, 4);
  assert.strictEqual(st.lastImportAt, 5);
  const raw = JSON.parse(mock.getItem('drugInventory.settings'));
  assert.strictEqual(raw.formatVersion, 4); // 已原地写回
});

/* ---------- 持久化（N4） ---------- */

test('数据跨实例持久（同一后端）', () => {
  const mock = createMockStorage();
  const s1 = new DrugStorage(mock);
  s1.addDrug(validDrug());
  s1.applySales([{ drugId: s1.listDrugs()[0].id, qty: 2, source: 'manual' }]);
  const s2 = new DrugStorage(mock);
  assert.strictEqual(s2.listDrugs().length, 1);
  assert.strictEqual(s2.listSales().length, 1);
});

/* ---------- 价格字段（US-7 / AC24） ---------- */

test('添加药品带价格：priceCost/priceSell 存储', () => {
  const s = makeStorage();
  const r = s.addDrug(validDrug({ priceCost: 8.5, priceSell: 15 }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.drug.priceCost, 8.5);
  assert.strictEqual(r.drug.priceSell, 15);
});

test('无价格药品 → 价格字段为 null（旧药品兼容）', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug());
  assert.strictEqual(drug.priceCost, null);
  assert.strictEqual(drug.priceSell, null);
});

test('价格两位小数归一化；负数/非法值 → null', () => {
  const s = makeStorage();
  const r = s.addDrug(validDrug({ priceCost: 8.556, priceSell: -3 }));
  assert.strictEqual(r.drug.priceCost, 8.56); // 四舍五入两位小数
  assert.strictEqual(r.drug.priceSell, null);
  assert.strictEqual(s.addDrug(validDrug({ name: 'x药', spec: 'y', priceCost: 'abc' })).drug.priceCost, null);
});

test('更新药品价格（含清空 → null；未修改字段保留）', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ priceCost: 8.5, priceSell: 15 }));
  const r = s.updateDrug(drug.id, { priceCost: 9.25, priceSell: 16 });
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.drug.priceCost, 9.25);
  assert.strictEqual(r.drug.priceSell, 16);
  const r2 = s.updateDrug(drug.id, { priceSell: null });
  assert.strictEqual(r2.drug.priceSell, null);
  assert.strictEqual(r2.drug.priceCost, 9.25);
});

/* ---------- 有效期（US-12 / AC39~AC41） ---------- */

test('添加/更新药品有效期：格式校验与归一化（AC39）', () => {
  const s = makeStorage();
  const r = s.addDrug(validDrug({ expiryDate: '2027-06-30' }));
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.drug.expiryDate, '2027-06-30');
  // 空 → null
  assert.strictEqual(s.addDrug(validDrug({ name: '维生素C片', spec: '100mg', expiryDate: '' })).drug.expiryDate, null);
  // 非法格式 → null
  assert.strictEqual(s.addDrug(validDrug({ name: '布洛芬片', spec: '0.1g*24片', expiryDate: '2027/06/30' })).drug.expiryDate, null);
  // 更新有效期
  const { drug } = s.addDrug(validDrug({ name: '感冒灵', spec: '10袋', expiryDate: '2026-12-31' }));
  const u = s.updateDrug(drug.id, { expiryDate: '2027-01-31' });
  assert.strictEqual(u.drug.expiryDate, '2027-01-31');
  const u2 = s.updateDrug(drug.id, { expiryDate: null });
  assert.strictEqual(u2.drug.expiryDate, null);
});

test('有效期状态：本地时区当日 0 点判断（AC40，§7 时区风险）', () => {
  const now = new Date(2026, 7, 30, 12, 0).getTime(); // 2026-08-30 12:00 本地
  assert.strictEqual(DrugStorage.expiryStatus(dayStr(90), now).status, 'expiring');  // 恰 90 天 → 临期
  assert.strictEqual(DrugStorage.expiryStatus(dayStr(91), now).status, 'ok');        // 91 天 → 正常
  assert.strictEqual(DrugStorage.expiryStatus(dayStr(0), now).status, 'expiring');   // 今天到期 → 临期
  assert.strictEqual(DrugStorage.expiryStatus(dayStr(1), now).status, 'expiring');   // 明天到期 → 临期
  assert.strictEqual(DrugStorage.expiryStatus(dayStr(-1), now).status, 'expired');   // 昨天到期 → 已过期
  assert.strictEqual(DrugStorage.expiryStatus(dayStr(-365), now).status, 'expired');
});

test('有效期状态：无有效期 / 非法日期 → none（不误判）', () => {
  const now = new Date(2026, 7, 30).getTime();
  assert.strictEqual(DrugStorage.expiryStatus(null, now).status, 'none');
  assert.strictEqual(DrugStorage.expiryStatus('', now).status, 'none');
  assert.strictEqual(DrugStorage.expiryStatus('2026-02-31', now).status, 'none'); // 无效日期
  assert.strictEqual(DrugStorage.expiryStatus('abc', now).status, 'none');
});

/* ---------- 售价快照（D12 / AC26） ---------- */

test('销售记录保存售价快照：改价不影响历史记录', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ priceSell: 15 }));
  s.applySales([{ drugId: drug.id, qty: 2, source: 'manual' }]);
  s.updateDrug(drug.id, { priceSell: 20 });
  s.applySales([{ drugId: drug.id, qty: 1, source: 'manual' }]);
  const sales = s.listSales();
  assert.strictEqual(sales[0].priceSell, 15); // 快照不受改价影响
  assert.strictEqual(sales[1].priceSell, 20);
});

test('手动登记可覆盖售价；无价格药品 → 记录 priceSell null', () => {
  const s = makeStorage();
  const { drug } = s.addDrug(validDrug({ priceSell: 15 }));
  s.applySales([{ drugId: drug.id, qty: 1, source: 'manual', priceSell: 12 }]);
  assert.strictEqual(s.listSales()[0].priceSell, 12);
  const noPrice = s.addDrug(validDrug({ name: '维生素C片', spec: '100mg' })).drug;
  s.applySales([{ drugId: noPrice.id, qty: 1, source: 'manual' }]);
  assert.strictEqual(s.listSales()[1].priceSell, null);
});

/* ---------- 导出 / 导入 v1/v2（D14/D19 / AC30 / AC31） ---------- */

test('导入 v1 旧备份：成功且价格/有效期补空（AC30）', () => {
  const s = makeStorage();
  const v1 = {
    formatVersion: 1,
    exportedAt: 1,
    drugs: [{ id: 'd1', name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', stock: 10, threshold: 5, createdAt: 1, updatedAt: 1 }],
    sales: [{ id: 's1', drugId: 'd1', name: '阿莫西林胶囊', spec: '0.25g*24粒', unit: '盒', qty: 2, source: 'manual', note: '', createdAt: 1 }],
    settings: { version: 1, lastImportAt: null }
  };
  const r = s.importData(v1);
  assert.strictEqual(r.ok, true);
  assert.strictEqual(s.listDrugs()[0].priceCost, null);
  assert.strictEqual(s.listDrugs()[0].priceSell, null);
  assert.strictEqual(s.listDrugs()[0].expiryDate, null);
  assert.strictEqual(s.listDrugs()[0].barcode, null); // v1 无条码 → 补 null
  assert.strictEqual(s.listSales()[0].priceSell, null);
});

test('导入 v2 备份：价格字段保留', () => {
  const s = makeStorage();
  const v2 = {
    formatVersion: 2,
    exportedAt: 2,
    drugs: [{ id: 'd2', name: '布洛芬片', spec: '0.1g*24片', unit: '盒', stock: 8, threshold: 5, priceCost: 5, priceSell: 12, createdAt: 1, updatedAt: 1 }],
    sales: [{ id: 's2', drugId: 'd2', name: '布洛芬片', spec: '0.1g*24片', unit: '盒', qty: 1, priceSell: 12, source: 'ocr', note: '', createdAt: 1 }],
    settings: { version: 2, lastImportAt: null }
  };
  assert.strictEqual(s.importData(v2).ok, true);
  assert.strictEqual(s.listDrugs()[0].priceCost, 5);
  assert.strictEqual(s.listSales()[0].priceSell, 12);
  assert.strictEqual(s.listSales()[0].type, 'drug'); // v2 记录补 type
});
