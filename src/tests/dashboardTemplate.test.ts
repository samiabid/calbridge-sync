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

test('event identifier control explains independent OneCal-style title behavior', async () => {
  const templatePath = path.join(process.cwd(), 'views', 'dashboard.ejs');
  const template = await fs.readFile(templatePath, 'utf8');

  assert.match(template, /Event Title Identifier \/ Custom Title \(optional\)/);
  assert.match(
    template,
    /When event titles are synced, this text is appended to the source title\. When titles are hidden, it becomes the destination title\. It is never added to the description\./
  );
  assert.match(template, /id="eventIdentifier" maxlength="64"/);
  assert.doesNotMatch(template, /id="syncEventTitlesOption"/);
  assert.doesNotMatch(template, /updateEventIdentifierTitleState/);
  assert.doesNotMatch(template, /titleCheckbox\.disabled/);
});

test('dashboard exposes and submits the optional clone color setting', async () => {
  const templatePath = path.join(process.cwd(), 'views', 'dashboard.ejs');
  const template = await fs.readFile(templatePath, 'utf8');

  assert.match(template, /id="cloneColorId"/);
  assert.match(template, /Keep source event color/);
  assert.match(template, /every clone created or updated by this sync uses this Google Calendar color/);
  assert.match(template, /cloneColorId: document\.getElementById\('cloneColorId'\)\.value/);
});
