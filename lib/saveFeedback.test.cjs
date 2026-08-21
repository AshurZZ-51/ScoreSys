const test = require('node:test');
const assert = require('node:assert/strict');
const { createSaveFeedback } = require('./saveFeedback');

test('creates visible feedback for saving, success and failure', () => {
  assert.deepEqual(createSaveFeedback('saving', '评分'), {
    tone: 'saving',
    text: '评分保存中...'
  });
  assert.deepEqual(createSaveFeedback('success', '评分'), {
    tone: 'success',
    text: '评分已保存'
  });
  assert.deepEqual(createSaveFeedback('error', '评分', '网络异常'), {
    tone: 'error',
    text: '评分保存失败：网络异常'
  });
});
