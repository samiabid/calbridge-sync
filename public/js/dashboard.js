/* Dashboard app logic. Bootstrapped by an inline script that sets
   window.__DASHBOARD_DATA__ = { syncs, systemHealth }. */

const __dashboardData = window.__DASHBOARD_DATA__ || {};
const syncsData = Array.isArray(__dashboardData.syncs) ? __dashboardData.syncs : [];
const initialSystemHealth = __dashboardData.systemHealth || {};

let calendars = [];
let keywords = [];
let excludedColors = [];
let editingSyncId = null;
let latestRepairCandidates = [];
let latestRepairSyncId = null;
let syncFormSnapshot = null;
const defaultRsvpStatuses = ['accepted', 'tentative', 'needsAction', 'declined'];
let eventsDashboardState = {
  syncId: syncsData[0]?.id || '',
  direction: syncsData[0]?.isTwoWay ? 'all' : 'source_to_target',
  daysBack: 30,
  daysForward: 365,
  search: '',
  page: 1,
  pageSize: 25,
};

const calendarColors = [
  { id: '1', name: 'Lavender', color: '#7986cb' },
  { id: '2', name: 'Sage', color: '#33b679' },
  { id: '3', name: 'Grape', color: '#8e24aa' },
  { id: '4', name: 'Flamingo', color: '#e67c73' },
  { id: '5', name: 'Banana', color: '#f6c026' },
  { id: '6', name: 'Tangerine', color: '#f5511d' },
  { id: '7', name: 'Peacock', color: '#039be5' },
  { id: '8', name: 'Graphite', color: '#616161' },
  { id: '9', name: 'Blueberry', color: '#3f51b5' },
  { id: '10', name: 'Basil', color: '#0b8043' },
  { id: '11', name: 'Tomato', color: '#d60000' },
];

/* ---------- toasts ---------- */
function showToast(message, options = {}) {
  const variant = options.variant || 'info';
  const container = document.getElementById('toastContainer');
  if (!container) { alert(message); return; }
  const toast = document.createElement('div');
  toast.className = `toast toast-${variant}`;
  toast.innerHTML = `<span class="toast-ic">${variant === 'success' ? svgIcon('check') : variant === 'error' ? svgIcon('x') : svgIcon('bolt')}</span><div class="toast-msg"></div><button class="toast-close" type="button" aria-label="Dismiss">×</button>`;
  toast.querySelector('.toast-msg').textContent = message;
  const remove = () => {
    if (!toast.isConnected) return;
    toast.classList.add('leaving');
    setTimeout(() => toast.remove(), 180);
  };
  toast.querySelector('.toast-close').addEventListener('click', remove);
  container.appendChild(toast);
  const duration = options.duration || (variant === 'error' ? 8000 : 5000);
  setTimeout(remove, duration);
}

/* ---------- button busy state ---------- */
async function withButtonBusy(button, busyLabel, fn) {
  if (!button) return fn();
  if (button.disabled) return undefined;
  const originalHtml = button.innerHTML;
  button.disabled = true;
  button.classList.add('is-busy');
  button.innerHTML = `<span class="spinner" aria-hidden="true"></span> ${busyLabel}`;
  try {
    return await fn();
  } finally {
    button.disabled = false;
    button.classList.remove('is-busy');
    button.innerHTML = originalHtml;
  }
}

function svgIcon(name) {
  const m = {
    check: '<path d="M4 12l5 5L20 6"/>',
    x: '<path d="M6 6l12 12"/><path d="M18 6 6 18"/>',
    trash: '<path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/><path d="M5 6l1 14a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2l1-14"/>',
    refresh: '<path d="M21 12a9 9 0 1 1-2.6-6.4"/><path d="M21 4v5h-5"/>',
    bolt: '<path d="M13 2 4 14h6l-1 8 9-12h-6l1-8Z"/>',
  };
  return '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' + (m[name] || '') + '</svg>';
}

async function loadCalendars() {
  try {
    const response = await fetch('/sync/calendars');
    calendars = await response.json();
    const sourceSelect = document.getElementById('sourceCalendar');
    const targetSelect = document.getElementById('targetCalendar');
    sourceSelect.innerHTML = '<option value="">Select a calendar</option>';
    targetSelect.innerHTML = '<option value="">Select a calendar</option>';
    calendars.forEach(cal => {
      const option1 = document.createElement('option');
      option1.value = cal.id;
      const roleLabel = cal.accessRole ? ` [${cal.accessRole}]` : '';
      const displayText = cal.account
        ? `${cal.name} (${cal.account})${cal.primary ? ' [Primary]' : ''}${roleLabel}`
        : `${cal.name}${cal.primary ? ' (Primary)' : ''}${roleLabel}`;
      option1.textContent = displayText;
      option1.dataset.name = cal.name;
      option1.dataset.accountId = cal.accountId;
      const option2 = option1.cloneNode(true);
      option2.dataset.accountId = cal.accountId;
      sourceSelect.appendChild(option1);
      targetSelect.appendChild(option2);
    });
    return calendars;
  } catch (error) {
    console.error('Error loading calendars:', error);
    showToast('Failed to load calendars', { variant: 'error' });
    return [];
  }
}

function renderSystemChecks(data) {
  const container = document.getElementById('systemChecks');
  const checks = data?.checks || {};
  const webhookRenewal = data?.webhookRenewal || initialSystemHealth.webhookRenewal || {};
  const entries = [
    ['Database', checks.database, data?.databaseError || 'Connected'],
    ['Session config', checks.sessionConfigured, checks.sessionConfigured ? 'Configured' : 'Missing secret or DB URL'],
    ['Token encryption', checks.tokenEncryptionConfigured, checks.tokenEncryptionConfigured ? 'Configured' : 'TOKEN_ENCRYPTION_KEY missing'],
    ['Public URL', checks.publicUrlConfigured, checks.publicUrlConfigured ? 'Configured' : 'PUBLIC_URL missing'],
    ['Canonical domain', checks.canonicalPublicUrlConfigured, checks.canonicalPublicUrlConfigured ? 'Using calendar.samiabid.com' : `Current: ${data?.runtimeConfig?.publicUrl || 'unknown'}`],
    ['Google OAuth client', checks.googleClientConfigured, checks.googleClientConfigured ? 'Configured' : 'GOOGLE_CLIENT_ID or SECRET missing'],
    ['Google redirect URI', checks.googleRedirectUriConfigured, data?.runtimeConfig?.googleRedirectUri || 'Missing redirect URI'],
    ['Internal renewal token', checks.internalRenewalTokenConfigured, checks.internalRenewalTokenConfigured ? 'Configured' : 'INTERNAL_CRON_TOKEN missing'],
    ['Alert webhook', checks.alertWebhookConfigured, checks.alertWebhookConfigured ? 'Configured' : 'ALERT_WEBHOOK_URL not set'],
    ['Webhook renewal', checks.webhookRenewalScheduled, webhookRenewal.lastRunSummary || webhookRenewal.status || 'Not scheduled'],
  ];
  container.innerHTML = entries.map(([label, ok, detail]) => `
    <div class="check ${ok ? 'ok' : 'bad'}">
      <span class="ic">${ok ? svgIcon('check') : svgIcon('x')}</span>
      <div>
        <div class="ctitle">${escapeHtml(label)}</div>
        <div class="cdetail">${escapeHtml(detail || 'No detail available')}</div>
      </div>
    </div>
  `).join('');
}

async function loadSystemHealth() {
  try {
    const response = await fetch('/ready');
    const data = await response.json();
    renderSystemChecks(data);
  } catch (error) {
    console.error('Error loading system health:', error);
    const container = document.getElementById('systemChecks');
    container.innerHTML = `
      <div class="check bad">
        <span class="ic">${svgIcon('x')}</span>
        <div><div class="ctitle">Readiness</div><div class="cdetail">Failed to load live readiness checks.</div></div>
      </div>`;
  }
}

function initColorFilter() {
  const container = document.getElementById('colorFilter');
  container.innerHTML = '';
  calendarColors.forEach(color => {
    const div = document.createElement('div');
    div.className = 'color-option';
    div.dataset.colorId = color.id;
    div.onclick = () => toggleColor(color.id, div);
    div.innerHTML = `<div class="color-dot" style="background: ${color.color}"></div><span>${color.name}</span>`;
    container.appendChild(div);
  });
}

function toggleColor(colorId, element) {
  const index = excludedColors.indexOf(colorId);
  if (index > -1) { excludedColors.splice(index, 1); element.classList.remove('selected'); }
  else { excludedColors.push(colorId); element.classList.add('selected'); }
}

function initKeywordInput() {
  const input = document.getElementById('keywordInput');
  if (!input) return;
  input.addEventListener('keypress', (e) => { if (e.key === 'Enter') { e.preventDefault(); addKeywordFromInput(); } });
  input.addEventListener('blur', () => { addKeywordFromInput(); });
}

function addKeywordFromInput() {
  const input = document.getElementById('keywordInput');
  if (!input) return;
  const value = input.value.trim();
  if (!value) return;
  const exists = keywords.some((keyword) => keyword.toLowerCase() === value.toLowerCase());
  if (!exists) { keywords.push(value); addKeywordTag(value); }
  input.value = '';
}

function addKeywordTag(keyword) {
  const container = document.getElementById('keywordTags');
  const input = document.getElementById('keywordInput');
  const tag = document.createElement('div');
  tag.className = 'tag';
  tag.innerHTML = `<span>${escapeHtml(keyword)}</span><button onclick="removeKeyword('${keyword.replace(/'/g, "\\'")}')" type="button" aria-label="Remove keyword">×</button>`;
  container.insertBefore(tag, input);
}

function setDefaultCopySettings() {
  document.getElementById('syncEventTitles').checked = true;
  document.getElementById('syncEventDescription').checked = true;
  document.getElementById('syncEventLocation').checked = true;
  document.getElementById('syncMeetingLinks').checked = true;
  document.getElementById('markEventPrivate').checked = false;
  document.getElementById('disableRemindersForClones').checked = false;
  document.getElementById('syncFreeEvents').checked = true;
  document.getElementById('eventIdentifier').value = '';
  document.getElementById('cloneColorId').value = '';
  document.querySelectorAll('input[name="copyRsvpStatus"]').forEach((input) => { input.checked = defaultRsvpStatuses.includes(input.value); });
}

function applyCopySettings(sync) {
  document.getElementById('syncEventTitles').checked = sync.syncEventTitles !== false;
  document.getElementById('syncEventDescription').checked = sync.syncEventDescription !== false;
  document.getElementById('syncEventLocation').checked = sync.syncEventLocation !== false;
  document.getElementById('syncMeetingLinks').checked = sync.syncMeetingLinks !== false;
  document.getElementById('markEventPrivate').checked = Boolean(sync.markEventPrivate);
  document.getElementById('disableRemindersForClones').checked = Boolean(sync.disableRemindersForClones);
  document.getElementById('syncFreeEvents').checked = sync.syncFreeEvents !== false;
  document.getElementById('eventIdentifier').value = sync.eventIdentifier || '';
  document.getElementById('cloneColorId').value = sync.cloneColorId || '';
  const selectedStatuses = Array.isArray(sync.copyRsvpStatuses) && sync.copyRsvpStatuses.length > 0 ? sync.copyRsvpStatuses : defaultRsvpStatuses;
  document.querySelectorAll('input[name="copyRsvpStatus"]').forEach((input) => { input.checked = selectedStatuses.includes(input.value); });
}

function getSelectedRsvpStatuses() {
  const statuses = [];
  document.querySelectorAll('input[name="copyRsvpStatus"]:checked').forEach((input) => { statuses.push(input.value); });
  return statuses;
}

function removeKeyword(keyword) {
  keywords = keywords.filter(k => k !== keyword);
  const tags = document.querySelectorAll('.tag');
  tags.forEach(tag => { if (tag.textContent.trim().startsWith(keyword)) { tag.remove(); } });
}

/* ---------- sync modal (create / edit) ---------- */
function captureSyncFormState() {
  return JSON.stringify({
    source: document.getElementById('sourceCalendar')?.value || '',
    target: document.getElementById('targetCalendar')?.value || '',
    isTwoWay: document.getElementById('isTwoWay')?.checked ?? true,
    syncStartMode: document.querySelector('input[name="syncStartMode"]:checked')?.value || '',
    keywords: [...keywords],
    excludedColors: [...excludedColors],
    syncEventTitles: document.getElementById('syncEventTitles')?.checked,
    syncEventDescription: document.getElementById('syncEventDescription')?.checked,
    syncEventLocation: document.getElementById('syncEventLocation')?.checked,
    syncMeetingLinks: document.getElementById('syncMeetingLinks')?.checked,
    markEventPrivate: document.getElementById('markEventPrivate')?.checked,
    disableRemindersForClones: document.getElementById('disableRemindersForClones')?.checked,
    syncFreeEvents: document.getElementById('syncFreeEvents')?.checked,
    eventIdentifier: document.getElementById('eventIdentifier')?.value || '',
    cloneColorId: document.getElementById('cloneColorId')?.value || '',
    copyRsvpStatuses: getSelectedRsvpStatuses(),
  });
}

function isSyncFormDirty() {
  return syncFormSnapshot !== null && captureSyncFormState() !== syncFormSnapshot;
}

function openCreateModal() {
  editingSyncId = null;
  document.getElementById('modalTitle').textContent = 'Create Calendar Sync';
  document.querySelector('#syncForm button[type="submit"]').textContent = 'Create Sync';
  document.getElementById('editLockNote').style.display = 'none';
  document.getElementById('syncModal').classList.add('active');
  loadCalendars();
  initColorFilter();
  initKeywordInput();
  keywords = [];
  excludedColors = [];
  const defaultSyncMode = document.querySelector('input[name="syncStartMode"][value="new_only"]');
  if (defaultSyncMode) defaultSyncMode.checked = true;
  setDefaultCopySettings();
  setFormDisabled(false);
  syncFormSnapshot = captureSyncFormState();
}

function closeModal(options = {}) {
  if (!options.force && isSyncFormDirty()) {
    if (!confirm('Discard unsaved changes to this sync?')) return;
  }
  syncFormSnapshot = null;
  document.getElementById('syncModal').classList.remove('active');
  document.getElementById('syncForm').reset();
  document.getElementById('keywordTags').innerHTML = '<input type="text" class="tag-input" id="keywordInput" placeholder="Type and press Enter">';
  setDefaultCopySettings();
  setFormDisabled(false);
}

function setFormDisabled(disabled) {
  document.getElementById('sourceCalendar').disabled = disabled;
  document.getElementById('targetCalendar').disabled = disabled;
  document.getElementById('isTwoWay').disabled = disabled;
  document.querySelectorAll('input[name="syncStartMode"]').forEach((el) => { el.disabled = disabled; });
}

function selectCalendarOption(selectElement, calendarId, accountId) {
  if (!selectElement || !calendarId) return;
  const options = Array.from(selectElement.options);
  const exactMatch = options.find((option) => option.value === calendarId && (!accountId || option.dataset.accountId === accountId));
  const fallbackMatch = options.find((option) => option.value === calendarId);
  const selectedOption = exactMatch || fallbackMatch;
  if (!selectedOption) return;
  options.forEach((option) => { option.selected = option === selectedOption; });
}

async function editSync(id) {
  const sync = syncsData.find(s => s.id === id);
  if (!sync) return;
  editingSyncId = id;
  document.getElementById('modalTitle').textContent = 'Edit Sync Settings';
  document.querySelector('#syncForm button[type="submit"]').textContent = 'Save Changes';
  document.getElementById('editLockNote').style.display = 'flex';
  document.getElementById('syncModal').classList.add('active');
  await loadCalendars();
  initColorFilter();
  initKeywordInput();
  const sourceAccountId = sync.sourceGoogleAccountId || sync.googleAccountId;
  const targetAccountId = sync.targetGoogleAccountId || sync.googleAccountId;
  selectCalendarOption(document.getElementById('sourceCalendar'), sync.sourceCalendarId, sourceAccountId);
  selectCalendarOption(document.getElementById('targetCalendar'), sync.targetCalendarId, targetAccountId);
  document.getElementById('isTwoWay').checked = sync.isTwoWay;
  keywords = [...(sync.excludedKeywords || [])];
  excludedColors = [...(sync.excludedColors || [])];
  keywords.forEach(addKeywordTag);
  excludedColors.forEach(colorId => {
    const option = document.querySelector(`.color-option[data-color-id="${colorId}"]`);
    if (option) option.classList.add('selected');
  });
  applyCopySettings(sync);
  setFormDisabled(true);
  syncFormSnapshot = captureSyncFormState();
}

document.getElementById('syncForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  addKeywordFromInput();
  const sourceSelect = document.getElementById('sourceCalendar');
  const targetSelect = document.getElementById('targetCalendar');
  const submitButton = document.querySelector('#syncForm button[type="submit"]');
  const isEdit = Boolean(editingSyncId);
  const commonSettings = {
    excludedKeywords: keywords,
    excludedColors: excludedColors,
    syncEventTitles: document.getElementById('syncEventTitles').checked,
    syncEventDescription: document.getElementById('syncEventDescription').checked,
    syncEventLocation: document.getElementById('syncEventLocation').checked,
    syncMeetingLinks: document.getElementById('syncMeetingLinks').checked,
    markEventPrivate: document.getElementById('markEventPrivate').checked,
    disableRemindersForClones: document.getElementById('disableRemindersForClones').checked,
    eventIdentifier: document.getElementById('eventIdentifier').value.trim(),
    cloneColorId: document.getElementById('cloneColorId').value,
    copyRsvpStatuses: getSelectedRsvpStatuses(),
    syncFreeEvents: document.getElementById('syncFreeEvents').checked,
  };
  if (commonSettings.copyRsvpStatuses.length === 0) { showToast('Select at least one RSVP status to copy.', { variant: 'error' }); return; }
  const data = isEdit ? commonSettings : {
    sourceCalendarId: sourceSelect.value,
    sourceCalendarName: sourceSelect.options[sourceSelect.selectedIndex].dataset.name,
    targetCalendarId: targetSelect.value,
    targetCalendarName: targetSelect.options[targetSelect.selectedIndex].dataset.name,
    googleAccountId: sourceSelect.options[sourceSelect.selectedIndex].dataset.accountId,
    targetGoogleAccountId: targetSelect.options[targetSelect.selectedIndex].dataset.accountId,
    isTwoWay: document.getElementById('isTwoWay').checked,
    syncStartMode: document.querySelector('input[name="syncStartMode"]:checked')?.value || 'new_only',
    ...commonSettings,
  };
  await withButtonBusy(submitButton, isEdit ? 'Saving…' : 'Creating…', async () => {
    try {
      const response = await fetch(isEdit ? `/sync/${editingSyncId}/filters` : '/sync', {
        method: isEdit ? 'PATCH' : 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
      });
      if (response.ok) { closeModal({ force: true }); location.reload(); }
      else {
        let message = isEdit ? 'Failed to update sync' : 'Failed to create sync';
        try { const body = await response.json(); if (body?.error) message = body.error; } catch (_) {}
        showToast(message, { variant: 'error' });
      }
    } catch (error) {
      console.error(isEdit ? 'Error updating sync:' : 'Error creating sync:', error);
      showToast(isEdit ? 'Failed to update sync' : 'Failed to create sync', { variant: 'error' });
    }
  });
});

/* close sync modal on backdrop click or Escape (with unsaved-changes guard) */
(function () {
  const modal = document.getElementById('syncModal');
  if (!modal) return;
  modal.addEventListener('mousedown', (e) => { if (e.target === modal) closeModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && modal.classList.contains('active')) closeModal();
  });
})();

async function deleteSync(id) {
  const dialog = document.createElement('div');
  dialog.className = 'modal active';
  dialog.innerHTML = `
    <div class="modal-content dialog-card">
      <h2>Delete Sync</h2>
      <p>What would you like to do with synced events?</p>
      <div class="dialog-actions" style="flex-direction:column;">
        <button class="btn btn-danger" style="width:100%;" onclick="confirmDelete('${id}', true, this)">Delete events from calendars</button>
        <button class="btn btn-secondary" style="width:100%;" onclick="confirmDelete('${id}', false, this)">Keep events in calendars</button>
        <button class="btn btn-secondary" style="width:100%;" onclick="this.closest('.modal').remove()">Cancel</button>
      </div>
      <p style="padding:0 24px 22px;color:var(--ink-3);font-size:12px;line-height:1.5;">
        <strong style="color:var(--ink-2);">Delete events</strong> removes synced clones from destination calendars.<br>
        <strong style="color:var(--ink-2);">Keep events</strong> leaves clones in place and only removes the sync configuration.
      </p>
    </div>`;
  dialog.addEventListener('mousedown', (e) => { if (e.target === dialog) dialog.remove(); });
  document.body.appendChild(dialog);
}

async function rerunBackfill(id, button) {
  const sync = syncsData.find((item) => item.id === id);
  if (!sync) { showToast('Sync not found.', { variant: 'error' }); return; }
  if (sync.backfillStatus === 'running' || sync.backfillStatus === 'queued') {
    showToast('A backfill is already running for this sync.');
    return;
  }
  const directionMessage = sync.isTwoWay
    ? 'This two-way backfill will scan both calendars sequentially.'
    : 'This one-way backfill will scan the source calendar.';
  if (!confirm(`${directionMessage} Existing mappings and native duplicate invites will be preserved. Continue?`)) return;
  await withButtonBusy(button, 'Starting…', async () => {
    try {
      const response = await fetch(`/sync/${id}/rerun-backfill`, { method: 'POST' });
      if (response.ok) {
        const body = await response.json();
        sync.backfillStatus = body?.run?.status || 'queued';
        sync.backfillRunId = body?.run?.runId || null;
        showToast(`Backfill queued${sync.backfillRunId ? ` (${sync.backfillRunId})` : ''}.`, { variant: 'success' });
        window.setTimeout(() => window.location.reload(), 600);
        return;
      }
      let message = 'Failed to start backfill';
      try { const body = await response.json(); if (body?.error) message = body.error; } catch (_) {}
      showToast(message, { variant: 'error' });
    } catch (error) { console.error('Error starting backfill:', error); showToast('Failed to start backfill', { variant: 'error' }); }
  });
}

function getSyncName(id) {
  const sync = syncsData.find((item) => item.id === id);
  if (!sync) return 'Unknown sync';
  return `${sync.sourceCalendarName} -> ${sync.targetCalendarName}`;
}

async function reconcileSync(id, button) {
  if (!confirm('Run bounded reconciliation for this sync? This will reprocess events from the last 30 days through the next 365 days.')) return;
  await withButtonBusy(button, 'Reconciling…', async () => {
    try {
      const response = await fetch(`/sync/${id}/reconcile`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      const body = await response.json();
      if (!response.ok) { showToast(body?.error || 'Failed to run reconciliation', { variant: 'error' }); return; }
      const directionSummary = (body.directions || []).map((item) => `${item.direction}: processed=${item.processed}, synced=${item.synced}, deleted=${item.deleted}, failed=${item.failed}`).join('\n');
      showToast(`Reconciliation finished for ${getSyncName(id)}.\n${directionSummary}`, { variant: 'success', duration: 10000 });
      setTimeout(() => location.reload(), 1600);
    } catch (error) { console.error('Error running reconciliation:', error); showToast('Failed to run reconciliation', { variant: 'error' }); }
  });
}

async function scanOrphans(id, button) {
  activateTab('repair');
  const panel = document.getElementById('repairResults');
  panel.innerHTML = '<p style="color:var(--ink-3);">Scanning sync-tagged target events…</p>';
  await withButtonBusy(button, 'Scanning…', async () => {
    try {
      const response = await fetch(`/sync/${id}/orphans`);
      const body = await response.json();
      if (!response.ok) { panel.innerHTML = `<p style="color:var(--danger);">${escapeHtml(body?.error || 'Failed to scan orphan clones')}</p>`; return; }
      renderRepairResults(id, body);
    } catch (error) { console.error('Error scanning orphans:', error); panel.innerHTML = '<p style="color:var(--danger);">Failed to scan orphan clones</p>'; }
  });
}

function renderRepairResults(syncId, data) {
  const panel = document.getElementById('repairResults');
  const candidates = Array.isArray(data?.candidates) ? data.candidates : [];
  latestRepairSyncId = syncId;
  latestRepairCandidates = candidates;
  const windowLabel = data?.window ? `${data.window.daysBack}d back / ${data.window.daysForward}d forward` : 'default window';
  if (candidates.length === 0) {
    panel.innerHTML = `
      <div class="repair-item">
        <h3>${escapeHtml(getSyncName(syncId))}</h3>
        <p class="repair-summary">No orphaned sync-tagged target events found in the ${escapeHtml(windowLabel)} window.</p>
        <div class="repair-meta"><div><strong>Scanned target events:</strong> ${data?.scannedTargetEvents || 0}</div></div>
      </div>`;
    return;
  }
  panel.innerHTML = `
    <div class="repair-item">
      <h3>${escapeHtml(getSyncName(syncId))}</h3>
      <p class="repair-summary">Found ${candidates.length} orphan candidate(s) in the ${escapeHtml(windowLabel)} window.</p>
      <div class="repair-meta"><div><strong>Scanned target events:</strong> ${data?.scannedTargetEvents || 0}</div></div>
    </div>
    ${candidates.map((candidate, index) => `
      <div class="repair-item" style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
        <div style="flex:1;min-width:200px;">
          <div style="font-weight:600;">${escapeHtml(candidate.summary || candidate.targetEventId || 'Untitled clone')}</div>
          <div class="event-row-meta">target ${escapeHtml(candidate.targetEventId || '')} · source mapping missing</div>
        </div>
        <button class="btn btn-small btn-danger" onclick="cleanupOrphanCandidateByIndex(${index}, this)">${svgIcon('trash')} Delete orphan clone</button>
      </div>
    `).join('')}`;
}

async function cleanupOrphanCandidateByIndex(index, button) {
  const candidate = latestRepairCandidates[index];
  const syncId = latestRepairSyncId;
  if (!candidate || !syncId) return;
  if (!confirm('Delete this orphaned sync-tagged target event? Only the selected sync clone will be removed.')) return;
  await withButtonBusy(button, 'Deleting…', async () => {
    try {
      const response = await fetch(`/sync/${syncId}/orphans/cleanup`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(candidate) });
      const body = await response.json();
      if (!response.ok) { showToast(body?.error || 'Failed to delete orphan clone', { variant: 'error' }); return; }
      showToast('Orphan clone deleted.', { variant: 'success' });
      await scanOrphans(syncId);
    } catch (error) { console.error('Error deleting orphan clone:', error); showToast('Failed to delete orphan clone', { variant: 'error' }); }
  });
}

async function confirmDelete(id, deleteEvents, button) {
  await withButtonBusy(button, 'Deleting…', async () => {
    try {
      const response = await fetch(`/sync/${id}`, { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ deleteEvents }) });
      if (response.ok) { location.reload(); } else { showToast('Failed to delete sync', { variant: 'error' }); }
    } catch (error) { console.error('Error deleting sync:', error); showToast('Failed to delete sync', { variant: 'error' }); }
  });
}

async function postFailureAction(failureId, actionPath, successMessage, button) {
  await withButtonBusy(button, 'Working…', async () => {
    try {
      const response = await fetch(`/sync/failures/${failureId}/${actionPath}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (response.ok) { if (successMessage) showToast(successMessage, { variant: 'success' }); setTimeout(() => location.reload(), 900); return; }
      let message = 'Failed to process failed event action';
      try { const body = await response.json(); if (body?.error) message = body.error; } catch (_) {}
      showToast(message, { variant: 'error' });
    } catch (error) { console.error('Error processing failed event action:', error); showToast('Failed to process failed event action', { variant: 'error' }); }
  });
}
function retryFailure(failureId, button) { postFailureAction(failureId, 'retry', 'Retry started.', button); }
function forceResyncFailure(failureId, button) { postFailureAction(failureId, 'force-resync', 'Force re-sync started.', button); }
function deleteStaleTarget(failureId, button) { if (!confirm('Delete the stale target clone for this failed event?')) return; postFailureAction(failureId, 'delete-stale-target', 'Stale target clone deleted.', button); }
function resolveFailure(failureId, button) { if (!confirm('Mark this failed event as resolved?')) return; postFailureAction(failureId, 'resolve', 'Failed event marked resolved.', button); }

function escapeHtml(value) {
  return String(value ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function getSelectedEventSync() { return syncsData.find((sync) => sync.id === eventsDashboardState.syncId) || null; }

function renderEventDirectionOptions() {
  const select = document.getElementById('eventDirectionSelector');
  if (!select) return;
  const sync = getSelectedEventSync();
  if (!sync) { select.innerHTML = '<option value="source_to_target">Source → Target</option>'; select.value = 'source_to_target'; return; }
  const options = sync.isTwoWay
    ? [['all', 'All directions'], ['source_to_target', 'Source → Target'], ['target_to_source', 'Target → Source']]
    : [['source_to_target', 'Source → Target']];
  select.innerHTML = options.map(([value, label]) => `<option value="${value}">${label}</option>`).join('');
  const allowedValues = new Set(options.map(([value]) => value));
  const nextDirection = allowedValues.has(eventsDashboardState.direction) ? eventsDashboardState.direction : options[0][0];
  select.value = nextDirection;
  eventsDashboardState.direction = nextDirection;
}

function getEventStatusBadgeClass(status) {
  switch (status) { case 'failed': return 'badge-danger'; case 'synced': return 'badge-success'; case 'skipped': return 'badge-warning'; default: return 'badge-neutral'; }
}
function getEventStatusLabel(status) {
  const labels = { failed: 'Failed', synced: 'Synced', skipped: 'Skipped', not_synced: 'Not Synced' };
  return labels[status] || status;
}
function getDirectionLabel(direction) { return direction === 'target_to_source' ? 'Target → Source' : 'Source → Target'; }

function formatAllDayDate(rawDate, endDate) {
  const start = new Date(rawDate);
  if (Number.isNaN(start.getTime())) return 'All day';
  if (!endDate) return `${start.toLocaleDateString()} · All day`;
  const exclusiveEnd = new Date(endDate);
  if (Number.isNaN(exclusiveEnd.getTime())) return `${start.toLocaleDateString()} · All day`;
  exclusiveEnd.setDate(exclusiveEnd.getDate() - 1);
  if (start.toDateString() === exclusiveEnd.toDateString()) return `${start.toLocaleDateString()} · All day`;
  return `${start.toLocaleDateString()} - ${exclusiveEnd.toLocaleDateString()} · All day`;
}
function formatEventTimeRange(item) {
  const startRaw = item?.start?.dateTime || item?.start?.date || null;
  const endRaw = item?.end?.dateTime || item?.end?.date || null;
  if (!startRaw) return 'Unknown time';
  if (item.isAllDay) return formatAllDayDate(startRaw, endRaw);
  const start = new Date(startRaw);
  const end = endRaw ? new Date(endRaw) : null;
  if (Number.isNaN(start.getTime())) return 'Unknown time';
  if (!end || Number.isNaN(end.getTime())) return start.toLocaleString();
  return `${start.toLocaleString()} - ${end.toLocaleString()}`;
}

function renderEventsTable(data) {
  const container = document.getElementById('eventsTableContainer');
  const pagination = document.getElementById('eventsPagination');
  const items = Array.isArray(data?.items) ? data.items : [];
  if (!container || !pagination) return;
  if (items.length === 0) { container.innerHTML = '<div class="table-empty">No events found in the selected window.</div>'; pagination.innerHTML = ''; return; }
  container.innerHTML = `
    <table class="events-table">
      <thead><tr><th>Event</th><th>Time</th><th>Location</th><th>Direction</th><th>Status</th><th>Details</th><th style="text-align:right;">Action</th></tr></thead>
      <tbody>
        ${items.map((item) => `
          <tr>
            <td>
              <strong>${escapeHtml(item.summary)}</strong>
              <div class="event-row-meta">Source: ${escapeHtml(item.sourceEventId)}</div>
              ${item.sourceStatus ? `<div class="event-row-meta">Source status: ${escapeHtml(item.sourceStatus)}</div>` : ''}
            </td>
            <td style="white-space:nowrap;">${escapeHtml(formatEventTimeRange(item))}</td>
            <td>${item.location ? escapeHtml(item.location) : '<span style="color:var(--ink-3);">—</span>'}</td>
            <td><span class="badge badge-neutral">${escapeHtml(getDirectionLabel(item.direction))}</span></td>
            <td><span class="badge ${getEventStatusBadgeClass(item.status)}"><span class="dot"></span>${escapeHtml(getEventStatusLabel(item.status))}</span></td>
            <td>
              ${escapeHtml(item.statusReason)}
              ${item.targetEventId ? `<div class="event-row-meta">Target: ${escapeHtml(item.targetEventId)}</div>` : ''}
              ${item.lastSyncedAt ? `<div class="event-row-meta">Last synced: ${escapeHtml(new Date(item.lastSyncedAt).toLocaleString())}</div>` : ''}
            </td>
            <td style="text-align:right;">
              <button class="btn btn-small force-sync-event-button" data-direction="${escapeHtml(item.direction)}" data-source-event-id="${escapeHtml(item.sourceEventId)}" data-source-calendar-id="${escapeHtml(item.sourceCalendarId)}">${svgIcon('bolt')} Force sync</button>
            </td>
          </tr>`).join('')}
      </tbody>
    </table>`;
  const page = data?.page || 1;
  const totalPages = data?.totalPages || 1;
  pagination.innerHTML = `
    <div class="mono" style="color:var(--ink-2);">Page ${page} of ${totalPages}</div>
    <div style="display:flex; gap:8px;">
      <button class="btn btn-small" type="button" onclick="loadSyncEvents({ page: ${page - 1} })" ${page <= 1 ? 'disabled style="opacity:.5;"' : ''}>Previous</button>
      <button class="btn btn-small" type="button" onclick="loadSyncEvents({ page: ${page + 1} })" ${page >= totalPages ? 'disabled style="opacity:.5;"' : ''}>Next</button>
    </div>`;
  container.querySelectorAll('.force-sync-event-button').forEach((button) => { button.addEventListener('click', () => forceSyncListedEvent(button)); });
}

function updateEventsSummary(data) {
  const summary = document.getElementById('eventsSummary');
  if (!summary) return;
  const total = data?.total || 0;
  const search = data?.search || eventsDashboardState.search || '';
  if (total === 0) {
    summary.textContent = search
      ? `No live source events matching "${search}" found in the selected window.`
      : 'No live source events found in the selected window.';
    return;
  }
  const startIndex = ((data.page || 1) - 1) * (data.pageSize || 25) + 1;
  const endIndex = Math.min(total, startIndex + (data.items?.length || 0) - 1);
  const matchText = search ? ` matching "${search}"` : '';
  summary.textContent = `Showing ${startIndex}-${endIndex} of ${total}${matchText} events for ${data.syncLabel} (${data.window.daysBack}d back / ${data.window.daysForward}d forward).`;
}

function syncEventsStateFromControls(resetPage = false) {
  const syncSelector = document.getElementById('eventSyncSelector');
  const directionSelector = document.getElementById('eventDirectionSelector');
  const daysBackInput = document.getElementById('eventDaysBack');
  const daysForwardInput = document.getElementById('eventDaysForward');
  const searchInput = document.getElementById('eventSearchInput');
  const pageSizeSelect = document.getElementById('eventPageSize');
  if (!syncSelector || !directionSelector || !daysBackInput || !daysForwardInput || !searchInput || !pageSizeSelect) return;
  eventsDashboardState.syncId = syncSelector.value;
  eventsDashboardState.direction = directionSelector.value;
  eventsDashboardState.daysBack = Number(daysBackInput.value || 30);
  eventsDashboardState.daysForward = Number(daysForwardInput.value || 365);
  eventsDashboardState.search = searchInput.value.trim();
  eventsDashboardState.pageSize = Number(pageSizeSelect.value || 25);
  if (resetPage) eventsDashboardState.page = 1;
}

async function loadSyncEvents(options = {}) {
  const container = document.getElementById('eventsTableContainer');
  const summary = document.getElementById('eventsSummary');
  if (!container || !summary) return;
  syncEventsStateFromControls(Boolean(options.resetPage));
  if (typeof options.page === 'number') eventsDashboardState.page = Math.max(1, options.page);
  if (!eventsDashboardState.syncId) { summary.textContent = 'Select a sync to load events.'; container.innerHTML = '<div class="table-empty">Select a sync to load events.</div>'; return; }
  summary.textContent = 'Loading events…';
  container.innerHTML = '<div class="table-empty">Loading events…</div>';
  const pagination = document.getElementById('eventsPagination');
  if (pagination) pagination.innerHTML = '';
  try {
    const params = new URLSearchParams({
      daysBack: String(eventsDashboardState.daysBack),
      daysForward: String(eventsDashboardState.daysForward),
      direction: eventsDashboardState.direction,
      page: String(eventsDashboardState.page),
      pageSize: String(eventsDashboardState.pageSize),
    });
    if (eventsDashboardState.search) params.set('search', eventsDashboardState.search);
    const response = await fetch(`/sync/${eventsDashboardState.syncId}/events?${params.toString()}`);
    const data = await response.json();
    if (!response.ok) { summary.textContent = data?.error || 'Failed to load sync events.'; container.innerHTML = `<div class="table-empty">${escapeHtml(data?.error || 'Failed to load sync events.')}</div>`; return; }
    eventsDashboardState.page = data.page;
    eventsDashboardState.pageSize = data.pageSize;
    eventsDashboardState.direction = data.direction;
    eventsDashboardState.search = data.search || eventsDashboardState.search || '';
    updateEventsSummary(data);
    renderEventsTable(data);
  } catch (error) { console.error('Error loading sync events:', error); summary.textContent = 'Failed to load sync events.'; container.innerHTML = '<div class="table-empty">Failed to load sync events.</div>'; }
}

async function forceSyncListedEvent(button) {
  if (!button) return;
  const sourceEventId = button.dataset.sourceEventId;
  const sourceCalendarId = button.dataset.sourceCalendarId;
  const direction = button.dataset.direction;
  if (!sourceEventId || !sourceCalendarId || !direction) return;
  await withButtonBusy(button, 'Syncing…', async () => {
    try {
      const response = await fetch(`/sync/${eventsDashboardState.syncId}/events/force-sync`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ direction, sourceEventId, sourceCalendarId }) });
      const body = await response.json();
      if (!response.ok) { showToast(body?.error || 'Failed to force sync event', { variant: 'error' }); return; }
      await loadSyncEvents({ page: eventsDashboardState.page });
    } catch (error) { console.error('Error forcing sync event:', error); showToast('Failed to force sync event', { variant: 'error' }); }
  });
}

function initializeEventsDashboard() {
  const syncSelector = document.getElementById('eventSyncSelector');
  if (!syncSelector) return;
  if (!eventsDashboardState.syncId && syncSelector.options.length > 0) eventsDashboardState.syncId = syncSelector.value;
  syncSelector.value = eventsDashboardState.syncId;
  renderEventDirectionOptions();
  syncSelector.addEventListener('change', () => { eventsDashboardState.syncId = syncSelector.value; renderEventDirectionOptions(); loadSyncEvents({ resetPage: true }); });
  const directionSelector = document.getElementById('eventDirectionSelector');
  if (directionSelector) directionSelector.addEventListener('change', () => loadSyncEvents({ resetPage: true }));
  const pageSizeSelect = document.getElementById('eventPageSize');
  if (pageSizeSelect) { pageSizeSelect.value = String(eventsDashboardState.pageSize); pageSizeSelect.addEventListener('change', () => loadSyncEvents({ resetPage: true })); }
  const searchInput = document.getElementById('eventSearchInput');
  if (searchInput) {
    searchInput.value = eventsDashboardState.search || '';
    searchInput.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault();
        loadSyncEvents({ resetPage: true });
      }
    });
  }
  ['eventDaysBack', 'eventDaysForward'].forEach((id) => { const input = document.getElementById(id); if (input) input.addEventListener('change', () => loadSyncEvents({ resetPage: true })); });
  loadSyncEvents({ resetPage: true });
}

async function loadAccounts() {
  try {
    const response = await fetch('/sync/accounts');
    const accounts = await response.json();
    const accountsList = document.getElementById('accountsList');
    if (accounts.length === 0) { accountsList.innerHTML = '<p style="color:var(--ink-3);">No accounts connected yet.</p>'; return; }
    accountsList.innerHTML = accounts.map(acc => {
      const initials = (acc.displayName || '?').split(/[@.\s]/).filter(Boolean).slice(0, 2).map(s => s[0].toUpperCase()).join('');
      const connected = acc.connectionStatus === 'connected';
      return `
      <div class="account">
        <div class="gava">${escapeHtml(initials)}</div>
        <div class="ainfo">
          <b>${escapeHtml(acc.displayName)}</b>
          <div class="ameta">Connected ${escapeHtml(new Date(acc.createdAt).toLocaleDateString())}${acc.connectionStatus === 'disconnected' && acc.statusReason ? ' · ' + escapeHtml(acc.statusReason) : ''}</div>
        </div>
        ${acc.isPrimary ? '<span class="badge badge-accent"><span class="dot"></span>Primary</span>' : ''}
        <span class="badge ${connected ? 'badge-success' : 'badge-danger'}"><span class="dot"></span>${connected ? 'Connected' : 'Disconnected'}</span>
        <div class="aacts">
          <button class="btn btn-small" onclick="reauthAccount('${acc.id}')">${svgIcon('refresh')} Re-authenticate</button>
          ${!acc.isPrimary ? `<button class="btn btn-small btn-danger" onclick="deleteAccount('${acc.id}', this)">Remove</button>` : ''}
        </div>
      </div>`;
    }).join('');
  } catch (error) { console.error('Error loading accounts:', error); document.getElementById('accountsList').innerHTML = '<p style="color:var(--danger);">Failed to load accounts</p>'; }
}

function reauthAccount(accountId) { window.location = `/auth/google/reauth/${accountId}`; }

async function deleteAccount(accountId, button) {
  if (!confirm('Are you sure? This will delete all syncs using this account.')) return;
  await withButtonBusy(button, 'Removing…', async () => {
    try {
      const response = await fetch(`/sync/accounts/${accountId}`, { method: 'DELETE' });
      if (response.ok) { location.reload(); } else { showToast('Failed to delete account', { variant: 'error' }); }
    } catch (error) { console.error('Error deleting account:', error); showToast('Failed to delete account', { variant: 'error' }); }
  });
}

document.addEventListener('DOMContentLoaded', () => {
  loadSystemHealth();
  loadAccounts();
  loadCalendars();
  initializeEventsDashboard();
});

/* inline onclick attributes in the template and in JS-generated markup
   resolve against window — every handler must be exported explicitly */
window.showToast = showToast;
window.openCreateModal = openCreateModal;
window.closeModal = closeModal;
window.editSync = editSync;
window.deleteSync = deleteSync;
window.confirmDelete = confirmDelete;
window.rerunBackfill = rerunBackfill;
window.reconcileSync = reconcileSync;
window.scanOrphans = scanOrphans;
window.cleanupOrphanCandidateByIndex = cleanupOrphanCandidateByIndex;
window.retryFailure = retryFailure;
window.forceResyncFailure = forceResyncFailure;
window.deleteStaleTarget = deleteStaleTarget;
window.resolveFailure = resolveFailure;
window.removeKeyword = removeKeyword;
window.reauthAccount = reauthAccount;
window.deleteAccount = deleteAccount;
window.loadSyncEvents = loadSyncEvents;
window.forceSyncListedEvent = forceSyncListedEvent;
