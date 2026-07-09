const test = require('node:test');
const assert = require('node:assert/strict');
const display = require('./projectDisplay.js');

test('shows empty project slots with stable fallback labels', () => {
  const project = { id: 'p9', seq_no: 9, name: '', submitter: '' };

  assert.equal(display.shouldShowProjectSlot(project), true);
  assert.equal(display.hasProjectIdentity(project), false);
  assert.equal(display.projectDisplayName(project), '未填写项目 #9');
  assert.equal(display.projectDisplaySubmitter(project), '未填写提报人');
});

test('uses trimmed project identity when present', () => {
  const project = { id: 'p10', seq_no: 10, name: '  新项目  ', submitter: '  Walker  ' };

  assert.equal(display.shouldShowProjectSlot(project), true);
  assert.equal(display.hasProjectIdentity(project), true);
  assert.equal(display.projectDisplayName(project), '新项目');
  assert.equal(display.projectDisplaySubmitter(project), 'Walker');
});
