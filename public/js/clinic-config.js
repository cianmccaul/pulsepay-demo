/*!
 * The fictional clinic for the demo: Northbank Physio, from the other
 * Northbank demos. Every therapist, deal and figure here is made up.
 * One therapist per rent model, so the sample month shows every rule:
 *
 *   Sarah Byrne  hybrid         tiered weekdays + fixed Saturday/Sunday/bank holiday
 *                               rates, shockwave per session. Busy: the rent cap applies.
 *   Mark Ryan    tiered         one rate by capacity, laser hired monthly
 *   Lucy Chen    fixed_monthly  flat monthly rent + itemised room hire
 *   Tom Hayes    percentage     weekday / Saturday / Sunday rates, shockwave per
 *                               session, a credit adjustment
 *   Aoife Doyle  per_session    a fee per session. Quiet month: the minimum
 *                               retainer applies.
 *
 * Clare Morgan (clinic director) is in the bookings export but is paid by the
 * clinic, so she has no profile: her rows show up as "not matched".
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.PulsePayClinic = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const CLINIC = {
    name: 'Northbank Physio',
    tagline: 'Physiotherapy & sports injury clinic',
    address: '12 Quay Street, Dublin 2',
    email: 'hello@northbank.example',
    phone: '01 555 0100',
  };

  // Irish public holidays, 2026. Editable in the app under Billing period.
  const BANK_HOLIDAYS = [
    '2026-01-01', '2026-02-02', '2026-03-17', '2026-04-06', '2026-05-04',
    '2026-06-01', '2026-08-03', '2026-10-26', '2026-12-25', '2026-12-26',
  ];

  // The sample export covers October 2026; the default period matches it.
  const DEFAULT_PERIOD = { year: 2026, month: 10, startDay: 1 };

  const THERAPISTS = [
    {
      id: 'sarah-byrne',
      name: 'Sarah Byrne',
      title: 'Chartered Physiotherapist',
      model: 'hybrid',
      rates: { weekday: 0.28, saturday: 0.25, sunday: 0.25, bankHoliday: 0.2 },
      fixedMonthly: 0,
      sessionFee: 0,
      capacity: 130,
      tiers: [
        { min: 0, rate: 0.3 },
        { min: 50, rate: 0.28 },
        { min: 70, rate: 0.26 },
        { min: 85, rate: 0.24 },
      ],
      rentCap: 2200,
      minRetainer: 500,
      equipment: [
        { id: 'shockwave', name: 'Shockwave machine', match: 'shockwave', mode: 'per_session', fee: 8 },
      ],
    },
    {
      id: 'mark-ryan',
      name: 'Mark Ryan',
      title: 'Chartered Physiotherapist',
      model: 'tiered',
      rates: { weekday: 0.28, saturday: 0.28, sunday: 0.28, bankHoliday: null },
      fixedMonthly: 0,
      sessionFee: 0,
      capacity: 110,
      tiers: [
        { min: 0, rate: 0.3 },
        { min: 60, rate: 0.275 },
        { min: 80, rate: 0.25 },
      ],
      rentCap: 2100,
      minRetainer: 450,
      equipment: [
        { id: 'laser', name: 'Laser (monthly hire)', match: 'laser', mode: 'per_month', fee: 60 },
      ],
    },
    {
      id: 'lucy-chen',
      name: 'Lucy Chen',
      title: 'Sports Massage Therapist',
      model: 'fixed_monthly',
      rates: { weekday: 0.2, saturday: 0.2, sunday: 0.2, bankHoliday: null },
      fixedMonthly: 650,
      sessionFee: 0,
      capacity: 0,
      tiers: [],
      rentCap: 0,
      minRetainer: 0,
      equipment: [],
    },
    {
      id: 'tom-hayes',
      name: 'Tom Hayes',
      title: 'Chartered Physiotherapist',
      model: 'percentage',
      rates: { weekday: 0.22, saturday: 0.18, sunday: 0.15, bankHoliday: null },
      fixedMonthly: 0,
      sessionFee: 0,
      capacity: 0,
      tiers: [],
      rentCap: 1900,
      minRetainer: 400,
      equipment: [
        { id: 'shockwave', name: 'Shockwave machine', match: 'shockwave', mode: 'per_session', fee: 8 },
      ],
    },
    {
      id: 'aoife-doyle',
      name: 'Aoife Doyle',
      title: 'Osteopath',
      model: 'per_session',
      rates: { weekday: 0.2, saturday: 0.2, sunday: 0.2, bankHoliday: null },
      fixedMonthly: 0,
      sessionFee: 14,
      capacity: 0,
      tiers: [],
      rentCap: 900,
      minRetainer: 350,
      equipment: [],
    },
  ];

  // This period's extra lines, per therapist (euros).
  const DEFAULT_EXTRAS = {
    'sarah-byrne': { itemised: [], adjustments: [], sessionsOverride: null },
    'mark-ryan': { itemised: [], adjustments: [{ label: 'Share of new treatment-room couch covers', amount: 15 }], sessionsOverride: null },
    'lucy-chen': { itemised: [{ label: 'Extra Saturday room hire, 17 & 24 Oct (2 × €40)', amount: 80 }], adjustments: [], sessionsOverride: null },
    'tom-hayes': { itemised: [], adjustments: [{ label: 'Credit: room 3 closed for repairs, 14 Oct', amount: -40 }], sessionsOverride: null },
    'aoife-doyle': { itemised: [], adjustments: [], sessionsOverride: null },
  };

  return { CLINIC, BANK_HOLIDAYS, DEFAULT_PERIOD, THERAPISTS, DEFAULT_EXTRAS };
});
