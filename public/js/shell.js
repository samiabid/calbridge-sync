/* Shell chrome: tab navigation, theme toggle, overflow menus, mobile rail. */

/* ---------- tab navigation ---------- */
const tabLabels = { overview: 'Overview', syncs: 'Calendar syncs', events: 'Events', failures: 'Failed events', repair: 'Repair tools' };
function activateTab(tab) {
  document.querySelectorAll('.nav-item[data-tab]').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  document.querySelectorAll('.panel[data-panel]').forEach(p => p.classList.toggle('active', p.dataset.panel === tab));
  const crumb = document.getElementById('crumbTab');
  if (crumb) crumb.textContent = tabLabels[tab] || '';
  try { localStorage.setItem('cs-tab', tab); } catch (_) {}
  const rail = document.getElementById('rail');
  if (rail) rail.classList.remove('show');
}
document.querySelectorAll('.nav-item[data-tab]').forEach(btn => {
  btn.addEventListener('click', () => activateTab(btn.dataset.tab));
});

/* ---------- theme toggle ---------- */
function setTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  document.querySelectorAll('#themeSeg button').forEach(b => {
    const on = b.dataset.themeSet === theme;
    b.classList.toggle('on', on);
    b.setAttribute('aria-pressed', on ? 'true' : 'false');
  });
  try { localStorage.setItem('cs-theme', theme); } catch (_) {}
}
document.querySelectorAll('#themeSeg button').forEach(btn => {
  btn.addEventListener('click', () => setTheme(btn.dataset.themeSet));
});

/* ---------- overflow menus (sync cards) ---------- */
document.addEventListener('click', (e) => {
  const toggle = e.target.closest('[data-menu-toggle]');
  const openMenus = document.querySelectorAll('.menu.open');
  const closeMenu = (menu) => {
    menu.classList.remove('open');
    menu.closest('.sync')?.classList.remove('menu-open');
    menu.parentElement?.querySelector('[data-menu-toggle]')?.setAttribute('aria-expanded', 'false');
  };
  if (toggle) {
    const menu = toggle.parentElement.querySelector('.menu');
    const isOpen = menu.classList.contains('open');
    openMenus.forEach(closeMenu);
    if (!isOpen) {
      menu.classList.add('open');
      menu.closest('.sync')?.classList.add('menu-open');
      toggle.setAttribute('aria-expanded', 'true');
    }
    e.stopPropagation();
    return;
  }
  if (!e.target.closest('.menu')) openMenus.forEach(closeMenu);
});

/* ---------- mobile rail toggle ---------- */
const railToggleBtn = document.getElementById('railToggle');
if (railToggleBtn) railToggleBtn.addEventListener('click', () => document.getElementById('rail').classList.toggle('show'));

/* restore persisted theme + tab */
(function () {
  let t = 'light';
  try { t = localStorage.getItem('cs-theme') || 'light'; } catch (_) {}
  setTheme(t);
  let tab = 'overview';
  try { tab = localStorage.getItem('cs-tab') || 'overview'; } catch (_) {}
  if (tabLabels[tab]) activateTab(tab);
})();

/* dashboard.js and inline onclick handlers rely on these globals */
window.activateTab = activateTab;
window.setTheme = setTheme;
