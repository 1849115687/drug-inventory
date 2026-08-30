/**
 * parser.js — OCR 文本行解析与药品匹配（纯函数，不依赖 DOM）
 *
 * 解析规则唯一权威来源：design.md §3.5。本模块不另立规则。
 *
 * 浏览器中通过 <script> 加载，暴露全局 Parser；node 中可 require。
 */
(function (global) {
  'use strict';

  /** 数量单位（§3.5 显式模式 <正整数><数量单位>） */
  var UNITS = ['盒', '瓶', '支', '袋', '片', '粒', '包'];

  /** 归一化：去全部空白（含全角空格）、ASCII 转小写。 */
  function normalize(s) {
    return String(s == null ? '' : s).replace(/\s+/g, '').toLowerCase();
  }

  /**
   * 归一化并记录字符在原串中的下标映射。
   * @returns {{text:string, idx:number[]}} idx[n] = 归一化后第 n 个字符在原串中的下标
   */
  function normWithMap(s) {
    s = String(s == null ? '' : s);
    var text = '';
    var idx = [];
    for (var i = 0; i < s.length; i++) {
      var c = s[i];
      if (/\s/.test(c)) continue;
      text += c.toLowerCase();
      idx.push(i);
    }
    return { text: text, idx: idx };
  }

  /** 正则转义（用于按规格文本构造匹配正则） */
  function escapeRegex(c) {
    return c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /** 在给定（已归一化）文本上执行匹配逻辑 */
  function matchDrugText(nl, drugs) {
    if (!nl || !Array.isArray(drugs) || drugs.length === 0) return null;

    var exact = [];
    var contains = [];
    for (var i = 0; i < drugs.length; i++) {
      var d = drugs[i];
      var dname = normalize(d.name);
      if (!dname) continue;
      var pos = nl.indexOf(dname);
      if (pos === 0) {
        exact.push({ drug: d, start: 0 });
      } else if (pos > 0) {
        contains.push({ drug: d, start: pos });
      }
    }

    function pick(list) {
      if (!list.length) return null;
      // 规格出现在行中 → 优先（同名称不同规格的消歧）
      var withSpec = list.filter(function (m) {
        return m.drug.spec && nl.indexOf(normalize(m.drug.spec)) >= 0;
      });
      var pool = withSpec.length ? withSpec : list;
      pool.sort(function (a, b) {
        var la = normalize(a.drug.name).length;
        var lb = normalize(b.drug.name).length;
        if (la !== lb) return lb - la;
        var sa = normalize(a.drug.spec || '').length;
        var sb = normalize(b.drug.spec || '').length;
        if (sa !== sb) return sb - sa;
        return 0; // 稳定排序保持插入顺序
      });
      return pool[0];
    }

    var m = pick(exact) || pick(contains);
    return m ? { drug: m.drug, matchStart: m.start } : null;
  }

  /**
   * 药品匹配（策略 D7：精确 → 名称包含 → 无匹配返回 null）。
   * 精确 = 行文本以药品名开头；名称包含 = 药品名出现在行中（非开头）。
   * 候选池内偏好：规格出现在行中 → 名称更长 → 规格更长 → 保持插入顺序。
   * @param {string} line OCR 行文本
   * @param {Array} drugs 药品数组（含 id/name/spec/unit/stock/threshold）
   * @returns {{drug:object, matchStart:number}|null}
   *   matchStart 为归一化文本中药品名起始位置。
   */
  function matchDrug(line, drugs) {
    return matchDrugText(normalize(line), drugs);
  }

  /**
   * 提取数量（§3.5 第 2/3/4 条）。
   * 仅从「药品名匹配位置之后」的文本提取；按优先级取第一个命中：
   *   1) 显式模式 x/×/* + 正整数（不区分大小写）
   *   2) <正整数><数量单位>，单位 ∈ {盒,瓶,支,袋,片,粒,包}
   *   3) 数量[:：]<正整数>
   *   4) 兜底：第一个独立整数（§3.5 例外：金额小数取其整数部分，如 12.50 → 12）
   *   5) 全部失败 → 默认 1
   * 数量仅接受正整数：0、负数、小数均视为未命中，落入后续规则。
   *
   * 在保留空白的前提下提取（数字与单位/符号之间的空白是有效分隔，
   * 全部去除会把 "2 12.50" 合并成 "212.50" 导致误判）。
   * @param {string} afterText 药品名之后的文本（保留原始空白）
   * @param {string} [drugSpec] 已匹配药品的规格；若出现在文本中则跳过
   *   （允许规格内部存在空白），避免把规格里的数字（如 0.25g*24粒 的 *24）误判为数量。
   * @returns {number} 正整数数量（默认 1）
   */
  function extractQuantity(afterText, drugSpec) {
    var t = String(afterText == null ? '' : afterText);

    // 规格跳过：规格出现时整体剔除，防止 *24 / 24粒 等规格数字干扰
    if (drugSpec) {
      var spec = String(drugSpec).trim();
      if (spec) {
        var re = new RegExp(spec.split('').map(escapeRegex).join('\\s*'), 'i');
        var sm = re.exec(t);
        if (sm) {
          t = t.slice(0, sm.index) + t.slice(sm.index + sm[0].length);
        }
      }
    }
    if (!t.trim()) return 1;

    // 1) 显式模式：x / × / * + 正整数（大小写不敏感）
    var m1 = t.match(/[x×*]\s*([1-9]\d*)/i);
    if (m1) return parseInt(m1[1], 10);

    // 2) <正整数><数量单位>
    var re2 = /(\d+)(盒|瓶|支|袋|片|粒|包)/g;
    var m2;
    while ((m2 = re2.exec(t)) !== null) {
      if (m2.index > 0 && (t[m2.index - 1] === '.' || t[m2.index - 1] === '-' || t[m2.index - 1] === '－')) {
        continue; // 小数/负数的组成部分，视为未命中
      }
      var n2 = parseInt(m2[1], 10);
      if (n2 > 0) return n2;
    }

    // 3) 数量[:：]<正整数>
    var m3 = t.match(/数量[:：]\s*([1-9]\d*)/);
    if (m3) return parseInt(m3[1], 10);

    // 4) 兜底：第一个独立整数
    //    独立 = 前一个字符不是 '.'（小数部分）或 '-'/'－'（负数）；
    //    金额小数取其整数部分（§3.5：金额整数部分除外），如 "12.50" → 12。
    var re4 = /\d+/g;
    var m4;
    while ((m4 = re4.exec(t)) !== null) {
      var prev = m4.index > 0 ? t[m4.index - 1] : '';
      if (prev === '.' || prev === '-' || prev === '－') continue;
      var n4 = parseInt(m4[0], 10);
      if (n4 > 0) return n4;
    }

    return 1; // 5) 默认
  }

  /**
   * 解析 OCR 多行文本 → 确认列表行（§3.5）。
   * @param {string} text Tesseract 输出的原始文本
   * @param {Array} drugs 药品数组
   * @returns {Array<object>} 每行：
   *   matched:boolean | drugId:string|null | name/spec/unit:string
   *   qty:number（未匹配行为占位 1）| raw:string（原始行，未匹配行显示用）
   */
  function parseSalesText(text, drugs) {
    var lines = String(text == null ? '' : text)
      .split(/\r?\n/)
      .map(function (l) { return l.trim(); })
      .filter(Boolean);

    return lines.map(function (line) {
      var nm = normWithMap(line);
      var m = matchDrugText(nm.text, drugs);
      if (!m) {
        // 无药品名匹配的行不提取数量，整体作为未匹配行处理（§3.5 第 3/5 条）
        return { matched: false, raw: line, drugId: null, name: '', spec: '', unit: '', qty: 1 };
      }
      // 映射回原始坐标，取药品名之后（含空白）的文本做数量提取
      var dname = normalize(m.drug.name);
      var startOrig = nm.idx[m.matchStart];
      var endOrig = nm.idx[m.matchStart + dname.length - 1] + 1;
      var afterText = line.slice(endOrig);
      var qty = extractQuantity(afterText, m.drug.spec);
      return {
        matched: true,
        raw: line,
        drugId: m.drug.id,
        name: m.drug.name,
        spec: m.drug.spec,
        unit: m.drug.unit,
        qty: qty
      };
    });
  }

  var Parser = {
    UNITS: UNITS,
    normalize: normalize,
    matchDrug: matchDrug,
    extractQuantity: extractQuantity,
    parseSalesText: parseSalesText
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = Parser;
  }
  global.Parser = Parser;
})(typeof window !== 'undefined' ? window : globalThis);
