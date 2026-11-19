// "Spending trends" screen: periods, grouping, chart styles, filters, zoom, details.
// Draws its own SVG charts (no libraries, works offline).

import { pad, isoDate, todayIso, parseIso, addDays, daysIn, shiftMonth, monthName, prettyDate, esc } from './util.js';

const MIN_BAR = { day: 14, week: 34, month: 46 }; // px per bucket at zoom 1
const H = 240, PAD_T = 14, PAD_B = 26;

/**
 * api: { state, money, catColor, isExcluded, sum, txHtml, amt (net amount of an expense), catIcon }
 * Returns { open(fromMonth), render() }.
 */
export function createTrends(api) {
  const $ = (id) => document.getElementById(id);
  const t = {
    period: 'month', anchor: todayIso(), group: null, style: 'bars', zoom: 1,
    cats: new Set(), methods: new Set(), incl: false, selected: null, from: null, to: null,
  };

  // ── Periods ──
  function range() {
    const a = t.anchor;
    if (t.period === 'week') {
      const dow = (parseIso(a).getDay() + 6) % 7; // Monday = 0
      const start = addDays(a, -dow);
      return { start, end: addDays(start, 6) };
    }
    if (t.period === 'month') { const ym = a.slice(0, 7); return { start: ym + '-01', end: `${ym}-${pad(daysIn(ym))}` }; }
    if (t.period === '3m') { const ym = a.slice(0, 7), s = shiftMonth(ym, -2); return { start: s + '-01', end: `${ym}-${pad(daysIn(ym))}` }; }
    if (t.period === 'year') { const y = a.slice(0, 4); return { start: `${y}-01-01`, end: `${y}-12-31` }; }
    const from = t.from || addDays(todayIso(), -29), to = t.to || todayIso();
    return from <= to ? { start: from, end: to } : { start: to, end: from };
  }
  const daysBetween = (a, b) => Math.round((parseIso(b) - parseIso(a)) / 86400000) + 1;

  function shift(dir) {
    if (t.period === 'week') t.anchor = addDays(t.anchor, 7 * dir);
    else if (t.period === 'month') t.anchor = shiftMonth(t.anchor.slice(0, 7), dir) + '-01';
    else if (t.period === '3m') t.anchor = shiftMonth(t.anchor.slice(0, 7), 3 * dir) + '-01';
    else if (t.period === 'year') t.anchor = `${Number(t.anchor.slice(0, 4)) + dir}-01-01`;
    else {
      const r = range(), n = daysBetween(r.start, r.end);
      t.from = addDays(r.start, n * dir); t.to = addDays(r.end, n * dir);
    }
    t.selected = null;
    render();
  }

  function previousRange(r) {
    if (t.period === 'month') { const ym = shiftMonth(r.start.slice(0, 7), -1); return { start: ym + '-01', end: `${ym}-${pad(daysIn(ym))}` }; }
    if (t.period === '3m') { const s = shiftMonth(r.start.slice(0, 7), -3), e = shiftMonth(r.start.slice(0, 7), -1); return { start: s + '-01', end: `${e}-${pad(daysIn(e))}` }; }
    if (t.period === 'year') { const y = Number(r.start.slice(0, 4)) - 1; return { start: `${y}-01-01`, end: `${y}-12-31` }; }
    const n = daysBetween(r.start, r.end);
    return { start: addDays(r.start, -n), end: addDays(r.start, -1) };
  }

  function label(r) {
    const y = (d) => d.slice(0, 4);
    if (t.period === 'month') return monthName(r.start.slice(0, 7));
    if (t.period === 'year') return y(r.start);
    if (t.period === '3m') return `${monthName(r.start.slice(0, 7), { month: 'short' })} – ${monthName(r.end.slice(0, 7), { month: 'short', year: 'numeric' })}`;
    const sameYear = y(r.start) === y(r.end);
    return `${prettyDate(r.start, sameYear ? { day: 'numeric', month: 'short' } : undefined)} – ${prettyDate(r.end)}`;
  }

  function autoGroup(r) {
    const n = daysBetween(r.start, r.end);
    return n <= 45 ? 'day' : n <= 120 ? 'week' : 'month';
  }

  // ── Data ──
  function filtered(r) {
    return api.state.expenses.filter((e) => e.date >= r.start && e.date <= r.end
      && (t.incl || !api.isExcluded(e.category))
      && (!t.cats.size || t.cats.has(e.category))
      && (!t.methods.size || t.methods.has(e.method)));
  }

  function buckets(r, group) {
    const out = [];
    if (group === 'day') {
      for (let d = r.start; d <= r.end; d = addDays(d, 1)) out.push({ start: d, end: d });
    } else if (group === 'week') {
      let s = r.start;
      while (s <= r.end) {
        const dow = (parseIso(s).getDay() + 6) % 7;
        let e = addDays(s, 6 - dow);
        if (e > r.end) e = r.end;
        out.push({ start: s, end: e });
        s = addDays(e, 1);
      }
    } else {
      let ym = r.start.slice(0, 7);
      while (`${ym}-01` <= r.end) {
        const s = `${ym}-01` < r.start ? r.start : `${ym}-01`;
        let e = `${ym}-${pad(daysIn(ym))}`; if (e > r.end) e = r.end;
        out.push({ start: s, end: e });
        ym = shiftMonth(ym, 1);
      }
    }
    return out;
  }

  function fill(bks, list) {
    bks.forEach((b) => { b.items = []; b.total = 0; });
    let i = 0;
    const sorted = list.slice().sort((a, b) => a.date.localeCompare(b.date));
    for (const e of sorted) {
      while (i < bks.length && e.date > bks[i].end) i++;
      if (i >= bks.length) break;
      if (e.date >= bks[i].start) { bks[i].items.push(e); bks[i].total += api.amt(e); }
    }
    return bks;
  }

  function bucketLabel(b, group, short) {
    if (group === 'day') return short ? String(Number(b.start.slice(8))) : prettyDate(b.start, { weekday: 'short', day: 'numeric', month: 'short' });
    if (group === 'month') return monthName(b.start.slice(0, 7), short ? { month: 'short' } : { month: 'long', year: 'numeric' });
    return short ? prettyDate(b.start, { day: 'numeric', month: 'short' }) : `${prettyDate(b.start, { day: 'numeric', month: 'short' })} – ${prettyDate(b.end, { day: 'numeric', month: 'short' })}`;
  }

  // ── Rendering ──
  function render() {
    const r = range();
    const group = t.group || autoGroup(r);
    const today = todayIso();
    document.querySelectorAll('#trPeriod button').forEach((b) => b.classList.toggle('on', b.dataset.p === t.period));
    document.querySelectorAll('#trStyle button').forEach((b) => b.classList.toggle('on', b.dataset.s === t.style));
    $('trGroup').value = group;
    $('trLabel').textContent = label(r);
    $('trCustom').hidden = t.period !== 'custom';
    if (t.period === 'custom') { $('trFrom').value = r.start; $('trTo').value = r.end; }
    $('trNext').disabled = r.end >= today && t.period !== 'custom';
    $('trIncl').checked = t.incl;

    const list = filtered(r);
    const bks = fill(buckets(r, group), list);
    const prev = previousRange(r);
    const prevBks = fill(buckets(prev, group), filtered(prev));

    renderStats(r, list, bks, prevBks, group, today);
    renderChart(r, bks, prevBks, group, today);
    renderFilters(r);
    renderDetail(bks, group, list);
  }

  function renderStats(r, list, bks, prevBks, group, today) {
    const total = api.sum(list);
    const lastDay = r.end < today ? r.end : today;
    const elapsed = r.start > today ? 0 : daysBetween(r.start, lastDay);
    const perDay = elapsed ? total / elapsed : 0;
    const top = bks.reduce((m, b) => (b.total > (m ? m.total : 0) ? b : m), null);
    const spentDays = new Set(list.map((e) => e.date));
    let noSpend = 0;
    for (let d = r.start; d <= lastDay && elapsed; d = addDays(d, 1)) if (!spentDays.has(d)) noSpend++;
    const prevTotal = prevBks.reduce((a, b) => a + b.total, 0);
    let cmp = '—';
    if (prevTotal > 0) {
      const d = ((total - prevTotal) / prevTotal) * 100;
      cmp = `<span class="${d > 0 ? 'up' : 'down'}">${d > 0 ? '▲' : '▼'} ${Math.abs(d).toFixed(0)}%</span>`;
    }
    $('trStats').innerHTML = `
      <div class="card"><div class="label">Total</div><div class="value num">${api.money(total)}</div><div class="sub">${list.length} expense${list.length === 1 ? '' : 's'}</div></div>
      <div class="card"><div class="label">Per day</div><div class="value num">${api.money(Math.round(perDay))}</div><div class="sub">${elapsed ? `over ${elapsed} day${elapsed === 1 ? '' : 's'}` : 'not started'}</div></div>
      <div class="card"><div class="label">Highest ${group}</div><div class="value num">${top ? api.money(top.total) : '—'}</div><div class="sub">${top ? esc(bucketLabel(top, group)) : 'No spending'}</div></div>
      <div class="card"><div class="label">vs previous</div><div class="value num">${cmp}</div><div class="sub">${noSpend} no-spend day${noSpend === 1 ? '' : 's'}</div></div>`;
  }

  function budgetPerBucket(b, group) {
    const budget = api.state.settings.budget;
    if (!(budget > 0) || t.cats.size || t.methods.size) return 0;
    if (group === 'month') return budget;
    return (budget / 30.44) * daysBetween(b.start, b.end);
  }

  function renderChart(r, bks, prevBks, group, today) {
    const n = bks.length;
    const box = $('trScroll');
    const avail = Math.max(240, box.clientWidth || 300);
    const slot = Math.max(MIN_BAR[group] * t.zoom, avail / n);
    const W = Math.round(slot * n);
    const ch = H - PAD_T - PAD_B;

    // Values for the y scale
    let vals;
    const budgetOn = api.state.settings.budget > 0 && !t.cats.size && !t.methods.size;
    if (t.style === 'running') {
      let acc = 0; const cum = bks.map((b) => (b.start > today ? null : (acc += b.total)));
      const totalBudget = budgetOn ? (api.state.settings.budget / 30.44) * daysBetween(r.start, r.end) : 0;
      vals = cum.filter((v) => v !== null).concat([totalBudget]);
      t._cum = cum; t._totalBudget = totalBudget;
    } else {
      vals = bks.map((b) => b.total).concat(t.style === 'compare' ? prevBks.map((b) => b.total) : [], budgetOn && t.style === 'bars' ? bks.map((b) => budgetPerBucket(b, group)) : []);
    }
    const top = Math.max(1, ...vals);
    const yMax = top * 1.12;
    const y = (v) => PAD_T + ch - (v / yMax) * ch;

    // Fixed y-axis (stays put while the chart scrolls)
    let ax = `<svg width="48" height="${H}" aria-hidden="true">`;
    [0, 0.5, 1].forEach((f) => { const v = top * f; ax += `<text class="axis" x="44" y="${y(v) + 4}" text-anchor="end">${esc(api.money(v, true))}</text>`; });
    $('trAxis').innerHTML = ax + '</svg>';

    let svg = `<svg width="${W}" height="${H}" role="img" aria-label="Spending chart">`;
    [0, 0.5, 1].forEach((f) => { const yy = y(top * f); svg += `<line class="grid" x1="0" x2="${W}" y1="${yy}" y2="${yy}"/>`; });
    const bw = Math.max(3, slot * (t.style === 'compare' ? 0.42 : 0.64));
    const labelEvery = Math.max(1, Math.ceil(40 / slot));

    if (t.style === 'running') {
      const pts = t._cum.map((v, i) => (v === null ? null : [i * slot + slot / 2, y(v)])).filter(Boolean);
      if (t._totalBudget) svg += `<line class="budget-line" x1="0" y1="${y(0)}" x2="${W}" y2="${y(t._totalBudget)}"/>`;
      if (pts.length) {
        svg += `<path class="area" d="M${pts[0][0]},${y(0)} ${pts.map((p) => `L${p[0]},${p[1]}`).join(' ')} L${pts[pts.length - 1][0]},${y(0)} Z"/>`;
        svg += `<polyline class="line" points="${pts.map((p) => p.join(',')).join(' ')}"/>`;
      }
      if (t.selected !== null && t._cum[t.selected] !== null && t._cum[t.selected] !== undefined) {
        svg += `<circle class="dot-sel" cx="${t.selected * slot + slot / 2}" cy="${y(t._cum[t.selected])}" r="5"/>`;
      }
    } else {
      bks.forEach((b, i) => {
        const x = i * slot + (slot - (t.style === 'compare' ? bw * 2 + 2 : bw)) / 2;
        const future = b.start > today;
        const over = budgetOn && t.style === 'bars' && b.total > budgetPerBucket(b, group) && budgetPerBucket(b, group) > 0;
        if (t.style === 'compare') {
          const pv = prevBks[i] ? prevBks[i].total : 0;
          if (pv > 0) { const h = Math.max(2, (pv / yMax) * ch); svg += `<rect class="bar-prev" x="${x}" y="${PAD_T + ch - h}" width="${bw}" height="${h}" rx="2"/>`; }
          if (b.total > 0) { const h = Math.max(2, (b.total / yMax) * ch); svg += `<rect class="bar-rect${t.selected === i ? ' sel' : ''}" x="${x + bw + 2}" y="${PAD_T + ch - h}" width="${bw}" height="${h}" rx="2"/>`; }
        } else if (b.total > 0) {
          const h = Math.max(2, (b.total / yMax) * ch);
          svg += `<rect class="bar-rect${over ? ' over' : ''}${t.selected === i ? ' sel' : ''}" x="${x}" y="${PAD_T + ch - h}" width="${bw}" height="${h}" rx="2"/>`;
        } else if (!future) {
          svg += `<rect class="zero" x="${x}" y="${PAD_T + ch - 2}" width="${bw}" height="2" rx="1"/>`;
        }
      });
      if (budgetOn && t.style === 'bars' && group !== 'month' && bks.length) {
        const per = budgetPerBucket(bks[Math.min(1, bks.length - 1)], group);
        svg += `<line class="budget-line" x1="0" x2="${W}" y1="${y(per)}" y2="${y(per)}"/>`;
      }
    }
    // labels + invisible tap targets
    bks.forEach((b, i) => {
      if (i % labelEvery === 0) svg += `<text class="axis" x="${i * slot + slot / 2}" y="${H - 8}" text-anchor="middle">${esc(bucketLabel(b, group, true))}</text>`;
      svg += `<rect class="hit" data-i="${i}" x="${i * slot}" y="0" width="${slot}" height="${H}"><title>${esc(bucketLabel(b, group))}: ${esc(api.money(b.total))}</title></rect>`;
    });
    svg += '</svg>';
    $('trChart').innerHTML = svg;

    const leg = [];
    if (t.style === 'compare') leg.push('<span><i class="sw prev"></i>Previous period</span><span><i class="sw cur"></i>This period</span>');
    if (t.style === 'running') leg.push('<span><i class="sw cur"></i>Running total</span>');
    if (budgetOn && (t.style === 'running' ? t._totalBudget : t.style === 'bars' && group !== 'month')) leg.push(`<span><i class="dash"></i>${t.style === 'running' ? 'Budget pace' : `Budget per ${group}`}</span>`);
    if (budgetOn && t.style === 'bars' && group === 'month') leg.push('<span>Red bars are over the monthly budget</span>');
    $('trLegend').innerHTML = leg.join('');
  }

  function chip(label, on, attr, color) {
    return `<button type="button" class="chip ${on ? 'selected' : ''}" ${attr}>${color ? `<span class="dot" style="background:${color}"></span>` : ''}${esc(label)}</button>`;
  }

  function renderFilters(r) {
    const inRange = api.state.expenses.filter((e) => e.date >= r.start && e.date <= r.end);
    const cats = [...new Set(inRange.map((e) => e.category))].filter((c) => t.incl || !api.isExcluded(c) || t.cats.has(c)).sort();
    const methods = [...new Set(inRange.map((e) => e.method))].sort();
    $('trCats').innerHTML = chip('All', !t.cats.size, 'data-cat=""') + cats.map((c) => chip(c, t.cats.has(c), `data-cat="${esc(c)}"`, api.catColor(c))).join('');
    $('trMethods').innerHTML = chip('All', !t.methods.size, 'data-method=""') + methods.map((m) => chip(m, t.methods.has(m), `data-method="${esc(m)}"`)).join('');
  }

  function renderDetail(bks, group, list) {
    const el = $('trDetail');
    if (t.selected !== null && bks[t.selected]) {
      const b = bks[t.selected];
      const items = b.items.slice().sort((a, c) => c.date.localeCompare(a.date) || api.amt(c) - api.amt(a));
      el.innerHTML = `<div class="panel-head"><h2>${esc(bucketLabel(b, group))}</h2><span class="num"><b>${api.money(b.total)}</b> <button class="linkish" id="trClearSel" style="margin-left:8px">Close</button></span></div>`
        + (items.length ? items.map(api.txHtml).join('') : '<div class="empty">No spending.</div>');
      return;
    }
    // No bar selected: where the money went in this period.
    const by = {};
    list.forEach((e) => (by[e.category] = (by[e.category] || 0) + api.amt(e)));
    const rows = Object.entries(by).sort((a, b) => b[1] - a[1]);
    const total = api.sum(list), max = rows.length ? rows[0][1] : 1;
    el.innerHTML = `<div class="panel-head"><h2>Where it went</h2><span class="muted small">Tap a bar for that ${group}’s expenses</span></div>`
      + (rows.length ? rows.map(([c, a]) => `<div class="cat-row static"><span class="cat-name">${api.catIcon ? api.catIcon(c, 'sm') : `<span class="dot" style="background:${api.catColor(c)}"></span>`}${esc(c)}</span><span class="cat-amt num">${api.money(a)}<small>${Math.round((a / total) * 100)}%</small></span><span class="bar"><span style="width:${(a / max) * 100}%;background:${api.catColor(c)}"></span></span></div>`).join('') : '<div class="empty">No spending in this period.</div>');
  }

  // ── Events ──
  $('trPeriod').addEventListener('click', (e) => {
    const b = e.target.closest('[data-p]'); if (!b) return;
    if (t.period === b.dataset.p) return;
    if (b.dataset.p === 'custom' && !t.from) { const r = range(); t.from = r.start; t.to = r.end > todayIso() ? todayIso() : r.end; }
    t.period = b.dataset.p; t.group = null; t.selected = null; t.zoom = 1;
    render();
  });
  $('trStyle').addEventListener('click', (e) => { const b = e.target.closest('[data-s]'); if (b) { t.style = b.dataset.s; render(); } });
  $('trGroup').addEventListener('change', (e) => { t.group = e.target.value; t.selected = null; t.zoom = 1; render(); });
  $('trPrev').addEventListener('click', () => shift(-1));
  $('trNext').addEventListener('click', () => shift(1));
  $('trFrom').addEventListener('change', (e) => { t.from = e.target.value; t.selected = null; render(); });
  $('trTo').addEventListener('change', (e) => { t.to = e.target.value; t.selected = null; render(); });
  $('trIncl').addEventListener('change', (e) => { t.incl = e.target.checked; render(); });
  $('trCats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-cat]'); if (!b) return;
    const c = b.dataset.cat;
    if (!c) t.cats.clear(); else if (t.cats.has(c)) t.cats.delete(c); else t.cats.add(c);
    render();
  });
  $('trMethods').addEventListener('click', (e) => {
    const b = e.target.closest('[data-method]'); if (!b) return;
    const m = b.dataset.method;
    if (!m) t.methods.clear(); else if (t.methods.has(m)) t.methods.delete(m); else t.methods.add(m);
    render();
  });
  $('trChart').addEventListener('click', (e) => {
    const h = e.target.closest('[data-i]'); if (!h) return;
    const i = Number(h.dataset.i);
    t.selected = t.selected === i ? null : i;
    render();
    if (t.selected !== null) setTimeout(() => $('trDetail').scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
  });
  $('trDetail').addEventListener('click', (e) => { if (e.target.id === 'trClearSel') { t.selected = null; render(); } });

  // Zoom: buttons and pinch
  const setZoom = (z, keepCenter = true) => {
    const box = $('trScroll');
    const center = box.scrollLeft + box.clientWidth / 2, oldW = box.scrollWidth || 1;
    t.zoom = Math.min(8, Math.max(0.5, z));
    render();
    if (keepCenter) box.scrollLeft = (center / oldW) * box.scrollWidth - box.clientWidth / 2;
  };
  $('trZoomIn').addEventListener('click', () => setZoom(t.zoom * 1.5));
  $('trZoomOut').addEventListener('click', () => setZoom(t.zoom / 1.5));
  let pinch = null, raf = 0;
  const dist = (ts) => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
  const scroll = $('trScroll');
  scroll.addEventListener('touchstart', (e) => { if (e.touches.length === 2) pinch = { d: dist(e.touches), z: t.zoom }; }, { passive: true });
  scroll.addEventListener('touchmove', (e) => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const z = pinch.z * (dist(e.touches) / pinch.d);
    cancelAnimationFrame(raf); raf = requestAnimationFrame(() => setZoom(z));
  }, { passive: false });
  scroll.addEventListener('touchend', () => { pinch = null; });

  // Swipe on the summary/header to change period
  let sw = null;
  ['trStats', 'trNav'].forEach((id) => {
    $(id).addEventListener('touchstart', (e) => { if (e.touches.length === 1) sw = { x: e.touches[0].clientX, y: e.touches[0].clientY }; }, { passive: true });
    $(id).addEventListener('touchend', (e) => {
      if (!sw) return;
      const dx = e.changedTouches[0].clientX - sw.x, dy = e.changedTouches[0].clientY - sw.y;
      sw = null;
      if (Math.abs(dx) > 60 && Math.abs(dy) < 50) shift(dx < 0 ? 1 : -1);
    }, { passive: true });
  });
  window.addEventListener('resize', () => { if (!$('view-insights').hidden) render(); });

  return {
    /** Open on a given month (from the Home screen). */
    open(ym) {
      t.period = 'month'; t.anchor = (ym || todayIso().slice(0, 7)) + '-01'; t.group = null; t.selected = null; t.zoom = 1;
    },
    render,
  };
}
