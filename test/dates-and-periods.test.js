'use strict';
// Dates, days of the week, bank holidays and billing period boundaries.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, booking, rules } = require('./helpers');

test.describe('parseDate', () => {
  test.it('reads ISO dates, with or without a time', () => {
    assert.equal(E.parseDate('2026-10-05'), '2026-10-05');
    assert.equal(E.parseDate('2026-10-05T09:30:00Z'), '2026-10-05');
    assert.equal(E.parseDate('2026-10-05 09:30'), '2026-10-05');
  });

  test.it('reads day-first numeric dates by default', () => {
    assert.equal(E.parseDate('05/10/2026'), '2026-10-05');
    assert.equal(E.parseDate('5/10/2026'), '2026-10-05');
    assert.equal(E.parseDate('05.10.26'), '2026-10-05');
    assert.equal(E.parseDate('05-10-2026 14:00'), '2026-10-05');
  });

  test.it('reads month-first dates when asked', () => {
    assert.equal(E.parseDate('10/05/2026', 'mdy'), '2026-10-05');
  });

  test.it('reads written dates', () => {
    assert.equal(E.parseDate('5 Oct 2026'), '2026-10-05');
    assert.equal(E.parseDate('Mon 5 October 2026'), '2026-10-05');
    assert.equal(E.parseDate('October 5th, 2026'), '2026-10-05');
  });

  test.it('rejects impossible and empty dates', () => {
    assert.equal(E.parseDate('31/02/2026'), null);
    assert.equal(E.parseDate('2026-13-01'), null);
    assert.equal(E.parseDate(''), null);
    assert.equal(E.parseDate(null), null);
    assert.equal(E.parseDate('next Tuesday'), null);
  });

  test.it('accepts 29 February only in a leap year', () => {
    assert.equal(E.parseDate('29/02/2028'), '2028-02-29');
    assert.equal(E.parseDate('29/02/2027'), null);
  });
});

test.describe('days of the week', () => {
  test.it('knows the weekday of a date, whatever the time zone', () => {
    assert.equal(E.weekdayOf('2026-10-01'), 4); // Thursday
    assert.equal(E.weekdayOf('2026-10-03'), 6);
    assert.equal(E.weekdayOf('2026-10-04'), 0);
    assert.equal(E.weekdayOf('2026-03-29'), 0); // the day the clocks change
  });

  test.it('sorts dates into weekday, Saturday, Sunday and bank holiday', () => {
    assert.equal(E.dayType('2026-10-05', []), 'weekday');
    assert.equal(E.dayType('2026-10-03', []), 'saturday');
    assert.equal(E.dayType('2026-10-04', []), 'sunday');
    assert.equal(E.dayType('2026-10-26', ['2026-10-26']), 'bankHoliday');
  });

  test.it('treats a bank holiday on a weekend as a bank holiday', () => {
    assert.equal(E.dayType('2026-12-26', new Set(['2026-12-26'])), 'bankHoliday'); // a Saturday
  });
});

test.describe('billingPeriod', () => {
  test.it('defaults to the 1st to the end of the month', () => {
    const p = E.billingPeriod({ year: 2026, month: 10 });
    assert.equal(p.start, '2026-10-01');
    assert.equal(p.end, '2026-10-31');
    assert.equal(p.name, 'October 2026');
    assert.equal(p.label, '1 Oct 2026 – 31 Oct 2026');
  });

  test.it('knows short months and leap years', () => {
    assert.equal(E.billingPeriod({ year: 2026, month: 2 }).end, '2026-02-28');
    assert.equal(E.billingPeriod({ year: 2028, month: 2 }).end, '2028-02-29');
    assert.equal(E.billingPeriod({ year: 2026, month: 4 }).end, '2026-04-30');
  });

  test.it('runs a mid-month period to the day before the start day', () => {
    const p = E.billingPeriod({ year: 2026, month: 10, startDay: 15 });
    assert.equal(p.start, '2026-10-15');
    assert.equal(p.end, '2026-11-14');
  });

  test.it('rolls a December period into January', () => {
    const p = E.billingPeriod({ year: 2026, month: 12, startDay: 20 });
    assert.equal(p.start, '2026-12-20');
    assert.equal(p.end, '2027-01-19');
  });

  test.it('keeps the start day between 1 and 28', () => {
    assert.equal(E.billingPeriod({ year: 2026, month: 1, startDay: 31 }).start, '2026-01-28');
    assert.equal(E.billingPeriod({ year: 2026, month: 1, startDay: 0 }).start, '2026-01-01');
  });

  test.it('throws without a valid month', () => {
    assert.throws(() => E.billingPeriod({ year: 2026, month: 13 }));
    assert.throws(() => E.billingPeriod({}));
  });

  test.it('includes both ends and nothing outside them', () => {
    const p = E.billingPeriod({ year: 2026, month: 10 });
    const r = rules({ model: 'per_session', sessionFee: 10 });
    const s = E.summarise([
      booking('2026-09-30', 70), booking('2026-10-01', 70), booking('2026-10-31', 70), booking('2026-11-01', 70),
    ], r, { period: p });
    assert.equal(s.sessions, 2);
    assert.equal(s.outsidePeriod, 2);
  });

  test.it('moves bookings between periods when the start day changes', () => {
    const r = rules({ model: 'per_session', sessionFee: 10 });
    const rows = [booking('2026-10-14', 70), booking('2026-10-15', 70), booking('2026-11-14', 70), booking('2026-11-15', 70)];
    const s = E.summarise(rows, r, { period: E.billingPeriod({ year: 2026, month: 10, startDay: 15 }) });
    assert.equal(s.sessions, 2);
  });
});

test.describe('formatting', () => {
  test.it('formats euros from cents', () => {
    assert.equal(E.euro(123456), '€1,234.56');
    assert.equal(E.euro(5), '€0.05');
    assert.equal(E.euro(-4000), '-€40.00');
    assert.equal(E.euro(100000000), '€1,000,000.00');
  });

  test.it('formats rates and dates', () => {
    assert.equal(E.formatRate(0.25), '25%');
    assert.equal(E.formatRate(0.275), '27.5%');
    assert.equal(E.formatDate('2026-10-05'), '5 Oct 2026');
  });

  test.it('converts euros to cents without float drift', () => {
    assert.equal(E.toCents(1.005), 101);
    assert.equal(E.toCents(0.1 + 0.2), 30);
    assert.equal(E.toCents('19.99'), 1999);
    assert.equal(E.toCents('abc'), 0);
  });
});
