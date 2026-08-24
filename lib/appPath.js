function normalizeBasePath(value) {
  if (!value || value === '/') return '';
  const normalized = String(value).trim();
  if (!normalized) return '';
  return `/${normalized.replace(/^\/+|\/+$/g, '')}`;
}

function getBasePath(configuredValue = process.env.NEXT_PUBLIC_BASE_PATH, environment = process.env.NODE_ENV) {
  if (configuredValue !== undefined) return normalizeBasePath(configuredValue);
  return normalizeBasePath(environment === 'production' ? '/scoringsys' : '');
}

const BASE_PATH = getBasePath();

function isExternalPath(path) {
  return /^(?:[a-z][a-z\d+.-]*:|\/\/|#)/i.test(path);
}

function appPath(path) {
  if (typeof path !== 'string' || !path || isExternalPath(path) || !path.startsWith('/')) return path;
  if (!BASE_PATH || path === BASE_PATH || path.startsWith(`${BASE_PATH}/`)) return path;
  return `${BASE_PATH}${path}`;
}

function appFetch(input, init) {
  if (typeof input === 'string') return fetch(appPath(input), init);
  if (typeof URL !== 'undefined' && input instanceof URL) {
    const url = new URL(input.toString());
    url.pathname = appPath(url.pathname);
    return fetch(url, init);
  }
  return fetch(input, init);
}

module.exports = { BASE_PATH, appFetch, appPath, getBasePath, normalizeBasePath };
