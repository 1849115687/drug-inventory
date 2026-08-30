/**
 * stats.js — 销售/成本/毛利统计 + 耗材使用统计聚合（纯函数，不依赖 DOM，可单测）
 *
 * 销售统计口径（design.md §3.3 / D13 / AC27~AC29 / AC44）：
 *   销售额 = Σ 售价 × 数量（售价取销售记录中的快照 priceSell；未设置售价的记录不计入）
 *   成本   = Σ 进价 × 数量（进价取统计时药品/耗材当前 priceCost；记录类型由 rec.type 区分，
 *            药品查 drugId、耗材查 consumableId；未设置售价 / 条目已删除 / 未设置进价 的记录不计入成本）
 *   毛利   = 销售额 − 成本；毛利率 = 毛利 ÷ 销售额（销售额为 0 → null，界面显示「—」）
 * 说明：已删除或无进价条目的销售额仍计入销售额（售价有快照），但其成本缺失，
 * 其毛利无法完整计算（按条目视图中显示「—」，界面注明口径）。
 *
 * 耗材使用统计口径（US-11 / AC38）：使用量 = Σ(操作明细 qty)（含已删除耗材的历史操作快照）。
 *
 * 金额一律以「分」为单位（整数）计算，展示时还原为元（design.md §7 风险缓解）。
 *
 * 浏览器中通过 <script> 加载，暴露全局 Stats；node 中可 require。
 */
(function (global) {
  'use strict';

  /** 元 → 分（整数）。无价格/非法值 → 0。 */
  function toCents(price) {
    var n = Number(price);
    if (!isFinite(n) || n <= 0) return 0;
    return Math.round(n * 100);
  }

  /** 分 → 元字符串（两位小数，如 1234 → '12.34'；负数 → '-10.00'）。 */
  function fmtYuan(cents) {
    var c = Math.round(Number(cents) || 0);
    var sign = c < 0 ? '-' : '';
    var abs = Math.abs(c);
    function p2(n) { return n < 10 ? '0' + n : '' + n; }
    return sign + Math.floor(abs / 100) + '.' + p2(abs % 100);
  }

  function indexById(list) {
    var m = {};
    (Array.isArray(list) ? list : []).forEach(function (x) {
      if (x && x.id) m[x.id] = x;
    });
    return m;
  }

  function indexDrugs(drugs) { return indexById(drugs); }
  function indexConsumables(consumables) { return indexById(consumables); }

  /** 记录类型：耗材 → 'consumable'；旧记录（无 type）/药品 → 'drug'。 */
  function recType(rec) {
    return rec && rec.type === 'consumable' ? 'consumable' : 'drug';
  }

  /** 单条记录对销售额的贡献（分）；无售价快照 → 0。 */
  function recordSalesCents(rec) {
    if (!rec || rec.priceSell == null) return 0;
    return toCents(rec.priceSell) * Number(rec.qty || 0);
  }

  /** 单条记录对成本的贡献（分）；需 有售价快照 + 对应条目存在 + 有当前进价（D13）。 */
  function recordCostCents(rec, drug, consumable) {
    if (!rec || rec.priceSell == null) return 0;
    var src = recType(rec) === 'consumable' ? consumable : drug;
    if (!src || src.priceCost == null) return 0;
    return toCents(src.priceCost) * Number(rec.qty || 0);
  }

  /** 汇总条目的成本来源（按条目视图 hasCost 用）：耗材查 consumable，药品查 drug。 */
  function recordCostSource(rec, drugs, consumables) {
    if (recType(rec) === 'consumable') {
      return rec.consumableId != null ? consumables[rec.consumableId] : null;
    }
    return rec.drugId != null ? drugs[rec.drugId] : null;
  }

  /**
   * 销售汇总（AC27 / AC44，含耗材售卖）：{ salesCents, costCents, profitCents, margin }。
   * margin = 毛利 ÷ 销售额（比率）；销售额为 0 时 margin 为 null（界面显示「—」）。
   */
  function summary(records, drugs, consumables) {
    var byId = indexDrugs(drugs);
    var byCid = indexConsumables(consumables);
    var salesCents = 0;
    var costCents = 0;
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      salesCents += recordSalesCents(rec);
      costCents += recordCostCents(rec, byId[rec.drugId], byCid[rec.consumableId]);
    });
    var profitCents = salesCents - costCents;
    return {
      salesCents: salesCents,
      costCents: costCents,
      profitCents: profitCents,
      margin: salesCents === 0 ? null : profitCents / salesCents
    };
  }

  /**
   * 按时间戳区间过滤（AC28）：保留 createdAt ∈ [startTs, endTs] 的记录（含边界）。
   * startTs / endTs 为毫秒时间戳；null 表示不设边界。销售记录与操作记录（均有 createdAt）通用。
   */
  function filterByDate(records, startTs, endTs) {
    return (Array.isArray(records) ? records : []).filter(function (rec) {
      var t = rec.createdAt;
      if (t == null) return false;
      if (startTs != null && t < startTs) return false;
      if (endTs != null && t > endTs) return false;
      return true;
    });
  }

  function dayKey(ts) {
    var d = new Date(ts);
    function p(n) { return n < 10 ? '0' + n : '' + n; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 按天汇总（销售，AC28）：{ day, qty, salesCents, costCents, profitCents }，按日期升序。 */
  function groupByDay(records, drugs, consumables) {
    var byId = indexDrugs(drugs);
    var byCid = indexConsumables(consumables);
    var map = {};
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      if (rec.createdAt == null) return;
      var k = dayKey(rec.createdAt);
      var row = map[k];
      if (!row) {
        row = map[k] = { day: k, qty: 0, salesCents: 0, costCents: 0 };
      }
      row.qty += Number(rec.qty || 0);
      row.salesCents += recordSalesCents(rec);
      row.costCents += recordCostCents(rec, byId[rec.drugId], byCid[rec.consumableId]);
    });
    return Object.keys(map).sort().map(function (k) {
      var row = map[k];
      row.profitCents = row.salesCents - row.costCents;
      return row;
    });
  }

  /**
   * 按药品汇总（AC29，药品维度，保留 v2 行为）：每行 { drugId, name, spec, unit, qty,
   * salesCents, costCents, hasCost, profitCents }。hasCost=false（药品已删除或当前未设置进价）
   * 时 costCents 恒为 0、profitCents 为 null（界面显示「—」）。
   * name / spec / unit 优先取当前药品，缺失时取记录快照（删除后仍可读）。
   */
  function groupByDrug(records, drugs) {
    var byId = indexDrugs(drugs);
    var map = {};
    var order = [];
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      if (!rec || rec.drugId == null) return;
      var row = map[rec.drugId];
      if (!row) {
        var drug = byId[rec.drugId];
        row = map[rec.drugId] = {
          drugId: rec.drugId,
          name: (drug && drug.name) || rec.name || '',
          spec: (drug && drug.spec) || rec.spec || '',
          unit: (drug && drug.unit) || rec.unit || '',
          qty: 0,
          salesCents: 0,
          costCents: 0,
          hasCost: !!(drug && drug.priceCost != null),
          profitCents: null
        };
        order.push(rec.drugId);
      }
      row.qty += Number(rec.qty || 0);
      row.salesCents += recordSalesCents(rec);
      row.costCents += recordCostCents(rec, byId[rec.drugId], null);
    });
    return order.map(function (id) {
      var row = map[id];
      row.profitCents = row.hasCost ? row.salesCents - row.costCents : null;
      return row;
    });
  }

  /**
   * 按条目汇总（AC44，药品+耗材一起，标注类型）：每行 { itemId, type:'drug'|'consumable',
   * name, spec, unit, qty, salesCents, costCents, hasCost, profitCents }。
   * 条目 id 同时充当分组键（药品 drugId / 耗材 consumableId）；已删除条目的记录仍显示
   * （名称/单位取快照，hasCost=false，成本/毛利显示「—」，D13）。
   */
  function groupByItem(records, drugs, consumables) {
    var byId = indexDrugs(drugs);
    var byCid = indexConsumables(consumables);
    var map = {};
    var order = [];
    (Array.isArray(records) ? records : []).forEach(function (rec) {
      if (!rec) return;
      var type = recType(rec);
      var key = type === 'consumable' ? rec.consumableId : rec.drugId;
      if (key == null) return;
      var row = map[key];
      if (!row) {
        var src = type === 'consumable' ? byCid[key] : byId[key];
        row = map[key] = {
          itemId: key,
          type: type,
          name: (src && src.name) || rec.name || '',
          spec: (src && src.spec) || rec.spec || '',
          unit: (src && src.unit) || rec.unit || '',
          qty: 0,
          salesCents: 0,
          costCents: 0,
          hasCost: !!(src && src.priceCost != null),
          profitCents: null
        };
        order.push(key);
      }
      row.qty += Number(rec.qty || 0);
      row.salesCents += recordSalesCents(rec);
      row.costCents += recordCostCents(rec, byId[rec.drugId], byCid[rec.consumableId]);
    });
    return order.map(function (key) {
      var row = map[key];
      row.profitCents = row.hasCost ? row.salesCents - row.costCents : null;
      return row;
    });
  }

  /** 排序（表头排序用）：按 key 升/降序；null/undefined（如无成本行的毛利）恒排最后。 */
  function sortBy(rows, key, desc) {
    var arr = (Array.isArray(rows) ? rows : []).slice();
    arr.sort(function (a, b) {
      var av = a[key];
      var bv = b[key];
      var aNull = av === null || av === undefined;
      var bNull = bv === null || bv === undefined;
      if (aNull && bNull) return 0;
      if (aNull) return 1;
      if (bNull) return -1;
      var cmp = av < bv ? -1 : av > bv ? 1 : 0;
      return desc ? -cmp : cmp;
    });
    return arr;
  }

  /* ---------- 耗材使用统计（US-11 / AC38） ---------- */

  /** 单条操作明细的数量（容错：缺省 0）。 */
  function itemQty(it) {
    var n = Number(it && it.qty);
    return isFinite(n) ? n : 0;
  }

  /** 一批操作的总使用量 = Σ(操作明细 qty)（AC38）。 */
  function consumableUsage(ops) {
    var total = 0;
    (Array.isArray(ops) ? ops : []).forEach(function (op) {
      (Array.isArray(op.items) ? op.items : []).forEach(function (it) {
        total += itemQty(it);
      });
    });
    return total;
  }

  /** 按日期汇总耗材使用量：{ day, qty }，日期升序（US-11 按日期查看）。 */
  function groupUsageByDay(ops) {
    var map = {};
    (Array.isArray(ops) ? ops : []).forEach(function (op) {
      if (op.createdAt == null) return;
      var k = dayKey(op.createdAt);
      var row = map[k];
      if (!row) row = map[k] = { day: k, qty: 0 };
      (Array.isArray(op.items) ? op.items : []).forEach(function (it) {
        row.qty += itemQty(it);
      });
    });
    return Object.keys(map).sort().map(function (k) { return map[k]; });
  }

  /**
   * 按耗材汇总使用量（US-11 按耗材查看，可排序）：每行 { consumableId, name, unit, qty }。
   * name / unit 优先取当前耗材，缺失时取操作明细快照（删除后仍可读，D16）。
   */
  function groupUsageByItem(ops, consumables) {
    var byId = indexConsumables(consumables);
    var map = {};
    var order = [];
    (Array.isArray(ops) ? ops : []).forEach(function (op) {
      (Array.isArray(op.items) ? op.items : []).forEach(function (it) {
        if (!it || it.consumableId == null) return;
        var row = map[it.consumableId];
        if (!row) {
          var c = byId[it.consumableId];
          row = map[it.consumableId] = {
            consumableId: it.consumableId,
            name: (c && c.name) || it.name || '',
            unit: (c && c.unit) || it.unit || '',
            qty: 0
          };
          order.push(it.consumableId);
        }
        row.qty += itemQty(it);
      });
    });
    return order.map(function (id) { return map[id]; });
  }

  var Stats = {
    toCents: toCents,
    fmtYuan: fmtYuan,
    summary: summary,
    filterByDate: filterByDate,
    groupByDay: groupByDay,
    groupByDrug: groupByDrug,
    groupByItem: groupByItem,
    sortBy: sortBy,
    consumableUsage: consumableUsage,
    groupUsageByDay: groupUsageByDay,
    groupUsageByItem: groupUsageByItem
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Stats;
  }
  global.Stats = Stats;
})(typeof window !== 'undefined' ? window : globalThis);
