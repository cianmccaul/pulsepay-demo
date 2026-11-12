'use strict';
// Every rent model, worked by hand.
const test = require('node:test');
const assert = require('node:assert/strict');
const { E, booking, rules, run } = require('./helpers');

const MON = '2026-10-05', TUE = '2026-10-06', SAT = '2026-10-03', SUN = '2026-10-04', BH = '2026-10-26';

test.describe('percentage of takings', () => {
  const r = rules({ model: 'percentage', rates: { weekday: 0.25, saturday: 0.2, sunday: 0.15, bankHoliday: null } });

  test.it('applies the weekday rate to weekday takings', () => {
    const { rent } = run(r, [booking(MON, 80), booking(TUE, 70)]);
    assert.equal(rent.gross, 3750); // €150 × 25%
    assert.equal(rent.total, 3750);
  });

  test.it('uses separate Saturday and Sunday rates', () => {
    const { rent } = run(r, [booking(MON, 100), booking(SAT, 100), booking(SUN, 100)]);
    assert.deepEqual(rent.shares.map((s) => [s.day, s.amount]), [['weekday', 2500], ['saturday', 2000], ['sunday', 1500]]);
    assert.equal(rent.gross, 6000);
  });

  test.it('falls back to the weekday rate on a bank holiday when none is set', () => {
    const { rent } = run(r, [booking(BH, 100)]);
    assert.equal(rent.shares[0].day, 'bankHoliday');
    assert.equal(rent.shares[0].rate, 0.25);
    assert.equal(rent.gross, 2500);
  });

  test.it('uses the bank holiday rate when one is set', () => {
    const r2 = rules({ model: 'percentage', rates: { weekday: 0.25, saturday: 0.2, sunday: 0.15, bankHoliday: 0.1 } });
    const { rent } = run(r2, [booking(BH, 100)]);
    assert.equal(rent.gross, 1000);
  });

  test.it('rounds each share to the cent, halves up', () => {
    const r2 = rules({ model: 'percentage', rates: { weekday: 0.225, saturday: 0.2, sunday: 0.2 } });
    const { rent } = run(r2, [booking(MON, 70.1)]); // 7010 × 0.225 = 1577.25
    assert.equal(rent.gross, 1577);
    const { rent: r3 } = run(rules({ model: 'percentage', rates: { weekday: 0.5, saturday: 0, sunday: 0 } }), [booking(MON, 0.01)]);
    assert.equal(r3.gross, 1); // 0.5 cent rounds up
  });

  test.it('leaves out day types with no bookings', () => {
    const { rent } = run(r, [booking(MON, 100)]);
    assert.equal(rent.shares.length, 1);
    assert.ok(!rent.steps.some((s) => s.kind === 'subtotal'));
  });
});

test.describe('fixed monthly rent', () => {
  const r = rules({ model: 'fixed_monthly', fixedMonthly: 650, rentCap: 300, minRetainer: 900 });

  test.it('charges the flat amount whatever the takings', () => {
    assert.equal(run(r, []).rent.total, 65000);
    assert.equal(run(r, [booking(MON, 5000), booking(SAT, 3000)]).rent.total, 65000);
  });

  test.it('ignores the rent cap and the retainer', () => {
    const { rent } = run(r, [booking(MON, 100)]);
    assert.equal(rent.limitsApply, false);
    assert.equal(rent.capApplied, false);
    assert.equal(rent.retainerApplied, false);
    assert.equal(rent.rentCap, 0);
  });

  test.it('still reports sessions and takings', () => {
    const { rent } = run(r, [booking(MON, 70), booking(TUE, 45)]);
    assert.equal(rent.sessions, 2);
    assert.equal(rent.takings, 11500);
  });
});

test.describe('fixed fee per session', () => {
  const r = rules({ model: 'per_session', sessionFee: 14 });

  test.it('charges the fee for every session', () => {
    const { rent } = run(r, [booking(MON, 80), booking(TUE, 70), booking(SAT, 70)]);
    assert.equal(rent.gross, 4200);
  });

  test.it('counts no-charge sessions, which still use the room', () => {
    const { rent } = run(r, [booking(MON, 80), booking(TUE, 0, { status: 'No charge' })]);
    assert.equal(rent.sessions, 2);
    assert.equal(rent.gross, 2800);
  });

  test.it('does not charge for cancellations, even with a fee', () => {
    const { rent } = run(r, [booking(MON, 80), booking(TUE, 70, { status: 'Late cancellation' }), booking(TUE, 0, { status: 'Cancelled' })]);
    assert.equal(rent.sessions, 1);
    assert.equal(rent.gross, 1400);
  });

  test.it('handles a cent fee exactly', () => {
    const { rent } = run(rules({ model: 'per_session', sessionFee: 12.35 }), Array.from({ length: 3 }, () => booking(MON, 70)));
    assert.equal(rent.gross, 3705);
  });
});

test.describe('tiered by capacity', () => {
  const tiers = [{ min: 0, rate: 0.3 }, { min: 50, rate: 0.28 }, { min: 70, rate: 0.26 }, { min: 85, rate: 0.24 }];
  const r = rules({ model: 'tiered', capacity: 10, tiers });
  const n = (count, day) => Array.from({ length: count }, () => booking(day || MON, 100));

  test.it('picks the tier from sessions ÷ capacity', () => {
    assert.equal(run(r, n(4)).rent.capacity.rate, 0.3);  // 40%
    assert.equal(run(r, n(5)).rent.capacity.rate, 0.28); // 50%: a tier starts at its min
    assert.equal(run(r, n(7)).rent.capacity.rate, 0.26); // 70%
    assert.equal(run(r, n(9)).rent.capacity.rate, 0.24); // 90%
  });

  test.it('applies one rate to all takings, weekends included', () => {
    const { rent } = run(r, [...n(3), booking(SAT, 100), booking(SUN, 100)]); // 5 of 10 = 50%
    assert.equal(rent.shares.length, 1);
    assert.equal(rent.shares[0].takings, 50000);
    assert.equal(rent.gross, 14000);
  });

  test.it('rounds capacity to a whole percent before matching', () => {
    const r2 = rules({ model: 'tiered', capacity: 1000, tiers });
    const many = (c) => Array.from({ length: c }, () => booking(MON, 1));
    assert.equal(run(r2, many(695)).rent.capacity.pct, 70); // 69.5% -> 70%
    assert.equal(run(r2, many(695)).rent.capacity.rate, 0.26);
    assert.equal(run(r2, many(694)).rent.capacity.rate, 0.28); // 69.4% -> 69%
  });

  test.it('uses the top tier above 100% capacity', () => {
    const { rent } = run(r, n(13));
    assert.equal(rent.capacity.pct, 130);
    assert.equal(rent.capacity.rate, 0.24);
  });

  test.it('does not need the tiers in order', () => {
    const shuffled = [tiers[2], tiers[0], tiers[3], tiers[1]];
    assert.equal(run(rules({ model: 'tiered', capacity: 10, tiers: shuffled }), n(7)).rent.capacity.rate, 0.26);
  });

  test.it('uses the lowest tier, with a warning, when capacity is below every tier', () => {
    const { rent } = run(rules({ model: 'tiered', capacity: 10, tiers: [{ min: 20, rate: 0.3 }, { min: 60, rate: 0.25 }] }), n(1));
    assert.equal(rent.capacity.rate, 0.3);
    assert.equal(rent.warnings.length, 1);
  });

  test.it('warns when no capacity is set', () => {
    const { rent } = run(rules({ model: 'tiered', capacity: 0, tiers }), n(3));
    assert.equal(rent.capacity.pct, 0);
    assert.match(rent.warnings[0], /No capacity/);
  });

  test.it('labels the tier ranges', () => {
    const { rent } = run(r, n(9));
    assert.deepEqual(rent.capacity.tiers.map((t) => t.range), ['0–49%', '50–69%', '70–84%', '85%+']);
    assert.equal(rent.capacity.range, '85%+');
  });
});

test.describe('hybrid', () => {
  const tiers = [{ min: 0, rate: 0.3 }, { min: 50, rate: 0.26 }];
  const r = rules({ model: 'hybrid', capacity: 4, tiers, rates: { weekday: 0, saturday: 0.2, sunday: 0.18, bankHoliday: 0.15 } });

  test.it('uses the capacity tier on weekdays and fixed rates at weekends', () => {
    const { rent } = run(r, [booking(MON, 100), booking(TUE, 100), booking(SAT, 100), booking(SUN, 100)]); // 4 of 4 = 100%
    assert.deepEqual(rent.shares.map((s) => [s.day, s.rate, s.amount]), [
      ['weekday', 0.26, 5200], ['saturday', 0.2, 2000], ['sunday', 0.18, 1800],
    ]);
    assert.equal(rent.gross, 9000);
  });

  test.it('counts weekend sessions toward capacity', () => {
    const { rent } = run(r, [booking(MON, 100), booking(SAT, 100)]); // 2 of 4 = 50%
    assert.equal(rent.capacity.pct, 50);
    assert.equal(rent.shares[0].rate, 0.26);
  });

  test.it('uses its bank holiday rate', () => {
    const { rent } = run(r, [booking(BH, 100)]);
    assert.equal(rent.shares[0].day, 'bankHoliday');
    assert.equal(rent.gross, 1500);
  });

  test.it('uses the weekday tier rate on bank holidays when no rate is set', () => {
    const r2 = rules({ model: 'hybrid', capacity: 4, tiers, rates: { weekday: 0, saturday: 0.2, sunday: 0.18, bankHoliday: null } });
    const { rent } = run(r2, [booking(BH, 100)]); // 1 of 4 = 25% -> 30%
    assert.equal(rent.gross, 3000);
  });
});

test.describe('model checks', () => {
  test.it('throws on an unknown model', () => {
    assert.throws(() => E.calculateRent(rules({ model: 'barter' }), E.summarise([], {}, {})), /Unknown rent model/);
  });

  test.it('has a label for every model', () => {
    for (const m of E.MODELS) assert.ok(E.MODEL_LABELS[m]);
  });
});
