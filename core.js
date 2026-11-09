/* 保底成本台 · core.js
 * 有保底的概率发放规则下的成本分布算术：
 *   单周期出货概率序列 p_1 … p_N
 *     无保底   p_k = p（不截断，用逐抽 DP 跑到尾部可忽略）
 *     硬保底   p_k = p (k<N)，p_N = 1
 *     软保底   p_k = min(p + max(0, k − s + 1)·q, 100)，且 p_N = 1
 *   单周期分布   P(T = k) = (∏_{j<k} (1 − p_j)) · p_k
 *   目标 m 个     S_m = T_1 + … + T_m（每次出货后保底重置，i.i.d. 相加）
 *   输出         期望抽数/成本、中位数与 75/90/95/99 分位、预算内达成概率、
 *                反向「要多少把握需要准备多少钱」、与同概率无保底对照、敏感性
 *   精确性       期望另有闭式（无保底 1/p；硬保底 (1 − (1−p)^N)/p）；
 *                测试里用 BigInt 精确有理数 DP 与蒙特卡洛独立对拍。
 * 纯计算、无 DOM、无网络；浏览器挂 window.AppCore，Node 下 module.exports。
 */
(function (global) {
  'use strict';

  var LIMITS = {
    MIN_COST: 0.0001, MAX_COST: 1e7,
    MIN_RATE: 0.001, MAX_RATE: 100,
    MIN_PITY: 1, MAX_PITY: 500,
    MIN_STEP: 0.0001, MAX_STEP: 100,
    MIN_TARGETS: 1, MAX_TARGETS: 10,
    MAX_PITY_TARGETS_PRODUCT: 3000,   // N × m 上限（逐抽 DP 规模）
    MAX_NO_PITY_CAP: 200000,          // 无保底模式下逐抽 DP 的抽数上限
    QUANTS: [0.5, 0.75, 0.9, 0.95, 0.99],
    TAIL_EPS: 1e-15
  };

  function err(msg) { var e = new Error(msg); e.userMessage = msg; return e; }

  // ── 数值解析 ────────────────────────────────────────────────
  function num(s) {
    if (typeof s === 'number') return isFinite(s) ? s : NaN;
    if (s === null || s === undefined) return NaN;
    var t = String(s).trim();
    if (!t) return NaN;
    t = t.replace(/[，,\s]/g, '').replace(/[．。]/g, '.').replace(/[％%]$/, '');
    if (!/^[+-]?(\d+(\.\d*)?|\.\d+)$/.test(t)) return NaN;
    var v = Number(t);
    return isFinite(v) ? v : NaN;
  }
  function intOf(s) {
    var v = num(s);
    if (!isFinite(v)) return NaN;
    if (Math.abs(v - Math.round(v)) > 1e-9) return NaN;
    return Math.round(v);
  }
  function isBlank(s) { return s === null || s === undefined || String(s).trim() === ''; }

  // ── 概率序列 ────────────────────────────────────────────────
  // 返回长度 N 的数组，seq[k-1] = 第 k 抽出货概率（小数）；无保底返回 null
  function probSeq(cfg) {
    var p = cfg.rate / 100;
    if (cfg.mode === 'none') return null;
    var N = cfg.pity, seq = new Array(N), k;
    if (cfg.mode === 'hard') {
      for (k = 1; k <= N; k++) seq[k - 1] = (k < N) ? p : 1;
      return seq;
    }
    var s = cfg.softStart, q = cfg.softStep / 100;
    for (k = 1; k <= N; k++) {
      var v = (k >= s) ? p + (k - s + 1) * q : p;
      seq[k - 1] = Math.min(v, 1);
    }
    seq[N - 1] = 1;                       // 硬保底兜底：第 N 抽必出
    return seq;
  }

  // 单个目标的闭式期望（软保底无闭式，返回 null）
  function closedFormMean(cfg) {
    var p = cfg.rate / 100;
    if (cfg.mode === 'none') return 1 / p;
    if (cfg.mode === 'hard') return (1 - Math.pow(1 - p, cfg.pity)) / p;
    return null;
  }

  // ── 分布核心：逐抽 DP ───────────────────────────────────────
  function solveDistribution(cfg, want) {
    var m = cfg.targets, p = cfg.rate / 100, i, j, k, t;
    var quantList = (want && want.quants) || LIMITS.QUANTS;
    var qi = 0, quants = [], samples, mean = 0, prev = 0, maxPulls, tail = 0;
    var eps = LIMITS.TAIL_EPS;

    function at(n) { return n < 0 ? 0 : (n >= samples.length ? 1 : samples[n]); }

    if (cfg.mode === 'none') {
      var per = Math.log(eps / m) / Math.log(1 - p);      // P(T > per) ≤ eps/m
      maxPulls = Math.ceil(m * per) + 2;
      if (maxPulls > LIMITS.MAX_NO_PITY_CAP) {
        throw err('基础概率太低：这个概率下要算到 ' + maxPulls + ' 抽以上（上限 ' + LIMITS.MAX_NO_PITY_CAP +
          '）。请提高概率、减少目标数量，或改用带保底的口径。');
      }
      // dp[j] = P(已完成 j 个、尚未完成 m 个)（j = 0 … m−1）；达成即吸收
      var dp = new Float64Array(m), nd = new Float64Array(m);
      dp[0] = 1;
      samples = new Float64Array(maxPulls + 1);
      var q0 = 1 - p;
      for (t = 1; t <= maxPulls; t++) {
        nd.fill(0);
        var hit = 0;
        for (j = 0; j < m; j++) {
          var v = dp[j];
          if (v === 0) continue;
          var succ = v * p;
          if (j + 1 >= m) hit += succ;       // 只有第 m 个目标落袋才算「首次达成」
          else nd[j + 1] += succ;
          nd[j] += v * q0;
        }
        var tmp = dp; dp = nd; nd = tmp;
        var c = prev + hit;
        samples[t] = c;
        mean += t * hit;
        prev = c;
        while (qi < quantList.length && c >= quantList[qi] - 1e-15) { quants.push({ q: quantList[qi], pulls: t }); qi++; }
        if (c >= 1 - eps && qi >= quantList.length) { maxPulls = t; samples = samples.slice(0, t + 1); break; }
      }
      prev = samples[maxPulls];
      tail = Math.max(0, 1 - prev);
    } else {
      var seq = probSeq(cfg), N = cfg.pity;
      maxPulls = m * N;
      // cur[j][k]：已完成 j 个目标（j < m），当前周期已抽 k 次（下一抽是本周期第 k+1 抽）
      var cur = [], nxt = [];
      for (j = 0; j < m; j++) { cur.push(new Float64Array(N)); nxt.push(new Float64Array(N)); }
      cur[0][0] = 1;
      samples = new Float64Array(maxPulls + 1);
      var out = new Float64Array(maxPulls + 1);
      for (t = 1; t <= maxPulls; t++) {
        for (j = 0; j < m; j++) nxt[j].fill(0);
        var jmax = Math.min(m - 1, t);
        for (j = 0; j <= jmax; j++) {
          var row = cur[j], nrow = nxt[j], srow = (j + 1 < m) ? nxt[j + 1] : null;
          for (k = 0; k < N; k++) {
            var vv = row[k];
            if (vv === 0) continue;
            var pk = seq[k], fail = 1 - pk;
            if (j + 1 >= m) out[t] += vv * pk;          // 达成目标（吸收）
            else srow[0] += vv * pk;
            if (fail > 0 && k + 1 < N) nrow[k + 1] += vv * fail;
          }
        }
        var tmp2 = cur; cur = nxt; nxt = tmp2;
        mean += t * out[t];
        prev += out[t];
        samples[t] = prev;
        while (qi < quantList.length && prev + 1e-15 >= quantList[qi]) { quants.push({ q: quantList[qi], pulls: t }); qi++; }
        if (prev >= 1 - eps && t >= m) { maxPulls = t; samples = samples.slice(0, t + 1); break; }
      }
      tail = Math.max(0, 1 - prev);
    }

    return {
      mean: mean, maxPulls: maxPulls, quants: quants, tail: tail,
      cdfAt: function (n) { return at(Math.floor(n)); }
    };
  }

  function qOf(dist, q) {
    for (var i = 0; i < dist.quants.length; i++) if (Math.abs(dist.quants[i].q - q) < 1e-12) return dist.quants[i].pulls;
    return null;
  }

  // ── 输入规范化 ──────────────────────────────────────────────
  var MODES = ['none', 'hard', 'soft'];
  function normalize(raw) {
    var errors = [], warnings = [];
    raw = raw || ({});

    var mode = isBlank(raw.mode) ? 'hard' : String(raw.mode);
    if (MODES.indexOf(mode) < 0) { errors.push('保底口径只能是「无保底 / 硬保底 / 软保底」；收到「' + String(raw.mode) + '」'); }

    var cost = num(raw.cost);
    if (isBlank(raw.cost)) errors.push('请填「单次成本」（每次抽取花的钱）');
    else if (!isFinite(cost)) errors.push('「单次成本」不是有效数字：' + raw.cost);
    else if (cost <= 0) errors.push('「单次成本」必须大于 0');
    else if (cost < LIMITS.MIN_COST) errors.push('「单次成本」太小（下限 ' + LIMITS.MIN_COST + ' 元）');
    else if (cost > LIMITS.MAX_COST) errors.push('「单次成本」太大（上限 ' + LIMITS.MAX_COST + ' 元）');

    var rate = num(raw.rate);
    if (isBlank(raw.rate)) errors.push('请填「单次出货概率」（%，从你自己看到的规则里抄，页面不提供任何平台的真实概率）');
    else if (!isFinite(rate)) errors.push('「单次出货概率」不是有效数字：' + raw.rate);
    else if (rate <= 0) errors.push('「单次出货概率」必须大于 0');
    else if (rate < LIMITS.MIN_RATE) errors.push('「单次出货概率」太小（下限 ' + LIMITS.MIN_RATE + '%）');
    else if (rate > LIMITS.MAX_RATE) errors.push('「单次出货概率」不能超过 100%');

    var pity = intOf(raw.pity), softStart = intOf(raw.softStart), softStep = num(raw.softStep);
    if (mode !== 'none') {
      if (isBlank(raw.pity)) errors.push('选了保底口径，请填「多少抽必出」');
      else if (!isFinite(pity)) errors.push('「多少抽必出」必须是整数');
      else if (pity < LIMITS.MIN_PITY) errors.push('「多少抽必出」至少是 1');
      else if (pity > LIMITS.MAX_PITY) errors.push('「多少抽必出」上限 ' + LIMITS.MAX_PITY + '（更大的保底超出本页逐抽精确计算的范围）');
    }
    if (mode === 'soft') {
      if (isBlank(raw.softStart)) errors.push('软保底口径下请填「第几抽开始加概率」');
      else if (!isFinite(softStart)) errors.push('「第几抽开始加概率」必须是整数');
      else if (softStart < 1) errors.push('「第几抽开始加概率」至少是 1');
      else if (isFinite(pity) && softStart > pity) errors.push('「第几抽开始加概率」不能大于「多少抽必出」（' + pity + '）');
      if (isBlank(raw.softStep)) errors.push('软保底口径下请填「每次加多少个百分点」');
      else if (!isFinite(softStep)) errors.push('「每次加多少个百分点」不是有效数字：' + raw.softStep);
      else if (softStep <= 0) errors.push('「每次加多少个百分点」必须大于 0');
      else if (softStep > LIMITS.MAX_STEP) errors.push('「每次加多少个百分点」不能超过 100');
    }

    var targets = intOf(raw.targets);
    if (isBlank(raw.targets)) errors.push('请填「要拿到几个」');
    else if (!isFinite(targets)) errors.push('「要拿到几个」必须是整数');
    else if (targets < LIMITS.MIN_TARGETS) errors.push('「要拿到几个」至少是 1');
    else if (targets > LIMITS.MAX_TARGETS) errors.push('「要拿到几个」上限 ' + LIMITS.MAX_TARGETS);
    else if (mode !== 'none' && isFinite(pity) && pity * targets > LIMITS.MAX_PITY_TARGETS_PRODUCT) {
      errors.push('口径太大：' + pity + ' 抽 × ' + targets + ' 个 = ' + (pity * targets) + ' 抽，超过本页逐抽精确计算的上限 ' +
        LIMITS.MAX_PITY_TARGETS_PRODUCT + ' 抽（请减小保底抽数或目标数量）');
    }

    var budget = null;
    if (!isBlank(raw.budget)) {
      var b = num(raw.budget);
      if (!isFinite(b)) errors.push('「预算」不是有效数字：' + raw.budget);
      else if (b <= 0) errors.push('「预算」必须大于 0（留空表示不算预算达成的概率）');
      else budget = b;
    }

    if (errors.length) return { ok: false, errors: errors };

    var cfg = {
      mode: mode, cost: cost, rate: rate,
      pity: isFinite(pity) ? pity : null,
      softStart: isFinite(softStart) ? softStart : null,
      softStep: isFinite(softStep) ? softStep : null,
      targets: targets, budget: budget
    };

    if (mode === 'soft') {
      var top = rate + (pity - softStart + 1) * softStep;
      if (top >= 100) {
        var k100 = Math.min(pity, softStart + Math.ceil((100 - rate) / softStep) - 1);
        if (k100 < pity) warnings.push('按这条规则概率到第 ' + k100 + ' 抽就已经涨到 100%，后面 ' + (pity - k100) + ' 抽其实都是必出；页面仍按逐抽概率序列计算。');
        else warnings.push('按这条规则概率到第 ' + pity + ' 抽（也就是保底那一抽）刚好涨到 100%，前面每一抽都按它自己的概率计算。');
      } else {
        warnings.push('按这条规则，概率升到第 ' + pity + ' 抽也只有 ' + fmt(top, 4) + '%，尾巴是「第 ' + pity + ' 抽必出」兜住的。');
      }
    }
    return { ok: true, cfg: cfg, warnings: warnings };
  }

  // 单个目标（等价 targets = 1）
  function solveSingle(cfg) {
    var c1 = Object.assign({}, cfg, { targets: 1 });
    var r = solveDistribution(c1, { quants: [0.5, 0.9, 0.99] });
    return {
      meanPulls: r.mean, meanCost: r.mean * cfg.cost, closedFormMean: closedFormMean(cfg),
      p50: qOf(r, 0.5), p90: qOf(r, 0.9), p99: qOf(r, 0.99),
      maxPulls: cfg.mode === 'none' ? null : cfg.pity
    };
  }

  // 单个周期「抽满保底才出」的概率（无保底返回 null）
  function pityHitRate(cfg) {
    if (cfg.mode === 'none') return null;
    var seq = probSeq(cfg), prod = 1;
    for (var k = 0; k < cfg.pity - 1; k++) prod *= (1 - seq[k]);
    return prod;
  }

  // ── 主分析 ──────────────────────────────────────────────────
  function analyze(raw) {
    var n = normalize(raw);
    if (!n.ok) throw err(n.errors.join('；'));
    var cfg = n.cfg, warnings = n.warnings.slice();

    var total = solveDistribution(cfg);
    var single = solveSingle(cfg);

    var compare = null;
    try {
      compare = solveDistribution(Object.assign({}, cfg, { mode: 'none' }), { quants: [0.5, 0.9, 0.99] });
    } catch (e) { compare = null; }

    var budget = null;
    if (cfg.budget !== null) {
      var afford = Math.floor(cfg.budget / cfg.cost + 1e-9);
      budget = {
        amount: cfg.budget, pulls: afford, prob: total.cdfAt(afford),
        coversWorst: cfg.mode !== 'none' && afford >= total.maxPulls
      };
    }

    var reverse = LIMITS.QUANTS.map(function (q) {
      var pulls = qOf(total, q);
      return { q: q, pulls: pulls, cost: pulls === null ? null : pulls * cfg.cost };
    });

    var variants = [
      { label: '基础概率 −20%', patch: { rate: cfg.rate * 0.8 } },
      { label: '基础概率 +20%', patch: { rate: Math.min(cfg.rate * 1.2, 100) } },
      { label: '单次成本 +20%', patch: { cost: cfg.cost * 1.2 } },
      { label: '单次成本 −20%', patch: { cost: cfg.cost * 0.8 } }
    ];
    if (cfg.mode !== 'none') {
      var dN = Math.max(1, Math.round(cfg.pity * 0.1));
      variants.push({ label: '保底抽数 −' + dN, patch: { pity: cfg.pity - dN, softStart: cfg.mode === 'soft' ? Math.min(cfg.softStart, cfg.pity - dN) : cfg.softStart } });
      variants.push({ label: '保底抽数 +' + dN, patch: { pity: cfg.pity + dN, softStart: cfg.softStart } });
    }
    var sens = variants.map(function (v) {
      var c2 = Object.assign({}, cfg, v.patch);
      if (c2.mode !== 'none') {
        if (c2.pity < 1) return { label: v.label, skipped: '保底抽数会小于 1' };
        if (c2.pity > LIMITS.MAX_PITY) return { label: v.label, skipped: '超出保底抽数上限' };
        if (c2.pity * c2.targets > LIMITS.MAX_PITY_TARGETS_PRODUCT) return { label: v.label, skipped: '超出本页精确计算上限' };
        if (c2.mode === 'soft' && (!c2.softStart || c2.softStart > c2.pity)) return { label: v.label, skipped: '软保底起始抽超出范围' };
      }
      try {
        var r = solveDistribution(c2);
        return { label: v.label, meanPulls: r.mean, meanCost: r.mean * c2.cost, maxPulls: r.maxPulls,
          p90: qOf(r, 0.9), p99: qOf(r, 0.99) };
      } catch (e) { return { label: v.label, skipped: (e.userMessage || e.message || String(e)).slice(0, 90) }; }
    });

    // 抽数分档表：在分布主体的 10% / 25% / 50% / 75% / 90% / 100% 位置上给出累计概率
    // 有保底时主体就是硬上限「抽满保底」；无保底时主体取中位数的两倍（硬上限只是尾部截断点，没有含义）
    var med = qOf(total, 0.5);
    var rangeEnd = cfg.mode === 'none' ? Math.max(2, Math.round((med || total.maxPulls) * 2)) : total.maxPulls;
    var fr = [0.1, 0.25, 0.5, 0.75, 0.9, 1], seen = {}, table = [];
    fr.forEach(function (f) {
      var p = Math.max(1, Math.round(rangeEnd * f));
      if (seen[p]) return; seen[p] = 1;
      table.push({ pulls: p, cost: p * cfg.cost, cdf: total.cdfAt(p) });
    });
    table.sort(function (a, b) { return a.pulls - b.pulls; });

    // 曲线采样（纯数据，供页面画累计概率曲线；也随 JSON 备份一起导出）
    var PT = 60, curve = [], ci, cp;
    for (ci = 0; ci <= PT; ci++) { cp = Math.round(rangeEnd * ci / PT); curve.push({ pulls: cp, cdf: total.cdfAt(cp) }); }

    var notes = [];
    notes.push('概率与保底规则全部由你自己填写；本页不提供任何游戏、平台或活动的真实概率，也不预测任何一次抽取的结果。');
    notes.push('每次出货后保底计数重置（按 i.i.d. 周期处理）；若实际规则里保底跨目标不重置，本页不适用。');
    if (cfg.mode === 'none') notes.push('无保底口径下抽数没有上限，页面把尾巴截断在累计概率 1 − ' + LIMITS.TAIL_EPS + ' 处（更远的尾巴对期望与分位数的贡献小于 1e-12）。');
    else notes.push('保底口径下抽数有硬上限：' + cfg.targets + ' 个目标最多 ' + cfg.targets + ' × ' + cfg.pity + ' = ' + total.maxPulls + ' 抽。');
    notes.push('期望是长期平均值，不等于「你这次会花多少」：一半人比中位数少、一半人比中位数多。');
    if (total.tail > LIMITS.TAIL_EPS * 10) notes.push('本次累计概率未收敛到 1（剩余 ' + fmt(total.tail, 8) + '），结果按已算到的抽数给出。');

    return {
      ok: true, input: cfg, warnings: warnings, notes: notes, single: single,
      pityHitRate: pityHitRate(cfg),
      table: table,
      total: {
        meanPulls: total.mean, meanCost: total.mean * cfg.cost,
        worstPulls: total.maxPulls, worstCost: cfg.mode === 'none' ? null : total.maxPulls * cfg.cost,
        quants: total.quants.map(function (x) { return { q: x.q, pulls: x.pulls, cost: x.pulls * cfg.cost }; }),
        curve: curve, rangeEnd: rangeEnd, tail: total.tail
      },
      compare: compare ? {
        meanPulls: compare.mean, meanCost: compare.mean * cfg.cost,
        p50: qOf(compare, 0.5), p90: qOf(compare, 0.9), p99: qOf(compare, 0.99)
      } : null,
      budget: budget, reverse: reverse, sensitivity: sens
    };
  }

  // ── 格式化 ──────────────────────────────────────────────────
  function fmt(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    d = (d === undefined) ? 2 : d;
    var s = Math.abs(v) >= 1e15 ? v.toExponential(6) : v.toFixed(d);
    var parts = s.split('.');
    parts[0] = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return parts.join('.');
  }
  function fmtInt(v) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return Math.round(v).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  }
  function pct(v, d) {
    if (v === null || v === undefined || !isFinite(v)) return '—';
    return fmt(v * 100, d === undefined ? 2 : d) + '%';
  }

  var API = {
    LIMITS: LIMITS, num: num, intOf: intOf, isBlank: isBlank,
    probSeq: probSeq, closedFormMean: closedFormMean, pityHitRate: pityHitRate,
    normalize: normalize, analyze: analyze, solveDistribution: solveDistribution, solveSingle: solveSingle,
    fmt: fmt, fmtInt: fmtInt, pct: pct,
    defaults: { cost: '12', rate: '0.6', mode: 'hard', pity: '90', softStart: '74', softStep: '6', targets: '1', budget: '1000' }
  };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  global.AppCore = API;
})(typeof window !== 'undefined' ? window : globalThis);
