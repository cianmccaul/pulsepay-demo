'use strict';
// The statement PDF: built in Node with the same vendored jsPDF the browser
// uses, uncompressed so the text can be searched, and checked against the
// engine's numbers.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { E } = require('./helpers');
const C = require('../public/js/clinic-config.js');
const P = require('../public/js/statement-pdf.js');
const { jsPDF } = require('../public/vendor/jspdf-4.2.1.umd.min.js');
const { parseCsv } = require('./csv');

const rows = parseCsv(fs.readFileSync(path.join(__dirname, '..', 'public', 'samples', 'northbank-bookings-october-2026.csv'), 'utf8'));
const h = E.findHeaderRow(rows);
const { bookings } = E.normaliseRows(rows, h, E.guessMapping(rows[h]));
const period = E.billingPeriod(C.DEFAULT_PERIOD);
const clinic = E.calculateClinic(C.THERAPISTS, bookings, { period, bankHolidays: C.BANK_HOLIDAYS, extras: C.DEFAULT_EXTRAS });
const options = { clinic: C.CLINIC, period, statementDate: '2026-11-02', compress: false };

// jsPDF writes standard-font text as literal strings; collect them per page.
function pageTexts(doc) {
  const out = [];
  for (let p = 1; p <= doc.getNumberOfPages(); p++) {
    const stream = doc.internal.pages[p].join('\n');
    const strings = [];
    stream.replace(/\(((?:\\.|[^\\)])*)\)\s*Tj/g, (_, s) => strings.push(s.replace(/\\(.)/g, '$1')));
    out.push(strings.join(' | '));
  }
  return out;
}
// In the PDF's WinAnsi encoding the euro sign is byte 0x80.
const pdfEuro = (cents) => E.euro(cents).replace('€', '\x80');

test.describe('statement PDF', () => {
  test.it('makes one page per therapist when downloading all', () => {
    const doc = P.build(jsPDF, clinic.results, options);
    assert.equal(doc.getNumberOfPages(), C.THERAPISTS.length);
  });

  test.it('prints each therapist\'s name, period and engine total', () => {
    const pages = pageTexts(P.build(jsPDF, clinic.results, options));
    clinic.results.forEach((x, i) => {
      assert.ok(pages[i].includes(x.therapist.name), x.therapist.name);
      assert.ok(pages[i].includes(period.label.replace('–', '\x96')), 'billing period');
      assert.ok(pages[i].includes(pdfEuro(x.rent.total)), `total for ${x.therapist.name}`);
    });
  });

  test.it('writes out every calculation step', () => {
    const sarah = clinic.results.find((x) => x.therapist.id === 'sarah-byrne');
    const text = pageTexts(P.build(jsPDF, [sarah], options))[0];
    for (const s of sarah.rent.steps.filter((s) => s.amount != null)) {
      assert.ok(text.includes(pdfEuro(s.amount)), `${s.label}: ${E.euro(s.amount)}`);
    }
    assert.ok(text.includes('Rent cap'));
    assert.ok(text.includes('Applied'));
  });

  test.it('shows itemised charges and adjustments', () => {
    const lucy = pageTexts(P.build(jsPDF, [clinic.results.find((x) => x.therapist.id === 'lucy-chen')], options))[0];
    assert.ok(lucy.includes('Extra Saturday room hire'));
    const tom = pageTexts(P.build(jsPDF, [clinic.results.find((x) => x.therapist.id === 'tom-hayes')], options))[0];
    assert.ok(tom.includes('Credit: room 3 closed for repairs, 14 Oct'));
  });

  test.it('carries the DEMO watermark and fictional branding on every page', () => {
    const doc = P.build(jsPDF, clinic.results, options);
    for (const t of pageTexts(doc)) {
      assert.ok(t.includes('DEMO'));
      assert.ok(t.includes('NORTHBANK PHYSIO'));
      assert.ok(t.includes('demo, fictional clinic and therapist'));
    }
  });

  test.it('starts a new page rather than overflowing a long statement', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ label: `Adjustment line ${i + 1}`, amount: 1 }));
    const t = C.THERAPISTS[3];
    const summary = E.summarise([], t, { period });
    const rent = E.calculateRent(t, summary, { adjustments: many });
    const doc = P.build(jsPDF, [{ therapist: t, summary, rent }], options);
    assert.ok(doc.getNumberOfPages() > 1);
    const all = pageTexts(doc).join(' ');
    assert.ok(all.includes('Adjustment line 40'));
    assert.ok(all.includes(pdfEuro(rent.total)));
  });

  test.it('is a valid PDF file', () => {
    const out = P.build(jsPDF, clinic.results.slice(0, 1), Object.assign({}, options, { compress: true })).output();
    assert.ok(out.startsWith('%PDF-'));
    assert.ok(out.trimEnd().endsWith('%%EOF'));
  });

  test.it('names files after the therapist and month', () => {
    assert.equal(P.fileName(C.THERAPISTS[0], period), 'Sarah-Byrne-rent-statement-October-2026.pdf');
    assert.equal(P.allFileName(C.CLINIC, period), 'Northbank-Physio-rent-statements-October-2026.pdf');
    assert.equal(P.statementNumber(C.THERAPISTS[0], period), 'NB-202610-SB');
  });
});
