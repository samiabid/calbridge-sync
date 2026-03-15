import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('dashboard template includes the event-level sync dashboard controls', async () => {
  const templatePath = path.join(process.cwd(), 'views', 'dashboard.ejs');
  const template = await fs.readFile(templatePath, 'utf8');

  assert.match(template, /<h2>Events<\/h2>/i);
  assert.match(template, /id="eventSyncSelector"/i);
  assert.match(template, /id="eventsTableContainer"/i);
  assert.match(template, /Force Sync/i);
  assert.match(template, /not_synced/i);
});
