/* 保底成本台 · ui.js —— 只负责读写界面、渲染、导出与持久化，算法全在 core.js */
(function () {
  'use strict';
  var C = window.AppCore;
  var STORE = 'pity-budget-v1';
  var APP = 'pity-budget';
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s === null || s === undefined ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function fx(v, d) { return C.fmt(v, d === undefined ? 2 : d); }
  function yi(v) { return '¥' + C.fmt(v, 2); }
  function y0(v) { return '¥' + C.fmt(v, 0); }
  function pc(v, d) { return C.pct(v, d === undefined ? 2 : d); }
  // 极小概率不要显示成 0.00%
  function pcTiny(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    if (v === 0) return '0%';
    if (v < 1e-6) return '约 ' + v.toExponential(2) + '（≈ 1/' + C.fmt(1 / v, 0) + '）';
    if (v < 0.0001) return C.pct(v, 6);
    return C.pct(v, 2);
  }

  var SCENES = [
    { key: 'hard90', label: '硬保底 90 抽（0.6%）', input: { cost: '12', rate: '0.6', mode: 'hard', pity: '90', softStart: '74', softStep: '6', targets: '1', budget: '1000' } },
    { key: 'soft90', label: '软保底（74 抽起 +6 个点）', input: { cost: '12', rate: '0.6', mode: 'soft', pity: '90', softStart: '74', softStep: '6', targets: '1', budget: '1000' } },
    { key: 'nopity', label: '无保底对照（0.5%）', input: { cost: '5', rate: '0.5', mode: 'none', pity: '', softStart: '', softStep: '', targets: '1', budget: '1000' } },
    { key: 'draw20', label: '小额抽奖（20 抽保底）', input: { cost: '2', rate: '3', mode: 'hard', pity: '20', softStart: '14', softStep: '6', targets: '1', budget: '60' } },
    { key: 'four', label: '要拿 4 个（硬保底 90）', input: { cost: '12', rate: '0.6', mode: 'hard', pity: '90', softStart: '74', softStep: '6', targets: '4', budget: '4000' } }
  ];
  var FIELDS = ['cost', 'rate', 'mode', 'pity', 'softStart', 'softStep', 'targets', 'budget'];
  var lastResult = null;

  function readInput() {
    var o = {};
    FIELDS.forEach(function (k) { var el = $(k); o[k] = el ? el.value : ''; });
    return o;
  }
  function writeInput(src) {
    FIELDS.forEach(function (k) { var el = $(k); if (el && src[k] !== undefined && src[k] !== null) el.value = src[k]; });
    syncMode();
  }
  function syncMode() {
    var m = $('mode').value;
    $('f-pity').style.display = (m === 'none') ? 'none' : '';
    $('f-softStart').style.display = (m === 'soft') ? '' : 'none';
    $('f-softStep').style.display = (m === 'soft') ? '' : 'none';
  }
  function renderPresets() {
    $('presets').innerHTML = SCENES.map(function (s, i) {
      return '<button type="button" class="mini" data-scene="' + esc(s.key) + '">' + esc(s.label) + '</button>';
    }).join('');
  }

  // ── 建议（每条都能作用回输入）──────────────────────────────
  function advice(r) {
    var out = [], t = r.total, c = r.input;
    if (c.mode !== 'none' && r.compare) {
      var dMean = 1 - t.meanCost / r.compare.meanCost;
      var p99cur = null;
      t.quants.forEach(function (q) { if (q.q === 0.99) p99cur = q; });
      var cmp99 = r.compare.p99 * c.cost;
      out.push({ cls: 'key', text: '同概率（' + fx(c.rate, 4) + '%）下，无保底要平均 ' + fx(r.compare.meanPulls, 1) + ' 抽（' + y0(r.compare.meanCost) + '），99% 把握要 ' + fx(r.compare.p99, 0) + ' 抽（' + y0(cmp99) + '）；这条保底把期望压到 ' + y0(t.meanCost) + '（降 ' + pc(dMean, 1) + '），把 99% 把握压到 ' + (p99cur ? (fx(p99cur.pulls, 0) + ' 抽（' + y0(p99cur.cost) + '，降 ' + pc(1 - p99cur.cost / cmp99, 1) + '）') : '—') + '。保底主要砍的是尾部，不是平均值。' });
    }
    if (r.pityHitRate !== null && r.pityHitRate > 1e-4) {
      out.push({ cls: r.pityHitRate > 0.5 ? 'warn' : 'info', text: '按这条规则，单个目标有 ' + pcTiny(r.pityHitRate) + ' 的概率要一直抽到第 ' + c.pity + ' 抽（保底）才出；最坏成本 ¥' + fx(t.worstCost, 0) + ' 就是这么来的。' });
    } else if (r.pityHitRate !== null) {
      out.push({ cls: 'ok', text: '按这条规则，抽满第 ' + c.pity + ' 抽的概率只有 ' + pcTiny(r.pityHitRate) + '（几乎不会发生）—— 出货几乎都发生在前面概率已经抬起来的那几抽上，最后一抽的兜底基本用不上。' });
    }
    var med = null;
    t.quants.forEach(function (q) { if (q.q === 0.5) med = q; });
    if (med && c.mode !== 'none' && med.pulls === t.worstPulls) {
      out.push({ cls: 'warn', text: '中位数（' + med.pulls + ' 抽）就等于最坏情况：超过一半的情况都是抽满保底才出。所以「平均 ' + fx(t.meanPulls, 1) + ' 抽」并不代表多数人的体验。' });
    } else if (med) {
      out.push({ cls: 'info', text: '一半人能在 ' + med.pulls + ' 抽（' + y0(med.cost) + '）内拿到，平均值是 ' + fx(t.meanPulls, 1) + ' 抽（' + y0(t.meanCost) + '）—— 平均值被少数很晚才出的情况拉高了。' });
    }
    if (c.mode === 'none') {
      var p99 = t.quants.filter(function (q) { return q.q === 0.99; })[0];
      out.push({ cls: 'act', text: '无保底口径下抽数没有上限：99% 分位要 ' + p99.pulls + ' 抽（' + y0(p99.cost) + '），是期望（' + y0(t.meanCost) + '）的 ' + fx(p99.cost / t.meanCost, 1) + ' 倍。没有「准备够了就一定能拿到」的金额。' });
    }
    if (r.budget) {
      var b = r.budget;
      if (b.prob >= 0.999999) {
        out.push({ cls: 'ok', text: '预算 ' + y0(b.amount) + ' 能买 ' + b.pulls + ' 抽，按这条规则一定拿得到（' + (c.mode === 'none' ? '但无保底口径下这只是本次截断范围内成立，抽数本身没有上限' : '因为已覆盖最坏情况 ' + t.worstPulls + ' 抽') + '）。' });
      } else if (b.prob < 0.5) {
        var need = t.quants.filter(function (q) { return q.q === 0.9; })[0];
        out.push({ cls: 'act', text: '预算 ' + y0(b.amount) + ' 只能买 ' + b.pulls + ' 抽，按这条规则拿到目标的概率是 ' + pc(b.prob) + ' —— 比一半还低。要做到 90% 把握，需要 ' + need.pulls + ' 抽，也就是 ' + y0(need.cost) + '。', action: { kind: 'budget', value: String(Math.ceil(need.cost)) , label: '把预算改成 ' + y0(Math.ceil(need.cost)) } });
      } else {
        out.push({ cls: 'info', text: '预算 ' + y0(b.amount) + ' 能买 ' + b.pulls + ' 抽，按这条规则拿到目标的概率是 ' + pc(b.prob) + '。' });
      }
      if (c.mode !== 'none' && b.prob < 1 && b.pulls >= t.meanPulls && b.prob < 0.6) {
        out.push({ cls: 'warn', text: '注意「期望成本」和「够不够」不是一回事：期望成本 ' + y0(t.meanCost) + ' 虽然低于预算 ' + y0(b.amount) + '，但达成概率只有 ' + pc(b.prob) + ' —— 因为一半以上的情况要花到 ' + (med ? y0(med.cost) : '—') + '。' });
      }
    }
    if (c.targets > 1) {
      var one = C.analyze({ cost: c.cost, rate: c.rate, mode: c.mode, pity: c.pity === null ? '' : String(c.pity), softStart: c.softStart === null ? '' : String(c.softStart), softStep: c.softStep === null ? '' : String(c.softStep), targets: '1', budget: '' });
      out.push({ cls: 'info', text: '现在要 ' + c.targets + ' 个：最坏要 ' + t.worstPulls + ' 抽（' + (t.worstCost === null ? '无上限' : y0(t.worstCost)) + '）。只要 1 个的话，期望成本 ' + y0(one.total.meanCost) + '，最坏 ' + (one.total.worstPulls === null ? '无上限' : y0(one.total.worstCost)) + '。', action: c.targets > 1 ? { kind: 'targets', value: '1', label: '改成只要 1 个' } : null });
    }
    return out.filter(function (x) { return x && x.text; });
  }

  // ── 渲染 ────────────────────────────────────────────────────
  function renderResult(r) {
    var t = r.total, c = r.input, h = [];
    var med = t.quants.filter(function (q) { return q.q === 0.5; })[0];
    var q90 = t.quants.filter(function (q) { return q.q === 0.9; })[0];

    h.push('<h2>这条规则下的成本分布</h2>');
    h.push('<div class="metric">达到目标平均要花 <strong>' + y0(t.meanCost) + '</strong>' +
      '<span class="sub">（约 ' + fx(t.meanPulls, 1) + ' 抽 × ' + y0(c.cost) + '）</span></div>');
    h.push('<p class="hint">' + (c.mode === 'none'
      ? '无保底口径：抽数没有上限。下面给出 50% / 75% / 90% / 95% / 99% 五档「把握」分别对应的抽数与金额，以及 99% 之后的尾巴。'
      : '保底口径：' + c.targets + ' 个目标最坏 ' + c.targets + ' × ' + c.pity + ' = ' + t.worstPulls + ' 抽，成本上限 ' + y0(t.worstCost) + '。') + '</p>');

    h.push('<div class="stats">');
    h.push('<div><strong>' + (med ? med.pulls + ' 抽' : '—') + '</strong><span>中位数：一半人在这么多抽内拿到' + (med ? '（' + y0(med.cost) + '）' : '') + '</span></div>');
    h.push('<div><strong>' + (q90 ? q90.pulls + ' 抽' : '—') + '</strong><span>90% 把握：九成人这么多抽内拿到' + (q90 ? '（' + y0(q90.cost) + '）' : '') + '</span></div>');
    h.push('<div><strong>' + (t.worstCost === null ? '无上限' : y0(t.worstCost)) + '</strong><span>' + (t.worstCost === null ? '无保底口径：抽数没有上限' : '最坏情况：' + t.worstPulls + ' 抽（抽满保底）') + '</span></div>');
    h.push('<div><strong>' + (r.pityHitRate === null ? '—' : pcTiny(r.pityHitRate)) + '</strong><span>' + (r.pityHitRate === null ? '无保底口径没有保底可抽满' : '单个目标要抽满第 ' + c.pity + ' 抽才出的概率') + '</span></div>');
    h.push('</div>');

    if (r.warnings && r.warnings.length) {
      h.push('<div class="callout"><p><strong>口径提醒</strong></p>' + r.warnings.map(function (w) { return '<p>' + esc(w) + '</p>'; }).join('') + '</div>');
    }

    // 预算
    if (r.budget) {
      var b = r.budget;
      var cls = b.prob >= 0.999999 ? 'key' : (b.prob < 0.5 ? 'bad' : 'key');
      h.push('<div class="callout ' + cls + '"><p><strong>预算 ' + y0(b.amount) + '（可买 ' + b.pulls + ' 抽）内拿到目标的概率：' + pc(b.prob) + '</strong></p>');
      h.push('<p>换算：' + fx(b.amount, 2) + ' 元 ÷ ' + fx(c.cost, 4) + ' 元/抽 = ' + b.pulls + ' 抽；这是「' + c.targets + ' 个目标全部拿到」所需的抽数不超过 ' + b.pulls + ' 的概率。</p>');
      h.push('<p>参照：期望成本 ' + y0(t.meanCost) + '（' + fx(t.meanPulls, 1) + ' 抽）' + (med ? '，中位数成本 ' + y0(med.cost) + '（' + med.pulls + ' 抽）' : '') + '。</p>');
      h.push('</div>');
    }

    // 分位数表
    h.push('<h3>按「把握」看需要多少抽 / 多少钱</h3><div class="tw"><table class="stack"><thead><tr><th>把握</th><th>需要抽数</th><th>需要金额</th></tr></thead><tbody>');
    r.reverse.forEach(function (x) {
      h.push('<tr' + (x.q === 0.5 ? ' class="cur"' : '') + '><td data-label="把握">' + (x.q * 100) + '%</td>' +
        '<td class="num" data-label="需要抽数">' + (x.pulls === null ? '—' : C.fmtInt(x.pulls) + ' 抽') + '</td>' +
        '<td class="num" data-label="需要金额">' + (x.cost === null ? '—' : y0(x.cost)) + '</td></tr>');
    });
    h.push('</tbody></table></div>');
    h.push('<p class="note">「把握」= 达到目标的抽数不超过该值的概率。' + (c.mode === 'none' ? '无保底口径下金额再高也到不了 100%，因为抽数本身没有上限。' : '保底口径下 100% 把握对应的金额就是最坏情况 ' + y0(t.worstCost) + '。') + '</p>');
    var distinct = {};
    r.reverse.forEach(function (x) { distinct[x.pulls] = 1; });
    if (Object.keys(distinct).length === 1 && c.mode !== 'none') {
      h.push('<p class="note">注意：五档把握对应的抽数全都是 ' + r.reverse[0].pulls + ' 抽 —— 这不是算错了，而是「' + pcTiny(r.pityHitRate) + ' 的情况都要抽满保底」的直接结果：中位数就已经等于最坏情况，所以 50% 到 99% 的把握都要靠同一个保底抽数兜住。</p>');
    } else if (Object.keys(distinct).length <= 2) {
      h.push('<p class="note">提示：几档把握落在了同一抽数上（' + r.reverse.map(function (x) { return (x.q * 100) + '%→' + x.pulls; }).join('、') + '），说明分布在这些抽数附近非常集中。</p>');
    }

    // 曲线
    h.push('<h3>抽数的累计概率</h3><div id="curveWrap"><canvas id="curve" width="900" height="210"></canvas></div>');
    h.push('<p class="note" id="curveNote"></p>');

    // 分档表
    h.push('<h3>几个关键位置上的达成概率</h3><div class="tw"><table class="stack"><thead><tr><th>抽数</th><th>累计花费</th><th>这么多抽内拿到的概率</th></tr></thead><tbody>');
    r.table.forEach(function (x) {
      h.push('<tr><td data-label="抽数">' + C.fmtInt(x.pulls) + ' 抽</td><td class="num" data-label="累计花费">' + y0(x.cost) + '</td>' +
        '<td class="num" data-label="这么多抽内拿到的概率">' + pc(x.cdf) + '</td></tr>');
    });
    h.push('</tbody></table></div>');

    // 保底对照
    if (r.compare && c.mode !== 'none') {
      h.push('<h3>与「同概率、无保底」对照</h3><div class="tw"><table class="stack"><thead><tr><th>口径</th><th>期望抽数</th><th>期望成本</th><th>50% 把握</th><th>90% 把握</th><th>99% 把握</th></tr></thead><tbody>');
      h.push('<tr class="cur"><td data-label="口径">当前（' + (c.mode === 'hard' ? '硬保底 ' + c.pity + ' 抽' : '软保底 ' + c.softStart + ' 抽起 +' + c.softStep + ' 个点，' + c.pity + ' 抽必出') + '）</td>' +
        '<td class="num" data-label="期望抽数">' + fx(t.meanPulls, 1) + '</td><td class="num" data-label="期望成本">' + y0(t.meanCost) + '</td>' +
        '<td class="num" data-label="50% 把握">' + (med ? C.fmtInt(med.pulls) + ' 抽' : '—') + '</td>' +
        '<td class="num" data-label="90% 把握">' + (q90 ? C.fmtInt(q90.pulls) + ' 抽' : '—') + '</td>' +
        '<td class="num" data-label="99% 把握">' + (function () { var x = t.quants.filter(function (q) { return q.q === 0.99; })[0]; return x ? C.fmtInt(x.pulls) + ' 抽' : '—'; })() + '</td></tr>');
      h.push('<tr class="dim"><td data-label="口径">同概率无保底（' + fx(c.rate, 4) + '%）</td>' +
        '<td class="num" data-label="期望抽数">' + fx(r.compare.meanPulls, 1) + '</td><td class="num" data-label="期望成本">' + y0(r.compare.meanCost) + '</td>' +
        '<td class="num" data-label="50% 把握">' + C.fmtInt(r.compare.p50) + ' 抽</td>' +
        '<td class="num" data-label="90% 把握">' + C.fmtInt(r.compare.p90) + ' 抽</td>' +
        '<td class="num" data-label="99% 把握">' + C.fmtInt(r.compare.p99) + ' 抽</td></tr>');
      h.push('</tbody></table></div>');
    }

    // 建议
    var adv = advice(r);
    if (adv.length) {
      h.push('<h3>下一步</h3><ul class="advice">');
      adv.forEach(function (a, i) {
        h.push('<li class="' + esc(a.cls) + '">' + esc(a.text));
        if (a.action) h.push('<div class="mini"><button type="button" class="mini" data-act="' + esc(a.action.kind) + '" data-value="' + esc(a.action.value) + '">' + esc(a.action.label) + '</button></div>');
        h.push('</li>');
      });
      h.push('</ul>');
    }

    // 敏感性
    if (r.sensitivity && r.sensitivity.length) {
      h.push('<h3>改一个条件会怎样</h3><div class="tw"><table class="stack"><thead><tr><th>改动</th><th>期望抽数</th><th>期望成本</th><th>90% 把握</th><th>99% 把握</th></tr></thead><tbody>');
      r.sensitivity.forEach(function (s) {
        if (s.skipped) { h.push('<tr class="dim"><td data-label="改动">' + esc(s.label) + '</td><td colspan="4" data-label="结果">' + esc(s.skipped) + '</td></tr>'); return; }
        h.push('<tr><td data-label="改动">' + esc(s.label) + '</td><td class="num" data-label="期望抽数">' + fx(s.meanPulls, 1) + '</td>' +
          '<td class="num" data-label="期望成本">' + y0(s.meanCost) + '</td>' +
          '<td class="num" data-label="90% 把握">' + (s.p90 === null ? '—' : C.fmtInt(s.p90) + ' 抽') + '</td>' +
          '<td class="num" data-label="99% 把握">' + (s.p99 === null ? '—' : C.fmtInt(s.p99) + ' 抽') + '</td></tr>');
      });
      h.push('</tbody></table></div>');
    }

    // 边界
    h.push('<details class="model"><summary>口径与边界（点开看这一页算了什么、没算什么）</summary>');
    h.push('<p><strong>逐抽概率序列</strong>：' + esc(seqText(c)) + '</p>');
    h.push('<p><strong>算法</strong>：把规则还原成逐抽出货概率 p₁…p_N，逐抽推进状态（已完成几个目标 × 当前周期已抽几次），得到「达到 ' + c.targets + ' 个目标」所需抽数的完整分布；期望、分位数、预算达成概率都从这一个分布读出。每次出货后保底计数重置。</p>');
    r.notes.forEach(function (n) { h.push('<p>· ' + esc(n) + '</p>'); });
    h.push('<p>没算的：保底跨目标不重置的规则、保底「继承」到下一个池子、十连折扣与首充优惠、货币与充值档位（这里只用「单次成本」一个数）、平台加重概率、限时活动叠加。本页不提供任何平台的真实概率，也不构成消费建议。</p>');
    h.push('</details>');

    h.push('<details class="model"><summary>这次计算用到的输入（原样回显）</summary><ul id="steps">');
    h.push('<li>单次成本：' + fx(c.cost, 4) + ' 元/抽</li>');
    h.push('<li>单次出货概率：' + fx(c.rate, 6) + '%</li>');
    h.push('<li>保底口径：' + esc(modeText(c)) + '</li>');
    h.push('<li>目标数量：' + c.targets + ' 个</li>');
    h.push('<li>预算：' + (c.budget === null ? '未填' : fx(c.budget, 2) + ' 元') + '</li>');
    h.push('</ul></details>');

    $('resultBody').innerHTML = h.join('');
    drawCurve(r);
    setCurveNote(r);
  }

  function modeText(c) {
    if (c.mode === 'none') return '无保底（每抽都是 ' + fx(c.rate, 4) + '%）';
    if (c.mode === 'hard') return '硬保底：第 ' + c.pity + ' 抽必出';
    return '软保底：第 ' + c.softStart + ' 抽起每次加 ' + fx(c.softStep, 2) + ' 个百分点，第 ' + c.pity + ' 抽必出';
  }
  function seqText(c) {
    if (c.mode === 'none') return '每抽恒为 ' + fx(c.rate, 4) + '%。';
    var seq = C.probSeq(c), parts = [];
    var head = Math.min(4, seq.length);
    for (var i = 0; i < head; i++) parts.push('第' + (i + 1) + '抽 ' + fx(seq[i] * 100, 4) + '%');
    if (c.mode === 'soft' && c.softStart <= seq.length) {
      var s = c.softStart;
      parts.push('…第' + s + '抽 ' + fx(seq[s - 1] * 100, 4) + '%');
      if (s + 1 <= seq.length - 1) parts.push('第' + (s + 1) + '抽 ' + fx(seq[s + 1 - 1] * 100, 4) + '%（每次 +' + fx(c.softStep, 2) + ' 个点）');
    } else if (seq.length > head) parts.push('…前 ' + (seq.length - 1) + ' 抽都是 ' + fx(c.rate, 4) + '%');
    parts.push('第' + seq.length + '抽 100%（必出）');
    return parts.join('，') + '。';
  }

  function curveRange(r) {
    return { x0: 0, x1: Math.max(1, r.total.rangeEnd) };
  }
  // 从纯数据的曲线点里线性插值出某个抽数上的累计概率
  function interpCdf(curve, x) {
    if (!curve || !curve.length) return 0;
    if (x <= curve[0].pulls) return curve[0].cdf;
    for (var i = 1; i < curve.length; i++) {
      if (curve[i].pulls >= x) {
        var a = curve[i - 1], b = curve[i];
        if (b.pulls === a.pulls) return b.cdf;
        return a.cdf + (b.cdf - a.cdf) * (x - a.pulls) / (b.pulls - a.pulls);
      }
    }
    return curve[curve.length - 1].cdf;
  }
  function drawCurve(r) {
    var cv = $('curve'); if (!cv) return;
    var dpr = Math.min(2, window.devicePixelRatio || 1);
    var W = 900, H = 210, padL = 52, padR = 14, padT = 12, padB = 30;
    cv.width = W * dpr; cv.height = H * dpr;
    cv.style.width = '100%'; cv.style.height = H + 'px';
    var g = cv.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = '#fcfdff'; g.fillRect(0, 0, W, H);
    var rg = curveRange(r), t = r.total;
    function X(p) { return padL + (Math.min(p, rg.x1) / rg.x1) * (W - padL - padR); }
    function Y(v) { return H - padB - Math.max(0, Math.min(1, v)) * (H - padT - padB); }
    g.strokeStyle = '#e4eaf1'; g.lineWidth = 1;
    [0, 0.25, 0.5, 0.75, 1].forEach(function (v) {
      g.beginPath(); g.moveTo(padL, Y(v)); g.lineTo(W - padR, Y(v)); g.stroke();
      g.fillStyle = '#7b8ca0'; g.font = '11px system-ui,"PingFang SC",sans-serif'; g.textAlign = 'right';
      g.fillText((v * 100) + '%', padL - 6, Y(v) + 4);
    });
    g.textAlign = 'center';
    [0, 0.25, 0.5, 0.75, 1].forEach(function (f) {
      var p = Math.round(rg.x1 * f);
      g.fillStyle = '#7b8ca0'; g.fillText(C.fmtInt(p), X(p), H - 10);
    });
    g.textAlign = 'left';
    // 曲线
    g.strokeStyle = '#2d5f96'; g.lineWidth = 2.4; g.beginPath();
    t.curve.forEach(function (x, i) { if (i === 0) g.moveTo(X(x.pulls), Y(x.cdf)); else g.lineTo(X(x.pulls), Y(x.cdf)); });
    g.stroke();
    // 中位数竖线
    var med = t.quants.filter(function (q) { return q.q === 0.5; })[0];
    if (med && med.pulls <= rg.x1) {
      var hMed = interpCdf(t.curve, med.pulls);
      g.strokeStyle = '#2b6b4f'; g.lineWidth = 1.4; g.setLineDash([5, 4]);
      g.beginPath(); g.moveTo(X(med.pulls), Y(0)); g.lineTo(X(med.pulls), Y(hMed)); g.stroke();
      g.setLineDash([]);
      g.fillStyle = '#2b6b4f'; g.font = '11px system-ui,"PingFang SC",sans-serif';
      g.fillText('中位数 ' + med.pulls + ' 抽', Math.min(X(med.pulls) + 4, W - 110), Y(0.06));
    }
    // 预算竖线
    if (r.budget && r.budget.pulls <= rg.x1) {
      g.strokeStyle = '#a23b28'; g.lineWidth = 1.6;
      g.beginPath(); g.moveTo(X(r.budget.pulls), Y(0)); g.lineTo(X(r.budget.pulls), Y(1)); g.stroke();
      g.fillStyle = '#a23b28'; g.font = '11px system-ui,"PingFang SC",sans-serif';
      g.fillText('预算 ' + r.budget.pulls + ' 抽', Math.min(X(r.budget.pulls) + 4, W - 96), Y(0.97));
    }
    if (r.input.mode !== 'none') {
      g.strokeStyle = '#c9821f'; g.lineWidth = 1.2; g.setLineDash([3, 3]);
      g.beginPath(); g.moveTo(X(t.worstPulls), Y(0)); g.lineTo(X(t.worstPulls), Y(1)); g.stroke();
      g.setLineDash([]);
    }
  }
  function setCurveNote(r) {
    var el = $('curveNote'); if (!el) return;
    var rg = curveRange(r);
    if (r.input.mode === 'none') {
      el.textContent = '横轴只画到 99% 分位附近（' + C.fmtInt(rg.x1) + ' 抽）；无保底口径下曲线会一直往右延伸，不会到 100%。';
    } else {
      el.textContent = '横轴到最坏情况 ' + r.total.worstPulls + ' 抽。绿色虚线是中位数，红色实线是你的预算，橙色点线是抽满保底的硬上限。';
    }
  }

  // ── 错误与重算 ──────────────────────────────────────────────
  function showError(msg) {
    $('error').textContent = msg;
    $('downloads').style.display = 'none';
  }
  function clearError() {
    $('error').textContent = '';
    $('downloads').style.display = '';
  }
  function recompute(silent) {
    var input = readInput(), r;
    try { r = C.analyze(input); }
    catch (e) {
      lastResult = null; window.__lastResult = null;
      showError((e && e.userMessage) || ('计算出错：' + (e && e.message)));
      return null;
    }
    lastResult = r; window.__lastResult = r;
    clearError(); renderResult(r);
    if (!silent) $('message').textContent = '';
    return r;
  }

  // ── 导出 ────────────────────────────────────────────────────
  function download(name, text, mime) {
    var blob = new Blob([text], { type: mime || 'text/plain;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  }
  function csvText(r) {
    var t = r.total, c = r.input;
    var L = [];
    L.push('"# 保底成本台 明细导出"');
    L.push('"生成时间","' + new Date().toISOString() + '"');
    L.push('');
    L.push('"# 输入（全部由用户填写，页面不提供任何平台真实概率）"');
    L.push('"单次成本(元)","' + c.cost + '"');
    L.push('"单次出货概率(%)","' + c.rate + '"');
    L.push('"保底口径","' + modeText(c).replace(/"/g, '""') + '"');
    L.push('"目标数量","' + c.targets + '"');
    L.push('"预算(元)","' + (c.budget === null ? '' : c.budget) + '"');
    L.push('');
    L.push('"# 逐抽出货概率序列"');
    L.push('"抽序","出货概率(%)"');
    if (c.mode === 'none') L.push('"每抽","' + (c.rate).toFixed(6) + '"');
    else C.probSeq(c).forEach(function (p, i) { L.push([i + 1, (p * 100).toFixed(6)].join(',')); });
    L.push('');
    L.push('"# 单个目标"');
    L.push('"期望抽数","' + r.single.meanPulls.toFixed(8) + '"');
    L.push('"期望成本(元)","' + r.single.meanCost.toFixed(6) + '"');
    L.push('"保守口径期望抽数","' + (r.single.closedFormMean === null ? '无闭式解(软保底)' : r.single.closedFormMean.toFixed(8)) + '"');
    L.push('"要抽满保底才出的概率","' + (r.pityHitRate === null ? '' : r.pityHitRate.toExponential(10)) + '"');
    L.push('');
    L.push('"# 达到目标（' + c.targets + ' 个）的成本分布"');
    L.push('"期望抽数","' + t.meanPulls.toFixed(8) + '"');
    L.push('"期望成本(元)","' + t.meanCost.toFixed(6) + '"');
    L.push('"最坏抽数","' + t.worstPulls + '"');
    L.push('"最坏成本(元)","' + (t.worstCost === null ? '无上限' : t.worstCost.toFixed(6)) + '"');
    L.push('"分布尾部未收敛量","' + t.tail.toExponential(10) + '"');
    L.push('');
    L.push('"# 分位数（把握）"');
    L.push('"把握","抽数","金额(元)"');
    r.reverse.forEach(function (x) { L.push([(x.q * 100) + '%', x.pulls === null ? '' : x.pulls, x.cost === null ? '' : x.cost.toFixed(6)].join(',')); });
    L.push('');
    L.push('"# 关键位置上的累计概率"');
    L.push('"抽数","累计花费(元)","累计概率"');
    r.table.forEach(function (x) { L.push([x.pulls, x.cost.toFixed(6), x.cdf.toFixed(10)].join(',')); });
    L.push('');
    if (r.compare) {
      L.push('"# 同概率无保底对照"');
      L.push('"期望抽数","' + r.compare.meanPulls.toFixed(8) + '"');
      L.push('"期望成本(元)","' + r.compare.meanCost.toFixed(6) + '"');
      L.push('"50% 把握(抽)","' + r.compare.p50 + '"');
      L.push('"90% 把握(抽)","' + r.compare.p90 + '"');
      L.push('"99% 把握(抽)","' + r.compare.p99 + '"');
      L.push('');
    }
    if (r.budget) {
      L.push('"# 预算"');
      L.push('"预算(元)","' + r.budget.amount.toFixed(6) + '"');
      L.push('"可买抽数","' + r.budget.pulls + '"');
      L.push('"达成概率","' + r.budget.prob.toFixed(10) + '"');
      L.push('"是否覆盖最坏情况","' + (r.budget.coversWorst ? '是' : '否') + '"');
      L.push('');
    }
    L.push('"# 敏感性"');
    L.push('"改动","期望抽数","期望成本(元)","90% 把握(抽)","99% 把握(抽)","说明"');
    r.sensitivity.forEach(function (s) {
      if (s.skipped) L.push(['"' + s.label + '"', '', '', '', '', '"' + s.skipped.replace(/"/g, '""') + '"'].join(','));
      else L.push(['"' + s.label + '"', s.meanPulls.toFixed(8), s.meanCost.toFixed(6), s.p90 === null ? '' : s.p90, s.p99 === null ? '' : s.p99, ''].join(','));
    });
    L.push('');
    L.push('"# 边界说明"');
    r.notes.forEach(function (n) { L.push('"' + n.replace(/"/g, '""') + '"'); });
    return L.join('\n');
  }
  function mdText(r) {
    var t = r.total, c = r.input, L = [];
    L.push('# 保底成本台 · 结果说明');
    L.push('');
    L.push('生成时间：' + new Date().toISOString() + '（本页全部数字来自同一次计算）');
    L.push('');
    L.push('## 这条规则');
    L.push('');
    L.push('- 单次成本：' + fx(c.cost, 4) + ' 元/抽');
    L.push('- 单次出货概率：' + fx(c.rate, 6) + '%');
    L.push('- 保底口径：' + modeText(c));
    L.push('- 目标数量：' + c.targets + ' 个');
    L.push('- 预算：' + (c.budget === null ? '未填' : fx(c.budget, 2) + ' 元'));
    L.push('');
    L.push('## 结论');
    L.push('');
    L.push('- 达到目标平均要花 **' + y0(t.meanCost) + '**（约 ' + fx(t.meanPulls, 1) + ' 抽）');
    var med = t.quants.filter(function (q) { return q.q === 0.5; })[0];
    var q90 = t.quants.filter(function (q) { return q.q === 0.9; })[0];
    L.push('- 中位数：' + (med ? med.pulls + ' 抽（' + y0(med.cost) + '）' : '—'));
    L.push('- 90% 把握：' + (q90 ? q90.pulls + ' 抽（' + y0(q90.cost) + '）' : '—'));
    L.push('- 最坏情况：' + (t.worstCost === null ? '无上限（无保底口径）' : t.worstPulls + ' 抽（' + y0(t.worstCost) + '）'));
    L.push('- 单个目标要抽满第 ' + (c.pity === null ? '—' : c.pity) + ' 抽才出的概率：' + (r.pityHitRate === null ? '—（无保底）' : pcTiny(r.pityHitRate)));
    if (r.budget) L.push('- 预算 ' + y0(r.budget.amount) + '（' + r.budget.pulls + ' 抽）内拿到目标的概率：**' + pc(r.budget.prob) + '**');
    L.push('');
    L.push('## 按把握看需要多少');
    L.push('');
    L.push('| 把握 | 抽数 | 金额 |');
    L.push('|---|---|---|');
    r.reverse.forEach(function (x) { L.push('| ' + (x.q * 100) + '% | ' + (x.pulls === null ? '—' : x.pulls) + ' | ' + (x.cost === null ? '—' : y0(x.cost)) + ' |'); });
    L.push('');
    L.push('## 几个关键位置上的达成概率');
    L.push('');
    L.push('| 抽数 | 累计花费 | 累计概率 |');
    L.push('|---|---|---|');
    r.table.forEach(function (x) { L.push('| ' + x.pulls + ' | ' + y0(x.cost) + ' | ' + pc(x.cdf) + ' |'); });
    L.push('');
    if (r.compare && c.mode !== 'none') {
      L.push('## 与「同概率、无保底」对照');
      L.push('');
      L.push('- 无保底：期望 ' + fx(r.compare.meanPulls, 1) + ' 抽（' + y0(r.compare.meanCost) + '），50% 把握 ' + r.compare.p50 + ' 抽，90% 把握 ' + r.compare.p90 + ' 抽，99% 把握 ' + r.compare.p99 + ' 抽（' + y0(r.compare.p99 * c.cost) + '）');
      L.push('');
    }
    var adv = advice(r);
    if (adv.length) {
      L.push('## 下一步');
      L.push('');
      adv.forEach(function (a) { L.push('- ' + a.text); });
      L.push('');
    }
    L.push('## 敏感性');
    L.push('');
    L.push('| 改动 | 期望抽数 | 期望成本 | 90% 把握 | 99% 把握 |');
    L.push('|---|---|---|---|---|');
    r.sensitivity.forEach(function (s) {
      if (s.skipped) L.push('| ' + s.label + ' | — | — | — | — |');
      else L.push('| ' + s.label + ' | ' + fx(s.meanPulls, 1) + ' | ' + y0(s.meanCost) + ' | ' + (s.p90 === null ? '—' : s.p90) + ' | ' + (s.p99 === null ? '—' : s.p99) + ' |');
    });
    L.push('');
    L.push('## 算法与边界');
    L.push('');
    L.push('逐抽出货概率序列：' + seqText(c));
    r.notes.forEach(function (n) { L.push('- ' + n); });
    L.push('- 没算的：保底跨目标不重置的规则、保底继承、十连折扣与首充优惠、货币与充值档位、限时活动叠加。');
    L.push('- 本页不提供任何平台的真实概率，也不构成消费建议。默认样例与内置场景均为虚构示例。');
    return L.join('\n');
  }

  // ── 结果卡 PNG 1080×1350 ────────────────────────────────────
  function wrapText(ctx, text, maxWidth, maxLines) {
    var chars = String(text).split(''), lines = [], line = '';
    for (var i = 0; i < chars.length; i++) {
      var ch = chars[i], test = line + ch;
      // 不让收尾标点落在行首（避免一行只剩「）」或「，」）
      var keepPunct = /[，。、；：）】》」』！？·…%]/.test(ch) && line;
      if (ctx.measureText(test).width > maxWidth && line && !keepPunct) { lines.push(line); line = ch; }
      else line = test;
    }
    if (line) lines.push(line);
    if (maxLines && lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].slice(0, -1) + '…'; }
    return lines;
  }
  // 结果卡专用的短要点（比页面建议更短，避免在 1080 画布上被截断）
  function cardPoints(r) {
    var t = r.total, c = r.input, out = [], med = t.quants.filter(function (q) { return q.q === 0.5; })[0];
    var q99 = t.quants.filter(function (q) { return q.q === 0.99; })[0];
    if (c.mode !== 'none' && r.compare) {
      out.push('同概率无保底：期望 ' + fx(r.compare.meanPulls, 1) + ' 抽（' + y0(r.compare.meanCost) + '），99% 把握 ' + C.fmtInt(r.compare.p99) + ' 抽（' + y0(r.compare.p99 * c.cost) + '）');
      out.push('保底把期望压到 ' + y0(t.meanCost) + '（降 ' + pc(1 - t.meanCost / r.compare.meanCost, 1) + '），把 99% 把握压到 ' + (q99 ? C.fmtInt(q99.pulls) + ' 抽（' + y0(q99.cost) + '，降 ' + pc(1 - q99.cost / (r.compare.p99 * c.cost), 1) + '）' : '—'));
    } else {
      out.push('无保底口径：抽数没有上限，99% 把握要 ' + (q99 ? C.fmtInt(q99.pulls) + ' 抽（' + y0(q99.cost) + '）' : '—'));
    }
    if (r.pityHitRate !== null) out.push(pcTiny(r.pityHitRate) + ' 的情况要抽满第 ' + c.pity + ' 抽才出' + (med && med.pulls === t.worstPulls && c.mode !== 'none' ? '；中位数＝最坏＝' + y0(med.cost) : ''));
    if (r.budget) out.push('预算 ' + y0(r.budget.amount) + '（' + r.budget.pulls + ' 抽）内拿到目标的概率：' + pc(r.budget.prob));
    if (c.targets > 1 && t.worstCost !== null) out.push('要 ' + c.targets + ' 个：最坏 ' + t.worstPulls + ' 抽 = ' + y0(t.worstCost));
    return out;
  }
  function drawCard(r) {
    var cv = document.createElement('canvas');
    cv.width = 1080; cv.height = 1350;
    var g = cv.getContext('2d'), t = r.total, c = r.input;
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 1080, 1350);
    g.fillStyle = '#eef3f8'; g.fillRect(0, 0, 1080, 258);
    g.fillStyle = '#2d5f96'; g.fillRect(0, 0, 1080, 14);
    g.fillStyle = '#4f6b91'; g.font = '600 24px system-ui,"PingFang SC",sans-serif';
    g.fillText('PITY BUDGET · 有保底的概率发放规则下的成本分布', 64, 84);
    g.fillStyle = '#22344e'; g.font = '700 52px system-ui,"PingFang SC",sans-serif';
    g.fillText('保底成本台', 64, 152);
    g.fillStyle = '#5a6d84'; g.font = '400 25px system-ui,"PingFang SC",sans-serif';
    g.fillText(wrapText(g, modeText(c) + ' · ' + y0(c.cost) + '/抽 · 要 ' + c.targets + ' 个', 950, 1)[0], 64, 202);
    g.fillStyle = '#22344e'; g.font = '700 74px system-ui,"PingFang SC",sans-serif';
    g.fillText(y0(t.meanCost), 64, 352);
    g.fillStyle = '#5a6d84'; g.font = '400 27px system-ui,"PingFang SC",sans-serif';
    g.fillText('达到目标的平均成本（约 ' + fx(t.meanPulls, 1) + ' 抽）', 64, 398);
    var med = t.quants.filter(function (q) { return q.q === 0.5; })[0];
    var q90 = t.quants.filter(function (q) { return q.q === 0.9; })[0];
    var boxes = [
      ['中位数成本', med ? y0(med.cost) : '—', med ? med.pulls + ' 抽 · 一半人在此之内' : '—'],
      ['90% 把握', q90 ? y0(q90.cost) : '—', q90 ? q90.pulls + ' 抽 · 九成人在此之内' : '—'],
      ['最坏情况', t.worstCost === null ? '无上限' : y0(t.worstCost), t.worstCost === null ? '无保底口径没有上限' : t.worstPulls + ' 抽 · 抽满保底']
    ];
    boxes.forEach(function (b, i) {
      var x = 64 + i * 320;
      g.fillStyle = '#f4f8fd'; g.fillRect(x, 434, 296, 152);
      g.strokeStyle = '#d9e3ee'; g.strokeRect(x, 434, 296, 152);
      g.fillStyle = '#61738a'; g.font = '600 22px system-ui,"PingFang SC",sans-serif';
      g.fillText(b[0], x + 20, 476);
      g.fillStyle = '#2d5f96'; g.font = '700 40px system-ui,"PingFang SC",sans-serif';
      g.fillText(wrapText(g, b[1], 258, 1)[0], x + 20, 530);
      g.fillStyle = '#7b8ca0'; g.font = '400 18px system-ui,"PingFang SC",sans-serif';
      g.fillText(wrapText(g, b[2], 258, 1)[0], x + 20, 562);
    });
    var y = 646;
    g.fillStyle = '#22344e'; g.font = '700 30px system-ui,"PingFang SC",sans-serif';
    g.fillText('按把握看需要多少', 64, y);
    y += 34;
    g.font = '600 23px system-ui,"PingFang SC",sans-serif';
    var xs = r.reverse.filter(function (x) { return x.pulls !== null; });
    xs.forEach(function (x, i) {
      var col = i % 3, row = Math.floor(i / 3);
      var bx = 64 + col * 320, by = y + row * 62;
      g.fillStyle = '#f7fafe'; g.fillRect(bx, by, 296, 52);
      g.fillStyle = '#61738a'; g.font = '600 20px system-ui,"PingFang SC",sans-serif';
      g.fillText((x.q * 100) + '% 把握', bx + 14, by + 22);
      g.fillStyle = '#22344e'; g.font = '600 21px system-ui,"PingFang SC",sans-serif';
      g.fillText(x.pulls + ' 抽 · ' + y0(x.cost), bx + 14, by + 44);
    });
    y += Math.ceil(xs.length / 3) * 62 + 16;
    if (r.budget) {
      g.fillStyle = '#f4f8fd'; g.fillRect(64, y, 952, 74);
      g.strokeStyle = '#c6d8ee'; g.strokeRect(64, y, 952, 74);
      g.fillStyle = '#22344e'; g.font = '700 27px system-ui,"PingFang SC",sans-serif';
      g.fillText('预算 ' + y0(r.budget.amount) + '（' + r.budget.pulls + ' 抽）内拿到：' + pc(r.budget.prob), 84, y + 46);
      y += 94;
    }
    g.fillStyle = '#22344e'; g.font = '700 30px system-ui,"PingFang SC",sans-serif';
    g.fillText('要点', 64, y + 6);
    y += 34;
    cardPoints(r).slice(0, 4).forEach(function (text) {
      if (y + 30 > 1215) return;
      wrapText(g, '· ' + text, 950, 2).forEach(function (ln) {
        if (y + 24 > 1215) return;
        g.fillStyle = '#4d6076'; g.font = '400 23px system-ui,"PingFang SC",sans-serif';
        g.fillText(ln, 64, y + 24); y += 34;
      });
      y += 6;
    });
    g.fillStyle = '#eef3f8'; g.fillRect(0, 1240, 1080, 110);
    g.fillStyle = '#7b8ca0'; g.font = '400 20px system-ui,"PingFang SC",sans-serif';
    g.fillText('保底成本台 V1.0.0 · 数字来自同一次计算 · 默认样例与内置场景均为虚构示例', 64, 1282);
    g.fillText('概率与保底规则由用户自填；本页不联网、不预测单次结果 · 生成于 ' + new Date().toLocaleString(), 64, 1316);
    return cv;
  }
  function exportPNG(r) {
    var cv = drawCard(r);
    return new Promise(function (resolve) {
      cv.toBlob(function (blob) {
        var a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'pity-budget-card-1080x1350.png';
        document.body.appendChild(a); a.click();
        setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); resolve(true); }, 1200);
      }, 'image/png');
    });
  }

  // ── 持久化 ──────────────────────────────────────────────────
  function payload(extra) {
    return Object.assign({ app: APP, version: 1, savedAt: new Date().toISOString(), input: readInput() }, extra || {});
  }
  function save() {
    try {
      localStorage.setItem(STORE, JSON.stringify(payload()));
      $('savedNote').textContent = '已保存到本机（' + new Date().toLocaleString() + '），刷新或重开页面会自动恢复。';
    } catch (e) { $('savedNote').textContent = '保存失败：' + (e && e.message); }
  }
  function restore(silent) {
    var raw = null;
    try { raw = localStorage.getItem(STORE); } catch (e) { raw = null; }
    if (!raw) { if (!silent) $('savedNote').textContent = '本机还没有保存过输入。'; return false; }
    try {
      var d = JSON.parse(raw);
      if (!d || !d.input) throw new Error('结构不对');
      writeInput(d.input);
      if (!silent) $('savedNote').textContent = '已读取本机保存的输入（保存于 ' + (d.savedAt || '未知时间') + '）。';
      return true;
    } catch (e) { if (!silent) $('savedNote').textContent = '读取失败：' + (e && e.message); return false; }
  }

  // ── 绑定 ────────────────────────────────────────────────────
  function bind() {
    $('mode').addEventListener('change', function () { syncMode(); recompute(); });
    ['cost', 'rate', 'pity', 'softStart', 'softStep', 'targets', 'budget'].forEach(function (k) {
      $(k).addEventListener('change', function () { recompute(); });
      $(k).addEventListener('input', function () { recompute(true); });
    });
    $('recompute').addEventListener('click', function () { recompute(); $('message').textContent = '已按当前输入重算。'; });
    $('demo').addEventListener('click', function () { writeInput(SCENES[0].input); recompute(); $('message').textContent = '已载入虚构示例（硬保底 90 抽 / 0.6% / 12 元一次）。'; });
    $('presets').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-scene]') : null;
      if (!b) return;
      var s = SCENES.filter(function (x) { return x.key === b.getAttribute('data-scene'); })[0];
      if (!s) return;
      writeInput(s.input); recompute();
      $('message').textContent = '已载入内置场景：' + s.label + '（虚构示例）。';
    });
    $('resultBody').addEventListener('click', function (ev) {
      var b = ev.target.closest ? ev.target.closest('button[data-act]') : null;
      if (!b) return;
      var kind = b.getAttribute('data-act'), value = b.getAttribute('data-value');
      if (kind === 'budget') { $('budget').value = value; recompute(); $('message').textContent = '已把预算改成 ' + value + ' 元并重算。'; }
      else if (kind === 'targets') { $('targets').value = value; recompute(); $('message').textContent = '已把目标数量改成 ' + value + ' 个并重算。'; }
    });
    $('save').addEventListener('click', save);
    $('restore').addEventListener('click', function () { if (restore(false)) recompute(); });
    $('backup').addEventListener('click', function () {
      download('pity-budget-backup.json', JSON.stringify(payload(), null, 2), 'application/json');
      $('message').textContent = '已下载 JSON 备份（含当前全部输入）。';
    });
    $('import').addEventListener('click', function () { $('imports').click(); });
    $('imports').addEventListener('change', function (ev) {
      var f = ev.target.files && ev.target.files[0];
      if (!f) return;
      var fr = new FileReader();
      fr.onload = function () {
        try {
          var d = JSON.parse(String(fr.result));
          var src = d && d.input ? d.input : d;
          writeInput(src); recompute();
          $('message').textContent = '已导入备份并重算。';
        } catch (e) { $('message').textContent = '导入失败：' + (e && e.message); }
      };
      fr.readAsText(f);
      ev.target.value = '';
    });
    $('csv').addEventListener('click', function () { if (lastResult) { download('pity-budget-detail.csv', csvText(lastResult), 'text/csv;charset=utf-8'); $('message').textContent = '已下载 CSV 明细。'; } });
    $('md').addEventListener('click', function () { if (lastResult) { download('pity-budget-result.md', mdText(lastResult), 'text/markdown;charset=utf-8'); $('message').textContent = '已下载结果说明 MD。'; } });
    $('json').addEventListener('click', function () { if (lastResult) { download('pity-budget-backup.json', JSON.stringify(payload(), null, 2), 'application/json'); $('message').textContent = '已下载 JSON 备份。'; } });
    $('png').addEventListener('click', function () { if (lastResult) { exportPNG(lastResult).then(function () { $('message').textContent = '已下载结果卡 PNG（1080×1350）。'; }); } });
  }

  function init() {
    renderPresets();
    $('modelHint').innerHTML = '把规则还原成逐抽出货概率 p₁…p_N：硬保底是前 N−1 抽恒为 p、第 N 抽为 100%；软保底是从第 s 抽起每次加若干个百分点，最后仍由第 N 抽必出兜底。' +
      '逐抽推进「已完成几个目标 × 当前周期已抽几次」的状态，得到达到目标的抽数分布，再从分布读出期望、中位数与各档把握。' +
      '每次出货后保底计数重置；保底不跨目标继承。';
    var ok = restore(true);
    if (!ok) writeInput(C.defaults);
    syncMode();
    recompute(true);
    window.__App = {
      readInput: readInput,
      state: function () { return { input: readInput(), result: lastResult }; },
      render: function () { syncMode(); return recompute(); },
      advice: function () { return lastResult ? advice(lastResult) : []; },
      csv: function () { return lastResult ? csvText(lastResult) : ''; },
      md: function () { return lastResult ? mdText(lastResult) : ''; }
    };
  }
  bind();
  init();
})();
