// feedmath.js — pure stock/burn-rate math shared by the browser app and the
// Node cron script. No DOM, no I/O, no globals beyond what's exported.
// UMD-lite: attach to window in the browser, module.exports in Node.
(function (root, factory) {
  const mod = factory();
  if (typeof module === 'object' && module.exports) {
    module.exports = mod;
  } else {
    root.feedmath = mod;
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  function toGrams(amount, product) {
    amount = Number(amount) || 0;
    if (!product) return 0;
    return product.unit === 'scoop' ? amount * (product.gramsPerScoop || 0) : amount;
  }

  // yyyy-mm-dd string -> yyyy-mm-dd string, n days offset (n may be negative).
  function addDaysToDateStr(dateStr, n) {
    const [y, m, d] = dateStr.split('-').map(Number);
    const dt = new Date(Date.UTC(y, m - 1, d));
    dt.setUTCDate(dt.getUTCDate() + n);
    return dt.toISOString().slice(0, 10);
  }

  // Grams per productId logged on dateStr, summed over all horses.
  function dayTotals(state, dateStr) {
    const totals = {};
    const day = state.logs[dateStr];
    if (!day) return totals;
    for (const horseId in day) {
      const entries = day[horseId];
      for (const productId in entries) {
        const product = state.products.find((p) => p.id === productId);
        if (!product) continue;
        const grams = toGrams(entries[productId], product);
        totals[productId] = (totals[productId] || 0) + grams;
      }
    }
    return totals;
  }

  // Sum over horses of the scheduled daily amount for productId, in grams.
  function scheduledDailyGrams(state, productId) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return 0;
    let total = 0;
    for (const horseId in state.schedule) {
      const amt = state.schedule[horseId][productId];
      if (amt) total += toGrams(amt, product);
    }
    return total;
  }

  // Grams/day burn rate: average over the trailing 14 days (before todayStr)
  // that actually have a log for this product, if there are >= 3 such days.
  // Otherwise fall back to the planned schedule.
  function burnRate(state, productId, todayStr) {
    const loggedGrams = [];
    for (let i = 1; i <= 14; i++) {
      const dateStr = addDaysToDateStr(todayStr, -i);
      const totals = dayTotals(state, dateStr);
      if (Object.prototype.hasOwnProperty.call(totals, productId)) {
        loggedGrams.push(totals[productId]);
      }
    }
    if (loggedGrams.length >= 3) {
      const sum = loggedGrams.reduce((a, b) => a + b, 0);
      return sum / loggedGrams.length;
    }
    return scheduledDailyGrams(state, productId);
  }

  function daysLeft(state, productId, todayStr) {
    const product = state.products.find((p) => p.id === productId);
    if (!product) return 0;
    const burn = burnRate(state, productId, todayStr);
    if (!burn) return Infinity;
    return product.stockGrams / burn;
  }

  // ISO date when (daysLeft - safetyDays) runs out, clamped so it's never
  // before today. Null if the product never runs out (burn rate is 0).
  function buyByDate(state, productId, todayStr, safetyDays) {
    const dl = daysLeft(state, productId, todayStr);
    if (!isFinite(dl)) return null;
    const days = Math.max(0, Math.floor(dl - safetyDays));
    return addDaysToDateStr(todayStr, days);
  }

  // How many packs to buy so stock covers targetDays at the current burn rate.
  function packsToBuy(state, productId, targetDays, todayStr) {
    const product = state.products.find((p) => p.id === productId);
    if (!product || !product.packGrams) return 0;
    const burn = burnRate(state, productId, todayStr);
    const needed = targetDays * burn - product.stockGrams;
    return Math.max(0, Math.ceil(needed / product.packGrams));
  }

  // Products that need buying soon (daysLeft <= settings.safetyDays).
  function checkAlerts(state, todayStr) {
    const safetyDays = state.settings.safetyDays;
    const alerts = [];
    for (const product of state.products) {
      if (product.archived) continue;
      const dl = daysLeft(state, product.id, todayStr);
      if (dl <= safetyDays) {
        alerts.push({
          productId: product.id,
          name: product.name,
          daysLeft: dl,
          buyBy: buyByDate(state, product.id, todayStr, safetyDays),
        });
      }
    }
    return alerts;
  }

  function selfCheck() {
    const assert = (cond, msg) => {
      if (!cond) throw new Error('feedmath selfCheck failed: ' + msg);
    };

    const state = {
      settings: { safetyDays: 3, ntfyTopic: '', gistId: '' },
      horses: [{ id: 'h1', name: 'Horse 1' }, { id: 'h2', name: 'Horse 2' }],
      products: [
        { id: 'p1', name: 'Pavo Nuggets', unit: 'g', gramsPerScoop: 0, stockGrams: 2000, packGrams: 20000, packLabel: '20 kg bag', archived: false },
        { id: 'p2', name: 'Beet Pulp', unit: 'scoop', gramsPerScoop: 250, stockGrams: 2000, packGrams: 15000, packLabel: '15 kg bag', archived: false },
      ],
      schedule: {
        h1: { p1: 500, p2: 2 },
        h2: { p1: 400, p2: 1 },
      },
      logs: {
        '2024-01-01': { h1: { p1: 500, p2: 2 }, h2: { p1: 400, p2: 1 } },
        '2024-01-02': { h1: { p1: 500, p2: 2 }, h2: { p1: 400, p2: 1 } },
        '2024-01-03': { h1: { p1: 500, p2: 2 }, h2: { p1: 400, p2: 1 } },
      },
      purchases: [],
    };
    const today = '2024-01-04';

    // toGrams
    assert(toGrams(500, state.products[0]) === 500, 'gram product passthrough');
    assert(toGrams(2, state.products[1]) === 500, 'scoop conversion');

    // dayTotals
    const totals = dayTotals(state, '2024-01-01');
    assert(totals.p1 === 900, 'dayTotals p1 sums both horses: ' + totals.p1);
    assert(totals.p2 === 750, 'dayTotals p2 sums both horses (scoops->g): ' + totals.p2);
    assert(Object.keys(dayTotals(state, '2024-01-09')).length === 0, 'dayTotals empty day');

    // scheduledDailyGrams
    assert(scheduledDailyGrams(state, 'p1') === 900, 'scheduled p1');
    assert(scheduledDailyGrams(state, 'p2') === 750, 'scheduled p2 (scoops->g)');

    // burnRate: only 3 logged days exist (< 14-day window, but count is exactly 3)
    const burnP1 = burnRate(state, 'p1', today);
    assert(burnP1 === 900, 'burnRate uses logged average when >=3 logged days: ' + burnP1);

    // fewer than 3 logged days -> falls back to schedule
    const sparseState = JSON.parse(JSON.stringify(state));
    delete sparseState.logs['2024-01-03'];
    const burnSparse = burnRate(sparseState, 'p1', today);
    assert(burnSparse === 900, 'burnRate falls back to schedule with <3 logged days: ' + burnSparse);

    // daysLeft
    const dl = daysLeft(state, 'p1', today);
    assert(Math.abs(dl - 2000 / 900) < 1e-9, 'daysLeft p1: ' + dl);
    const zeroBurnState = JSON.parse(JSON.stringify(state));
    zeroBurnState.schedule = { h1: {}, h2: {} };
    zeroBurnState.logs = {};
    assert(daysLeft(zeroBurnState, 'p1', today) === Infinity, 'daysLeft Infinity on zero burn');

    // buyByDate
    const bb = buyByDate(state, 'p1', today, 3);
    // daysLeft ~3.33, safetyDays 3 -> floor(0.33) = 0 -> today
    assert(bb === today, 'buyByDate clamps to today when already within safety window: ' + bb);
    assert(buyByDate(zeroBurnState, 'p1', today, 3) === null, 'buyByDate null on infinite runway');

    const farState = JSON.parse(JSON.stringify(state));
    farState.products[0].stockGrams = 900 * 10 + 900 * 3; // 10 days beyond safety
    const bbFar = buyByDate(farState, 'p1', today, 3);
    assert(bbFar === addDaysToDateStr(today, 10), 'buyByDate offsets by days beyond safety: ' + bbFar);

    // packsToBuy
    const packs = packsToBuy(state, 'p1', 30, today);
    // needed = 30*900 - 2000 = 25000; packGrams 20000 -> ceil(1.25) = 2
    assert(packs === 2, 'packsToBuy: ' + packs);
    assert(packsToBuy(state, 'p1', 1, today) === 0, 'packsToBuy 0 when stock already covers target');

    // checkAlerts
    const alerts = checkAlerts(state, today);
    assert(alerts.some((a) => a.productId === 'p1'), 'checkAlerts flags p1 (daysLeft <= safetyDays)');
    const archivedState = JSON.parse(JSON.stringify(state));
    archivedState.products[0].archived = true;
    const alerts2 = checkAlerts(archivedState, today);
    assert(!alerts2.some((a) => a.productId === 'p1'), 'checkAlerts skips archived products');

    console.log('feedmath OK');
  }

  return {
    toGrams,
    dayTotals,
    scheduledDailyGrams,
    burnRate,
    daysLeft,
    buyByDate,
    packsToBuy,
    checkAlerts,
    selfCheck,
    addDaysToDateStr,
  };
});

if (typeof require !== 'undefined' && typeof module !== 'undefined' && require.main === module) {
  module.exports.selfCheck();
}
