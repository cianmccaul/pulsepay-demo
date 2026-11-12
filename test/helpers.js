'use strict';
const E = require('../public/js/engine.js');

/** A booking, the way normaliseRows() returns one. Price in euros. */
function booking(date, price, extra) {
  return Object.assign({ date, therapist: 'Test Therapist', treatment: 'Physiotherapy', status: 'Arrived', priceCents: E.toCents(price) }, extra || {});
}

/** Rules with sensible defaults for a test. */
function rules(overrides) {
  return E.defaultRules(Object.assign({ id: 'test', name: 'Test Therapist', title: 'Physio' }, overrides || {}));
}

// October 2026: Thu 1st. Weekdays used below: Mon 5, Tue 6, Wed 7. Sat 3, Sun 4. Mon 26 is a bank holiday.
const OCT = E.billingPeriod({ year: 2026, month: 10 });

/** summarise() + calculateRent() in one go. */
function run(r, bookings, extras, opts) {
  const summary = E.summarise(bookings, r, Object.assign({ period: OCT, bankHolidays: ['2026-10-26'] }, opts || {}));
  return { summary, rent: E.calculateRent(r, summary, extras) };
}

module.exports = { E, booking, rules, OCT, run };
