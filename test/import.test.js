'use strict';
// Reading a bookings export: money, columns, header rows, statuses, names.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E } = require('./helpers');

test.describe('parseMoney', () => {
  test.it('reads plain and formatted amounts', () => {
    assert.equal(E.parseMoney('80'), 80);
    assert.equal(E.parseMoney('80.00'), 80);
    assert.equal(E.parseMoney('€1,234.50'), 1234.5);
    assert.equal(E.parseMoney('EUR 95'), 95);
    assert.equal(E.parseMoney(70), 70);
  });

  test.it('reads decimal commas', () => {
    assert.equal(E.parseMoney('45,00'), 45);
    assert.equal(E.parseMoney('1.234,50'), 1234.5);
  });

  test.it('keeps thousands commas as thousands', () => {
    assert.equal(E.parseMoney('1,234'), 1234);
  });

  test.it('reads negatives', () => {
    assert.equal(E.parseMoney('-35'), -35);
    assert.equal(E.parseMoney('(35.00)'), -35);
  });

  test.it('returns NaN for blanks and text', () => {
    assert.ok(Number.isNaN(E.parseMoney('')));
    assert.ok(Number.isNaN(E.parseMoney('n/a')));
    assert.ok(Number.isNaN(E.parseMoney(null)));
  });
});

test.describe('column mapping', () => {
  test.it('maps the sample export\'s headers', () => {
    const m = E.guessMapping(['Appointment ID', 'Appointment Date', 'Start Time', 'Practitioner', 'Service', 'Client ID', 'Status', 'Amount (EUR)', 'Payment Method']);
    assert.deepEqual(m, { date: 1, therapist: 3, price: 7, treatment: 4, status: 6 });
  });

  test.it('maps other booking systems\' headers', () => {
    assert.deepEqual(E.guessMapping(['Invoice Date', 'Item', 'Provider', 'Total', 'Appointment Status']),
      { date: 0, therapist: 2, price: 3, treatment: 1, status: 4 });
    assert.deepEqual(E.guessMapping(['date', 'therapist', 'treatment', 'price', 'status']),
      { date: 0, therapist: 1, price: 3, treatment: 2, status: 4 });
  });

  test.it('prefers an exact header over a partial match', () => {
    const m = E.guessMapping(['Total Paid To Date', 'Date', 'Staff', 'Fee']);
    assert.equal(m.date, 1);
    assert.equal(m.price, 3);
  });

  test.it('never uses one column twice', () => {
    const m = E.guessMapping(['Date', 'Amount']);
    assert.equal(m.date, 0);
    assert.equal(m.price, 1);
    assert.equal(m.therapist, -1);
    assert.equal(E.mappingComplete(m), false);
  });

  test.it('finds a header row below a title', () => {
    const rows = [['Clinic export', ''], ['Range: Oct', ''], ['Date', 'Practitioner', 'Amount'], ['05/10/2026', 'A', '70']];
    assert.equal(E.findHeaderRow(rows), 2);
    assert.equal(E.findHeaderRow([['x'], ['y']]), 0);
  });
});

test.describe('normaliseRows', () => {
  const rows = [
    ['Date', 'Practitioner', 'Service', 'Client', 'Status', 'Amount'],
    ['05/10/2026', 'Sarah Byrne', 'Physio', 'C-1', 'Arrived', '70.00'],
    ['', '', '', '', '', ''],
    ['32/10/2026', 'Sarah Byrne', 'Physio', 'C-2', 'Arrived', '70.00'],
    ['06/10/2026', '', 'Physio', 'C-3', 'Arrived', '70.00'],
    ['06/10/2026', 'Sarah Byrne', 'Physio', 'C-4', 'Arrived', 'seventy'],
    ['07/10/2026', 'Sarah Byrne', 'Physio', 'C-5', 'Cancelled', ''],
  ];
  const mapping = { date: 0, therapist: 1, treatment: 2, status: 4, price: 5 };

  test.it('keeps good rows and explains skipped ones', () => {
    const { bookings, skipped } = E.normaliseRows(rows, 0, mapping);
    assert.equal(bookings.length, 2);
    assert.deepEqual(skipped.map((s) => [s.line, s.reason]), [[4, 'unreadable date'], [5, 'no therapist'], [6, 'unreadable price']]);
  });

  test.it('turns a blank price into €0', () => {
    const { bookings } = E.normaliseRows(rows, 0, mapping);
    assert.equal(bookings[1].priceCents, 0);
    assert.equal(bookings[1].status, 'Cancelled');
  });

  test.it('never copies the client column', () => {
    const { bookings } = E.normaliseRows(rows, 0, mapping);
    assert.deepEqual(Object.keys(bookings[0]).sort(), ['date', 'priceCents', 'status', 'therapist', 'treatment']);
  });

  test.it('works without the optional columns', () => {
    const { bookings } = E.normaliseRows(rows, 0, { date: 0, therapist: 1, price: 5, treatment: -1, status: -1 });
    assert.equal(bookings[0].treatment, '');
    assert.equal(bookings[0].status, '');
  });

  test.it('uses the date order given', () => {
    const { bookings } = E.normaliseRows([['d', 't', 'p'], ['10/05/2026', 'X', '1']], 0, { date: 0, therapist: 1, price: 2 }, { dateOrder: 'mdy' });
    assert.equal(bookings[0].date, '2026-10-05');
  });
});

test.describe('classifyBooking', () => {
  test.it('counts seen and charged as a session', () => {
    assert.equal(E.classifyBooking('Arrived', 7000), 'session');
    assert.equal(E.classifyBooking('', 7000), 'session');
    assert.equal(E.classifyBooking('Completed', 7000), 'session');
  });

  test.it('counts no-charge and €0 sessions as sessions without takings', () => {
    assert.equal(E.classifyBooking('No charge', 0), 'no_charge');
    assert.equal(E.classifyBooking('No-charge', 7000), 'no_charge');
    assert.equal(E.classifyBooking('Complimentary review', 0), 'no_charge');
    assert.equal(E.classifyBooking('Arrived', 0), 'no_charge');
  });

  test.it('counts a charged cancellation or no-show as a fee, not a session', () => {
    assert.equal(E.classifyBooking('Late cancellation', 7000), 'cancellation_fee');
    assert.equal(E.classifyBooking('Did not attend', 7000), 'cancellation_fee');
    assert.equal(E.classifyBooking('DNA', 3500), 'cancellation_fee');
  });

  test.it('ignores free cancellations, refunds and negatives', () => {
    assert.equal(E.classifyBooking('Cancelled', 0), 'ignored');
    assert.equal(E.classifyBooking('No show', 0), 'ignored');
    assert.equal(E.classifyBooking('Refunded', 7000), 'ignored');
    assert.equal(E.classifyBooking('Arrived', -7000), 'ignored');
  });

  test.it('adds cancellation fees to takings for percentage rent', () => {
    const r = E.defaultRules({ name: 'T', model: 'percentage', rates: { weekday: 0.2, saturday: 0.2, sunday: 0.2 } });
    const s = E.summarise([
      { date: '2026-10-05', therapist: 'T', treatment: '', status: 'Arrived', priceCents: 7000 },
      { date: '2026-10-05', therapist: 'T', treatment: '', status: 'Late cancellation', priceCents: 7000 },
      { date: '2026-10-05', therapist: 'T', treatment: '', status: 'Cancelled', priceCents: 0 },
    ], r, {});
    assert.deepEqual([s.sessions, s.cancellationFees, s.ignored, s.takings], [1, 1, 1, 14000]);
  });
});

test.describe('matching therapist names', () => {
  const therapists = [{ id: 'sb', name: 'Sarah Byrne' }, { id: 'ad', name: 'Aoife Doyle', aliases: ['A. Doyle'] }, { id: 'so', name: "Seán O'Brien" }];

  test.it('ignores case, spacing, accents and titles', () => {
    assert.equal(E.matchTherapist('  sarah   BYRNE ', therapists), 'sb');
    assert.equal(E.matchTherapist('Dr Sarah Byrne', therapists), 'sb');
    assert.equal(E.matchTherapist("Sean O'Brien", therapists), 'so');
  });

  test.it('reads "Surname, First name"', () => {
    assert.equal(E.matchTherapist('Byrne, Sarah', therapists), 'sb');
  });

  test.it('uses aliases', () => {
    assert.equal(E.matchTherapist('A. Doyle', therapists), 'ad');
  });

  test.it('returns null for anyone else', () => {
    assert.equal(E.matchTherapist('Clare Morgan', therapists), null);
    assert.equal(E.matchTherapist('', therapists), null);
  });
});
