'use strict';
// The tests parse CSV with the same vendored PapaParse the browser loads.
const Papa = require('../public/vendor/papaparse-5.5.5.min.js');

function parseCsv(text) {
  return Papa.parse(text, { skipEmptyLines: true }).data;
}

module.exports = { parseCsv, Papa };
