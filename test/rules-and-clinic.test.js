'use strict';
// Rules validation, the capacity calculator, and the whole sample month end to end.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { E, rules } = require('./helpers');
const C = require('../public/js/clinic-config.js');
const { parseCsv } = require('./csv');

test.describe('validateRules', () => {
  test.it('accepts every built-in therapist', () => {
    for (const t of C.THERAPISTS) assert.deepEqual(E.validateRules(t), [], t.name);
  });

  test.it('catches rates outside 0–100%', () => {
    const p = E.validateRules(rules({ model: 'percentage', rates: { weekday: 25, saturday: 0.2, sunday: 0.2 } }));
    assert.match(p.join(' '), /Weekdays rate/);
  });

  test.it('needs an amount for fixed and per-session deals', () => {
    assert.ok(E.validateRules(rules({ model: 'fixed_monthly', fixedMonthly: 0 })).length);
    assert.ok(E.validateRules(rules({ model: 'per_session', sessionFee: 0 })).length);
  });

  test.it('needs capacity and a 0% tier for tiered deals, without duplicates', () => {
    const p = E.validateRules(rules({ model: 'tiered', capacity: 0, tiers: [{ min: 10, rate: 0.3 }, { min: 10, rate: 0.2 }] }));
    const text = p.join(' ');
    assert.match(text, /Capacity/);
    assert.match(text, /start at 0%/);
    assert.match(text, /Two tiers start at 10%/);
  });

  test.it('catches a retainer above the cap', () => {
    assert.match(E.validateRules(rules({ rentCap: 100, minRetainer: 200 })).join(' '), /retainer is above the rent cap/);
  });

  test.it('checks equipment fees', () => {
    const p = E.validateRules(rules({ equipment: [{ name: 'Laser', mode: 'per_session', fee: 5, match: '' }, { name: 'X', mode: 'weekly', fee: 5 }] }));
    assert.equal(p.length, 2);
  });

  test.it('rejects an unknown model or a missing name', () => {
    assert.ok(E.validateRules(rules({ model: 'nope' })).length);
    assert.ok(E.validateRules(rules({ name: ' ' })).length);
  });
});

test.describe('capacity calculator', () => {
  test.it('works out max sessions from hours, breaks and session length', () => {
    const r = E.capacityFromHours({ hours: 120, breaks: { 30: 10, 60: 5 }, sessionMinutes: 45, retainerPerHour: 4 });
    assert.equal(r.breakHours, 10);
    assert.equal(r.workHours, 110);
    assert.equal(r.maxSessions, 146); // 110h ÷ 0.75h = 146.7
    assert.equal(r.suggestedRetainer, 480);
  });

  test.it('returns nothing useful without hours', () => {
    assert.equal(E.capacityFromHours({ hours: 0 }).maxSessions, null);
  });

  test.it('never goes below zero', () => {
    assert.equal(E.capacityFromHours({ hours: 2, breaks: { 60: 5 }, sessionMinutes: 60 }).maxSessions, 0);
  });
});

test.describe('describeRules', () => {
  test.it('summarises each built-in deal in a line', () => {
    const lines = C.THERAPISTS.map(E.describeRules);
    assert.deepEqual(lines, [
      'Tiered weekdays · 25% Sat · 25% Sun',
      '25%–30% by capacity',
      '€650.00 a month',
      '22% weekdays · 18% Sat · 15% Sun',
      '€14.00 a session',
    ]);
  });
});

test.describe('the sample month, end to end', () => {
  const csv = fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'northbank-bookings-october-2026.csv'), 'utf8');
  const rows = parseCsv(csv);
  const header = E.findHeaderRow(rows);
  const mapping = E.guessMapping(rows[header]);
  const { bookings, skipped } = E.normaliseRows(rows, header, mapping);
  const period = E.billingPeriod(C.DEFAULT_PERIOD);
  const clinic = E.calculateClinic(C.THERAPISTS, bookings, { period, bankHolidays: C.BANK_HOLIDAYS, extras: C.DEFAULT_EXTRAS });
  const by = (id) => clinic.results.find((x) => x.therapist.id === id);

  test.it('reads every row of the file, below its title lines', () => {
    assert.equal(header, 2);
    assert.ok(E.mappingComplete(mapping));
    assert.equal(skipped.length, 0);
    assert.equal(bookings.length, rows.length - 3);
  });

  test.it('matches the embedded copy used by "Load sample month"', () => {
    const js = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', 'sample-bookings.js'), 'utf8');
    const sandbox = { window: {} };
    new Function('window', js)(sandbox.window);
    assert.equal(sandbox.window.PulsePaySample.csv, csv);
  });

  test.it('leaves out rows outside October and staff without a profile', () => {
    assert.ok(clinic.outsidePeriod > 0);
    assert.deepEqual(clinic.unmatched.map((u) => u.name), ['Clare Morgan']);
  });

  test.it('applies the rent cap to the busiest therapist (hybrid)', () => {
    const r = by('sarah-byrne').rent;
    assert.equal(r.capApplied, true);
    assert.equal(r.rent, 220000);
    assert.ok(r.shares.some((s) => s.day === 'bankHoliday'), 'worked the October bank holiday');
    assert.ok(r.equipmentTotal > 0, 'shockwave sessions charged');
  });

  test.it('applies the minimum retainer to the quietest (per session)', () => {
    const r = by('aoife-doyle').rent;
    assert.equal(r.retainerApplied, true);
    assert.equal(r.rent, 35000);
  });

  test.it('charges the fixed monthly rent plus room hire', () => {
    assert.equal(by('lucy-chen').rent.total, 65000 + 8000);
  });

  test.it('uses the tier table for Mark and Saturday/Sunday rates for Tom', () => {
    assert.ok(by('mark-ryan').rent.capacity.pct > 0);
    const tom = by('tom-hayes').rent;
    assert.deepEqual(tom.shares.map((s) => s.day), ['weekday', 'saturday', 'sunday']);
    assert.equal(tom.adjustmentsTotal, -4000);
  });

  test.it('adds up: each total is the sum of its steps, the clinic total the sum of totals', () => {
    for (const { rent } of clinic.results) {
      const sum = rent.steps.filter((s) => s.kind !== 'total' && s.kind !== 'subtotal' && s.amount != null).reduce((t, s) => t + s.amount, 0);
      assert.equal(sum, rent.total);
    }
    assert.equal(clinic.totals.rent, clinic.results.reduce((t, x) => t + x.rent.total, 0));
  });

  test.it('gives the same answer every time', () => {
    const again = E.calculateClinic(C.THERAPISTS, bookings, { period, bankHolidays: C.BANK_HOLIDAYS, extras: C.DEFAULT_EXTRAS });
    assert.deepEqual(again.totals, clinic.totals);
  });
});
