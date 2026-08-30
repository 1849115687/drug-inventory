/**
 * parser.js 单元测试 —— 规则唯一权威：design.md §3.5
 * 运行：node --test tests/
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert');
const Parser = require('../js/parser.js');

/** 构造测试药品 */
function drug(overrides) {
  return Object.assign({
    id: 'd_' + Math.random().toString(36).slice(2, 8),
    name: '阿莫西林胶囊',
    spec: '0.25g*24粒',
    unit: '盒',
    stock: 10,
    threshold: 5
  }, overrides || {});
}

/* ---------- 匹配（§3.5 第 1 条 + D7） ---------- */

test('精确匹配：行以药品名开头', () => {
  const d = drug();
  const m = Parser.matchDrug('阿莫西林胶囊 x2', [d]);
  assert.ok(m);
  assert.strictEqual(m.drug.id, d.id);
  assert.strictEqual(m.matchStart, 0);
});

test('名称包含：药品名不在行首也能匹配', () => {
  const d = drug({ name: '布洛芬缓释胶囊' });
  const m = Parser.matchDrug('购：布洛芬缓释胶囊 2盒', [d]);
  assert.ok(m);
  assert.strictEqual(m.drug.id, d.id);
});

test('无匹配 → null', () => {
  const m = Parser.matchDrug('维生素C片 100mg', [drug()]);
  assert.strictEqual(m, null);
});

test('多个候选：名称更长者胜', () => {
  const short = drug({ id: 'd_short', name: '阿莫西林' });
  const long = drug({ id: 'd_long', name: '阿莫西林胶囊' });
  const m = Parser.matchDrug('阿莫西林胶囊 x2', [short, long]);
  assert.strictEqual(m.drug.id, 'd_long');
});

test('同名不同规格：规格出现在行中者胜', () => {
  const a = drug({ id: 'd_a', name: '阿莫西林胶囊', spec: '0.25g*24粒' });
  const b = drug({ id: 'd_b', name: '阿莫西林胶囊', spec: '0.5g*12粒' });
  const m = Parser.matchDrug('阿莫西林胶囊 0.5g*12粒 x1', [a, b]);
  assert.strictEqual(m.drug.id, 'd_b');
});

test('精确匹配优先于名称包含（D7 策略顺序）', () => {
  const exactDrug = drug({ id: 'd_exact', name: '阿莫西林颗粒' });
  const containedDrug = drug({ id: 'd_contained', name: '阿莫西林胶囊' });
  // "阿莫西林颗粒" 在行首（精确）；"阿莫西林胶囊" 出现在后面（包含）
  const m = Parser.matchDrug('阿莫西林颗粒 阿莫西林胶囊 x2', [exactDrug, containedDrug]);
  assert.strictEqual(m.drug.id, 'd_exact');
});

test('空白归一化：全角空格不影响匹配', () => {
  const d = drug();
  const m = Parser.matchDrug('阿莫西林胶囊\u3000x2', [d]);
  assert.ok(m);
});

/* ---------- 数量提取（§3.5 第 2/3/4 条） ---------- */

test('显式模式 x/×/* + 正整数', () => {
  assert.strictEqual(Parser.extractQuantity('x2'), 2);
  assert.strictEqual(Parser.extractQuantity('×1'), 1);
  assert.strictEqual(Parser.extractQuantity('*3'), 3);
  assert.strictEqual(Parser.extractQuantity('X2'), 2); // 大写不区分
});

test('<正整数><数量单位>', () => {
  assert.strictEqual(Parser.extractQuantity('2盒'), 2);
  assert.strictEqual(Parser.extractQuantity('3瓶'), 3);
  assert.strictEqual(Parser.extractQuantity('1支'), 1);
  assert.strictEqual(Parser.extractQuantity('5袋'), 5);
  assert.strictEqual(Parser.extractQuantity('10片'), 10);
  assert.strictEqual(Parser.extractQuantity('4粒'), 4);
  assert.strictEqual(Parser.extractQuantity('2包'), 2);
});

test('数量[:：]<正整数>', () => {
  assert.strictEqual(Parser.extractQuantity('数量:2'), 2);
  assert.strictEqual(Parser.extractQuantity('数量：2'), 2);
});

test('兜底：第一个独立整数', () => {
  assert.strictEqual(Parser.extractQuantity('2'), 2);
  assert.strictEqual(Parser.extractQuantity('本次 3 件'), 3);
});

test('全部失败 → 默认 1', () => {
  assert.strictEqual(Parser.extractQuantity(''), 1);
  assert.strictEqual(Parser.extractQuantity('无数量信息'), 1);
});

test('优先级：显式模式 > 整数+单位 > 数量: > 兜底', () => {
  assert.strictEqual(Parser.extractQuantity('2盒 x3'), 3);        // 显式模式优先
  assert.strictEqual(Parser.extractQuantity('数量:2 3盒'), 3);     // 整数+单位优先于 数量:
  assert.strictEqual(Parser.extractQuantity('x2 3'), 2);          // 显式优先于兜底
});

test('规格跳过：0.25g*24粒 中的 *24 不被当作数量', () => {
  // §3.5 第 3 条意图：规格数字不参与数量判定
  assert.strictEqual(Parser.extractQuantity('0.25g*24粒 x2', '0.25g*24粒'), 2);
  assert.strictEqual(Parser.extractQuantity('0.25g*24粒', '0.25g*24粒'), 1);
});

test('数量合法性：0 / 负数 / 小数 → 未命中，走默认', () => {
  assert.strictEqual(Parser.extractQuantity('x0'), 1);        // 0 非法
  assert.strictEqual(Parser.extractQuantity('-2'), 1);        // 负数非法
  assert.strictEqual(Parser.extractQuantity('x-2'), 1);       // 负数非法（显式模式）
  assert.strictEqual(Parser.extractQuantity('0.25'), 1);      // 小数（0 的整数部分非法）
});

test('金额整数部分例外：12.50 → 12（§3.5 例外条款）', () => {
  assert.strictEqual(Parser.extractQuantity('12.50'), 12);
  assert.strictEqual(Parser.extractQuantity('¥12.50'), 12);
});

test('小数数量 1.5盒 → 不作为数量，兜底取整数部分 1', () => {
  // "5盒" 是小数 "1.5" 的组成部分 → 跳过；兜底整数部分 1
  assert.strictEqual(Parser.extractQuantity('1.5盒'), 1);
});

test('多个整数：取最靠近药品名的第一个', () => {
  // "2" 在 "12.50" 之前，取 2
  assert.strictEqual(Parser.extractQuantity('2 12.50'), 2);
  assert.strictEqual(Parser.extractQuantity('3 件 12.50'), 3);
});

/* ---------- 整行解析（parseSalesText） ---------- */

test('整行解析：匹配行与未匹配行', () => {
  const d = drug();
  const rows = Parser.parseSalesText('阿莫西林胶囊 0.25g*24粒 x2\n维生素C片 100mg\n', [d]);
  assert.strictEqual(rows.length, 2);
  assert.strictEqual(rows[0].matched, true);
  assert.strictEqual(rows[0].drugId, d.id);
  assert.strictEqual(rows[0].qty, 2);
  assert.strictEqual(rows[0].name, d.name);
  assert.strictEqual(rows[1].matched, false);
  assert.strictEqual(rows[1].drugId, null);
  assert.strictEqual(rows[1].raw, '维生素C片 100mg');
});

test('整行解析：药品名之前的数字不参与数量判定', () => {
  const d = drug();
  const rows = Parser.parseSalesText('2026-08-29 阿莫西林胶囊 x2', [d]);
  assert.strictEqual(rows[0].qty, 2);
});

test('整行解析：空行/纯空白行被忽略', () => {
  const rows = Parser.parseSalesText('阿莫西林胶囊 x1\n\n   \n', [drug()]);
  assert.strictEqual(rows.length, 1);
});

test('整行解析：无匹配行不提取数量，qty 占位 1', () => {
  const rows = Parser.parseSalesText('未知药品 5盒', [drug()]);
  assert.strictEqual(rows[0].matched, false);
  assert.strictEqual(rows[0].qty, 1);
});

test('整行解析：规格在行中时正确跳过', () => {
  const d = drug({ spec: '0.25g*24粒' });
  const rows = Parser.parseSalesText('阿莫西林胶囊 0.25g*24粒 x2', [d]);
  assert.strictEqual(rows[0].qty, 2);
});
