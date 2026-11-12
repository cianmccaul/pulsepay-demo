/*!
 * PulsePay demo: the screens.
 * ---------------------------------------------------------------------------
 * Holds the demo's state (therapists, billing period, bookings, this period's
 * extra lines) in localStorage and draws the dashboard from it. All the maths
 * is in engine.js, and statement-pdf.js draws the PDFs from the same results.
 * Nothing leaves the browser: there is no API, login or server storage.
 */
(function () {
  'use strict';

  const E = window.PulsePayEngine;
  const C = window.PulsePayClinic;
  const P = window.PulsePayPDF;
  const $ = (id) => document.getElementById(id);
  const KEY = 'pulsepay-demo:v1';
  const JSPDF_SRC = 'vendor/jspdf-4.2.1.umd.min.js';

  // =========================================================================
  // State
  // =========================================================================

  const clone = (x) => JSON.parse(JSON.stringify(x));

  function todayISO() {
    const d = new Date();
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  }

  function blankState() {
    return {
      v: 1,
      therapists: clone(C.THERAPISTS),
      selectedId: C.THERAPISTS[0].id,
      period: clone(C.DEFAULT_PERIOD),
      bankHolidays: clone(C.BANK_HOLIDAYS),
      statementDate: todayISO(),
      bookings: null, // { source, fileName, rows, skipped }
      extras: clone(C.DEFAULT_EXTRAS),
    };
  }

  /** A fresh visit, or Reset: the sample month is already loaded so every screen has data. */
  function seededState() {
    const s = blankState();
    s.bookings = parseSample();
    return s;
  }

  function load() {
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return null;
      const s = JSON.parse(raw);
      if (!s || s.v !== 1 || !Array.isArray(s.therapists)) return null;
      return s;
    } catch (e) { return null; }
  }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(state)); } catch (e) { /* private mode: the demo still works */ }
  }

  function parseSample() {
    const rows = window.Papa.parse(window.PulsePaySample.csv, { skipEmptyLines: true }).data;
    const header = E.findHeaderRow(rows);
    const { bookings, skipped } = E.normaliseRows(rows, header, E.guessMapping(rows[header]));
    return { source: 'sample', fileName: window.PulsePaySample.fileName, rows: bookings, skipped: skipped.length };
  }

  let state = load() || seededState();

  const selected = () => state.therapists.find((t) => t.id === state.selectedId) || null;
  const extrasFor = (id) => {
    if (!state.extras[id]) state.extras[id] = { itemised: [], adjustments: [], sessionsOverride: null };
    return state.extras[id];
  };
  const period = () => E.billingPeriod(state.period);

  /** A hand-entered session count belongs to one set of bookings and one period. */
  function clearSessionOverrides() {
    for (const id of Object.keys(state.extras)) state.extras[id].sessionsOverride = null;
  }

  /** Runs the engine for the whole clinic. Cheap enough to do on every change. */
  function compute() {
    return E.calculateClinic(state.therapists, state.bookings ? state.bookings.rows : [], {
      period: period(), bankHolidays: state.bankHolidays, extras: state.extras,
    });
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }

  let toastTimer = null;
  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 3200);
  }

  const pctIn = (rate) => (rate == null || rate === '' ? '' : String(Math.round(Number(rate) * 10000) / 100));
  const pctOut = (v) => (String(v).trim() === '' ? null : Number(v) / 100);
  const numOut = (v) => (String(v).trim() === '' ? 0 : Number(v));

  function slug(name) {
    const base = E.normName(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'therapist';
    let id = base, n = 2;
    while (state.therapists.some((t) => t.id === id)) id = `${base}-${n++}`;
    return id;
  }

  function shortModel(t) {
    return {
      percentage: '% of takings', fixed_monthly: 'Fixed monthly', per_session: 'Per session', tiered: 'Tiered', hybrid: 'Hybrid',
    }[t.model] || '';
  }

  const tag = (k, v) => `<span class="tag"><span class="dot"></span><b>${esc(k)}</b> ${esc(v)}</span>`;
  const row = (k, v, cls) => `<div class="row${cls ? ` ${cls}` : ''}"><span>${k}</span><strong>${v}</strong></div>`;

  // =========================================================================
  // Render
  // =========================================================================

  let last = null; // the latest engine result, for the PDF buttons

  function render(opts) {
    const o = opts || {};
    last = compute();
    renderBubbles();
    renderOverview();
    renderSelection(o);
    if (!o.keepLines) renderLines();
    $('invoiceDateInput').value = state.statementDate || todayISO();
  }

  function resultFor(id) {
    return last && last.results.find((x) => x.therapist.id === id);
  }

  function hasBookings() {
    return !!(state.bookings && state.bookings.rows.length);
  }

  function renderBubbles() {
    const grid = $('bubbleGrid');
    grid.innerHTML = state.therapists.map((t) => {
      const r = resultFor(t.id);
      const hint = hasBookings() || t.model === 'fixed_monthly' ? E.euro(r.rent.total).replace(/\.\d\d$/, '') + ' due' : shortModel(t);
      return `<button type="button" class="bubble${t.id === state.selectedId ? ' active' : ''}" data-act="select" data-id="${esc(t.id)}" aria-pressed="${t.id === state.selectedId}">
        <div class="name">${esc(t.name)}</div><div class="hint">${esc(hint)}</div></button>`;
    }).join('');
  }

  function renderOverview() {
    const p = period();
    const body = $('overviewBody');
    $('overviewSub').textContent = `Every therapist's rent for ${p.label}.`;
    if (!hasBookings()) {
      body.innerHTML = `<div class="empty">No bookings loaded for this period yet.
        <div class="fileRow"><button class="btn btn-primary" type="button" data-act="load-sample">Load sample month</button>
        <button class="btn btn-ghost-dark" type="button" data-act="pick-file">Upload CSV</button></div></div>`;
      return;
    }
    const rows = last.results.map(({ therapist: t, rent }) => {
      const flags = (rent.capApplied ? ' <span class="flag cap">Cap</span>' : '') + (rent.retainerApplied ? ' <span class="flag ret">Retainer</span>' : '');
      return `<button type="button" class="ovRow${t.id === state.selectedId ? ' active' : ''}" data-act="select" data-id="${esc(t.id)}">
        <span class="ovName"><b>${esc(t.name)}</b><span>${esc(E.describeRules(t))}</span></span>
        <span class="ovNum model">${esc(shortModel(t))}</span>
        <span class="ovNum">${rent.sessions}<span class="ovLabel"> sessions</span></span>
        <span class="ovNum"><span class="ovLabel">Takings </span>${E.euro(rent.takings)}</span>
        <span class="ovDue">${E.euro(rent.total)}${flags}</span>
      </button>`;
    }).join('');
    const tot = last.totals;
    const head = `<div class="ovRow ovHead" aria-hidden="true"><span>Therapist</span><span class="ovNum model">Model</span><span class="ovNum">Sessions</span><span class="ovNum">Takings</span><span class="ovDue" style="color:inherit">Rent due</span></div>`;
    const total = `<div class="ovRow ovTotal"><span>Clinic total</span><span class="ovNum model"></span><span class="ovNum">${tot.sessions}</span><span class="ovNum">${E.euro(tot.takings)}</span><span class="ovDue">${E.euro(tot.rent)}</span></div>`;

    const b = state.bookings;
    const meta = [`<span>${esc(b.source === 'sample' ? 'Sample month' : b.fileName)} · ${b.rows.length} bookings read</span>`];
    if (b.skipped) meta.push(`<span>${b.skipped} row${b.skipped === 1 ? '' : 's'} couldn't be read</span>`);
    if (last.outsidePeriod) meta.push(`<span>${last.outsidePeriod} outside the period</span>`);
    for (const u of last.unmatched) {
      meta.push(`<span>${u.rows} for <b>${esc(u.name)}</b>, who has no profile · <button type="button" class="linkBtn" data-act="add-unmatched" data-name="${esc(u.name)}">Add as therapist</button></span>`);
    }
    if (!last.results.some((x) => x.summary.sessions || x.summary.takings)) {
      meta.push('<span><b>No bookings fall in this period for these therapists.</b> Check the billing period or the therapist names.</span>');
    }
    body.innerHTML = `<div class="ovList">${head}${rows}${total}</div><div class="ovMeta">${meta.join('')}</div>`;
  }

  function renderSelection(o) {
    const t = selected();
    const p = period();
    $('periodLabel').textContent = p.label;
    const b = state.bookings;
    if (hasBookings()) {
      $('csvDot').className = 'status-dot ok';
      $('csvMsg').textContent = `${b.source === 'sample' ? 'Sample month' : 'Uploaded'} · ${b.rows.length} rows`;
      $('uploadTitle').textContent = b.source === 'sample' ? 'Sample month loaded' : b.fileName;
      $('uploadDetail').textContent = `${b.rows.length} bookings · billing period ${p.label}`;
    } else {
      $('csvDot').className = 'status-dot';
      $('csvMsg').textContent = 'Waiting for bookings';
      $('uploadTitle').textContent = 'No bookings loaded';
      $('uploadDetail').textContent = 'Drop a CSV here, browse, or load the sample month';
    }

    if (!t) {
      $('heroName').textContent = 'PulsePay';
      $('heroSuffix').textContent = ' payouts. Zero spreadsheets.';
      $('heroSub').textContent = 'Create a therapist profile to get started.';
      $('rules').innerHTML = '';
      $('capacityCard').style.display = 'none';
      $('selLabel').textContent = 'None selected';
      $('modelLabel').textContent = '—';
      $('statusText').textContent = 'Ready';
      $('results').style.display = 'none';
      $('breakdown').style.display = 'none';
      $('warnBox').style.display = 'none';
      return;
    }

    const x = resultFor(t.id);
    const rent = x.rent;
    const sum = x.summary;
    const show = hasBookings() || t.model === 'fixed_monthly';

    $('heroName').textContent = t.name;
    $('heroSuffix').textContent = ' Monthly Fees';
    $('heroSub').textContent = `${t.title ? `${t.title}. ` : ''}${E.MODEL_LABELS[t.model]}: ${E.describeRules(t)}.`;
    $('selLabel').textContent = `${t.name} selected`;
    $('modelLabel').textContent = E.MODEL_LABELS[t.model];
    $('statusText').textContent = !show ? 'No bookings' : rent.capApplied ? 'Cap applied' : rent.retainerApplied ? 'Retainer applied' : 'Ready';

    // rule pills
    const r = t.rates || {};
    const pills = [tag('Model', shortModel(t))];
    if (t.model === 'percentage') {
      pills.push(tag('Weekday', E.formatRate(r.weekday)), tag('Saturday', E.formatRate(r.saturday)), tag('Sunday', E.formatRate(r.sunday)));
      pills.push(tag('Bank holiday', r.bankHoliday != null ? E.formatRate(r.bankHoliday) : 'weekday rate'));
    } else if (t.model === 'fixed_monthly') {
      pills.push(tag('Fixed', `${E.euro(E.toCents(t.fixedMonthly))} / month`));
    } else if (t.model === 'per_session') {
      pills.push(tag('Per session', E.euro(E.toCents(t.sessionFee))));
    } else if (t.model === 'tiered') {
      pills.push(tag('Rate', rent.capacity ? E.formatRate(rent.capacity.rate) : '—'), tag('Capacity', `${t.capacity} sessions`));
    } else if (t.model === 'hybrid') {
      pills.push(tag('Weekday', rent.capacity ? `${E.formatRate(rent.capacity.rate)} (tier)` : '—'), tag('Saturday', E.formatRate(r.saturday)), tag('Sunday', E.formatRate(r.sunday)));
      pills.push(tag('Bank holiday', r.bankHoliday != null ? E.formatRate(r.bankHoliday) : 'weekday tier'));
    }
    if (t.model !== 'fixed_monthly') {
      pills.push(tag('Rent cap', Number(t.rentCap) > 0 ? E.euro(E.toCents(t.rentCap)).replace(/\.00$/, '') : 'None'));
      pills.push(tag('Retainer', Number(t.minRetainer) > 0 ? E.euro(E.toCents(t.minRetainer)).replace(/\.00$/, '') : 'None'));
    }
    for (const e of t.equipment || []) {
      pills.push(tag(e.name, `${E.euro(E.toCents(e.fee)).replace(/\.00$/, '')} / ${e.mode === 'per_month' ? 'month' : 'session'}`));
    }
    if (!(t.equipment || []).length) pills.push(tag('Equipment', 'None'));
    $('rules').innerHTML = pills.join('');

    // capacity card
    const cap = rent.capacity;
    $('capacityCard').style.display = cap ? '' : 'none';
    if (cap) {
      $('capMaxP').textContent = cap.max || '—';
      const input = $('capActualInput');
      input.disabled = !hasBookings();
      if (!(o.keepCapInput && document.activeElement === input)) input.value = hasBookings() ? String(rent.sessions) : '';
      $('capPct').textContent = cap.max ? `${cap.pct}%` : '—';
      $('capRateLabel').textContent = t.model === 'hybrid' ? 'Weekday rent %' : 'Rent %';
      $('capWeekdayPct').textContent = E.formatRate(cap.rate);
      $('capTable').innerHTML = cap.tiers.map((tr, i) =>
        `<div class="capRow${i === cap.tierIndex && hasBookings() ? ' active' : ''}"><span>${esc(tr.range)}</span><b>${E.formatRate(tr.rate)}</b></div>`).join('');
    }

    // results
    $('results').style.display = show ? 'grid' : 'none';
    $('breakdown').style.display = show ? 'grid' : 'none';
    $('errBox').style.display = 'none';
    const warns = show ? rent.warnings.slice() : [];
    if (show && hasBookings() && !sum.sessions && !sum.takings && t.model !== 'fixed_monthly') {
      warns.push(`No bookings for ${t.name} in ${p.label}. Check the billing period, or how their name appears in the export.`);
    }
    $('warnBox').style.display = warns.length ? 'block' : 'none';
    $('warnBox').innerHTML = warns.length ? `<b>Check before sending:</b><ul>${warns.map((w) => `<li>${esc(w)}</li>`).join('')}</ul>` : '';
    if (!show) return;

    $('sessions').textContent = rent.sessions;
    const extra = [];
    if (sum.noChargeSessions) extra.push(`${sum.noChargeSessions} no-charge`);
    if (rent.sessions !== rent.sessionsFromExport) extra.push(`export: ${rent.sessionsFromExport}`);
    $('sessionsNote').textContent = extra.length ? `in the period · ${extra.join(' · ')}` : 'in the period';
    $('collectedTotal').textContent = E.euro(rent.takings);
    $('takingsNote').textContent = sum.cancellationFees ? `incl. ${sum.cancellationFees} cancellation fee${sum.cancellationFees > 1 ? 's' : ''}` : 'sum of prices charged';
    $('grossShare').textContent = E.euro(rent.gross);
    $('grossNote').textContent = t.model === 'fixed_monthly' ? 'fixed rent' : t.model === 'per_session' ? 'sessions × fee' : 'before cap and retainer';
    $('finalDue').textContent = E.euro(rent.total);
    const parts = [];
    if (rent.capApplied) parts.push('cap applied');
    if (rent.retainerApplied) parts.push('retainer applied');
    if (rent.equipmentTotal) parts.push('equipment');
    if (rent.itemisedTotal) parts.push('itemised');
    if (rent.adjustmentsTotal) parts.push('adjustments');
    $('finalNote').textContent = parts.length ? parts.join(' · ') : 'base rent only';

    $('stepsList').innerHTML = rent.steps.map((s) => {
      const cls = ['step'];
      if (s.kind === 'note' || s.kind === 'capacity') cls.push('muted');
      if (s.kind === 'cap' || s.kind === 'retainer') cls.push('limit');
      if (s.kind === 'subtotal') cls.push('sub');
      if (s.kind === 'total') cls.push('total');
      const plus = ['equipment', 'itemised', 'adjustment', 'retainer'].includes(s.kind) && s.amount > 0 ? '+ ' : '';
      return row(esc(s.label), s.amount == null ? '' : plus + E.euro(s.amount), cls.join(' '));
    }).join('');

    const ra = [];
    if (rent.limitsApply) {
      ra.push(row('Rent cap', Number(t.rentCap) > 0 ? E.euro(rent.rentCap) : 'None'));
      ra.push(row('Cap triggered?', rent.capApplied ? '<span class="yes">Yes</span>' : 'No'));
      ra.push(row('Minimum retainer', Number(t.minRetainer) > 0 ? E.euro(rent.minRetainer) : 'None'));
      ra.push(row('Retainer triggered?', rent.retainerApplied ? '<span class="yes">Yes</span>' : 'No'));
    } else {
      ra.push(row('Rent cap / retainer', 'Not used for fixed rent'));
    }
    for (const e of rent.equipment) {
      ra.push(row(esc(e.mode === 'per_month' ? e.name : `${e.name} sessions`), e.mode === 'per_month' ? 'Monthly' : String(e.count)));
    }
    ra.push(row('Equipment fees', E.euro(rent.equipmentTotal)));
    ra.push(row('Cancellation fees charged', String(sum.cancellationFees)));
    ra.push(row('Free cancellations left out', String(sum.ignored)));
    if (sum.bankHolidaysWorked.length) ra.push(row('Bank holidays worked', esc(sum.bankHolidaysWorked.map(E.formatDate).join(', '))));
    $('rulesApplied').innerHTML = ra.join('');
  }

  function renderLines() {
    const t = selected();
    const x = t ? extrasFor(t.id) : { itemised: [], adjustments: [] };
    const lineHtml = (kind, list, placeholder, amountPh) => list.map((l, i) => `
      <div class="lineRow">
        <input class="lbl" type="text" data-line="${kind}" data-i="${i}" data-f="label" value="${esc(l.label)}" placeholder="${placeholder}" aria-label="Description" />
        <input class="amt" type="number" step="0.01" inputmode="decimal" data-line="${kind}" data-i="${i}" data-f="amount" value="${l.amount === 0 || l.amount == null ? '' : esc(l.amount)}" placeholder="${amountPh}" aria-label="Amount in euros" />
        <button class="rmBtn" type="button" data-act="rm-line" data-kind="${kind}" data-i="${i}" aria-label="Remove line">✕</button>
      </div>`).join('');
    $('itemizedRows').innerHTML = x.itemised.length ? lineHtml('itemised', x.itemised, 'Description (e.g. Saturday room hire)', 'Amount (€)')
      : `<div class="lineEmpty">No itemised charges${t ? ` for ${esc(t.name)}` : ''} this period.</div>`;
    $('adjRows').innerHTML = x.adjustments.length ? lineHtml('adjustments', x.adjustments, 'Reason (e.g. Credit: room closed)', 'Amount (– = credit)')
      : `<div class="lineEmpty">No adjustments${t ? ` for ${esc(t.name)}` : ''} this period.</div>`;
    updateLineTotals();
  }

  function updateLineTotals() {
    const t = selected();
    const x = t ? extrasFor(t.id) : { itemised: [], adjustments: [] };
    const itot = x.itemised.reduce((s, l) => s + Math.max(0, E.toCents(l.amount)), 0);
    const atot = x.adjustments.reduce((s, l) => s + E.toCents(l.amount), 0);
    $('itemizedSummary').style.display = x.itemised.length ? 'flex' : 'none';
    $('itemizedTotalDisplay').textContent = E.euro(itot);
    $('adjSummary').style.display = x.adjustments.length ? 'flex' : 'none';
    $('adjNet').textContent = (atot > 0 ? '+' : '') + E.euro(atot);
  }

  // =========================================================================
  // Bookings: sample, upload, column mapper
  // =========================================================================

  function loadSample() {
    state.bookings = parseSample();
    clearSessionOverrides();
    const moved = state.period.year !== C.DEFAULT_PERIOD.year || state.period.month !== C.DEFAULT_PERIOD.month;
    state.period.year = C.DEFAULT_PERIOD.year;
    state.period.month = C.DEFAULT_PERIOD.month;
    save();
    render();
    toast(`Sample month loaded · ${state.bookings.rows.length} bookings${moved ? ' · period set to October 2026' : ''}`);
  }

  let pending = null; // { fileName, rows, header }

  function handleFile(file) {
    if (!file) return;
    $('errBox').style.display = 'none';
    if (!/\.(csv|txt)$/i.test(file.name) && file.type !== 'text/csv') return showError('Please choose a .csv file (in Excel: Save As → CSV).');
    if (file.size > 10 * 1024 * 1024) return showError('That file is over 10 MB. Export one month at a time.');
    window.Papa.parse(file, {
      skipEmptyLines: true,
      complete: (res) => {
        const rows = (res.data || []).filter((r) => r.some((c) => String(c).trim() !== ''));
        if (rows.length < 2) return showError('That file has no rows to read.');
        const header = E.findHeaderRow(rows);
        pending = { fileName: file.name, rows, header };
        openMapper(E.guessMapping(rows[header]));
      },
      error: () => showError('Couldn’t read that file. Try exporting it again as CSV.'),
    });
  }

  function showError(msg) {
    const box = $('errBox');
    box.textContent = msg;
    box.style.display = 'block';
    $('csvDot').className = 'status-dot error';
    $('csvMsg').textContent = 'File not loaded';
    box.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function openMapper(mapping) {
    const { rows, header, fileName } = pending;
    const headers = rows[header];
    const first = rows[header + 1] || [];
    $('mapFor').textContent = `${fileName} · ${rows.length - header - 1} rows · headers on row ${header + 1}`;
    const optionList = (sel) => ['<option value="-1">— not in this file —</option>']
      .concat(headers.map((h, i) => `<option value="${i}"${i === sel ? ' selected' : ''}>${esc(String(h).trim() || `Column ${i + 1}`)}</option>`)).join('');
    $('mapFields').innerHTML = E.FIELDS.map((f) => {
      const req = E.REQUIRED_FIELDS.includes(f);
      return `<div class="mapRow"><span>${E.FIELD_LABELS[f]}${req ? ' <span class="req">*</span>' : ''}</span>
        <select id="map_${f}" data-map="${f}" aria-label="Column for ${E.FIELD_LABELS[f]}">${optionList(mapping[f])}</select>
        <span class="ex" id="ex_${f}"></span></div>`;
    }).join('');
    E.FIELDS.forEach((f) => updateExample(f, first));
    updateMapPreview();
    openModal('mapModal');
  }

  function currentMapping() {
    const m = {};
    for (const f of E.FIELDS) m[f] = Number($(`map_${f}`).value);
    return m;
  }

  function updateExample(f, firstRow) {
    const i = Number($(`map_${f}`).value);
    const v = i >= 0 ? String(firstRow[i] == null ? '' : firstRow[i]).trim() : '';
    $(`ex_${f}`).textContent = i >= 0 ? `e.g. ${v || '(blank)'}` : (f === 'treatment' ? 'Needed for per-session equipment fees' : f === 'status' ? 'Without it, every row with a price counts as a session' : 'Required');
  }

  function updateMapPreview() {
    if (!pending) return;
    const m = currentMapping();
    const err = $('mapErr');
    if (!E.mappingComplete(m)) {
      $('mapPreview').innerHTML = row('Ready to import', 'Choose the required columns');
      err.style.display = 'none';
      return;
    }
    const { bookings, skipped } = E.normaliseRows(pending.rows, pending.header, m, { dateOrder: $('mapDateOrder').value });
    const names = Array.from(new Set(bookings.map((b) => b.therapist.trim())));
    const matched = names.filter((n) => E.matchTherapist(n, state.therapists));
    const dates = bookings.map((b) => b.date).sort();
    const preview = [
      row('Bookings', String(bookings.length)),
      row('Rows skipped', skipped.length ? `${skipped.length} (${esc(skipped.slice(0, 3).map((s) => `row ${s.line}: ${s.reason}`).join('; '))}${skipped.length > 3 ? '…' : ''})` : '0'),
      row('Dates', dates.length ? `${E.formatDate(dates[0])} – ${E.formatDate(dates[dates.length - 1])}` : '—'),
      row('Therapists', `${names.length} in file · ${matched.length} match a profile`),
    ];
    $('mapPreview').innerHTML = preview.join('');
    err.style.display = 'none';
  }

  function importMapped() {
    const m = currentMapping();
    const err = $('mapErr');
    if (!E.mappingComplete(m)) {
      err.textContent = 'Choose a column for date, therapist and price.';
      err.style.display = 'block';
      return;
    }
    const used = E.FIELDS.map((f) => m[f]).filter((i) => i >= 0);
    if (new Set(used).size !== used.length) {
      err.textContent = 'Each column can only be used once.';
      err.style.display = 'block';
      return;
    }
    const { bookings, skipped } = E.normaliseRows(pending.rows, pending.header, m, { dateOrder: $('mapDateOrder').value });
    if (!bookings.length) {
      err.textContent = 'No rows could be read with these columns. Check the date and price columns.';
      err.style.display = 'block';
      return;
    }
    state.bookings = { source: 'upload', fileName: pending.fileName, rows: bookings, skipped: skipped.length };
    clearSessionOverrides();

    // If most bookings fall in another month, move the period there.
    const p = period();
    const inside = bookings.filter((b) => E.inPeriod(b.date, p)).length;
    let moved = '';
    if (inside < bookings.length / 2) {
      const counts = {};
      for (const b of bookings) { const k = b.date.slice(0, 7); counts[k] = (counts[k] || 0) + 1; }
      const top = Object.keys(counts).sort((a, b) => counts[b] - counts[a])[0];
      state.period.year = Number(top.slice(0, 4));
      state.period.month = Number(top.slice(5, 7));
      moved = ` · period set to ${E.billingPeriod(state.period).name}`;
    }
    pending = null;
    closeModal();
    save();
    render();
    toast(`Imported ${bookings.length} bookings${skipped.length ? ` (${skipped.length} skipped)` : ''}${moved}`);
  }

  // =========================================================================
  // Modals
  // =========================================================================

  let openId = null;
  let lastFocus = null;

  function openModal(id) {
    lastFocus = document.activeElement;
    openId = id;
    const m = $(id);
    m.style.display = 'flex';
    m.scrollTop = 0;
    const f = m.querySelector('input:not([type=radio]), select, button');
    if (f) setTimeout(() => f.focus(), 30);
  }

  function closeModal() {
    if (!openId) return;
    $(openId).style.display = 'none';
    openId = null;
    pending = null;
    if (lastFocus && lastFocus.focus) lastFocus.focus();
  }

  // ---- billing period ----
  function openPeriod() {
    const sel = $('pStart');
    if (!sel.options.length) {
      sel.innerHTML = Array.from({ length: 28 }, (_, i) => `<option value="${i + 1}">${i + 1}${i === 0 ? ' (calendar month)' : ''}</option>`).join('');
    }
    $('pMonth').value = `${state.period.year}-${String(state.period.month).padStart(2, '0')}`;
    sel.value = String(state.period.startDay || 1);
    $('pBH').value = state.bankHolidays.join(', ');
    $('pErr').style.display = 'none';
    previewPeriod();
    openModal('periodModal');
  }

  function readPeriodForm() {
    const v = $('pMonth').value;
    const m = v.match(/^(\d{4})-(\d{2})$/);
    if (!m) return null;
    return { year: Number(m[1]), month: Number(m[2]), startDay: Number($('pStart').value) || 1 };
  }

  function previewPeriod() {
    const p = readPeriodForm();
    $('pPreview').textContent = p ? E.billingPeriod(p).label : '—';
  }

  function savePeriod() {
    const p = readPeriodForm();
    const err = $('pErr');
    if (!p) { err.textContent = 'Choose a month.'; err.style.display = 'block'; return; }
    const raw = $('pBH').value.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
    const bad = raw.filter((s) => !/^\d{4}-\d{2}-\d{2}$/.test(s) || E.parseDate(s) !== s);
    if (bad.length) { err.textContent = `These aren't dates in YYYY-MM-DD form: ${bad.join(', ')}`; err.style.display = 'block'; return; }
    if (p.year !== state.period.year || p.month !== state.period.month || p.startDay !== state.period.startDay) clearSessionOverrides();
    state.period = p;
    state.bankHolidays = Array.from(new Set(raw)).sort();
    save();
    closeModal();
    render();
    toast(`Billing period: ${E.billingPeriod(p).label}`);
  }

  // ---- capacity calculator ----
  function openCalc() {
    const t = selected();
    if (!t) return toast('Select a therapist first.');
    $('calcFor').textContent = `Therapist: ${t.name}${t.model === 'tiered' || t.model === 'hybrid' ? '' : ' (capacity only affects tiered and hybrid deals)'}`;
    if ($('c_hours').value === '') $('c_hours').value = '128';
    if ($('c_b30').value === '') $('c_b30').value = '16';
    if ($('c_b45').value === '') $('c_b45').value = '0';
    if ($('c_b60').value === '') $('c_b60').value = '0';
    if ($('c_perHour').value === '') $('c_perHour').value = '4';
    recomputeCalc();
    openModal('calcModal');
  }

  function recomputeCalc() {
    const dur = document.querySelector('input[name="apptDur"]:checked');
    const res = E.capacityFromHours({
      hours: Number($('c_hours').value),
      breaks: { 30: Number($('c_b30').value), 45: Number($('c_b45').value), 60: Number($('c_b60').value) },
      sessionMinutes: dur ? Number(dur.value) : 45,
      retainerPerHour: Number($('c_perHour').value),
    });
    if (res.maxSessions == null) {
      $('c_outMaxP').textContent = '—';
      $('c_outRet').textContent = '—';
      $('c_outExplain').textContent = 'Enter the hours worked in the period.';
    } else {
      $('c_outMaxP').textContent = String(res.maxSessions);
      $('c_outRet').textContent = res.suggestedRetainer != null ? E.euro(res.suggestedRetainer * 100).replace(/\.00$/, '') : '—';
      $('c_outExplain').textContent = `(${res.workHours + res.breakHours}h − ${res.breakHours}h breaks) ÷ ${dur ? dur.value : 45} min sessions`;
    }
    return res;
  }

  function applyCalc() {
    const t = selected();
    const res = recomputeCalc();
    if (!t || !res.maxSessions) return toast('Enter the hours worked to work out capacity.');
    t.capacity = res.maxSessions;
    if (res.suggestedRetainer != null && t.model !== 'fixed_monthly') t.minRetainer = res.suggestedRetainer;
    save();
    closeModal();
    render();
    toast(`${t.name}: capacity ${res.maxSessions}${res.suggestedRetainer != null && t.model !== 'fixed_monthly' ? `, retainer €${res.suggestedRetainer}` : ''}`);
  }

  // ---- rules ----
  const MODEL_HELP = {
    percentage: 'A share of takings, with its own rate for weekdays, Saturdays and Sundays.',
    fixed_monthly: 'The same rent every period, whatever the takings.',
    per_session: 'A flat fee for every session seen, including no-charge sessions.',
    tiered: 'One rate for all takings, set by how full the diary was: sessions ÷ capacity.',
    hybrid: 'The capacity tier sets the weekday rate; weekends and bank holidays have fixed rates.',
  };
  let draftModel = 'percentage';

  function openRules() {
    const t = selected();
    if (!t) return toast('Select a therapist first.');
    $('rulesFor').textContent = `Therapist: ${t.name}`;
    $('r_title').value = t.title || '';
    $('modelChips').innerHTML = E.MODELS.map((m) => `<label class="chip"><input type="radio" name="rentModel" value="${m}"${m === t.model ? ' checked' : ''} /> ${esc(E.MODEL_LABELS[m].split(':')[0])}</label>`).join('');
    const r = t.rates || {};
    $('r_wd').value = pctIn(r.weekday);
    $('r_sat').value = pctIn(r.saturday);
    $('r_sun').value = pctIn(r.sunday);
    $('r_bh').value = pctIn(r.bankHoliday);
    $('r_hsat').value = pctIn(r.saturday);
    $('r_hsun').value = pctIn(r.sunday);
    $('r_hbh').value = pctIn(r.bankHoliday);
    $('r_fixed').value = t.fixedMonthly || '';
    $('r_fee').value = t.sessionFee || '';
    $('r_capacity').value = t.capacity || '';
    $('tierBody').innerHTML = '';
    const tiers = (t.tiers && t.tiers.length) ? E.sortedTiers(t.tiers) : [{ min: 0, rate: 0.3 }, { min: 60, rate: 0.27 }, { min: 80, rate: 0.25 }];
    tiers.forEach((x) => addTierRow(x.min, pctIn(x.rate)));
    $('r_cap').value = t.rentCap || '';
    $('r_ret').value = t.minRetainer || '';
    $('equipRows').innerHTML = '';
    (t.equipment || []).forEach(addEquipRow);
    $('rulesErr').style.display = 'none';
    setDraftModel(t.model);
    openModal('rulesModal');
  }

  function setDraftModel(m) {
    draftModel = m;
    $('modelHelp').textContent = MODEL_HELP[m];
    $('w_percentage').classList.toggle('on', m === 'percentage');
    $('w_fixed_monthly').classList.toggle('on', m === 'fixed_monthly');
    $('w_per_session').classList.toggle('on', m === 'per_session');
    $('w_tiers').classList.toggle('on', m === 'tiered' || m === 'hybrid');
    $('w_hybrid_weekend').style.display = m === 'hybrid' ? '' : 'none';
    $('tierLabel').textContent = m === 'hybrid' ? 'Weekday capacity tiers' : 'Capacity tiers';
    $('w_limits').style.display = m === 'fixed_monthly' ? 'none' : '';
    $('limitsNote').style.display = m === 'fixed_monthly' ? '' : 'none';
  }

  function addTierRow(min, rate) {
    const tr = document.createElement('tr');
    tr.className = 'tier-row';
    tr.innerHTML = `<td><input type="number" class="t-min" min="0" max="999" step="1" inputmode="numeric" value="${esc(min == null ? '' : min)}" aria-label="Tier starts at capacity %" /></td>
      <td><input type="number" class="t-rent" min="0" max="100" step="0.1" inputmode="decimal" value="${esc(rate == null ? '' : rate)}" aria-label="Rent % for this tier" /></td>
      <td><button type="button" class="rmBtn" data-act="rm-row" aria-label="Remove tier">✕</button></td>`;
    $('tierBody').appendChild(tr);
  }

  function addEquipRow(e) {
    const x = e || { name: '', match: '', mode: 'per_session', fee: '' };
    const div = document.createElement('div');
    div.className = 'equipRow';
    div.dataset.id = x.id || '';
    div.innerHTML = `<label>Name<input type="text" class="e-name" value="${esc(x.name)}" placeholder="e.g. Shockwave machine" /></label>
      <label>Charged<select class="e-mode"><option value="per_session"${x.mode === 'per_session' ? ' selected' : ''}>Per session</option><option value="per_month"${x.mode === 'per_month' ? ' selected' : ''}>Per month</option></select></label>
      <label>Treatments containing<input type="text" class="e-match" value="${esc(x.match || '')}" placeholder="e.g. shockwave" /></label>
      <label>Fee (€)<input type="number" class="e-fee" min="0" step="0.5" inputmode="decimal" value="${esc(x.fee)}" /></label>
      <button type="button" class="rmBtn" data-act="rm-row" aria-label="Remove equipment">✕ Remove</button>`;
    $('equipRows').appendChild(div);
  }

  function saveRules() {
    const t = selected();
    if (!t) return;
    const m = draftModel;
    const rates = m === 'hybrid'
      ? { weekday: 0, saturday: pctOut($('r_hsat').value), sunday: pctOut($('r_hsun').value), bankHoliday: pctOut($('r_hbh').value) }
      : { weekday: pctOut($('r_wd').value), saturday: pctOut($('r_sat').value), sunday: pctOut($('r_sun').value), bankHoliday: pctOut($('r_bh').value) };
    const tiers = Array.from(document.querySelectorAll('#tierBody .tier-row')).map((tr) => ({
      min: Number(tr.querySelector('.t-min').value), rate: pctOut(tr.querySelector('.t-rent').value),
      blank: tr.querySelector('.t-min').value === '' && tr.querySelector('.t-rent').value === '',
    })).filter((x) => !x.blank).map((x) => ({ min: x.min, rate: x.rate }));
    const equipment = Array.from(document.querySelectorAll('#equipRows .equipRow')).map((d, i) => ({
      id: d.dataset.id || `eq-${Date.now().toString(36)}-${i}`,
      name: d.querySelector('.e-name').value.trim(),
      mode: d.querySelector('.e-mode').value,
      match: d.querySelector('.e-match').value.trim(),
      fee: numOut(d.querySelector('.e-fee').value),
    })).filter((e) => e.name || e.match || e.fee);
    const next = Object.assign({}, t, {
      title: $('r_title').value.trim(),
      model: m,
      rates: Object.assign({}, t.rates, rates, m === 'hybrid' ? { weekday: (t.rates || {}).weekday || 0 } : {}),
      fixedMonthly: numOut($('r_fixed').value),
      sessionFee: numOut($('r_fee').value),
      capacity: Math.round(numOut($('r_capacity').value)),
      tiers,
      rentCap: m === 'fixed_monthly' ? t.rentCap : numOut($('r_cap').value),
      minRetainer: m === 'fixed_monthly' ? t.minRetainer : numOut($('r_ret').value),
      equipment,
    });
    // only check the fields this model uses
    const check = Object.assign({}, next);
    if (m === 'fixed_monthly') { check.rentCap = 0; check.minRetainer = 0; }
    if (m === 'hybrid') check.rates = Object.assign({}, next.rates, { weekday: 0 });
    const problems = E.validateRules(check);
    if (problems.length) {
      const err = $('rulesErr');
      err.innerHTML = `<b>Fix these to save:</b><br>${problems.map(esc).join('<br>')}`;
      err.style.display = 'block';
      err.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
      return;
    }
    Object.assign(t, next);
    save();
    closeModal();
    render();
    toast(`Rules saved for ${t.name}`);
  }

  // =========================================================================
  // Profiles
  // =========================================================================

  function createProfile(name) {
    const n = String(name || '').trim();
    if (!n) return;
    if (state.therapists.some((t) => E.normName(t.name) === E.normName(n))) return toast('That profile already exists.');
    const t = E.defaultRules({ id: slug(n), name: n, title: '', model: 'percentage', rates: { weekday: 0.25, saturday: 0.2, sunday: 0.2, bankHoliday: null }, rentCap: 0, minRetainer: 0 });
    state.therapists.push(t);
    state.selectedId = t.id;
    extrasFor(t.id);
    save();
    render();
    toast(`Profile created: ${n} (25% of takings). Change it in Edit Rules.`);
  }

  function deleteProfile() {
    const t = selected();
    if (!t) return toast('Select a therapist first.');
    if (!window.confirm(`Delete the profile for ${t.name}? (Reset brings the demo therapists back.)`)) return;
    state.therapists = state.therapists.filter((x) => x.id !== t.id);
    delete state.extras[t.id];
    state.selectedId = state.therapists[0] ? state.therapists[0].id : null;
    save();
    render();
    toast(`Deleted ${t.name}`);
  }

  // =========================================================================
  // PDFs (jsPDF is loaded on first use, from vendor/)
  // =========================================================================

  let jsPDFPromise = null;
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve(window.jspdf.jsPDF);
    if (!jsPDFPromise) {
      jsPDFPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = JSPDF_SRC;
        s.onload = () => resolve(window.jspdf.jsPDF);
        s.onerror = () => { jsPDFPromise = null; reject(new Error('jsPDF failed to load')); };
        document.head.appendChild(s);
      });
    }
    return jsPDFPromise;
  }

  async function downloadPDF(all) {
    const t = selected();
    if (!all && !t) return toast('Select a therapist first.');
    if (!hasBookings() && (all || t.model !== 'fixed_monthly')) return toast('Load the sample month or upload a CSV first.');
    const items = all ? last.results : [resultFor(t.id)];
    if (!items.length) return toast('There are no therapists to make statements for.');
    try {
      toast(all ? `Making ${items.length} statements…` : `Making ${t.name}'s statement…`);
      const jsPDF = await loadJsPDF();
      const p = period();
      const doc = P.build(jsPDF, items, { clinic: C.CLINIC, period: p, statementDate: state.statementDate || todayISO(), compress: true });
      doc.save(all ? P.allFileName(C.CLINIC, p) : P.fileName(t, p));
      toast(all ? `Downloaded ${items.length} statements in one PDF` : `Downloaded ${P.fileName(t, p)}`);
    } catch (e) {
      console.error(e);
      toast('Sorry, the PDF couldn’t be made. Try again.');
    }
  }

  // =========================================================================
  // Events
  // =========================================================================

  function reset() {
    if (!window.confirm('Reset the demo? This brings back the sample month, the five therapists and their rules.')) return;
    try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ }
    state = seededState();
    save();
    closeModal();
    render();
    window.scrollTo({ top: 0, behavior: 'smooth' });
    toast('Demo reset · sample month loaded');
  }

  const actions = {
    'select': (el) => {
      if (state.selectedId !== el.dataset.id) {
        state.selectedId = el.dataset.id;
        save();
        render();
      }
      if (el.classList.contains('ovRow') && window.matchMedia('(max-width: 980px)').matches) {
        document.querySelector('.hero').scrollIntoView({ behavior: 'smooth', block: 'start' });
      }
    },
    'load-sample': loadSample,
    'pick-file': () => $('fileInput').click(),
    'pdf-one': () => downloadPDF(false),
    'pdf-all': () => downloadPDF(true),
    'open-calc': openCalc,
    'apply-calc': applyCalc,
    'open-rules': openRules,
    'save-rules': saveRules,
    'add-tier': () => addTierRow('', ''),
    'add-equipment': () => addEquipRow(null),
    'rm-row': (el) => { const r = el.closest('tr, .equipRow'); if (r) r.remove(); },
    'open-period': openPeriod,
    'save-period': savePeriod,
    'close-modal': closeModal,
    'map-import': importMapped,
    'create-profile': () => createProfile(window.prompt('New therapist name (as it appears in the bookings export):')),
    'add-unmatched': (el) => createProfile(el.dataset.name),
    'delete-profile': deleteProfile,
    'reset': reset,
    'add-itemised': () => addLine('itemised'),
    'add-adjustment': () => addLine('adjustments'),
    'rm-line': (el) => {
      const t = selected();
      if (!t) return;
      extrasFor(t.id)[el.dataset.kind].splice(Number(el.dataset.i), 1);
      save();
      render();
    },
  };

  function addLine(kind) {
    const t = selected();
    if (!t) return toast('Select a therapist first.');
    extrasFor(t.id)[kind].push({ label: '', amount: 0 });
    save();
    render();
    const inputs = document.querySelectorAll(`[data-line="${kind}"][data-f="label"]`);
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  document.addEventListener('click', (ev) => {
    const el = ev.target.closest('[data-act]');
    if (el && actions[el.dataset.act]) {
      ev.preventDefault();
      actions[el.dataset.act](el);
      return;
    }
    // click on the dark backdrop closes a modal
    if (openId && ev.target.id === openId) closeModal();
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && openId) closeModal();
  });

  document.addEventListener('input', (ev) => {
    const el = ev.target;
    if (el.dataset.line) {
      const t = selected();
      if (!t) return;
      const line = extrasFor(t.id)[el.dataset.line][Number(el.dataset.i)];
      if (!line) return;
      line[el.dataset.f] = el.dataset.f === 'amount' ? (el.value === '' ? 0 : Number(el.value)) : el.value;
      save();
      render({ keepLines: true });
      updateLineTotals();
    } else if (el.id === 'capActualInput') {
      const t = selected();
      if (!t) return;
      const v = el.value.trim();
      const fromExport = resultFor(t.id).summary.sessions;
      extrasFor(t.id).sessionsOverride = v === '' || Number(v) === fromExport ? null : Math.max(0, Math.round(Number(v)));
      save();
      render({ keepLines: true, keepCapInput: true });
    } else if (['c_hours', 'c_b30', 'c_b45', 'c_b60', 'c_perHour'].includes(el.id)) {
      recomputeCalc();
    } else if (el.id === 'pMonth') {
      previewPeriod();
    }
  });

  document.addEventListener('change', (ev) => {
    const el = ev.target;
    if (el.name === 'rentModel') setDraftModel(el.value);
    else if (el.name === 'apptDur') recomputeCalc();
    else if (el.id === 'pStart' || el.id === 'pMonth') previewPeriod();
    else if (el.dataset.map) { updateExample(el.dataset.map, pending.rows[pending.header + 1] || []); updateMapPreview(); }
    else if (el.id === 'mapDateOrder') updateMapPreview();
    else if (el.id === 'invoiceDateInput') { state.statementDate = el.value || todayISO(); save(); }
    else if (el.id === 'fileInput') { handleFile(el.files && el.files[0]); el.value = ''; }
  });

  // drag and drop onto the upload box
  const drop = $('dropArea');
  ['dragenter', 'dragover'].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.style.borderColor = 'rgba(255,62,91,.45)';
  }));
  ['dragleave', 'drop'].forEach((t) => drop.addEventListener(t, (e) => {
    e.preventDefault();
    drop.style.borderColor = '';
  }));
  drop.addEventListener('drop', (e) => handleFile(e.dataTransfer.files && e.dataTransfer.files[0]));

  // another tab reset or changed the demo: follow it
  window.addEventListener('storage', (e) => {
    if (e.key !== KEY) return;
    state = load() || seededState();
    render();
  });

  save();
  render();
})();
