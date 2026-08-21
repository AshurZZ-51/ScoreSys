function isSuperAdmin(code) {
  return String(code || '').trim().toLowerCase() === 'admin51';
}

module.exports = { isSuperAdmin };
