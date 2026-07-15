const ACTION_LABELS = {
  restore: '恢复',
  request_purge: '发起清除',
  restore_purge: '撤销清除请求'
};

function formatArchiveBulkFeedback(action, results) {
  const label = ACTION_LABELS[action] || '归档操作';
  const succeeded = (results || []).filter((result) => result.ok);
  const failed = (results || []).filter((result) => !result.ok);
  const nameOf = (result) => result.project?.name || '未命名项目';
  const lines = [`批量${label}完成：成功 ${succeeded.length} 个，失败 ${failed.length} 个。`];

  if (succeeded.length) lines.push(`成功：${succeeded.map(nameOf).join('、')}`);
  if (failed.length) lines.push(`失败：${failed.map((result) => `${nameOf(result)}（${result.error || '归档操作失败'}）`).join('、')}`);

  return lines.join('\n');
}

module.exports = { formatArchiveBulkFeedback };
