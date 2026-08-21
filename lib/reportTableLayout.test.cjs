const test = require('node:test');
const assert = require('node:assert/strict');
const layout = require('./reportTableLayout');

test('report table headers and data cells use the same left alignment', () => {
  assert.equal(layout.REPORT_TABLE_HEADER_CELL.textAlign, 'left');
  assert.equal(layout.REPORT_TABLE_DATA_CELL.textAlign, 'left');
});
