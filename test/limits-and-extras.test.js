'use strict';
// Rent cap, minimum retainer, equipment fees, itemised charges, adjustments
// and the hand-entered session count.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, booking, rules, run } = require('./helpers');

const MON = '2026-10-05', TUE = '2026-10-06';
const pct = (extra) => rules(Object.assign({ model: 'percentage', rates: { weekday: 0.25, saturday: 0.25, sunday: 0.25 } }, extra));

test.describe('rent cap', () => {
  test.it('limits the rent share to the cap', () => {
    const { rent } = run(pct({ rentCap: 100 }), [booking(MON, 1000)]); // €250 share
    assert.equal(rent.gross, 25000);
    assert.equal(rent.rent, 10000);
    assert.equal(rent.capApplied, true);
    const step = rent.steps.find((s) => s.kind === 'cap');
    assert.equal(step.amount, -15000);
  });

  test.it('does nothing when the share is exactly the cap', () => {
    const { rent } = run(pct({ rentCap: 250 }), [booking(MON, 1000)]);
    assert.equal(rent.capApplied, false);
    assert.equal(rent.rent, 25000);
  });

  test.it('does nothing when the cap is 0 (no cap)', () => {
    const { rent } = run(pct({ rentCap: 0 }), [booking(MON, 100000)]);
    assert.equal(rent.capApplied, false);
    assert.equal(rent.rent, 2500000);
  });

  test.it('applies to per-session rent too', () => {
    const many = Array.from({ length: 100 }, () => booking(MON, 70));
    const { rent } = run(rules({ model: 'per_session', sessionFee: 14, rentCap: 900 }), many);
    assert.equal(rent.gross, 140000);
    assert.equal(rent.rent, 90000);
  });
});

test.describe('minimum retainer', () => {
  test.it('raises a low share to the retainer', () => {
    const { rent } = run(pct({ minRetainer: 400 }), [booking(MON, 100)]); // €25 share
    assert.equal(rent.rent, 40000);
    assert.equal(rent.retainerApplied, true);
    assert.equal(rent.steps.find((s) => s.kind === 'retainer').amount, 37500);
  });

  test.it('applies even with no bookings at all', () => {
    const { rent } = run(pct({ minRetainer: 400 }), []);
    assert.equal(rent.total, 40000);
  });

  test.it('does nothing when the share is above it', () => {
    const { rent } = run(pct({ minRetainer: 10 }), [booking(MON, 100)]);
    assert.equal(rent.retainerApplied, false);
  });

  test.it('wins over the cap if set above it (cap first, then retainer)', () => {
    const { rent } = run(pct({ rentCap: 100, minRetainer: 200 }), [booking(MON, 1000)]);
    assert.equal(rent.capApplied, true);
    assert.equal(rent.retainerApplied, true);
    assert.equal(rent.rent, 20000);
  });
});

test.describe('equipment fees', () => {
  const shockwave = { id: 'sw', name: 'Shockwave machine', match: 'shockwave', mode: 'per_session', fee: 8 };
  const laser = { id: 'laser', name: 'Laser', match: 'laser', mode: 'per_month', fee: 60 };

  test.it('charges per session for treatments that name the machine', () => {
    const { rent } = run(pct({ equipment: [shockwave] }), [
      booking(MON, 95, { treatment: 'Physiotherapy with Shockwave - Returning' }),
      booking(MON, 95, { treatment: 'SHOCKWAVE therapy' }),
      booking(TUE, 70, { treatment: 'Physiotherapy - Returning' }),
    ]);
    assert.deepEqual(rent.equipment[0], { name: 'Shockwave machine', mode: 'per_session', count: 2, fee: 800, amount: 1600 });
  });

  test.it('does not count cancelled machine sessions', () => {
    const { rent } = run(pct({ equipment: [shockwave] }), [
      booking(MON, 95, { treatment: 'Shockwave', status: 'Late cancellation' }),
      booking(MON, 0, { treatment: 'Shockwave', status: 'Cancelled' }),
    ]);
    assert.equal(rent.equipment[0].count, 0);
    assert.equal(rent.equipmentTotal, 0);
  });

  test.it('charges a monthly fee whatever the use', () => {
    const { rent } = run(pct({ equipment: [laser] }), []);
    assert.equal(rent.equipmentTotal, 6000);
  });

  test.it('adds equipment after the cap, so the cap does not limit it', () => {
    const { rent } = run(pct({ rentCap: 100, equipment: [shockwave, laser] }), [
      booking(MON, 1000, { treatment: 'Shockwave' }),
    ]);
    assert.equal(rent.rent, 10000);
    assert.equal(rent.equipmentTotal, 6800);
    assert.equal(rent.total, 16800);
  });

  test.it('applies to fixed monthly rent too', () => {
    const { rent } = run(rules({ model: 'fixed_monthly', fixedMonthly: 650, equipment: [laser] }), []);
    assert.equal(rent.total, 71000);
  });
});

test.describe('itemised charges and adjustments', () => {
  const r = rules({ model: 'fixed_monthly', fixedMonthly: 650 });

  test.it('adds itemised charges as plain lines', () => {
    const { rent } = run(r, [], { itemised: [{ label: 'Saturday room hire', amount: 40 }, { label: 'Locker', amount: 10.5 }] });
    assert.equal(rent.itemisedTotal, 5050);
    assert.equal(rent.total, 70050);
  });

  test.it('ignores empty and negative itemised lines', () => {
    const { rent } = run(r, [], { itemised: [{ label: 'x', amount: 0 }, { label: 'y', amount: -20 }, { label: '', amount: '' }] });
    assert.equal(rent.itemised.length, 0);
  });

  test.it('adds debits and takes off credits', () => {
    const { rent } = run(r, [], { adjustments: [{ label: 'Credit: room closed', amount: -40 }, { label: 'Couch covers', amount: 15 }] });
    assert.equal(rent.adjustmentsTotal, -2500);
    assert.equal(rent.total, 62500);
  });

  test.it('gives a label to unlabelled lines', () => {
    const { rent } = run(r, [], { itemised: [{ label: ' ', amount: 5 }], adjustments: [{ amount: 5 }] });
    assert.equal(rent.itemised[0].label, 'Charge');
    assert.equal(rent.adjustments[0].label, 'Adjustment');
  });

  test.it('applies adjustments after the retainer', () => {
    const { rent } = run(pct({ minRetainer: 400 }), [], { adjustments: [{ label: 'Credit', amount: -50 }] });
    assert.equal(rent.rent, 40000);
    assert.equal(rent.total, 35000);
  });

  test.it('can end in a credit to the therapist', () => {
    const { rent } = run(r, [], { adjustments: [{ label: 'Refund of deposit', amount: -1000 }] });
    assert.equal(rent.total, -35000);
    assert.equal(rent.steps[rent.steps.length - 1].label, 'Credit due to therapist');
  });

  test.it('writes every step in order, ending in the total', () => {
    const { rent } = run(pct({ rentCap: 10, equipment: [{ id: 'l', name: 'Laser', mode: 'per_month', fee: 5 }] }), [booking(MON, 100)], {
      itemised: [{ label: 'Room hire', amount: 20 }], adjustments: [{ label: 'Credit', amount: -1 }],
    });
    assert.deepEqual(rent.steps.map((s) => s.kind), ['share', 'cap', 'equipment', 'itemised', 'adjustment', 'total']);
    const sum = rent.steps.filter((s) => s.kind !== 'total' && s.amount != null).reduce((t, s) => t + s.amount, 0);
    assert.equal(sum, rent.total);
  });
});

test.describe('sessions entered by hand', () => {
  const tiered = rules({ model: 'tiered', capacity: 10, tiers: [{ min: 0, rate: 0.3 }, { min: 50, rate: 0.25 }] });
  const four = Array.from({ length: 4 }, () => booking(MON, 100));

  test.it('changes the capacity tier but not the takings', () => {
    const { rent } = run(tiered, four, { sessionsOverride: 6 });
    assert.equal(rent.capacity.pct, 60);
    assert.equal(rent.takings, 40000);
    assert.equal(rent.gross, 10000);
    assert.equal(rent.steps[0].kind, 'note');
  });

  test.it('changes per-session rent', () => {
    const { rent } = run(rules({ model: 'per_session', sessionFee: 10 }), four, { sessionsOverride: 7 });
    assert.equal(rent.gross, 7000);
  });

  test.it('is ignored when blank or the same as the export', () => {
    assert.equal(run(tiered, four, { sessionsOverride: '' }).rent.sessions, 4);
    assert.equal(run(tiered, four, { sessionsOverride: null }).rent.sessions, 4);
    assert.ok(!run(tiered, four, { sessionsOverride: 4 }).rent.steps.some((s) => s.kind === 'note'));
  });
});
