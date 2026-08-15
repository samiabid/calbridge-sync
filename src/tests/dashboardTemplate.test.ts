import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

async function readDashboardSources() {
  const template = await fs.readFile(
    path.join(process.cwd(), 'views', 'dashboard.ejs'),
    'utf8'
  );
  const dashboardJs = await fs.readFile(
    path.join(process.cwd(), 'public', 'js', 'dashboard.js'),
    'utf8'
  );
  const shellJs = await fs.readFile(
    path.join(process.cwd(), 'public', 'js', 'shell.js'),
    'utf8'
  );
  return { template, dashboardJs, shellJs, combined: template + dashboardJs + shellJs };
}

test('dashboard template includes the event-level sync dashboard controls', async () => {
  const { template, combined } = await readDashboardSources();

  assert.match(template, /<h2>Events<\/h2>/i);
  assert.match(template, /id="eventSyncSelector"/i);
  assert.match(template, /id="eventSearchInput"/i);
  assert.match(template, /Search Event Title/i);
  assert.match(template, /id="eventsTableContainer"/i);
  assert.match(combined, /Force Sync/i);
  assert.match(combined, /not_synced/i);
});

test('dashboard template bootstraps data and loads the external scripts', async () => {
  const { template } = await readDashboardSources();

  assert.match(template, /window\.__DASHBOARD_DATA__/);
  assert.match(template, /<%- syncsJson %>/);
  assert.match(template, /<%- systemHealthJson %>/);
  assert.match(template, /src="\/js\/shell\.js"/);
  assert.match(template, /src="\/js\/dashboard\.js"/);
  assert.match(template, /id="toastContainer"/);
  // No leftover inline app logic beyond the data bootstrap.
  const inlineScripts = template.match(/<script>[\s\S]*?<\/script>/g) || [];
  assert.equal(inlineScripts.length, 1);
  assert.match(inlineScripts[0], /window\.__DASHBOARD_DATA__/);
});

test('dashboard scripts parse and export the globals used by inline handlers', async () => {
  const { template, dashboardJs, shellJs } = await readDashboardSources();

  // Both files must at least parse (no bundler/transpiler in the pipeline).
  assert.doesNotThrow(() => new Function(dashboardJs));
  assert.doesNotThrow(() => new Function(shellJs));

  // Every global invoked by an inline onclick must be assigned to window.
  const handlerNames = new Set<string>();
  for (const match of template.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*\(/g)) {
    handlerNames.add(match[1]);
  }
  for (const match of dashboardJs.matchAll(/onclick="([A-Za-z_$][\w$]*)\s*\(/g)) {
    handlerNames.add(match[1]);
  }
  assert.ok(handlerNames.size > 0, 'expected inline onclick handlers in the template');
  const exported = new Set(
    [...(dashboardJs + shellJs).matchAll(/window\.([A-Za-z_$][\w$]*)\s*=/g)].map((m) => m[1])
  );
  for (const name of handlerNames) {
    assert.ok(exported.has(name), `handler "${name}" is not exported on window`);
  }
});

test('event identifier control explains independent OneCal-style title behavior', async () => {
  const { template, dashboardJs } = await readDashboardSources();

  assert.match(template, /Event Title Identifier \/ Custom Title \(optional\)/);
  assert.match(
    template,
    /When event titles are synced, this text is appended to the source title\. When titles are hidden, it becomes the destination title\. It is never added to the description\./
  );
  assert.match(template, /id="eventIdentifier" maxlength="64"/);
  assert.doesNotMatch(template, /id="syncEventTitlesOption"/);
  assert.doesNotMatch(dashboardJs, /updateEventIdentifierTitleState/);
  assert.doesNotMatch(dashboardJs, /titleCheckbox\.disabled/);
});

test('dashboard exposes and submits the optional clone color setting', async () => {
  const { template, dashboardJs } = await readDashboardSources();

  assert.match(template, /id="cloneColorId"/);
  assert.match(template, /Keep source event color/);
  assert.match(template, /every clone created or updated by this sync uses this Google Calendar color/);
  assert.match(dashboardJs, /cloneColorId: document\.getElementById\('cloneColorId'\)\.value/);
});

test('dashboard explains two-way backfill safety and exposes persisted run state', async () => {
  const { template, dashboardJs } = await readDashboardSources();

  assert.match(template, /Two-way syncs scan both calendars sequentially/i);
  assert.match(template, /sync\.backfillStatus/);
  assert.match(dashboardJs, /A backfill is already running for this sync/);
  assert.match(dashboardJs, /native duplicate invites will be preserved/);
});
