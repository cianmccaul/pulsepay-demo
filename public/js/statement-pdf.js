/*!
 * PulsePay statement PDF
 * ---------------------------------------------------------------------------
 * Draws a rent statement with jsPDF, as real vector text (selectable, small,
 * crisp when printed). It prints only what the engine returned, so the PDF
 * and the dashboard can't disagree.
 *
 *   PulsePayPDF.build(jsPDF, items, options) -> jsPDF document
 *     items    [{ therapist, summary, rent }] from PulsePayEngine.calculateClinic()
 *              (one statement per item; "Download all" passes every therapist)
 *     options  { clinic, period, statementDate: 'YYYY-MM-DD', compress }
 *
 * Works in the browser (window.PulsePayPDF) and in Node (the tests).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'));
  else root.PulsePayPDF = factory(root.PulsePayEngine);
})(typeof self !== 'undefined' ? self : this, function (E) {
  'use strict';

  // Northbank Physio's colours (fictional clinic).
  const TEAL = [11, 107, 99];
  const DARK = [9, 64, 59];
  const MINT = [20, 160, 138];
  const MINT_LIGHT = [159, 227, 207];
  const INK = [23, 50, 47];
  const MUTED = [92, 110, 106];
  const LINE = [219, 228, 226];
  const SOFT = [244, 248, 247];
  const TINT = [231, 245, 241];
  const RED = [190, 38, 50];
  const GREEN = [31, 120, 60];

  const PAGE_W = 595.28;
  const PAGE_H = 841.89;
  const X0 = 44;
  const X1 = PAGE_W - 40;
  const W = X1 - X0;
  const BOTTOM = PAGE_H - 70; // keep clear of the footer

  function initials(name) {
    return String(name || '').split(/\s+/).filter(Boolean).map((p) => p[0].toUpperCase()).join('').slice(0, 3);
  }

  /** e.g. "Sarah-Byrne-rent-statement-October-2026.pdf" */
  function fileName(therapist, period) {
    const who = String(therapist && therapist.name || 'Therapist').replace(/[^A-Za-z0-9]+/g, '-').replace(/^-|-$/g, '');
    return `${who}-rent-statement-${E.MONTHS_LONG[period.month - 1]}-${period.year}${period.startDay > 1 ? `-from-${period.startDay}` : ''}.pdf`;
  }

  function allFileName(clinic, period) {
    const who = String(clinic && clinic.name || 'Clinic').replace(/[^A-Za-z0-9]+/g, '-');
    return `${who}-rent-statements-${E.MONTHS_LONG[period.month - 1]}-${period.year}.pdf`;
  }

  function statementNumber(therapist, period) {
    return `NB-${period.year}${String(period.month).padStart(2, '0')}-${initials(therapist.name)}`;
  }

  // -------------------------------------------------------------------------

  function build(jsPDF, items, options) {
    const opts = options || {};
    const clinic = opts.clinic || { name: 'Clinic' };
    const period = opts.period;
    const doc = new jsPDF({ unit: 'pt', format: 'a4', compress: !!opts.compress });
    doc.setProperties({
      title: items.length === 1 ? `Rent statement: ${items[0].therapist.name}, ${period.name}` : `Rent statements: ${period.name}`,
      subject: 'Demo rent statement (fictional data)',
      author: `${clinic.name} (demo)`,
      creator: 'PulsePay demo',
    });
    items.forEach((item, i) => {
      if (i > 0) doc.addPage();
      drawStatement(doc, item, clinic, period, opts.statementDate);
    });
    return doc;
  }

  function drawStatement(doc, item, clinic, period, statementDate) {
    const { therapist, summary, rent } = item;
    const ctx = { doc, y: 0, pages: 0, therapist, clinic, period };
    newPage(ctx, true);

    // ---- meta + banner ----
    ctx.y = 106;
    fill(doc, DARK);
    doc.rect(X0, ctx.y, W, 28, 'F');
    fill(doc, MINT);
    doc.rect(X0, ctx.y, 5, 28, 'F');
    text(doc, 'Rent statement', X0 + 18, ctx.y + 18.5, { size: 13, bold: true, color: [255, 255, 255] });
    text(doc, rent.modelLabel.toUpperCase(), X1 - 14, ctx.y + 17.5, { size: 7.5, bold: true, color: MINT_LIGHT, align: 'right' });
    ctx.y += 40;

    // ---- this period ----
    heading(ctx, 'This period');
    const stats = [
      ['Sessions', String(rent.sessions)],
      ['Takings', E.euro(rent.takings)],
    ];
    if (rent.capacity) stats.push(['Capacity used', `${rent.capacity.pct}%`]);
    stats.push(['Cancellation fees', String(summary.cancellationFees)]);
    if (!rent.capacity) stats.push(['No-charge sessions', String(summary.noChargeSessions)]);
    statBoxes(ctx, stats);
    const notes = [];
    if (rent.capacity) notes.push(`Capacity: ${rent.sessions} sessions of a maximum ${rent.capacity.max} in the period.`);
    if (summary.bankHolidaysWorked.length) notes.push(`Bank holiday${summary.bankHolidaysWorked.length > 1 ? 's' : ''} worked: ${summary.bankHolidaysWorked.map(E.formatDate).join(', ')}.`);
    if (rent.capacity && summary.noChargeSessions) notes.push(`Includes ${summary.noChargeSessions} no-charge session${summary.noChargeSessions > 1 ? 's' : ''}.`);
    if (rent.sessions !== rent.sessionsFromExport) notes.push(`Sessions set by the clinic to ${rent.sessions}; the bookings export has ${rent.sessionsFromExport}.`);
    if (notes.length) smallNote(ctx, notes.join(' '));
    ctx.y += 6;

    // ---- rent share ----
    heading(ctx, rent.model === 'fixed_monthly' ? 'Rent' : 'How the rent share was worked out');
    if (rent.model === 'fixed_monthly') {
      table(ctx, ['Description', '', 'Amount'], [['Fixed monthly rent', 'Flat rate', E.euro(rent.gross)]], { widths: [0.55, 0.25, 0.2], footer: null });
      smallNote(ctx, 'A fixed rent is the same every month: the rent cap and minimum retainer don’t apply to it.');
    } else if (rent.model === 'per_session') {
      const fee = rent.sessions ? rent.gross / rent.sessions : E.toCents(therapist.sessionFee);
      table(ctx, ['Description', 'Sessions', 'Fee', 'Rent'], [['Fixed fee per session', String(rent.sessions), E.euro(fee), E.euro(rent.gross)]], {
        widths: [0.46, 0.16, 0.18, 0.2], footer: null,
      });
    } else {
      const rows = rent.shares.map((s) => [
        s.label, String(s.sessions), E.euro(s.takings), E.formatRate(s.rate) + (s.rateNote ? `  (${s.rateNote})` : ''), E.euro(s.amount),
      ]);
      if (!rows.length) rows.push(['No takings in this period', '0', E.euro(0), '-', E.euro(0)]);
      table(ctx, ['Takings', 'Sessions', 'Amount', 'Rate', 'Rent'], rows, {
        widths: [0.22, 0.12, 0.18, 0.3, 0.18],
        footer: ['Rent share', '', '', '', E.euro(rent.gross)],
      });
    }

    // ---- tiers ----
    if (rent.capacity && rent.capacity.tiers.length) {
      ctx.y += 4;
      heading(ctx, rent.model === 'hybrid' ? 'Weekday tiers' : 'Capacity tiers');
      tierTable(ctx, rent.capacity);
      if (rent.model === 'hybrid') smallNote(ctx, 'Saturdays, Sundays and bank holidays have fixed rates and aren’t affected by the tiers.');
      ctx.y += 4;
    }

    // ---- limits + equipment ----
    const capSet = rent.limitsApply && (rent.rentCap > 0 || rent.minRetainer > 0);
    if (capSet || rent.equipment.length) {
      heading(ctx, 'Limits and equipment');
      const rows = [];
      if (rent.limitsApply && rent.rentCap > 0) rows.push(['Rent cap', E.euro(rent.rentCap), rent.capApplied ? 'Applied' : 'Not reached', rent.capApplied ? 'red' : 'green']);
      if (rent.limitsApply && rent.minRetainer > 0) rows.push(['Minimum retainer', E.euro(rent.minRetainer), rent.retainerApplied ? 'Applied' : 'Not needed', rent.retainerApplied ? 'red' : 'green']);
      for (const e of rent.equipment) {
        const how = e.mode === 'per_month' ? `${E.euro(e.fee)} per month` : `${e.count} session${e.count === 1 ? '' : 's'} × ${E.euro(e.fee)}`;
        rows.push([e.name, how, E.euro(e.amount), null]);
      }
      table(ctx, ['Item', 'Terms', 'Result'], rows.map((r) => r.slice(0, 3)), {
        widths: [0.42, 0.33, 0.25], footer: null,
        cellColor: (ri, ci) => (ci === 2 && rows[ri][3] ? (rows[ri][3] === 'red' ? RED : GREEN) : null),
      });
    }

    // ---- itemised + adjustments ----
    if (rent.itemised.length) {
      heading(ctx, 'Itemised charges');
      table(ctx, ['Description', 'Amount'], rent.itemised.map((i) => [i.label, E.euro(i.amount)]), {
        widths: [0.8, 0.2], footer: rent.itemised.length > 1 ? ['Total itemised charges', E.euro(rent.itemisedTotal)] : null,
      });
    }
    if (rent.adjustments.length) {
      heading(ctx, 'Adjustments');
      table(ctx, ['Description', 'Amount'], rent.adjustments.map((a) => [a.label, signed(a.amount)]), {
        widths: [0.8, 0.2],
        footer: rent.adjustments.length > 1 ? ['Net adjustment', signed(rent.adjustmentsTotal)] : null,
        cellColor: (ri, ci) => (ci === 1 ? (rent.adjustments[ri].amount < 0 ? GREEN : RED) : null),
      });
      smallNote(ctx, 'Credits (–) reduce the amount due; charges (+) add to it. Entered by the clinic for this period.');
      ctx.y += 2;
    }

    // ---- calculation summary ----
    calcSummary(ctx, rent);

    // ---- total ----
    ensure(ctx, 82);
    fill(doc, DARK);
    doc.rect(X0, ctx.y, W, 44, 'F');
    fill(doc, MINT);
    doc.rect(X0, ctx.y, 5, 44, 'F');
    const parts = ['base rent'];
    if (rent.equipmentTotal) parts.push('equipment');
    if (rent.itemisedTotal) parts.push('itemised charges');
    if (rent.adjustmentsTotal) parts.push('adjustments');
    text(doc, rent.total < 0 ? 'Credit due to you' : 'Total rent due', X0 + 18, ctx.y + 19, { size: 12, bold: true, color: [255, 255, 255] });
    text(doc, parts.length > 1 ? parts.join(' + ').replace(/^./, (c) => c.toUpperCase()) : 'Base rent only', X0 + 18, ctx.y + 32, { size: 8, color: MINT_LIGHT });
    text(doc, E.euro(Math.abs(rent.total)), X1 - 16, ctx.y + 30, { size: 21, bold: true, color: [255, 255, 255], align: 'right' });
    ctx.y += 52;

    const due = statementDate ? `${E.formatDate(addDays(statementDate, 14))}` : 'within 14 days';
    fill(doc, SOFT);
    draw(doc, LINE);
    doc.rect(X0, ctx.y, W, 28, 'FD');
    fill(doc, TEAL);
    doc.rect(X0, ctx.y, 3, 28, 'F');
    text(doc, 'PAYMENT', X0 + 14, ctx.y + 11.5, { size: 7, bold: true, color: TEAL, charSpace: 0.8 });
    text(doc, `Please pay by bank transfer to ${clinic.name} by ${due}, quoting ${statementNumber(therapist, period)}. Bank details are left out of this demo.`, X0 + 14, ctx.y + 21.5, { size: 8, color: INK });
    ctx.y += 38;
  }

  // -------------------------------------------------------------------------
  // Page furniture

  function newPage(ctx, first) {
    const { doc, therapist, clinic, period } = ctx;
    if (!first) doc.addPage();
    ctx.pages++;
    watermark(doc);

    // side bar
    fill(doc, TEAL);
    doc.rect(0, 0, 12, PAGE_H, 'F');

    // header: logo, clinic name, statement details
    logo(doc, X0, 34, 36);
    text(doc, clinic.name.toUpperCase(), X0 + 46, 50, { size: 16, bold: true, color: INK, charSpace: 1.2 });
    text(doc, String(clinic.tagline || '').toUpperCase(), X0 + 46, 63, { size: 6.8, bold: true, color: MUTED, charSpace: 1.5 });

    const meta = [
      ['Statement date', ctx.doc.__statementDate || ''],
      ['Billing period', period.label],
      ['Therapist', therapist.name],
      ['Statement no.', statementNumber(therapist, period) + (ctx.pages > 1 ? ` (page ${ctx.pages})` : '')],
    ];
    let my = 38;
    for (const [k, v] of meta) {
      if (!v) continue;
      const vw = width(doc, v, 8.5, true);
      text(doc, v, X1, my, { size: 8.5, bold: true, color: INK, align: 'right' });
      text(doc, `${k}:`, X1 - vw - 4, my, { size: 8.5, color: MUTED, align: 'right' });
      my += 12;
    }
    draw(doc, TEAL);
    doc.setLineWidth(1.6);
    doc.line(X0, 90, X1, 90);
    doc.setLineWidth(0.5);

    // footer
    draw(doc, TEAL);
    doc.setLineWidth(1.2);
    doc.line(X0, PAGE_H - 48, X1, PAGE_H - 48);
    doc.setLineWidth(0.5);
    text(doc, clinic.name.toUpperCase(), X0, PAGE_H - 34, { size: 7.5, bold: true, color: INK, charSpace: 0.6 });
    text(doc, 'Statement generated by PulsePay · demo, fictional clinic and therapist', X0, PAGE_H - 23, { size: 7, color: MUTED });
    text(doc, clinic.address || '', X1, PAGE_H - 34, { size: 7, color: MUTED, align: 'right' });
    text(doc, [clinic.email, clinic.phone].filter(Boolean).join('  |  '), X1, PAGE_H - 23, { size: 7, color: MUTED, align: 'right' });

    ctx.y = 106;
  }

  function watermark(doc) {
    const hasGState = typeof doc.GState === 'function' && typeof doc.setGState === 'function';
    if (hasGState) {
      doc.saveGraphicsState();
      doc.setGState(new doc.GState({ opacity: 0.06 }));
    }
    text(doc, 'DEMO', PAGE_W / 2 + 20, PAGE_H / 2 + 120, { size: 170, bold: true, color: hasGState ? TEAL : [240, 246, 245], align: 'center', angle: 32 });
    if (hasGState) doc.restoreGraphicsState();
  }

  /** The Northbank mark: rounded square, white roof line, mint wave. */
  function logo(doc, x, y, size) {
    const k = size / 48;
    fill(doc, TEAL);
    doc.roundedRect(x, y, size, size, 13 * k, 13 * k, 'F');
    doc.setLineCap('round');
    doc.setLineJoin('round');
    draw(doc, [255, 255, 255]);
    doc.setLineWidth(4.5 * k);
    doc.lines([[11 * k, -12 * k], [11 * k, 12 * k]], x + 13 * k, y + 27 * k, [1, 1], 'S', false);
    draw(doc, MINT_LIGHT);
    doc.setLineWidth(4 * k);
    const c = (a) => a * k;
    doc.lines([
      [c(4.333), c(-3.333), c(8.667), c(-3.333), c(13), 0],
      [c(4.333), c(3.333), c(8.667), c(3.333), c(13), 0],
    ], x + 11 * k, y + 35.5 * k, [1, 1], 'S', false);
    doc.setLineWidth(0.5);
    doc.setLineCap('butt');
    doc.setLineJoin('miter');
  }

  // -------------------------------------------------------------------------
  // Blocks

  function heading(ctx, title) {
    ensure(ctx, 40);
    const { doc } = ctx;
    text(doc, title.toUpperCase(), X0, ctx.y + 8, { size: 7.5, bold: true, color: TEAL, charSpace: 1.2 });
    draw(doc, LINE);
    doc.setLineWidth(0.6);
    doc.line(X0, ctx.y + 12, X1, ctx.y + 12);
    ctx.y += 18;
  }

  function statBoxes(ctx, stats) {
    const { doc } = ctx;
    ensure(ctx, 50);
    const gap = 8;
    const bw = (W - gap * (stats.length - 1)) / stats.length;
    stats.forEach(([k, v], i) => {
      const x = X0 + i * (bw + gap);
      fill(doc, SOFT);
      draw(doc, LINE);
      doc.roundedRect(x, ctx.y, bw, 38, 4, 4, 'FD');
      text(doc, k.toUpperCase(), x + bw / 2, ctx.y + 13, { size: 6.5, bold: true, color: MUTED, align: 'center', charSpace: 0.6 });
      text(doc, v, x + bw / 2, ctx.y + 30, { size: 13, bold: true, color: INK, align: 'center' });
    });
    ctx.y += 44;
  }

  function smallNote(ctx, s) {
    const { doc } = ctx;
    doc.setFont('helvetica', 'italic');
    doc.setFontSize(7.8);
    const lines = doc.splitTextToSize(safe(s), W);
    ensure(ctx, lines.length * 10 + 2);
    color(doc, MUTED);
    doc.text(lines, X0, ctx.y + 4);
    ctx.y += lines.length * 10 + 2;
  }

  /**
   * A table with a dark header row. The first column is left-aligned; the
   * rest are right-aligned (they're numbers). Rows wrap their first column.
   */
  function table(ctx, head, rows, o) {
    const { doc } = ctx;
    const widths = o.widths.map((f) => f * W);
    const xs = widths.map((_, i) => X0 + widths.slice(0, i).reduce((a, b) => a + b, 0));
    const pad = 8;
    const cellX = (i) => (i === 0 ? xs[i] + pad : xs[i] + widths[i] - pad);

    const drawHead = () => {
      ensure(ctx, 40);
      fill(doc, DARK);
      doc.rect(X0, ctx.y, W, 16, 'F');
      head.forEach((h, i) => text(doc, h.toUpperCase(), cellX(i), ctx.y + 11, { size: 6.8, bold: true, color: [255, 255, 255], align: i === 0 ? 'left' : 'right', charSpace: 0.6 }));
      ctx.y += 16;
    };
    drawHead();

    rows.forEach((row, ri) => {
      doc.setFont('helvetica', 'bold');
      doc.setFontSize(9);
      const first = doc.splitTextToSize(String(row[0]), widths[0] - pad * 2);
      const h = Math.max(17, first.length * 11 + 6);
      if (ctx.y + h > BOTTOM) { newPage(ctx); drawHead(); }
      if (ri % 2 === 1) { fill(doc, SOFT); doc.rect(X0, ctx.y, W, h, 'F'); }
      color(doc, INK);
      doc.text(first.map(safe), cellX(0), ctx.y + 11.5);
      for (let i = 1; i < row.length; i++) {
        const c = (o.cellColor && o.cellColor(ri, i)) || MUTED;
        text(doc, String(row[i]), cellX(i), ctx.y + 11.5, { size: 9, color: c, bold: c !== MUTED, align: 'right' });
      }
      draw(doc, LINE);
      doc.setLineWidth(0.5);
      doc.line(X0, ctx.y + h, X1, ctx.y + h);
      ctx.y += h;
    });

    if (o.footer) {
      ensure(ctx, 20);
      fill(doc, TINT);
      doc.rect(X0, ctx.y, W, 18, 'F');
      draw(doc, TEAL);
      doc.setLineWidth(1.2);
      doc.line(X0, ctx.y, X1, ctx.y);
      doc.setLineWidth(0.5);
      o.footer.forEach((f, i) => {
        if (f) text(doc, String(f), cellX(i), ctx.y + 12.5, { size: 9, bold: true, color: INK, align: i === 0 ? 'left' : 'right' });
      });
      ctx.y += 18;
    }
    ctx.y += 10;
  }

  function tierTable(ctx, capacity) {
    const { doc } = ctx;
    const tiers = capacity.tiers;
    const cols = Math.min(tiers.length, 5);
    const gap = 6;
    const bw = (W - gap * (cols - 1)) / cols;
    const rowsNeeded = Math.ceil(tiers.length / cols);
    ensure(ctx, rowsNeeded * 32);
    tiers.forEach((t, i) => {
      const r = Math.floor(i / cols);
      const x = X0 + (i % cols) * (bw + gap);
      const y = ctx.y + r * 32;
      const match = i === capacity.tierIndex;
      fill(doc, match ? TEAL : SOFT);
      draw(doc, match ? TEAL : LINE);
      doc.roundedRect(x, y, bw, 27, 4, 4, 'FD');
      text(doc, `${t.range} capacity`, x + bw / 2, y + 11, { size: 7, color: match ? MINT_LIGHT : MUTED, align: 'center', bold: true });
      text(doc, `${E.formatRate(t.rate)} rent${match ? ' · this month' : ''}`, x + bw / 2, y + 21.5, { size: match ? 8.5 : 9, bold: true, color: match ? [255, 255, 255] : INK, align: 'center' });
    });
    ctx.y += rowsNeeded * 32 + 2;
  }

  function calcSummary(ctx, rent) {
    const { doc } = ctx;
    const steps = rent.steps.filter((s) => s.kind !== 'total');
    // measure
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(8.8);
    const labelW = W - 36 - 90;
    const lines = steps.map((s) => doc.splitTextToSize(s.label, labelW));
    const height = 26 + lines.reduce((t, l) => t + l.length * 10.5 + 4.5, 0) + 24;
    ensure(ctx, Math.min(height, BOTTOM - 112));
    const top = ctx.y;
    // background drawn after we know the height on this page
    const bgStart = ctx.y;
    fill(doc, SOFT);
    draw(doc, LINE);
    doc.roundedRect(X0, bgStart, W, Math.min(height, BOTTOM - bgStart), 5, 5, 'FD');
    text(doc, 'CALCULATION SUMMARY', X0 + 16, ctx.y + 15, { size: 7.5, bold: true, color: TEAL, charSpace: 1.2 });
    ctx.y += 24;
    steps.forEach((s, i) => {
      const l = lines[i];
      const h = l.length * 10.5 + 4.5;
      if (ctx.y + h > BOTTOM) newPage(ctx);
      const isLimit = s.kind === 'cap' || s.kind === 'retainer';
      const isSub = s.kind === 'subtotal';
      doc.setFont('helvetica', isSub ? 'bold' : 'normal');
      doc.setFontSize(8.5);
      color(doc, isLimit ? RED : s.kind === 'note' || s.kind === 'capacity' ? MUTED : INK);
      doc.text(l.map(safe), X0 + 16, ctx.y + 7.5);
      if (s.amount != null) {
        const showPlus = ['equipment', 'itemised', 'adjustment', 'retainer'].includes(s.kind) && s.amount > 0;
        const c = s.kind === 'adjustment' ? (s.amount < 0 ? GREEN : RED) : isLimit ? RED : INK;
        text(doc, (showPlus ? '+ ' : '') + E.euro(s.amount), X1 - 16, ctx.y + 7.5, { size: 8.5, bold: true, color: c, align: 'right' });
      }
      draw(doc, LINE);
      doc.setLineWidth(0.4);
      doc.line(X0 + 16, ctx.y + h - 1, X1 - 16, ctx.y + h - 1);
      ctx.y += h;
    });
    draw(doc, TEAL);
    doc.setLineWidth(1.4);
    doc.line(X0 + 16, ctx.y + 2, X1 - 16, ctx.y + 2);
    doc.setLineWidth(0.5);
    text(doc, rent.total < 0 ? 'CREDIT DUE TO THERAPIST' : 'TOTAL DUE', X0 + 16, ctx.y + 15, { size: 9.5, bold: true, color: INK, charSpace: 0.4 });
    text(doc, E.euro(rent.total), X1 - 16, ctx.y + 15.5, { size: 11, bold: true, color: TEAL, align: 'right' });
    ctx.y = Math.max(ctx.y + 24, top) + 10;
  }

  // -------------------------------------------------------------------------
  // Small helpers

  function fill(doc, c) { doc.setFillColor(c[0], c[1], c[2]); }
  function draw(doc, c) { doc.setDrawColor(c[0], c[1], c[2]); }
  function color(doc, c) { doc.setTextColor(c[0], c[1], c[2]); }

  function text(doc, s, x, y, o) {
    const opt = o || {};
    doc.setFont('helvetica', opt.bold ? 'bold' : 'normal');
    doc.setFontSize(opt.size || 9);
    color(doc, opt.color || INK);
    const extra = {};
    if (opt.align) extra.align = opt.align;
    if (opt.angle) extra.angle = opt.angle;
    // jsPDF measures right/centred text without letter spacing, so only space left-aligned text
    if (opt.charSpace && (!opt.align || opt.align === 'left')) extra.charSpace = opt.charSpace;
    doc.text(safe(s), x, y, extra);
  }

  /** The built-in PDF font covers Windows-1252: swap the few characters it lacks. */
  function safe(s) {
    return String(s).replace(/[\u2192\u2794]/g, '->').replace(/\u2212/g, '-').replace(/[\u2713\u2714]/g, '');
  }

  function width(doc, s, size, bold) {
    doc.setFont('helvetica', bold ? 'bold' : 'normal');
    doc.setFontSize(size);
    return doc.getTextWidth(String(s));
  }

  function ensure(ctx, h) {
    if (ctx.y + h > BOTTOM) newPage(ctx);
  }

  function signed(cents) {
    return cents < 0 ? `– ${E.euro(-cents)}` : `+ ${E.euro(cents)}`;
  }

  function addDays(iso, n) {
    const [y, m, d] = iso.split('-').map(Number);
    const t = new Date(Date.UTC(y, m - 1, d + n));
    return t.toISOString().slice(0, 10);
  }

  return {
    build(jsPDF, items, options) {
      // the header reads the statement date from the document, set once here
      const opts = options || {};
      const Ctor = function (cfg) {
        const doc = new jsPDF(cfg);
        doc.__statementDate = opts.statementDate ? E.formatDate(opts.statementDate) : '';
        return doc;
      };
      return build(Ctor, items, opts);
    },
    fileName,
    allFileName,
    statementNumber,
  };
});
