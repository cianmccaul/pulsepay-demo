#!/usr/bin/env node
/**
 * Generates the sample bookings export for October 2026.
 *
 *   node scripts/generate-sample.js
 *
 * Writes:
 *   public/samples/northbank-bookings-october-2026.csv   (the downloadable file)
 *   public/js/sample-bookings.js                          (the same text, for "Load sample month")
 *
 * Seeded, so it produces the same file every time. Everything is made up:
 * clients are IDs only (C-20xxx), never names. The export runs from 30 Sep
 * to 1 Nov like a real date-range export, so a few rows fall outside the
 * billing period, and it includes Clare Morgan (clinic director, paid by the
 * clinic, not on PulsePay) so the "not matched" handling shows.
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');

// mulberry32: small, deterministic PRNG
function rng(seed) {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rand = rng(20261031);
const pick = (weighted) => {
  const total = weighted.reduce((t, w) => t + w[1], 0);
  let x = rand() * total;
  for (const [v, w] of weighted) { if ((x -= w) < 0) return v; }
  return weighted[weighted.length - 1][0];
};

const PHYSIO = [['Physiotherapy - New Patient', 80], ['Physiotherapy - Returning Patient', 70]];
const SERVICES = {
  sarah: [[PHYSIO[0], 14], [PHYSIO[1], 54], [['Physiotherapy with Shockwave - Returning Patient', 95], 32]],
  mark: [[PHYSIO[0], 16], [PHYSIO[1], 60], [['Physiotherapy with Laser - Returning Patient', 90], 24]],
  lucy: [[['Sports Massage - New Patient', 75], 18], [['Sports Massage - Returning Patient', 70], 62], [['Sports Massage - 30 min', 45], 20]],
  tom: [[PHYSIO[0], 18], [PHYSIO[1], 62], [['Physiotherapy with Shockwave - Returning Patient', 95], 20]],
  aoife: [[['Osteopathy - New Patient', 85], 35], [['Osteopathy - Returning Patient', 70], 65]],
  clare: [[PHYSIO[0], 40], [PHYSIO[1], 60]],
};

// Working pattern. days: weekday numbers (0 = Sunday). slots: per day. fill: chance a slot is booked.
const PEOPLE = [
  { key: 'sarah', name: 'Sarah Byrne', start: '08:00', mins: 60, days: { 1: [8, 0.83], 2: [8, 0.83], 3: [8, 0.83], 4: [8, 0.83], 6: [4, 0.9] }, extraDates: { '2026-10-26': [6, 1] } },
  { key: 'mark', name: 'Mark Ryan', start: '12:00', mins: 60, days: { 1: [8, 0.6], 2: [8, 0.6], 4: [8, 0.6], 5: [8, 0.55] }, offDates: ['2026-10-26'] },
  { key: 'lucy', name: 'Lucy Chen', start: '10:00', mins: 60, days: { 2: [7, 0.75], 3: [7, 0.75], 5: [7, 0.75], 6: [4, 0.85] } },
  { key: 'tom', name: 'Tom Hayes', start: '09:00', mins: 60, days: { 1: [8, 0.7], 3: [8, 0.7], 4: [8, 0.7], 5: [8, 0.7] }, offDates: ['2026-10-26', '2026-10-14'], extraDates: { '2026-10-10': [4, 0.85], '2026-10-11': [4, 0.9], '2026-10-25': [4, 0.9] } },
  { key: 'aoife', name: 'Aoife Doyle', start: '10:00', mins: 60, days: { 3: [4, 0.55], 5: [4, 0.6] } },
  { key: 'clare', name: 'Clare Morgan', start: '09:00', mins: 60, days: { 2: [4, 0.7], 4: [4, 0.7] } },
];

const STATUS = [['Arrived', 88], ['Cancelled', 5], ['Late cancellation', 3], ['Did not attend', 2], ['No charge', 2]];

function isoDays(from, to) {
  const out = [];
  const d = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  while (d <= end) { out.push(d.toISOString().slice(0, 10)); d.setUTCDate(d.getUTCDate() + 1); }
  return out;
}
const dmy = (iso) => { const [y, m, d] = iso.split('-'); return `${d}/${m}/${y}`; };
const addMins = (hhmm, mins) => {
  const [h, m] = hhmm.split(':').map(Number);
  const t = h * 60 + m + mins;
  return `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`;
};

const rows = [];
let apptId = 418200;
let clientSeq = 20100;
const clients = [];

for (const iso of isoDays('2026-09-30', '2026-11-01')) {
  const wd = new Date(iso + 'T00:00:00Z').getUTCDay();
  const edge = iso === '2026-09-30' || iso === '2026-11-01';
  for (const p of PEOPLE) {
    if ((p.offDates || []).includes(iso)) continue;
    const plan = (p.extraDates && p.extraDates[iso]) || p.days[wd];
    if (!plan) continue;
    let [slots, fill] = plan;
    if (edge) slots = Math.min(slots, 3); // the export's first and last days are partial
    for (let s = 0; s < slots; s++) {
      if (rand() > fill) continue;
      const [service, price] = pick(SERVICES[p.key]);
      const status = pick(STATUS);
      let amount = price;
      if (status === 'Cancelled' || status === 'No charge') amount = 0;
      // returning clients mostly; a new client for new-patient appointments
      let client;
      if (/New Patient/.test(service) || clients.length < 40 || rand() < 0.15) {
        client = `C-${++clientSeq}`;
        clients.push(client);
      } else {
        client = clients[Math.floor(rand() * clients.length)];
      }
      const payment = amount === 0 ? '' : pick([['Card', 80], ['Cash', 6], ['Online', 14]]);
      rows.push([
        String(++apptId), dmy(iso), addMins(p.start, s * p.mins), p.name, service, client,
        status, amount.toFixed(2), payment,
      ]);
    }
  }
}

const csvCell = (v) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const header = ['Appointment ID', 'Appointment Date', 'Start Time', 'Practitioner', 'Service', 'Client ID', 'Status', 'Amount (EUR)', 'Payment Method'];
const lines = [
  'Northbank Physio - Appointments export,,,,,,,,',
  'Date range: 30/09/2026 to 01/11/2026,,,,,,,,',
  header.map(csvCell).join(','),
  ...rows.map((r) => r.map(csvCell).join(',')),
];
const csv = lines.join('\r\n') + '\r\n';

const csvPath = path.join(ROOT, 'public', 'samples', 'northbank-bookings-october-2026.csv');
fs.mkdirSync(path.dirname(csvPath), { recursive: true });
fs.writeFileSync(csvPath, csv);

const js = `/* Generated by scripts/generate-sample.js. Do not edit by hand. */
/* The sample bookings export for October 2026 (fictional), embedded so
   "Load sample month" works without a network request, even from file://. */
window.PulsePaySample = {
  fileName: 'northbank-bookings-october-2026.csv',
  csv: ${JSON.stringify(csv)}
};
`;
fs.writeFileSync(path.join(ROOT, 'public', 'js', 'sample-bookings.js'), js);

console.log(`${rows.length} bookings written to ${path.relative(ROOT, csvPath)} and public/js/sample-bookings.js`);
