function createSaveFeedback(state, action, errorMessage = '') {
  const label = action || '数据';
  if (state === 'saving') {
    return { tone: 'saving', text: `${label}保存中...` };
  }
  if (state === 'success') {
    return { tone: 'success', text: `${label}已保存` };
  }
  return {
    tone: 'error',
    text: errorMessage ? `${label}保存失败：${errorMessage}` : `${label}保存失败，请重试`
  };
}

module.exports = { createSaveFeedback };
