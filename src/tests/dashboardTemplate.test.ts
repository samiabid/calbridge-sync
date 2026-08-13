import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

test('dashboard template includes the event-level sync dashboard controls', async () => {
  const templatePath = path.join(process.cwd(), 'views', 'dashboard.ejs');
  const template = await fs.readFile(templatePath, 'utf8');

  assert.match(template, /<h2>Events<\/h2>/i);
  assert.match(template, /id="eventSyncSelector"/i);
  assert.match(template, /id="eventSearchInput"/i);
  assert.match(template, /Search Event Title/i);
  assert.match(template, /id="eventsTableContainer"/i);
  assert.match(template, /Force Sync/i);
  assert.match(template, /not_synced/i);
});

test('event identifier control explains and enforces destination-title precedence', async () => {
  const templatePath = path.join(process.cwd(), 'views', 'dashboard.ejs');
  const template = await fs.readFile(templatePath, 'utf8');

  assert.match(template, /Destination Event Title \/ Identifier \(optional\)/);
  assert.match(
    template,
    /If set, this exact text replaces the source event title on destination events\. It is never added to the description\./
  );
  assert.match(template, /id="eventIdentifier" maxlength="64"/);
  assert.match(template, /id="syncEventTitlesOption"/);
  assert.match(template, /titleCheckbox\.disabled = hasIdentifier/);
  assert.match(template, /addEventListener\('input', updateEventIdentifierTitleState\)/);
});
