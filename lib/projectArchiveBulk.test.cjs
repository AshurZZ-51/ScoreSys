const test = require('node:test');
const assert = require('node:assert/strict');
const { formatArchiveBulkFeedback } = require('./projectArchiveBulk');

test('summarizes bulk archive results with each project outcome and failure count', () => {
  assert.equal(
    formatArchiveBulkFeedback('restore', [
      { project: { name: '项目甲' }, ok: true },
      { project: { name: '项目乙' }, ok: false, error: '权限不足' },
      { project: { name: '项目丙' }, ok: true }
    ]),
    '批量恢复完成：成功 2 个，失败 1 个。\n成功：项目甲、项目丙\n失败：项目乙（权限不足）'
  );
});

test('uses the matching Chinese label for purge request and cancellation results', () => {
  assert.match(formatArchiveBulkFeedback('request_purge', []), /^批量发起清除完成：成功 0 个，失败 0 个。$/);
  assert.match(formatArchiveBulkFeedback('restore_purge', []), /^批量撤销清除请求完成：成功 0 个，失败 0 个。$/);
});
