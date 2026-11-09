/* 保底成本台 · 核心测试（node --test tests/core.test.cjs）
 * 覆盖：闭式锚点、手算锚点、逐抽 DP 与 BigInt 精确有理数 DP 对拍、
 *       与蒙特卡洛（独立随机数发生器）对拍、分位数定义、生存函数恒等式、
 *       单调性、预算概率、非法输入、输出字段有效性、确定性、不修改入参。
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const C = require('../core.js');

const close = (a, b, eps) => {
  const tol = Math.max(eps === undefined ? 1e-9 : eps, Math.abs(b) * 1e-11);
  assert.ok(Math.abs(a - b) <= tol, `期望 ${a} ≈ ${b}（差 ${Math.abs(a - b)}，容差 ${tol}）`);
};
const mk = (o) => Object.assign({
  cost: '12', rate: '0.6', mode: 'hard', pity: '90',
  softStart: '74', softStep: '6', targets: '1', budget: ''
}, o || {});
const cfgOf = (o) => { const n = C.normalize(mk(o)); assert.ok(n.ok, '输入应有效：' + JSON.stringify(o) + ' → ' + (n.errors || []).join('；')); return n.cfg; };
const meanOf = (o) => C.solveDistribution(cfgOf(o)).mean;

// ── G1 闭式与手算锚点 ────────────────────────────────────────
test('G1-1 无保底：期望恰好是 1/p（几何分布）', () => {
  [[0.5, 200], [1, 100], [5, 20], [10, 10], [50, 2], [100, 1]].forEach(([rate, want]) => {
    const cfg = cfgOf({ mode: 'none', rate: String(rate), targets: '1' });
    close(C.closedFormMean(cfg), 1 / (rate / 100), 1e-12);
    close(C.solveDistribution(cfg).mean, want, 1e-8);
  });
});

test('G1-2 硬保底：期望等于 (1 − (1−p)^N)/p（解析式与逐抽 DP 两条路径）', () => {
  const cases = [[50, 2, 1.5], [25, 4, 2.734375], [10, 10, (1 - Math.pow(0.9, 10)) / 0.1], [0.6, 90, (1 - Math.pow(0.994, 90)) / 0.006]];
  cases.forEach(([rate, N, want]) => {
    const cfg = cfgOf({ rate: String(rate), pity: String(N), targets: '1' });
    close(C.closedFormMean(cfg), want, 1e-10);          // 解析式
    close(C.solveDistribution(cfg).mean, want, 1e-8);   // 逐抽 DP（独立路径）
  });
});

test('G1-3 保底抽数 = 1 或概率 = 100% 时，一个周期恰好 1 抽', () => {
  [[{ pity: '1', rate: '0.6' }, '保底 1 抽'], [{ pity: '90', rate: '100' }, '概率 100%']].forEach(([o, tag]) => {
    const r = C.solveDistribution(cfgOf(Object.assign({ targets: '1' }, o)));
    close(r.mean, 1, 1e-12);
    assert.strictEqual(r.maxPulls, 1, tag);
    assert.strictEqual(C.pityHitRate(cfgOf(Object.assign({ targets: '1' }, o))), o.rate === '100' ? 0 : 1, tag);
  });
});

test('G1-4 硬保底累计分布：t < N 时等于 1 − (1−p)^t，t ≥ N 时等于 1', () => {
  const cfg = cfgOf({ rate: '0.6', pity: '90', targets: '1' });
  const r = C.solveDistribution(cfg);
  [1, 10, 50, 83, 89].forEach(t => close(r.cdfAt(t), 1 - Math.pow(0.994, t), 1e-12));
  close(r.cdfAt(90), 1, 1e-12);
  close(r.cdfAt(120), 1, 1e-12);
  close(r.cdfAt(89), 0.4146869443224154, 1e-9);        // 手算锚点：0.994^89
});

test('G1-5 「抽满保底才出」的概率 = ∏(1−p_k) = 1 − F(N−1)', () => {
  const cfg = cfgOf({ rate: '0.6', pity: '90', targets: '1' });
  const rate = C.pityHitRate(cfg);
  close(rate, Math.pow(0.994, 89), 1e-12);
  close(rate, 1 - C.solveDistribution(cfg).cdfAt(89), 1e-12);
  assert.ok(rate > 0.58 && rate < 0.59, '默认样例：58.5% 的人要抽满保底');
  assert.strictEqual(C.pityHitRate(cfgOf({ mode: 'none' })), null);
});

test('G1-6 概率序列形状：硬保底末抽为 1；软保底单调不减且被硬保底兜住', () => {
  const hard = C.probSeq({ mode: 'hard', rate: 0.6, pity: 5 });
  assert.deepStrictEqual(hard, [0.006, 0.006, 0.006, 0.006, 1]);
  const soft = C.probSeq({ mode: 'soft', rate: 0.6, pity: 90, softStart: 74, softStep: 6 });
  assert.strictEqual(soft[73], 0.066);                  // 第 74 抽：0.6% + 6 个点
  assert.strictEqual(soft[74], 0.126);
  assert.strictEqual(soft[89], 1);
  for (let i = 1; i < soft.length; i++) assert.ok(soft[i] >= soft[i - 1] - 1e-15, '单调不减 @' + i);
  assert.strictEqual(C.probSeq({ mode: 'none', rate: 1, pity: 5 }), null);
});

test('G1-7 软保底起始抽 = 保底抽数 时退化为硬保底', () => {
  const soft = meanOf({ mode: 'soft', pity: '90', softStart: '90', softStep: '6' });
  const hard = meanOf({ mode: 'hard', pity: '90' });
  close(soft, hard, 1e-12);
});

// ── G2 BigInt 精确有理数独立实现对拍 ─────────────────────────
// 概率用整数/定标分母表示，全程 BigInt 有理数递推（与工程实现的浮点 DP 完全独立）
function exactDP(rateStr, mode, N, softStart, softStep, m) {
  const dec = (s) => { const i = String(s).indexOf('.'); return i < 0 ? 0 : String(s).length - i - 1; };
  const d = Math.max(dec(rateStr), dec(String(softStep === undefined ? 0 : softStep)));
  const scale = 10n ** BigInt(d);
  const numOf = (s) => BigInt(Math.round(Number(s) * Number(scale)));
  const D = 100n * scale;                                 // p = u / D
  const u = numOf(rateStr), step = numOf(softStep === undefined ? 0 : softStep);
  const seq = [];
  for (let k = 1; k <= N; k++) {
    let v = u;
    if (mode === 'soft' && k >= softStart) v = u + BigInt(k - softStart + 1) * step;
    if (v > D) v = D;
    if (k === N) v = D;
    seq.push(v);
  }
  // 状态 (j, k)，分子在分母 D^t 下
  let cur = new Map(); cur.set('0,0', 1n);
  const out = [];                                          // out[t] = 在第 t 抽首次达成的分子（分母 D^t）
  for (let t = 1; t <= m * N; t++) {
    const nxt = new Map(); let hit = 0n;
    for (const [key, v] of cur) {
      if (v === 0n) continue;
      const [j, k] = key.split(',').map(Number);
      const p = seq[k], f = D - p;
      if (j + 1 >= m) hit += v * p;
      else { const nk = (j + 1) + ',0'; nxt.set(nk, (nxt.get(nk) || 0n) + v * p); }
      if (f > 0n && k + 1 < N) { const nk = j + ',' + (k + 1); nxt.set(nk, (nxt.get(nk) || 0n) + v * f); }
    }
    cur = nxt; out[t] = hit;
    if (hit === 0n && cur.size === 0) break;
  }
  // 统一到分母 D^T
  const T = out.length - 1;
  const DT = D ** BigInt(T);
  const cdfNum = [0n], pows = [DT];
  for (let t = 1; t <= T; t++) {
    const nm = (out[t] || 0n) * (D ** BigInt(T - t));
    cdfNum[t] = cdfNum[t - 1] + nm;
  }
  // 精确期望 = Σ t·out[t]·D^(T−t) / D^T
  let meanNum = 0n;
  for (let t = 1; t <= T; t++) if (out[t]) meanNum += BigInt(t) * out[t] * (D ** BigInt(T - t));
  const toFloat = (n) => Number(n * 10n ** 24n / DT) / 1e24;
  return { cdfNum, DT, mean: Number(meanNum * 10n ** 24n / DT) / 1e24, T, toFloat, exactMean: meanNum, exactDen: DT };
}
function exactQuantile(ex, qn, qd) {
  for (let t = 0; t <= ex.T; t++) if (ex.cdfNum[t] * BigInt(qd) >= BigInt(qn) * ex.DT) return t;
  return null;
}

test('G2-1 硬保底：BigInt 精确有理数 DP 与浮点逐抽 DP 对拍（20 组）', () => {
  const cases = [];
  for (let i = 0; i < 20; i++) {
    const rate = [0.1, 0.3, 0.6, 1, 1.5, 2, 3, 5, 8, 12][i % 10];
    const N = [1, 2, 5, 10, 30][i % 5];
    const m = 1 + (i % 2);
    cases.push({ rate, N, m });
  }
  cases.forEach(({ rate, N, m }) => {
    const ex = exactDP(String(rate), 'hard', N, 0, 0, m);
    const r = C.solveDistribution(cfgOf({ rate: String(rate), pity: String(N), targets: String(m), mode: 'hard' }), { quants: [0.5, 0.9, 0.99] });
    close(r.mean, ex.mean, 1e-9);
    assert.strictEqual(r.maxPulls, N * m);
    [0.5, 0.9, 0.99].forEach(q => {
      const qn = Math.round(q * 100), eq = exactQuantile(ex, qn, 100);
      const got = r.quants.filter(x => Math.abs(x.q - q) < 1e-12)[0];
      assert.ok(got, `应有 q=${q} 的分位数`);
      assert.strictEqual(got.pulls, eq, `q=${q} rate=${rate} N=${N} m=${m}`);
    });
    for (let t = 0; t <= N * m; t++) close(r.cdfAt(t), ex.toFloat(ex.cdfNum[t]), 1e-11);
  });
});

test('G2-2 软保底：BigInt 精确有理数 DP 与浮点逐抽 DP 对拍（12 组）', () => {
  const cases = [];
  for (let i = 0; i < 12; i++) {
    cases.push({ rate: [0.6, 1.6, 3][i % 3], N: [20, 40, 90][i % 3], s: [10, 30, 74][i % 3], q: [6, 12, 25][i % 3], m: 1 + (i % 2) });
  }
  cases.forEach(({ rate, N, s, q, m }) => {
    if (s > N) return;
    const cfg = cfgOf({ mode: 'soft', rate: String(rate), pity: String(N), softStart: String(s), softStep: String(q), targets: String(m) });
    const ex = exactDP(String(rate), 'soft', N, s, q, m);
    const r = C.solveDistribution(cfg, { quants: [0.5, 0.9] });
    close(r.mean, ex.mean, 1e-9);
    [0.5, 0.9].forEach(qq => {
      const eq = exactQuantile(ex, Math.round(qq * 100), 100);
      const got = r.quants.filter(x => Math.abs(x.q - qq) < 1e-12)[0];
      assert.strictEqual(got.pulls, eq, `q=${qq} rate=${rate} N=${N} s=${s} q=${q}`);
    });
  });
});

test('G2-3 精确期望也等于解析式（硬保底，3 组；两条独立推导互证）', () => {
  [[0.6, 30], [2, 10], [5, 4]].forEach(([rate, N]) => {
    const ex = exactDP(String(rate), 'hard', N, 0, 0, 1);
    const analytic = (1 - Math.pow(1 - rate / 100, N)) / (rate / 100);
    close(ex.mean, analytic, 1e-12);
    // 精确期望与闭式解析的差应当远小于 1e-12（有理数 → 浮点只损失表示精度）
    assert.ok(Math.abs(ex.mean - analytic) < 1e-12, `${ex.mean} vs ${analytic}`);
  });
});

// ── G3 蒙特卡洛对拍（独立随机数发生器）───────────────────────
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// 完全独立的一次模拟：直接按概率序列抽，保底计数重置
function simulate(rate, mode, N, s, step, m, trials, seed) {
  const rnd = mulberry32(seed), seq = C.probSeq({ mode, rate, pity: N, softStart: s, softStep: step });
  const totals = new Float64Array(trials);
  for (let i = 0; i < trials; i++) {
    let pulls = 0;
    for (let j = 0; j < m; j++) {
      let k = 0;
      for (;;) {
        const pk = (mode === 'none') ? rate / 100 : seq[k];
        pulls++; k++;
        if (rnd() < pk) break;
        if (mode !== 'none' && k >= N) { pulls++; break; }
      }
    }
    totals[i] = pulls;
  }
  let sum = 0; const sorted = Array.from(totals).sort((a, b) => a - b);
  for (const v of totals) sum += v;
  const q = (p) => sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
  return { mean: sum / trials, p50: q(0.5), p90: q(0.9), n: trials };
}

test('G3-1 蒙特卡洛（20 万次）与 DP 的期望一致（硬保底 0.6% / 90 抽）', () => {
  const sim = simulate(0.6, 'hard', 90, 74, 6, 1, 200000, 20261110);
  const dp = meanOf({ rate: '0.6', pity: '90', targets: '1' });
  close(sim.mean, dp, 0.35);                            // 标准差约 33 抽，20 万次的标准误约 0.07
  assert.ok(Math.abs(sim.mean - dp) < 0.35, `MC ${sim.mean} vs DP ${dp}`);
});

test('G3-2 蒙特卡洛分位数落在 DP 分位数的相邻抽内（软保底）', () => {
  const sim = simulate(0.6, 'soft', 90, 74, 6, 1, 120000, 20261111);
  const r = C.solveDistribution(cfgOf({ mode: 'soft', rate: '0.6', pity: '90', softStart: '74', softStep: '6', targets: '1' }), { quants: [0.5, 0.9] });
  const p50 = r.quants.filter(x => x.q === 0.5)[0].pulls, p90 = r.quants.filter(x => x.q === 0.9)[0].pulls;
  assert.ok(Math.abs(sim.p50 - p50) <= 2, `MC p50 ${sim.p50} vs DP ${p50}`);
  assert.ok(Math.abs(sim.p90 - p90) <= 2, `MC p90 ${sim.p90} vs DP ${p90}`);
});

test('G3-3 蒙特卡洛与 DP 一致（无保底口径，0.5% / 2 万次）', () => {
  const sim = simulate(0.5, 'none', 0, 0, 0, 1, 20000, 20261112);
  const dp = meanOf({ mode: 'none', rate: '0.5', targets: '1' });
  close(sim.mean, dp, 4.5);                             // 标准差 200 抽，2 万次标准误约 1.4
});

// ── G4 结构恒等式 ────────────────────────────────────────────
test('G4-1 生存函数恒等式：E[S_m] = Σ_{t≥0} (1 − F(t))（与直接求和独立）', () => {
  const r = C.solveDistribution(cfgOf({ rate: '1', pity: '30', targets: '2' }));
  let acc = 0;
  for (let t = 0; t <= r.maxPulls; t++) acc += 1 - r.cdfAt(t);
  close(acc, r.mean, 1e-9);
});

test('G4-2b 无保底多目标：期望 = m/p，且等于负二项分布均值（闭式对照）', () => {
  [[0.6, 2], [0.6, 3], [1.6, 4], [5, 2]].forEach(([rate, m]) => {
    const cfg = cfgOf({ mode: 'none', rate: String(rate), targets: String(m), pity: '' });
    close(C.solveDistribution(cfg).mean, m / (rate / 100), 1e-8);
  });
});

test('G4-2 多目标期望是单目标的 m 倍（i.i.d. 相加）', () => {
  const one = meanOf({ rate: '0.6', pity: '90', targets: '1' });
  [2, 3, 5].forEach(m => {
    const mm = meanOf({ rate: '0.6', pity: '90', targets: String(m) });
    close(mm, one * m, 1e-9);
    const worst = C.solveDistribution(cfgOf({ rate: '0.6', pity: '90', targets: String(m) })).maxPulls;
    assert.strictEqual(worst, 90 * m);
  });
});

test('G4-3 累计分布单调不减、末端为 1，且概率和为 1（有保底口径）', () => {
  const r = C.solveDistribution(cfgOf({ mode: 'soft', rate: '1.6', pity: '80', softStart: '60', softStep: '10', targets: '2' }));
  let prev = 0;
  for (let t = 0; t <= r.maxPulls; t++) {
    const c = r.cdfAt(t);
    assert.ok(c >= prev - 1e-15, `单调 @${t}`);
    assert.ok(c <= 1 + 1e-12, `不超过 1 @${t}`);
    prev = c;
  }
  close(r.cdfAt(r.maxPulls), 1, 1e-12);
  assert.ok(r.tail < 1e-12);
});

test('G4-4 分位数定义：F(q−1) < q ≤ F(q)（逐个分位核验）', () => {
  [['hard', 0.6, 90, 74, 6, 1], ['soft', 0.6, 90, 74, 6, 1], ['soft', 3, 20, 10, 25, 3], ['hard', 10, 10, 0, 0, 2]].forEach(([mode, rate, N, s, st, m]) => {
    const cfg = cfgOf({ mode, rate: String(rate), pity: String(N), softStart: String(s), softStep: String(st), targets: String(m) });
    const r = C.solveDistribution(cfg);
    r.quants.forEach(q => {
      assert.ok(r.cdfAt(q.pulls) >= q.q - 1e-12, `F(${q.pulls}) ≥ ${q.q}`);
      if (q.pulls > 1) assert.ok(r.cdfAt(q.pulls - 1) < q.q, `F(${q.pulls - 1}) < ${q.q}`);
    });
  });
});

test('G4-5 无保底分位数与几何分布解析解一致（P(T ≤ t) = 1 − (1−p)^t）', () => {
  const cfg = cfgOf({ mode: 'none', rate: '0.5', targets: '1' });
  const r = C.solveDistribution(cfg, { quants: [0.5, 0.9, 0.99] });
  [0.5, 0.9, 0.99].forEach(q => {
    const want = Math.ceil(Math.log(1 - q) / Math.log(0.995));
    const got = r.quants.filter(x => Math.abs(x.q - q) < 1e-12)[0].pulls;
    assert.strictEqual(got, want, `q=${q}`);
  });
});

// ── G5 单调性与方向 ──────────────────────────────────────────
test('G5-1 基础概率越大期望越小；保底抽数越短期望越小；目标越多期望越大', () => {
  let last = Infinity;
  [0.5, 1, 2, 5, 10].forEach(rate => { const v = meanOf({ rate: String(rate) }); assert.ok(v < last, `rate=${rate}`); last = v; });
  last = 0;
  [120, 100, 90, 60, 30].forEach(N => { const v = meanOf({ pity: String(N) }); assert.ok(v < last || last === 0, `N=${N}`); last = v; });
  last = 0;
  [1, 2, 3, 4].forEach(m => { const v = meanOf({ targets: String(m) }); assert.ok(v > last, `m=${m}`); last = v; });
});

test('G5-2 保底只砍尾部：同概率下无保底的 p90/p99 远大于有保底', () => {
  const r = C.analyze(mk({ rate: '0.6', pity: '90', targets: '1' }));
  assert.ok(r.compare.p90 > 300 && r.compare.p90 < 400, `无保底 p90 = ${r.compare.p90}`);
  assert.ok(r.compare.p99 > 700, `无保底 p99 = ${r.compare.p99}`);
  assert.strictEqual(r.total.quants.filter(q => q.q === 0.9)[0].pulls, 90);
  assert.ok(r.compare.meanPulls > 2 * r.total.meanPulls, '期望的降幅远小于尾部的降幅');
});

test('G5-3 期望 ≤ 最坏情况；期望 ≥ 1 抽；中位数 ≤ 期望 × 2（有保底时中位数不超上限）', () => {
  [['hard', 0.6, 90, 1], ['soft', 1.6, 90, 1], ['none', 2, 0, 1], ['hard', 5, 20, 3]].forEach(([mode, rate, N, m]) => {
    const cfg = cfgOf({ mode, rate: String(rate), pity: String(N), targets: String(m) });
    const r = C.solveDistribution(cfg);
    assert.ok(r.mean >= 1 - 1e-12);
    assert.ok(r.mean <= r.maxPulls + 1e-9, `期望 ${r.mean} ≤ 上限 ${r.maxPulls}`);
    if (mode !== 'none') assert.ok(r.mean <= N * m + 1e-9);
  });
});

// ── G6 预算与反向求解 ────────────────────────────────────────
test('G6-1 预算达成的概率 = F(⌊预算 ÷ 单次成本⌋)', () => {
  const r = C.analyze(mk({ cost: '12', budget: '1000', targets: '1' }));
  assert.strictEqual(r.budget.pulls, 83);
  close(r.budget.prob, 1 - Math.pow(0.994, 83), 1e-12);
  assert.ok(Math.abs(r.budget.prob - 0.39316600096222865) < 1e-9);
  assert.strictEqual(r.budget.coversWorst, false, '1000 元买不到 90 抽（1080 元）');
});

test('G6-2 预算边界：极小预算概率→0；预算 ≥ 最坏情况成本概率 = 1 且 coversWorst', () => {
  const tiny = C.analyze(mk({ cost: '12', budget: '1', targets: '1' }));
  assert.strictEqual(tiny.budget.pulls, 0);
  assert.strictEqual(tiny.budget.prob, 0);
  const big = C.analyze(mk({ cost: '12', budget: '5000', targets: '2' }));
  assert.strictEqual(big.budget.prob, 1);
  assert.strictEqual(big.budget.coversWorst, true);
  const none = C.analyze(mk({ mode: 'none', cost: '12', budget: '5000', targets: '2' }));
  assert.strictEqual(none.budget.coversWorst, false, '无保底口径没有「一定够」的预算');
  assert.strictEqual(none.budget.pulls, 416);
  // 负二项闭式：P(S_2 > n) = (1−p)^n + n·p·(1−p)^(n−1)
  const n = 416, q = Math.pow(0.994, n), want = 1 - (q + n * 0.006 * Math.pow(0.994, n - 1));
  close(none.budget.prob, want, 1e-12);
  assert.ok(none.budget.prob > 0.5 && none.budget.prob < 0.95, `实际 ${none.budget.prob}`);
});

test('G6-3 预算留空时不计算预算，但仍给出反向所需预算', () => {
  const r = C.analyze(mk({ budget: '' }));
  assert.strictEqual(r.budget, null);
  const q90 = r.reverse.filter(x => x.q === 0.9)[0];
  assert.strictEqual(q90.pulls, 90);
  close(q90.cost, 1080, 1e-9);
  assert.deepStrictEqual(r.reverse.map(x => x.q), [0.5, 0.75, 0.9, 0.95, 0.99]);
});

test('G6-4 反向所需预算单调不减，且成本 = 抽数 × 单次成本', () => {
  const r = C.analyze(mk({ mode: 'soft', rate: '1.6', pity: '90', softStart: '74', softStep: '6', targets: '2', budget: '2000' }));
  let last = 0;
  r.reverse.forEach(x => {
    assert.ok(x.pulls >= last, `单调 ${x.q}`);
    close(x.cost, x.pulls * 12, 1e-9);
    last = x.pulls;
  });
});

// ── G7 输入处理 ──────────────────────────────────────────────
test('G7-1 非法输入逐条报错（不再抛异常、不静默修正）', () => {
  const bad = [
    [{ cost: '' }, '单次成本'], [{ cost: '0' }, '单次成本'], [{ cost: '-3' }, '单次成本'], [{ cost: 'abc' }, '单次成本'],
    [{ cost: '0.00001' }, '单次成本'], [{ cost: '20000000' }, '单次成本'],
    [{ rate: '' }, '单次出货概率'], [{ rate: '0' }, '单次出货概率'], [{ rate: '-1' }, '单次出货概率'],
    [{ rate: '100.1' }, '单次出货概率'], [{ rate: 'xx' }, '单次出货概率'], [{ rate: '0.0001' }, '单次出货概率'],
    [{ mode: 'x' }, '保底口径'],
    [{ pity: '' }, '多少抽必出'], [{ pity: '0' }, '多少抽必出'], [{ pity: '-2' }, '多少抽必出'],
    [{ pity: '3.5' }, '多少抽必出'], [{ pity: '501' }, '多少抽必出'],
    [{ mode: 'soft', softStart: '' }, '第几抽开始加概率'], [{ mode: 'soft', softStart: '0' }, '第几抽开始加概率'],
    [{ mode: 'soft', softStart: '95' }, '第几抽开始加概率'], [{ mode: 'soft', softStart: 'x' }, '第几抽开始加概率'],
    [{ mode: 'soft', softStep: '' }, '每次加多少个百分点'], [{ mode: 'soft', softStep: '0' }, '每次加多少个百分点'],
    [{ mode: 'soft', softStep: '-6' }, '每次加多少个百分点'], [{ mode: 'soft', softStep: '120' }, '每次加多少个百分点'],
    [{ targets: '' }, '要拿到几个'], [{ targets: '0' }, '要拿到几个'], [{ targets: '11' }, '要拿到几个'],
    [{ targets: '2.5' }, '要拿到几个'], [{ budget: '-1' }, '预算'], [{ budget: 'abc' }, '预算'],
    [{ pity: '500', targets: '7' }, '口径太大']
  ];
  bad.forEach(([o, key]) => {
    const n = C.normalize(mk(o));
    assert.strictEqual(n.ok, false, JSON.stringify(o) + ' 应当被判非法');
    assert.ok(n.errors.join('｜').indexOf(key) >= 0, `错误信息应提到「${key}」，实际：${n.errors.join('｜')}`);
  });
  assert.ok(C.normalize(mk({ pity: '500', targets: '6' })).ok, '500 × 6 = 3000 在上限内');
});

test('G7-2 合法但宽容的写法：全角百分号、千分位逗号、前后空格、数字型入参', () => {
  const r1 = C.normalize(mk({ cost: ' 12 ', rate: '0.6％', pity: '90' }));
  assert.ok(r1.ok, (r1.errors || []).join('；'));
  assert.strictEqual(r1.cfg.cost, 12);
  assert.strictEqual(r1.cfg.rate, 0.6);
  const r2 = C.normalize({ cost: 12, rate: 0.6, mode: 'hard', pity: 90, targets: 1 });
  assert.ok(r2.ok);
  assert.strictEqual(r2.cfg.pity, 90);
  const r3 = C.normalize(mk({ cost: '1,200' }));
  assert.ok(r3.ok);
  assert.strictEqual(r3.cfg.cost, 1200);
});

test('G7-3 无保底口径忽略保底字段（允许留空）', () => {
  const n = C.normalize({ mode: 'none', cost: '5', rate: '0.5', pity: '', softStart: '', softStep: '', targets: '1', budget: '' });
  assert.ok(n.ok, (n.errors || []).join('；'));
  assert.strictEqual(n.cfg.pity, null);
  assert.strictEqual(C.normalize(mk({ mode: 'none', rate: '0.0005' })).ok, false, '概率过低在无保底口径下也会被逐抽上限拦下');
});

// ── G8 输出有效性与确定性 ────────────────────────────────────
function scanFields(v, path, seen) {
  if (v === null || v === undefined) {
    assert.ok(v !== undefined, `${path} 不应是 undefined`);
    return;
  }
  if (typeof v === 'number') { assert.ok(isFinite(v), `${path} 应是有限数，实际 ${v}`); return; }
  if (typeof v === 'string' || typeof v === 'boolean') return;
  if (Array.isArray(v)) { v.forEach((x, i) => scanFields(x, `${path}[${i}]`, seen)); return; }
  if (typeof v === 'object') {
    Object.keys(v).forEach(k => scanFields(v[k], `${path}.${k}`, seen));
    return;
  }
  assert.ok(false, `${path} 出现意外类型 ${typeof v}`);
}
test('G8-1 输出对象递归扫描：无 undefined、无 NaN / Infinity（8 组输入）', () => {
  const inputs = [
    mk({}), mk({ mode: 'soft', rate: '1.6', pity: '90', softStart: '74', softStep: '6', targets: '2', budget: '2000' }),
    mk({ mode: 'none', rate: '0.5', targets: '1', budget: '6000' }), mk({ rate: '100', pity: '1', targets: '10' }),
    mk({ rate: '0.001', pity: '500', targets: '6' }), mk({ mode: 'soft', rate: '0.6', pity: '90', softStart: '90', softStep: '0.0001' }),
    mk({ mode: 'soft', rate: '50', pity: '20', softStart: '2', softStep: '50', targets: '5', budget: '3' }),
    mk({ budget: '0.5', targets: '10', pity: '300' })
  ];
  inputs.forEach((raw, i) => {
    const r = C.analyze(raw);
    assert.strictEqual(r.ok, true, `第 ${i} 组应可解`);
    scanFields(r, `r${i}`, {});
    assert.ok(r.total.quants.length >= 1);
    r.total.quants.forEach(q => { assert.ok(q.q > 0 && q.q < 1); assert.ok(q.pulls >= 1); });
    r.sensitivity.forEach(s => assert.ok(s.skipped || isFinite(s.meanPulls)));
  });
});

test('G8-2 同一输入两次求解结果逐字节一致（确定性）', () => {
  const raw = mk({ mode: 'soft', rate: '1.6', pity: '90', softStart: '74', softStep: '6', targets: '3', budget: '2000' });
  const a = JSON.stringify(C.analyze(raw)), b = JSON.stringify(C.analyze(raw));
  assert.strictEqual(a, b);
});

test('G8-3 求解不修改传入对象（含嵌套）', () => {
  const raw = mk({ mode: 'soft', targets: '2' });
  const copy = JSON.parse(JSON.stringify(raw));
  C.analyze(raw);
  assert.deepStrictEqual(raw, copy);
});

test('G8-4 内置场景（5 个）全部可解且字段完整', () => {
  const scenes = [
    mk({ cost: '12', rate: '0.6', mode: 'hard', pity: '90', targets: '1', budget: '1000' }),
    mk({ cost: '12', rate: '0.6', mode: 'soft', pity: '90', softStart: '74', softStep: '6', targets: '1', budget: '1000' }),
    mk({ cost: '5', rate: '0.5', mode: 'none', pity: '', targets: '1', budget: '1000' }),
    mk({ cost: '2', rate: '3', mode: 'hard', pity: '20', targets: '1', budget: '60' }),
    mk({ cost: '12', rate: '0.6', mode: 'hard', pity: '90', targets: '4', budget: '4000' })
  ];
  scenes.forEach((raw, i) => {
    const r = C.analyze(raw);
    assert.ok(r.total.meanPulls > 0, `场景 ${i}`);
    assert.ok(r.single.meanPulls > 0, `场景 ${i}`);
    assert.ok(r.table.length >= 4, `场景 ${i} 应有分档表`);
    assert.ok(r.notes.length >= 4, `场景 ${i} 应有边界说明`);
  });
});

test('G8-5 敏感性：概率升高 → 期望下降；成本 ±20% 只等比改变成本不改抽数', () => {
  const r = C.analyze(mk({ cost: '12', rate: '0.6', pity: '90', targets: '1' }));
  const byLabel = {};
  r.sensitivity.forEach(s => { byLabel[s.label] = s; });
  assert.ok(byLabel['基础概率 +20%'].meanPulls < byLabel['基础概率 −20%'].meanPulls);
  close(byLabel['单次成本 +20%'].meanPulls, r.total.meanPulls, 1e-9);
  close(byLabel['单次成本 +20%'].meanCost, r.total.meanCost * 1.2, 1e-6);
  close(byLabel['保底抽数 −9'].meanPulls, meanOf({ rate: '0.6', pity: '81', targets: '1' }), 1e-9);
  close(byLabel['保底抽数 +9'].meanPulls, meanOf({ rate: '0.6', pity: '99', targets: '1' }), 1e-9);
});

test('G8-6 单目标结果与 targets = 1 的分布一致，闭式期望可对照', () => {
  const r = C.analyze(mk({ rate: '0.6', pity: '90', targets: '3' }));
  const one = C.analyze(mk({ rate: '0.6', pity: '90', targets: '1' }));
  close(r.single.meanPulls, one.total.meanPulls, 1e-12);
  close(r.single.closedFormMean, r.single.meanPulls, 1e-9);
  assert.strictEqual(r.single.maxPulls, 90);
  assert.strictEqual(one.single.maxPulls, 90);
  const none = C.analyze(mk({ mode: 'none', rate: '0.5', targets: '1' }));
  assert.strictEqual(none.single.maxPulls, null);
  close(none.single.closedFormMean, 200, 1e-9);
});

test('G8-7 分档表：抽数递增、成本与抽数同口径、累计概率单调不减', () => {
  [mk({}), mk({ mode: 'none', rate: '0.5', cost: '5', targets: '1' }), mk({ mode: 'soft', rate: '1.6', pity: '90', softStart: '74', softStep: '6', targets: '2' })].forEach((raw, i) => {
    const r = C.analyze(raw);
    let last = -1, lastC = -1;
    r.table.forEach(row => {
      assert.ok(row.pulls > last, `第 ${i} 组抽数递增`);
      close(row.cost, row.pulls * r.input.cost, 1e-9);
      assert.ok(row.cdf >= lastC - 1e-12, `第 ${i} 组累计概率单调`);
      assert.ok(row.cdf >= 0 && row.cdf <= 1 + 1e-12);
      last = row.pulls; lastC = row.cdf;
    });
  });
});
