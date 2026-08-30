/**
 * stats.js 单元测试 —— 统计口径（design.md §3.3 / D12 / D13 / D16 / AC27~AC29 / AC38 / AC44）
 * 运行：node --test tests/
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Stats = require('../js/stats.js');

function drug(overrides) {
  return Object.assign({
    id: 'd_a',
    name: '阿莫西林胶囊',
    spec: '0.25g*24粒',
    unit: '盒',
    stock: 10,
    threshold: 5,
    priceCost: 8.5,
    priceSell: 15
  }, overrides || {});
}

function consumable(overrides) {
  return Object.assign({
    id: 'c_x',
    name: '医用纱布',
    unit: '卷',
    stock: 20,
    threshold: 5,
    initialStock: 20,
    priceCost: 3,
    priceSell: 5
  }, overrides || {});
}

function rec(overrides) {
  return Object.assign({
    id: 's_' + Math.random().toString(36).slice(2, 8),
    type: 'drug',
    drugId: 'd_a',
    consumableId: null,
    name: '阿莫西林胶囊',
    spec: '0.25g*24粒',
    unit: '盒',
    qty: 1,
    priceSell: 15,
    source: 'manual',
    note: '',
    createdAt: 1000
  }, overrides || {});
}

function cRec(overrides) {
  return Object.assign({
    id: 's_' + Math.random().toString(36).slice(2, 8),
    type: 'consumable',
    drugId: null,
    consumableId: 'c_x',
    name: '医用纱布',
    spec: null,
    unit: '卷',
    qty: 1,
    priceSell: 5,
    source: 'manual',
    note: '',
    createdAt: 1000
  }, overrides || {});
}

function op(overrides) {
  return Object.assign({
    id: 'o_' + Math.random().toString(36).slice(2, 8),
    type: '换药',
    note: '',
    items: [{ consumableId: 'c_x', name: '医用纱布', unit: '卷', qty: 2 }],
    createdAt: 1000
  }, overrides || {});
}

/* ---------- 汇总（AC27 / AC44：含耗材售卖） ---------- */

test('summary：销售额/成本/毛利/毛利率（AC27）', () => {
  const drugs = [
    drug({ id: 'd_a', priceCost: 8.5, priceSell: 15 }),
    drug({ id: 'd_b', name: '布洛芬片', spec: '0.1g*24片', priceCost: 5, priceSell: 12 })
  ];
  const records = [
    rec({ drugId: 'd_a', priceSell: 15, qty: 2, createdAt: 1000 }),
    rec({ drugId: 'd_b', priceSell: 12, qty: 1, createdAt: 2000 })
  ];
  const s = Stats.summary(records, drugs);
  assert.strictEqual(s.salesCents, 4200); // 15×2 + 12×1 = 42 元
  assert.strictEqual(s.costCents, 2200);  // 8.5×2 + 5×1 = 22 元
  assert.strictEqual(s.profitCents, 2000);
  assert.ok(Math.abs(s.margin - 2000 / 4200) < 1e-9);
});

test('summary 含耗材售卖：销售额/成本计入（AC44）', () => {
  const drugs = [drug({ id: 'd_a', priceCost: 8.5, priceSell: 15 })];
  const consumables = [consumable({ id: 'c_x', priceCost: 3, priceSell: 5 })];
  const records = [
    rec({ drugId: 'd_a', qty: 2, priceSell: 15 }),
    cRec({ consumableId: 'c_x', qty: 3, priceSell: 5 })
  ];
  const s = Stats.summary(records, drugs, consumables);
  assert.strictEqual(s.salesCents, 3000 + 1500); // 15×2 + 5×3
  assert.strictEqual(s.costCents, 1700 + 900);   // 8.5×2 + 3×3
  assert.strictEqual(s.profitCents, 1900);
});

test('耗材售卖：无售价记录不计入；已删除耗材成本缺失（D13/AC44）', () => {
  const consumables = [consumable({ id: 'c_x', priceCost: 3, priceSell: 5 })];
  const records = [
    cRec({ consumableId: 'c_x', qty: 2, priceSell: null }),   // 无售价：不计入
    cRec({ consumableId: 'c_gone', qty: 2, priceSell: 5 })    // 已删除耗材：销售额计入、成本缺失
  ];
  const s = Stats.summary(records, [], consumables);
  assert.strictEqual(s.salesCents, 1000); // 仅已删除条目 5×2
  assert.strictEqual(s.costCents, 0);
  assert.strictEqual(s.profitCents, 1000);
});

test('销售额为 0 → 毛利率 null（界面显示「—」，AC27）', () => {
  const s = Stats.summary([rec({ priceSell: null })], [drug()]);
  assert.strictEqual(s.salesCents, 0);
  assert.strictEqual(s.costCents, 0);
  assert.strictEqual(s.margin, null);
  assert.strictEqual(Stats.summary([], [drug()]).margin, null);
});

test('售价快照：改价不影响历史销售额（D12）', () => {
  // 记录保存售价快照 15；药品当前卖价已改为 20 → 销售额仍按 15
  const drugs = [drug({ priceCost: 8.5, priceSell: 20 })];
  const records = [rec({ qty: 2, priceSell: 15 })];
  const s = Stats.summary(records, drugs);
  assert.strictEqual(s.salesCents, 3000); // 15×2（快照）
  assert.strictEqual(s.costCents, 1700);  // 成本按当前进价 8.5×2
});

test('成本按统计时当前进价计算（D13）', () => {
  const drugs = [drug({ priceCost: 10 })];
  const records = [rec({ qty: 2, priceSell: 15 })];
  const s = Stats.summary(records, drugs);
  assert.strictEqual(s.costCents, 2000); // 10×2
});

test('无价格记录不计入销售额/成本/毛利（D13）', () => {
  const drugs = [drug({ priceCost: 8.5 })];
  const records = [
    rec({ priceSell: null, qty: 2 }), // 无售价：全部不计入
    rec({ qty: 1, priceSell: 15 })
  ];
  const s = Stats.summary(records, drugs);
  assert.strictEqual(s.salesCents, 1500); // 仅第 2 条
  assert.strictEqual(s.costCents, 850);   // 仅第 2 条（第 1 条无售价不计成本）
  assert.strictEqual(s.profitCents, 650);
});

test('已删除/无进价药品的记录：销售额计入、成本不计入（D13）', () => {
  // 记录中的药品不在 drugs 里（已删除）：有售价快照 → 销售额计入，成本无法计算
  const s = Stats.summary([rec({ drugId: 'd_gone', qty: 1, priceSell: 15 })], [drug({ id: 'd_a' })]);
  assert.strictEqual(s.salesCents, 1500);
  assert.strictEqual(s.costCents, 0);
  assert.strictEqual(s.profitCents, 1500);
  // 药品存在但未设置进价：同样不计入成本
  const s2 = Stats.summary([rec({ qty: 1, priceSell: 15 })], [drug({ priceCost: null })]);
  assert.strictEqual(s2.costCents, 0);
  assert.strictEqual(s2.salesCents, 1500);
});

/* ---------- 按日期（AC28） ---------- */

test('按日期区间过滤：含首尾边界', () => {
  const records = [
    rec({ createdAt: 1000 }),
    rec({ createdAt: 2000 }),
    rec({ createdAt: 3000 })
  ];
  const r = Stats.filterByDate(records, 1000, 2000);
  assert.deepStrictEqual(r.map((x) => x.createdAt), [1000, 2000]);
  assert.strictEqual(Stats.filterByDate(records, null, 2000).length, 2); // 只设上界
  assert.strictEqual(Stats.filterByDate(records, 2000, null).length, 2); // 只设下界
  assert.strictEqual(Stats.filterByDate(records, 9999, 10000).length, 0);
});

test('按天汇总：分组、升序、数值正确（AC28）', () => {
  const drugs = [drug({ priceCost: 8.5, priceSell: 15 })];
  const d1 = new Date(2026, 7, 30, 10, 0).getTime();
  const d2 = new Date(2026, 7, 31, 9, 0).getTime();
  const records = [
    rec({ qty: 2, priceSell: 15, createdAt: d1 }),
    rec({ qty: 1, priceSell: 15, createdAt: d1 }),
    rec({ qty: 3, priceSell: 15, createdAt: d2 })
  ];
  const rows = Stats.groupByDay(records, drugs);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].day, '2026-08-30');
  assert.strictEqual(rows[0].qty, 3);
  assert.strictEqual(rows[0].salesCents, 4500);
  assert.strictEqual(rows[0].costCents, 2550);
  assert.strictEqual(rows[0].profitCents, 1950);
  assert.strictEqual(rows[1].day, '2026-08-31');
  assert.strictEqual(rows[1].salesCents, 4500);
});

test('按天汇总含耗材售卖（AC44）', () => {
  const drugs = [drug({ id: 'd_a', priceCost: 8.5, priceSell: 15 })];
  const consumables = [consumable({ id: 'c_x', priceCost: 3, priceSell: 5 })];
  const d1 = new Date(2026, 7, 30, 10, 0).getTime();
  const records = [
    rec({ drugId: 'd_a', qty: 2, priceSell: 15, createdAt: d1 }),
    cRec({ consumableId: 'c_x', qty: 3, priceSell: 5, createdAt: d1 })
  ];
  const rows = Stats.groupByDay(records, drugs, consumables);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].qty, 5);
  assert.strictEqual(rows[0].salesCents, 4500);
  assert.strictEqual(rows[0].costCents, 2600); // 8.5×2 + 3×3
});

/* ---------- 按药品（AC29，v2 行为保留） ---------- */

test('按药品汇总：聚合、已删除/无进价药品（AC29）', () => {
  const drugs = [drug({ id: 'd_a', priceCost: 8.5, priceSell: 15 })];
  const records = [
    rec({ drugId: 'd_a', qty: 2, priceSell: 15 }),
    rec({ drugId: 'd_a', qty: 1, priceSell: 15 }),
    rec({ drugId: 'd_gone', name: '已删除药', spec: 'x', unit: '盒', qty: 4, priceSell: 10 })
  ];
  const rows = Stats.groupByDrug(records, drugs);
  assert.strictEqual(rows.length, 2);

  const a = rows.find((r) => r.drugId === 'd_a');
  assert.strictEqual(a.qty, 3);
  assert.strictEqual(a.salesCents, 4500);
  assert.strictEqual(a.costCents, 2550);
  assert.strictEqual(a.hasCost, true);
  assert.strictEqual(a.profitCents, 1950);

  const gone = rows.find((r) => r.drugId === 'd_gone');
  assert.strictEqual(gone.hasCost, false);
  assert.strictEqual(gone.costCents, 0);
  assert.strictEqual(gone.profitCents, null); // 毛利无法计算
  assert.strictEqual(gone.salesCents, 4000);
  assert.strictEqual(gone.name, '已删除药');   // 快照兜底
});

/* ---------- 按条目（AC44：药品 + 耗材，标注类型） ---------- */

test('按条目汇总：药品与耗材分列、标注类型（AC44）', () => {
  const drugs = [drug({ id: 'd_a', priceCost: 8.5, priceSell: 15 })];
  const consumables = [consumable({ id: 'c_x', priceCost: 3, priceSell: 5 })];
  const records = [
    rec({ drugId: 'd_a', qty: 2, priceSell: 15 }),
    rec({ drugId: 'd_a', qty: 1, priceSell: 15 }),
    cRec({ consumableId: 'c_x', qty: 3, priceSell: 5 })
  ];
  const rows = Stats.groupByItem(records, drugs, consumables);
  assert.strictEqual(rows.length, 2);

  const d = rows.find((r) => r.type === 'drug');
  assert.strictEqual(d.itemId, 'd_a');
  assert.strictEqual(d.qty, 3);
  assert.strictEqual(d.salesCents, 4500);
  assert.strictEqual(d.costCents, 2550);
  assert.strictEqual(d.hasCost, true);
  assert.strictEqual(d.profitCents, 1950);

  const c = rows.find((r) => r.type === 'consumable');
  assert.strictEqual(c.itemId, 'c_x');
  assert.strictEqual(c.qty, 3);
  assert.strictEqual(c.salesCents, 1500);
  assert.strictEqual(c.costCents, 900);
  assert.strictEqual(c.profitCents, 600);
});

test('按条目汇总：已删除耗材的记录仍显示、成本「—」（D13/AC44）', () => {
  const records = [
    cRec({ consumableId: 'c_gone', name: '已删纱布', unit: '卷', qty: 2, priceSell: 5 })
  ];
  const rows = Stats.groupByItem(records, [], []);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].type, 'consumable');
  assert.strictEqual(rows[0].hasCost, false);
  assert.strictEqual(rows[0].profitCents, null);
  assert.strictEqual(rows[0].salesCents, 1000);
  assert.strictEqual(rows[0].name, '已删纱布'); // 快照兜底
});

test('按条目排序：null（无成本毛利）恒排最后（AC29）', () => {
  const rows = [
    { drugId: 'a', profitCents: 100, salesCents: 300 },
    { drugId: 'b', profitCents: null, salesCents: 500 },
    { drugId: 'c', profitCents: 50, salesCents: 200 }
  ];
  assert.deepStrictEqual(Stats.sortBy(rows, 'profitCents', false).map((r) => r.drugId), ['c', 'a', 'b']);
  assert.deepStrictEqual(Stats.sortBy(rows, 'profitCents', true).map((r) => r.drugId), ['a', 'c', 'b']);
  assert.deepStrictEqual(Stats.sortBy(rows, 'salesCents', true).map((r) => r.drugId), ['b', 'a', 'c']);
});

/* ---------- 耗材使用统计（US-11 / AC38） ---------- */

test('耗材总使用量 = Σ 操作明细 qty（AC38）', () => {
  const ops = [
    op({ items: [
      { consumableId: 'c_x', name: '医用纱布', unit: '卷', qty: 2 },
      { consumableId: 'c_y', name: '棉签', unit: '包', qty: 1 }
    ] }),
    op({ items: [{ consumableId: 'c_x', name: '医用纱布', unit: '卷', qty: 3 }] }),
    op({ items: [] })
  ];
  assert.strictEqual(Stats.consumableUsage(ops), 6);
  assert.strictEqual(Stats.consumableUsage([]), 0);
});

test('按日期汇总耗材使用量：分组升序', () => {
  const d1 = new Date(2026, 7, 30, 10, 0).getTime();
  const d2 = new Date(2026, 7, 31, 9, 0).getTime();
  const ops = [
    op({ items: [{ consumableId: 'c_x', qty: 2 }], createdAt: d1 }),
    op({ items: [{ consumableId: 'c_x', qty: 1 }], createdAt: d1 }),
    op({ items: [{ consumableId: 'c_x', qty: 4 }], createdAt: d2 })
  ];
  const rows = Stats.groupUsageByDay(ops);
  assert.deepStrictEqual(rows, [
    { day: '2026-08-30', qty: 3 },
    { day: '2026-08-31', qty: 4 }
  ]);
});

test('按耗材汇总使用量：聚合 + 快照兜底（已删除耗材）', () => {
  const consumables = [consumable({ id: 'c_x', name: '医用纱布', unit: '卷' })];
  const ops = [
    op({ items: [
      { consumableId: 'c_x', name: '医用纱布', unit: '卷', qty: 2 },
      { consumableId: 'c_gone', name: '已删棉签', unit: '包', qty: 1 }
    ] }),
    op({ items: [{ consumableId: 'c_x', name: '医用纱布', unit: '卷', qty: 3 }] })
  ];
  const rows = Stats.groupUsageByItem(ops, consumables);
  assert.strictEqual(rows.length, 2);
  const gauze = rows.find((r) => r.consumableId === 'c_x');
  assert.strictEqual(gauze.name, '医用纱布'); // 取当前耗材
  assert.strictEqual(gauze.qty, 5);
  const gone = rows.find((r) => r.consumableId === 'c_gone');
  assert.strictEqual(gone.name, '已删棉签');   // 快照兜底
  assert.strictEqual(gone.unit, '包');
  assert.strictEqual(gone.qty, 1);
});

test('使用量可排序（sortBy 通用）', () => {
  const rows = [
    { consumableId: 'a', qty: 3, name: 'A' },
    { consumableId: 'b', qty: 8, name: 'B' },
    { consumableId: 'c', qty: 1, name: 'C' }
  ];
  assert.deepStrictEqual(Stats.sortBy(rows, 'qty', true).map((r) => r.consumableId), ['b', 'a', 'c']);
  assert.deepStrictEqual(Stats.sortBy(rows, 'qty', false).map((r) => r.consumableId), ['c', 'a', 'b']);
});

/* ---------- 分位精度与格式化（§7 风险） ---------- */

test('分位精度：0.1×3 = ¥0.30，无浮点误差（§7）', () => {
  const s = Stats.summary([rec({ priceSell: 0.1, qty: 3 })], [drug({ priceCost: 0.1 })]);
  assert.strictEqual(s.salesCents, 30);
  assert.strictEqual(s.costCents, 30);
  assert.strictEqual(Stats.fmtYuan(s.salesCents), '0.30');
  assert.strictEqual(Stats.toCents(0.1) * 3, 30);
  assert.strictEqual(Stats.toCents(15) * 2, 3000);
});

test('fmtYuan：分 → 元字符串（两位小数）', () => {
  assert.strictEqual(Stats.fmtYuan(0), '0.00');
  assert.strictEqual(Stats.fmtYuan(5), '0.05');
  assert.strictEqual(Stats.fmtYuan(100), '1.00');
  assert.strictEqual(Stats.fmtYuan(1234), '12.34');
  assert.strictEqual(Stats.fmtYuan(-1000), '-10.00');
  assert.strictEqual(Stats.toCents(null), 0);
  assert.strictEqual(Stats.toCents(undefined), 0);
});
