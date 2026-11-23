const form = document.getElementById('loginForm');
const err = document.getElementById('err');

form.addEventListener('submit', async e => {
  e.preventDefault();
  err.hidden = true;
  const password = document.getElementById('pw').value;
  const r = await fetch('/api/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ password }),
  }).catch(() => null);
  if (r && r.ok) { location.href = '/'; return; }
  const d = r ? await r.json().catch(() => ({})) : {};
  err.textContent = d.error || 'Der Server ist gerade nicht erreichbar.';
  err.hidden = false;
});
