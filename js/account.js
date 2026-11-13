// Accounts + cloud sync against the PHP API in /api.
const H = { 'Content-Type': 'application/json', 'X-Glazies': '1' };

async function api(path, opts = {}) {
  let r, j;
  try {
    r = await fetch(`api/${path}`, { credentials: 'same-origin', ...opts, headers: { ...H, ...(opts.headers || {}) } });
    j = await r.json();
  } catch {
    throw new Error('The account server is not reachable right now.');
  }
  if (!r.ok || !j.ok) throw new Error(j.error || `Error ${r.status}`);
  return j;
}

export const me = () => api('auth.php').then((j) => j.user);
export const signup = (name, email, password) => api('auth.php', { method: 'POST', body: JSON.stringify({ action: 'signup', name, email, password }) }).then((j) => j.user);
export const login = (email, password) => api('auth.php', { method: 'POST', body: JSON.stringify({ action: 'login', email, password }) }).then((j) => j.user);
export const logout = () => api('auth.php', { method: 'POST', body: JSON.stringify({ action: 'logout' }) });
export const pull = () => api('data.php');
export const push = (positions, settings = {}) => api('data.php', { method: 'PUT', body: JSON.stringify({ positions, settings }) });
