/*!
 * PulsePay rent engine
 * ---------------------------------------------------------------------------
 * Works out what each self-employed therapist owes the clinic for a billing
 * period, from a bookings export and the therapist's rent deal.
 *
 * Pure functions only: no DOM, no storage, no network, no clock. The same
 * file runs in the browser (as window.PulsePayEngine) and in Node (require),
 * where the unit tests drive it. The dashboard and the PDF statement both
 * print from the result it returns, so they can never disagree.
 *
 * Units
 *   - Rules are written the way a person types them: euros for amounts
 *     (fixedMonthly: 650) and decimal rates for percentages (0.25 = 25%).
 *   - Everything the engine returns is in whole cents (integers), and every
 *     multiplication is rounded to the cent straight away (halves round up),
 *     so the lines on a statement always add up to its total.
 *   - Dates are plain 'YYYY-MM-DD' strings. Days of the week are worked out
 *     in UTC from the calendar date, so the result never depends on the
 *     time zone of the computer running it.
 *
 * Pipeline
 *   1. normaliseRows()   CSV cells + a column mapping -> bookings
 *   2. summarise()       one therapist's bookings in the period -> counts and
 *                        takings per day type (weekday, Saturday, Sunday,
 *                        bank holiday), plus equipment use
 *   3. calculateRent()   summary + rules + this period's itemised charges and
 *                        adjustments -> rent, line by line
 *   calculateClinic() runs 2 and 3 for every therapist at once.
 *
 * Rent models
 *   percentage     a share of takings, with its own rate for weekdays,
 *                  Saturdays, Sundays and (optionally) bank holidays
 *   fixed_monthly  a flat amount for the period, whatever the takings
 *   per_session    a flat fee for every session seen
 *   tiered         one rate for all takings, picked from a tier table by how
 *                  full the therapist's diary was (sessions / capacity)
 *   hybrid         tiered rate on weekdays, fixed rates on Saturdays, Sundays
 *                  and bank holidays
 *
 * Then, in this order:
 *   rent cap       a ceiling on the rent share (not for fixed_monthly)
 *   min. retainer  a floor on the rent share (not for fixed_monthly)
 *   equipment      per session (bookings whose treatment names it) or per month
 *   itemised       plain extra charges for the period (e.g. room hire)
 *   adjustments    credits (negative) and debits (positive)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PulsePayEngine = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ===================================================================
  // Money
  // ===================================================================

  /** Euros (number or numeric string) -> whole cents. Non-numbers -> 0. */
  function toCents(euros) {
    const n = Number(euros);
    if (!Number.isFinite(n)) return 0;
    // The tiny nudge stops 1.005 * 100 = 100.49999… from rounding down.
    return Math.round(n * 100 + (n >= 0 ? 1e-7 : -1e-7));
  }

  /** cents x rate, rounded to the nearest cent (halves up). */
  function applyRate(cents, rate) {
    const r = Number(rate) || 0;
    return Math.round(cents * r + 1e-9);
  }

  /**
   * Reads a money cell from a bookings export. Returns euros as a number, or
   * NaN if the cell is blank or unreadable. Understands "€1,234.50",
   * "1234.5", "EUR 80", "45,00" and "1.234,50" (decimal comma), "-35" and
   * "(35.00)" (negative).
   */
  function parseMoney(value) {
    if (typeof value === 'number') return Number.isFinite(value) ? value : NaN;
    let s = String(value == null ? '' : value).trim();
    if (!s) return NaN;
    let negative = false;
    if (/^\(.*\)$/.test(s)) { negative = true; s = s.slice(1, -1); }
    s = s.replace(/EUR/gi, '').replace(/[€$£\s ]/g, '');
    if (s.startsWith('-')) { negative = !negative; s = s.slice(1); }
    if (/^\d{1,3}(\.\d{3})+,\d{1,2}$/.test(s) || /^\d+,\d{1,2}$/.test(s)) {
      s = s.replace(/\./g, '').replace(',', '.'); // decimal comma
    } else {
      s = s.replace(/,/g, ''); // thousands commas
    }
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    const n = Number(s);
    return negative ? -n : n;
  }

  // ===================================================================
  // Dates
  // ===================================================================

  const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const MONTHS_LONG = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

  function pad2(n) { return String(n).padStart(2, '0'); }
  function isoOf(y, m, d) { return `${y}-${pad2(m)}-${pad2(d)}`; }
  function daysInMonth(y, m) { return new Date(Date.UTC(y, m, 0)).getUTCDate(); }

  function validYMD(y, m, d) {
    return Number.isInteger(y) && y >= 1900 && y <= 2200 &&
      Number.isInteger(m) && m >= 1 && m <= 12 &&
      Number.isInteger(d) && d >= 1 && d <= daysInMonth(y, m);
  }

  function monthIndex(word) {
    const w = String(word).slice(0, 3).toLowerCase();
    return MONTHS.findIndex((m) => m.toLowerCase() === w) + 1; // 0 if unknown
  }

  /**
   * Reads a date cell. Returns 'YYYY-MM-DD' or null.
   * Accepts ISO (2026-10-05, with or without a time), numeric dates
   * (05/10/2026, 5.10.26, 05-10-2026; day first unless order is 'mdy'),
   * and written dates (5 Oct 2026, Mon 5 October 2026, Oct 5, 2026).
   */
  function parseDate(value, order) {
    if (value == null) return null;
    let s = String(value).trim();
    if (!s) return null;
    let m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
    if (m) {
      const y = +m[1], mo = +m[2], d = +m[3];
      return validYMD(y, mo, d) ? isoOf(y, mo, d) : null;
    }
    m = s.match(/^(\d{1,2})[/.\-](\d{1,2})[/.\-](\d{2}|\d{4})(?:[\s,T].*)?$/);
    if (m) {
      let a = +m[1], b = +m[2], y = +m[3];
      if (m[3].length === 2) y += 2000;
      const [d, mo] = order === 'mdy' ? [b, a] : [a, b];
      return validYMD(y, mo, d) ? isoOf(y, mo, d) : null;
    }
    // leading weekday: "Mon 5 Oct 2026", "Monday, 5 October 2026"
    s = s.replace(/^(mon|tue|tues|wed|thu|thur|thurs|fri|sat|sun)[a-z]*\.?,?\s+(?=\d)/i, '');
    m = s.match(/^(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]{3,9})\.?,?\s+(\d{4})\b/);
    if (m) {
      const d = +m[1], mo = monthIndex(m[2]), y = +m[3];
      return mo && validYMD(y, mo, d) ? isoOf(y, mo, d) : null;
    }
    m = s.match(/^([A-Za-z]{3,9})\.?\s+(\d{1,2})(?:st|nd|rd|th)?,?\s+(\d{4})\b/);
    if (m) {
      const mo = monthIndex(m[1]), d = +m[2], y = +m[3];
      return mo && validYMD(y, mo, d) ? isoOf(y, mo, d) : null;
    }
    return null;
  }

  /** 0 = Sunday … 6 = Saturday, from the calendar date alone. */
  function weekdayOf(iso) {
    const [y, m, d] = iso.split('-').map(Number);
    return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  }

  /** 'weekday' | 'saturday' | 'sunday' | 'bankHoliday'. Bank holidays win. */
  function dayType(iso, bankHolidays) {
    const bh = bankHolidays instanceof Set ? bankHolidays : new Set(bankHolidays || []);
    if (bh.has(iso)) return 'bankHoliday';
    const wd = weekdayOf(iso);
    if (wd === 6) return 'saturday';
    if (wd === 0) return 'sunday';
    return 'weekday';
  }

  /** '2026-10-05' -> '5 Oct 2026' */
  function formatDate(iso) {
    if (!iso) return '';
    const [y, m, d] = iso.split('-').map(Number);
    return `${d} ${MONTHS[m - 1]} ${y}`;
  }

  /**
   * The billing period that starts in the given month.
   * startDay 1 (the default) runs from the 1st to the last day of the month.
   * Any other start day (2–28) runs to the day before it in the next month,
   * e.g. startDay 15 in October = 15 Oct – 14 Nov. Both ends are included.
   */
  function billingPeriod(opts) {
    const year = Number(opts && opts.year);
    const month = Number(opts && opts.month);
    let startDay = Math.round(Number(opts && opts.startDay) || 1);
    startDay = Math.min(28, Math.max(1, startDay));
    if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
      throw new Error('billingPeriod needs a year and a month (1–12)');
    }
    const start = isoOf(year, month, startDay);
    let end;
    if (startDay === 1) {
      end = isoOf(year, month, daysInMonth(year, month));
    } else {
      const ny = month === 12 ? year + 1 : year;
      const nm = month === 12 ? 1 : month + 1;
      end = isoOf(ny, nm, startDay - 1);
    }
    const label = `${formatDate(start)} – ${formatDate(end)}`;
    const name = startDay === 1 ? `${MONTHS_LONG[month - 1]} ${year}` : label;
    return { year, month, startDay, start, end, label, name };
  }

  function inPeriod(iso, period) {
    return !!iso && iso >= period.start && iso <= period.end;
  }

  // ===================================================================
  // Bookings export: columns, rows, statuses, names
  // ===================================================================

  const FIELDS = ['date', 'therapist', 'treatment', 'price', 'status'];
  const REQUIRED_FIELDS = ['date', 'therapist', 'price'];
  const FIELD_LABELS = {
    date: 'Date', therapist: 'Therapist', treatment: 'Treatment', price: 'Price', status: 'Status',
  };

  // Exact header names first, then words a header may contain.
  const HEADER_HINTS = {
    date: {
      exact: ['date', 'appointment date', 'appt date', 'session date', 'booking date', 'invoice date', 'service date', 'visit date', 'day'],
      contains: ['date'],
    },
    therapist: {
      exact: ['therapist', 'practitioner', 'provider', 'clinician', 'staff', 'staff member', 'team member', 'physio', 'therapist name', 'practitioner name'],
      contains: ['practitioner', 'therapist', 'provider', 'clinician', 'staff'],
    },
    price: {
      exact: ['price', 'amount', 'total', 'fee', 'charge', 'billed', 'invoice total', 'amount billed', 'collected', 'value'],
      contains: ['amount', 'price', 'total', 'fee', 'charge', 'billed', 'collected'],
    },
    treatment: {
      exact: ['treatment', 'service', 'appointment type', 'item', 'session type', 'service name', 'treatment type', 'product', 'description'],
      contains: ['treatment', 'service', 'appointment type', 'item'],
    },
    status: {
      exact: ['status', 'appointment status', 'attendance', 'outcome', 'booking status', 'state'],
      contains: ['status', 'attendance', 'outcome'],
    },
  };

  function normHeader(h) {
    return String(h == null ? '' : h).replace(/﻿/g, '').toLowerCase()
      .replace(/\(.*?\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /**
   * Guesses which column holds each field. Returns { date: 1, therapist: 3, … }
   * with a column index, or -1 when no column looks right. One column is
   * never used for two fields.
   */
  function guessMapping(headers) {
    const names = (headers || []).map(normHeader);
    const used = new Set();
    const mapping = {};
    const order = ['date', 'therapist', 'price', 'treatment', 'status'];
    for (const field of order) {
      const hints = HEADER_HINTS[field];
      let idx = names.findIndex((n, i) => !used.has(i) && hints.exact.includes(n));
      if (idx === -1) {
        idx = names.findIndex((n, i) => !used.has(i) && n && hints.contains.some((w) => n.includes(w)));
      }
      mapping[field] = idx;
      if (idx !== -1) used.add(idx);
    }
    return mapping;
  }

  /** True when every required field has a column. */
  function mappingComplete(mapping) {
    return REQUIRED_FIELDS.every((f) => Number.isInteger(mapping[f]) && mapping[f] >= 0);
  }

  /**
   * Many exports put a title or a date range above the real header row.
   * Returns the index of the first of the top 10 rows that looks like a
   * header (date column plus a therapist or price column), or 0.
   */
  function findHeaderRow(rows) {
    const limit = Math.min(10, (rows || []).length);
    for (let i = 0; i < limit; i++) {
      const m = guessMapping(rows[i] || []);
      if (m.date !== -1 && (m.therapist !== -1 || m.price !== -1)) return i;
    }
    return 0;
  }

  /**
   * Turns raw CSV rows (arrays of cells) into bookings, using a column
   * mapping from guessMapping() or the column mapper.
   *   rows        every row of the file, header row included
   *   headerIndex which row is the header (data starts on the next row)
   *   mapping     { date, therapist, treatment, price, status } -> column index (-1 = none)
   *   options     { dateOrder: 'dmy' | 'mdy' }
   * Returns { bookings, skipped }. Patient columns are never read.
   */
  function normaliseRows(rows, headerIndex, mapping, options) {
    const dateOrder = (options && options.dateOrder) || 'dmy';
    const cell = (row, field) => {
      const i = mapping[field];
      return Number.isInteger(i) && i >= 0 ? String(row[i] == null ? '' : row[i]).trim() : '';
    };
    const bookings = [];
    const skipped = [];
    for (let r = (headerIndex || 0) + 1; r < (rows || []).length; r++) {
      const row = rows[r] || [];
      const raw = { date: cell(row, 'date'), therapist: cell(row, 'therapist'), price: cell(row, 'price') };
      if (!raw.date && !raw.therapist && !raw.price) continue; // blank line
      const line = r + 1; // 1-based, as a spreadsheet shows it
      const date = parseDate(raw.date, dateOrder);
      if (!date) { skipped.push({ line, reason: 'unreadable date' }); continue; }
      if (!raw.therapist) { skipped.push({ line, reason: 'no therapist' }); continue; }
      let euros = raw.price === '' ? 0 : parseMoney(raw.price);
      if (Number.isNaN(euros)) { skipped.push({ line, reason: 'unreadable price' }); continue; }
      bookings.push({
        date,
        therapist: raw.therapist,
        treatment: cell(row, 'treatment'),
        status: cell(row, 'status'),
        priceCents: toCents(euros),
      });
    }
    return { bookings, skipped };
  }

  const NO_CHARGE = /no[\s-]?charge|complimentary|\bcomp\b|\bfree\b|\bfoc\b/i;
  const NOT_SEEN = /cancel|no[\s-]?show|did not attend|\bdna\b|missed|not attended|absent/i;
  const VOID = /refund|void|deleted/i;

  /**
   * How a booking counts:
   *   'session'          seen and charged: a session, and its price is takings
   *   'no_charge'        seen for free: a session, no takings
   *   'cancellation_fee' cancelled or missed but a fee was charged: the fee
   *                      is takings, but it is not a session
   *   'ignored'          cancelled or missed with no fee, refunded/void, or a
   *                      negative amount
   */
  function classifyBooking(status, priceCents) {
    const s = String(status || '');
    if (VOID.test(s) || priceCents < 0) return 'ignored';
    if (NOT_SEEN.test(s)) return priceCents > 0 ? 'cancellation_fee' : 'ignored';
    if (NO_CHARGE.test(s) || priceCents === 0) return 'no_charge';
    return 'session';
  }

  function normName(name) {
    let s = String(name || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().trim();
    const comma = s.match(/^([^,]+),\s*(.+)$/); // "Byrne, Sarah" -> "sarah byrne"
    if (comma) s = `${comma[2]} ${comma[1]}`;
    return s.replace(/[^a-z0-9' ]+/g, ' ')
      .replace(/^(dr|mr|mrs|ms|miss)\s+/, '')
      .replace(/\s+/g, ' ').trim();
  }

  /** Finds the therapist a name in the export belongs to. Returns an id or null. */
  function matchTherapist(name, therapists) {
    const n = normName(name);
    if (!n) return null;
    for (const t of therapists || []) {
      const names = [t.name].concat(t.aliases || []);
      if (names.some((x) => normName(x) === n)) return t.id;
    }
    return null;
  }

  // ===================================================================
  // Rules
  // ===================================================================

  const MODELS = ['percentage', 'fixed_monthly', 'per_session', 'tiered', 'hybrid'];
  const MODEL_LABELS = {
    percentage: 'Percentage of takings',
    fixed_monthly: 'Fixed monthly rent',
    per_session: 'Fixed fee per session',
    tiered: 'Tiered by capacity',
    hybrid: 'Hybrid: tiered weekdays, fixed weekends',
  };
  const DAY_LABELS = { weekday: 'Weekdays', saturday: 'Saturdays', sunday: 'Sundays', bankHoliday: 'Bank holidays' };
  const DAY_ORDER = ['weekday', 'saturday', 'sunday', 'bankHoliday'];

  /** A complete rules object with every field present. */
  function defaultRules(overrides) {
    return Object.assign({
      id: '',
      name: '',
      title: '',
      model: 'percentage',
      rates: { weekday: 0.25, saturday: 0.2, sunday: 0.2, bankHoliday: null },
      fixedMonthly: 0,
      sessionFee: 0,
      capacity: 0,
      tiers: [],
      rentCap: 0,
      minRetainer: 0,
      equipment: [],
    }, overrides || {});
  }

  /** Lists anything about a rules object that would give a wrong statement. */
  function validateRules(rules) {
    const problems = [];
    const r = rules || {};
    const isRate = (x) => typeof x === 'number' && Number.isFinite(x) && x >= 0 && x <= 1;
    if (!MODELS.includes(r.model)) problems.push(`Unknown rent model "${r.model}".`);
    if (!String(r.name || '').trim()) problems.push('A therapist needs a name.');
    const rates = r.rates || {};
    if (r.model === 'percentage' || r.model === 'hybrid') {
      const days = r.model === 'percentage' ? ['weekday', 'saturday', 'sunday'] : ['saturday', 'sunday'];
      for (const d of days) if (!isRate(rates[d])) problems.push(`${DAY_LABELS[d]} rate must be between 0% and 100%.`);
      if (rates.bankHoliday != null && !isRate(rates.bankHoliday)) problems.push('Bank holiday rate must be between 0% and 100%.');
    }
    if (r.model === 'fixed_monthly' && !(Number(r.fixedMonthly) > 0)) problems.push('Fixed monthly rent must be more than €0.');
    if (r.model === 'per_session' && !(Number(r.sessionFee) > 0)) problems.push('Fee per session must be more than €0.');
    if (r.model === 'tiered' || r.model === 'hybrid') {
      if (!(Number(r.capacity) > 0)) problems.push('Capacity (max sessions in the period) must be more than 0.');
      const tiers = r.tiers || [];
      if (!tiers.length) problems.push('Add at least one capacity tier.');
      const mins = new Set();
      for (const t of tiers) {
        if (!(Number.isFinite(t.min) && t.min >= 0)) problems.push('Each tier needs a starting capacity of 0% or more.');
        if (!isRate(t.rate)) problems.push('Each tier rate must be between 0% and 100%.');
        if (mins.has(t.min)) problems.push(`Two tiers start at ${t.min}%.`);
        mins.add(t.min);
      }
      if (tiers.length && !tiers.some((t) => t.min === 0)) problems.push('The first tier should start at 0% so every capacity has a rate.');
    }
    if (Number(r.rentCap) < 0 || Number(r.minRetainer) < 0) problems.push('Rent cap and retainer can’t be negative.');
    if (Number(r.rentCap) > 0 && Number(r.minRetainer) > Number(r.rentCap)) problems.push('The minimum retainer is above the rent cap.');
    for (const e of r.equipment || []) {
      if (!String(e.name || '').trim()) problems.push('Each equipment fee needs a name.');
      if (!['per_session', 'per_month'].includes(e.mode)) problems.push(`Equipment "${e.name}" must be charged per session or per month.`);
      if (!(Number(e.fee) >= 0)) problems.push(`Equipment "${e.name}" needs a fee of €0 or more.`);
      if (e.mode === 'per_session' && !String(e.match || '').trim()) problems.push(`Equipment "${e.name}" needs a word to find in treatment names.`);
    }
    return problems;
  }

  function sortedTiers(tiers) {
    return (tiers || []).slice().sort((a, b) => a.min - b.min);
  }

  /**
   * Picks the tier for a capacity. Capacity is rounded to a whole percent
   * first (the figure printed on the statement), then the tier with the
   * highest starting point at or below it wins: with tiers from 0, 50, 70
   * and 85, 69.6% -> 70% -> the 70% tier. Returns an index into the sorted
   * tiers, or -1 if capacity is below every tier.
   */
  function findTierIndex(capacityPctWhole, tiers) {
    const list = sortedTiers(tiers);
    let best = -1;
    for (let i = 0; i < list.length; i++) if (capacityPctWhole >= list[i].min) best = i;
    return best;
  }

  /** "0–49%", "50–69%", "85%+" for each sorted tier. */
  function tierRanges(tiers) {
    const list = sortedTiers(tiers);
    return list.map((t, i) => (i < list.length - 1 ? `${t.min}–${list[i + 1].min - 1}%` : `${t.min}%+`));
  }

  // ===================================================================
  // Summarise one therapist's bookings
  // ===================================================================

  function emptyDay() { return { sessions: 0, takings: 0 }; }

  /**
   * Counts one therapist's bookings inside the period.
   *   bookings  that therapist's bookings (from normaliseRows)
   *   rules     their rules (for equipment matching)
   *   options   { period, bankHolidays }
   */
  function summarise(bookings, rules, options) {
    const period = options && options.period;
    const bh = new Set((options && options.bankHolidays) || []);
    const equipment = (rules && rules.equipment) || [];
    const s = {
      sessions: 0,
      paidSessions: 0,
      noChargeSessions: 0,
      cancellationFees: 0,
      ignored: 0,
      outsidePeriod: 0,
      takings: 0,
      byDay: { weekday: emptyDay(), saturday: emptyDay(), sunday: emptyDay(), bankHoliday: emptyDay() },
      bankHolidaysWorked: [],
      equipmentUse: {},
    };
    for (const e of equipment) s.equipmentUse[e.id || e.name] = 0;
    const bhWorked = new Set();

    for (const b of bookings || []) {
      if (period && !inPeriod(b.date, period)) { s.outsidePeriod++; continue; }
      const kind = classifyBooking(b.status, b.priceCents);
      if (kind === 'ignored') { s.ignored++; continue; }
      const day = dayType(b.date, bh);
      if (kind === 'cancellation_fee') {
        s.cancellationFees++;
        s.takings += b.priceCents;
        s.byDay[day].takings += b.priceCents;
        continue;
      }
      s.sessions++;
      s.byDay[day].sessions++;
      if (day === 'bankHoliday') bhWorked.add(b.date);
      if (kind === 'no_charge') s.noChargeSessions++;
      else {
        s.paidSessions++;
        s.takings += b.priceCents;
        s.byDay[day].takings += b.priceCents;
      }
      const treatment = String(b.treatment || '').toLowerCase();
      for (const e of equipment) {
        if (e.mode === 'per_session' && e.match && treatment.includes(String(e.match).toLowerCase())) {
          s.equipmentUse[e.id || e.name]++;
        }
      }
    }
    s.bankHolidaysWorked = Array.from(bhWorked).sort();
    return s;
  }

  // ===================================================================
  // Rent
  // ===================================================================

  /**
   * Works out the rent for one therapist.
   *   rules    their rules (see defaultRules)
   *   summary  from summarise()
   *   extras   { itemised: [{label, amount}], adjustments: [{label, amount}],
   *              sessionsOverride: number | null }   (amounts in euros)
   *
   * sessionsOverride replaces the session count from the export for
   * capacity and per-session rent (e.g. sessions booked outside the system).
   * Takings always come from the export.
   *
   * Returns amounts in cents, plus `steps`: the calculation written out line
   * by line, in order, for the dashboard and the PDF.
   */
  function calculateRent(rules, summary, extras) {
    const r = defaultRules(rules);
    const s = summary || summarise([], r, {});
    const x = extras || {};
    const rates = Object.assign({ weekday: 0, saturday: 0, sunday: 0, bankHoliday: null }, r.rates || {});
    const warnings = [];
    const steps = [];

    const override = x.sessionsOverride;
    const hasOverride = override !== null && override !== undefined && override !== '' &&
      Number.isFinite(Number(override)) && Number(override) >= 0 && Math.round(Number(override)) !== s.sessions;
    const sessions = hasOverride ? Math.round(Number(override)) : s.sessions;
    if (hasOverride) {
      steps.push({ kind: 'note', label: `Sessions set by hand to ${sessions} (the export has ${s.sessions})`, amount: null });
    }

    // ---- capacity (tiered and hybrid) ----
    let capacity = null;
    if (r.model === 'tiered' || r.model === 'hybrid') {
      const max = Math.round(Number(r.capacity) || 0);
      const tiers = sortedTiers(r.tiers);
      const ranges = tierRanges(tiers);
      const pct = max > 0 ? Math.round((sessions / max) * 100) : 0;
      let idx = tiers.length ? findTierIndex(pct, tiers) : -1;
      if (max <= 0) warnings.push('No capacity is set, so capacity counts as 0%.');
      if (!tiers.length) warnings.push('No capacity tiers are set, so the rate is 0%.');
      else if (idx === -1) {
        idx = 0;
        warnings.push(`No tier starts at or below ${pct}%, so the lowest tier was used.`);
      }
      const tier = idx >= 0 ? tiers[idx] : null;
      capacity = {
        max, sessions, pct, tierIndex: idx, rate: tier ? tier.rate : 0,
        range: idx >= 0 ? ranges[idx] : '',
        tiers: tiers.map((t, i) => ({ min: t.min, rate: t.rate, range: ranges[i] })),
      };
      steps.push({
        kind: 'capacity',
        label: `Capacity: ${sessions} of ${max} sessions = ${pct}%, so the ${capacity.range} tier at ${formatRate(capacity.rate)}`,
        amount: null,
      });
    }

    // ---- base rent ----
    const shares = [];
    let gross = 0;
    const share = (day, rate, rateNote) => {
      const d = s.byDay[day];
      if (!d || (d.takings === 0 && d.sessions === 0)) return;
      const amount = applyRate(d.takings, rate);
      shares.push({ day, label: DAY_LABELS[day], sessions: d.sessions, takings: d.takings, rate, amount, rateNote: rateNote || '' });
      gross += amount;
      steps.push({ kind: 'share', label: `${DAY_LABELS[day]}: ${euro(d.takings)} × ${formatRate(rate)}${rateNote ? ` (${rateNote})` : ''}`, amount });
    };

    switch (r.model) {
      case 'percentage': {
        share('weekday', rates.weekday);
        share('saturday', rates.saturday);
        share('sunday', rates.sunday);
        if (rates.bankHoliday != null) share('bankHoliday', rates.bankHoliday);
        else share('bankHoliday', rates.weekday, 'weekday rate');
        break;
      }
      case 'tiered': {
        const all = DAY_ORDER.reduce((acc, d) => {
          acc.sessions += s.byDay[d].sessions; acc.takings += s.byDay[d].takings; return acc;
        }, { sessions: 0, takings: 0 });
        const amount = applyRate(all.takings, capacity.rate);
        shares.push({ day: 'all', label: 'All takings', sessions: all.sessions, takings: all.takings, rate: capacity.rate, amount, rateNote: `tier ${capacity.range}` });
        gross = amount;
        steps.push({ kind: 'share', label: `All takings: ${euro(all.takings)} × ${formatRate(capacity.rate)} (tier ${capacity.range})`, amount });
        break;
      }
      case 'hybrid': {
        share('weekday', capacity.rate, `tier ${capacity.range}`);
        share('saturday', rates.saturday);
        share('sunday', rates.sunday);
        if (rates.bankHoliday != null) share('bankHoliday', rates.bankHoliday);
        else share('bankHoliday', capacity.rate, 'weekday tier rate');
        break;
      }
      case 'per_session': {
        const fee = toCents(r.sessionFee);
        gross = sessions * fee;
        steps.push({ kind: 'per_session', label: `${sessions} session${sessions === 1 ? '' : 's'} × ${euro(fee)}`, amount: gross });
        break;
      }
      case 'fixed_monthly': {
        gross = toCents(r.fixedMonthly);
        steps.push({ kind: 'fixed', label: 'Fixed monthly rent', amount: gross });
        break;
      }
      default:
        throw new Error(`Unknown rent model "${r.model}"`);
    }

    if (shares.length > 1 || (r.model !== 'fixed_monthly' && r.model !== 'per_session' && shares.length === 0)) {
      steps.push({ kind: 'subtotal', label: 'Rent share', amount: gross });
    }

    // ---- cap and retainer (not for fixed monthly rent) ----
    const limitsApply = r.model !== 'fixed_monthly';
    const cap = limitsApply ? toCents(r.rentCap) : 0;
    const retainer = limitsApply ? toCents(r.minRetainer) : 0;
    let rent = gross;
    let capApplied = false;
    let retainerApplied = false;
    if (cap > 0 && rent > cap) {
      steps.push({ kind: 'cap', label: `Rent cap: ${euro(gross)} is above the ${euro(cap)} cap`, amount: cap - gross });
      rent = cap;
      capApplied = true;
    }
    if (retainer > 0 && rent < retainer) {
      steps.push({ kind: 'retainer', label: `Minimum retainer: ${euro(rent)} is below the ${euro(retainer)} minimum`, amount: retainer - rent });
      rent = retainer;
      retainerApplied = true;
    }

    // ---- equipment ----
    const equipment = [];
    for (const e of r.equipment || []) {
      const fee = toCents(e.fee);
      if (e.mode === 'per_month') {
        equipment.push({ name: e.name, mode: e.mode, count: null, fee, amount: fee });
        steps.push({ kind: 'equipment', label: `${e.name} (per month)`, amount: fee });
      } else {
        const count = (s.equipmentUse && s.equipmentUse[e.id || e.name]) || 0;
        const amount = count * fee;
        equipment.push({ name: e.name, mode: e.mode, count, fee, amount });
        if (count > 0) steps.push({ kind: 'equipment', label: `${e.name}: ${count} × ${euro(fee)}`, amount });
      }
    }
    const equipmentTotal = equipment.reduce((t, e) => t + e.amount, 0);

    // ---- itemised charges and adjustments ----
    const itemised = (x.itemised || [])
      .map((i) => ({ label: String(i.label || '').trim() || 'Charge', amount: Math.max(0, toCents(i.amount)) }))
      .filter((i) => i.amount > 0);
    for (const i of itemised) steps.push({ kind: 'itemised', label: i.label, amount: i.amount });
    const itemisedTotal = itemised.reduce((t, i) => t + i.amount, 0);

    const adjustments = (x.adjustments || [])
      .map((a) => ({ label: String(a.label || '').trim() || 'Adjustment', amount: toCents(a.amount) }))
      .filter((a) => a.amount !== 0);
    for (const a of adjustments) steps.push({ kind: 'adjustment', label: a.label, amount: a.amount });
    const adjustmentsTotal = adjustments.reduce((t, a) => t + a.amount, 0);

    const total = rent + equipmentTotal + itemisedTotal + adjustmentsTotal;
    steps.push({ kind: 'total', label: total < 0 ? 'Credit due to therapist' : 'Total due', amount: total });

    return {
      model: r.model,
      modelLabel: MODEL_LABELS[r.model],
      sessions,
      sessionsFromExport: s.sessions,
      takings: s.takings,
      capacity,
      shares,
      gross,
      rentCap: cap,
      minRetainer: retainer,
      limitsApply,
      capApplied,
      retainerApplied,
      rent,
      equipment,
      equipmentTotal,
      itemised,
      itemisedTotal,
      adjustments,
      adjustmentsTotal,
      total,
      steps,
      warnings,
    };
  }

  /**
   * Runs the whole clinic for one period.
   *   therapists  rules for each therapist
   *   bookings    every booking in the export (from normaliseRows)
   *   options     { period, bankHolidays, extras: { [therapistId]: extras } }
   * Returns { results: [{ therapist, summary, rent }], unmatched, outsidePeriod, totals }.
   */
  function calculateClinic(therapists, bookings, options) {
    const opts = options || {};
    const byId = {};
    for (const t of therapists || []) byId[t.id] = [];
    const unmatched = {};
    let outsidePeriod = 0;
    for (const b of bookings || []) {
      if (opts.period && !inPeriod(b.date, opts.period)) { outsidePeriod++; continue; }
      const id = matchTherapist(b.therapist, therapists);
      if (id) byId[id].push(b);
      else {
        const key = b.therapist.trim();
        unmatched[key] = (unmatched[key] || 0) + 1;
      }
    }
    const results = (therapists || []).map((t) => {
      const summary = summarise(byId[t.id], t, { period: opts.period, bankHolidays: opts.bankHolidays });
      const rent = calculateRent(t, summary, (opts.extras || {})[t.id]);
      return { therapist: t, summary, rent };
    });
    const totals = results.reduce((acc, x) => {
      acc.sessions += x.rent.sessions;
      acc.takings += x.summary.takings;
      acc.rent += x.rent.total;
      return acc;
    }, { sessions: 0, takings: 0, rent: 0 });
    return {
      results,
      unmatched: Object.keys(unmatched).sort().map((name) => ({ name, rows: unmatched[name] })),
      outsidePeriod,
      totals,
    };
  }

  // ===================================================================
  // Capacity calculator
  // ===================================================================

  /**
   * Max sessions a therapist can see from their hours:
   * (hours − breaks) ÷ session length, rounded down. Also suggests a
   * minimum retainer of hours × retainerPerHour (euros, whole).
   *   { hours, breaks: { 30: n, 45: n, 60: n }, sessionMinutes, retainerPerHour }
   */
  function capacityFromHours(input) {
    const hours = Number(input && input.hours);
    const minutes = Number(input && input.sessionMinutes) || 45;
    const b = (input && input.breaks) || {};
    if (!(hours > 0)) return { maxSessions: null, workHours: 0, breakHours: 0, suggestedRetainer: null };
    const breakHours = (Number(b[30]) || 0) * 0.5 + (Number(b[45]) || 0) * 0.75 + (Number(b[60]) || 0) * 1;
    const workHours = Math.max(0, hours - breakHours);
    const maxSessions = Math.floor((workHours * 60) / minutes + 1e-9);
    const perHour = Number(input && input.retainerPerHour);
    const suggestedRetainer = perHour > 0 ? Math.round(hours * perHour) : null;
    return { maxSessions, workHours, breakHours, suggestedRetainer };
  }

  // ===================================================================
  // Formatting
  // ===================================================================

  /** 123456 -> "€1,234.56"; -1200 -> "-€12.00" (plain hyphen, safe in PDFs). */
  function euro(cents) {
    const c = Math.round(Number(cents) || 0);
    const abs = Math.abs(c);
    const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    return `${c < 0 ? '-' : ''}€${whole}.${pad2(abs % 100)}`;
  }

  /** 0.25 -> "25%", 0.275 -> "27.5%". */
  function formatRate(rate) {
    const p = Math.round((Number(rate) || 0) * 1000) / 10;
    return `${p}%`;
  }

  /** A one-line description of a deal, for pills and lists. */
  function describeRules(rules) {
    const r = defaultRules(rules);
    const rates = r.rates || {};
    switch (r.model) {
      case 'percentage':
        return `${formatRate(rates.weekday)} weekdays · ${formatRate(rates.saturday)} Sat · ${formatRate(rates.sunday)} Sun`;
      case 'fixed_monthly':
        return `${euro(toCents(r.fixedMonthly))} a month`;
      case 'per_session':
        return `${euro(toCents(r.sessionFee))} a session`;
      case 'tiered': {
        const t = sortedTiers(r.tiers);
        return t.length ? `${formatRate(t[t.length - 1].rate)}–${formatRate(t[0].rate)} by capacity` : 'Tiered by capacity';
      }
      case 'hybrid':
        return `Tiered weekdays · ${formatRate(rates.saturday)} Sat · ${formatRate(rates.sunday)} Sun`;
      default:
        return '';
    }
  }

  return {
    // money and dates
    toCents, applyRate, parseMoney, parseDate, weekdayOf, dayType, formatDate,
    billingPeriod, inPeriod, daysInMonth,
    // export
    FIELDS, REQUIRED_FIELDS, FIELD_LABELS, guessMapping, mappingComplete, findHeaderRow,
    normaliseRows, classifyBooking, normName, matchTherapist,
    // rules
    MODELS, MODEL_LABELS, DAY_LABELS, defaultRules, validateRules, findTierIndex, tierRanges, sortedTiers,
    // calculation
    summarise, calculateRent, calculateClinic, capacityFromHours,
    // formatting
    euro, formatRate, describeRules, MONTHS, MONTHS_LONG,
  };
});
