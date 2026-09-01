import { chromium } from 'playwright';
import { mkdir, readFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, '..', '..', '..');
const shotDir = join(here, 'screenshots');
await mkdir(shotDir, { recursive: true });
const url = pathToFileURL(join(here, 'index.html')).href;
const browser = await chromium.launch({ headless: true });
const results = [];

// Exercise the repository's normative schemas, operation envelopes, invalid
// corpus, history revision, and byte-exact Obsidian fixture tree. The browser
// presents these results but remains deliberately in-memory and non-authoritative.
const fixtureProof = execFileSync(
  'uv',
  ['run', 'pytest', '-q', 'tests/test_memory_adapter_architecture.py'],
  { cwd: repoRoot, encoding: 'utf8' }
).trim();
assert.match(fixtureProof, /passed/);
const prototypeFixtureProof = execFileSync(
  'uv',
  ['run', 'python', 'design/prototypes/memory-setup/verify_fixtures.py'],
  { cwd: repoRoot, encoding: 'utf8' }
).trim();
assert.equal(prototypeFixtureProof, 'prototype lifecycle fixtures: 3 validated');
const operationFixtures = JSON.parse(await readFile(join(repoRoot, 'docs/memory/fixtures/memory-adapter/valid/operation-envelopes.json'), 'utf8'));
const expectedVaultBytes = JSON.parse(await readFile(join(repoRoot, 'docs/memory/fixtures/obsidian-vault/expected-bytes.json'), 'utf8'));
const correctionFixture = JSON.parse(await readFile(join(repoRoot, 'docs/memory/fixtures/memory-adapter/history/room-record-revision-2.json'), 'utf8'));
const retrievalFixture = JSON.parse(await readFile(join(here, 'fixtures/retrieve-match-response.json'), 'utf8'));
const tombstoneFixture = JSON.parse(await readFile(join(here, 'fixtures/tombstone-record.json'), 'utf8'));
const lifecycleFixture = JSON.parse(await readFile(join(here, 'fixtures/lifecycle-evidence.json'), 'utf8'));
const operation = (name) => operationFixtures.find((fixture) => fixture.operation === name);
assert.equal(operation('append_events').request.events[0].event_sequence, 10);
assert.deepEqual(operation('append_events').response.assigned[0], {
  event_id: '018f0f6f-a3d2-7d09-bd19-d6325d4bc77a',
  event_sequence: 10,
  content_digest: 'sha256:be6ed51fbb2b40a38eeb34dc6ed00628e2b2ba2ed0ec07b0ddff02f98aa1894d'
});
assert.equal(operation('retrieve').response.items_returned, 0);
assert.equal(operation('retrieve').response.bytes_returned, 0);
assert.equal(operation('export').response.bytes, 1024);
assert.deepEqual(operation('export').response.counts, { events: 1, record_revisions: 4, active_records: 4, tombstones: 0 });
assert.equal(correctionFixture.revision, 2);
assert.equal(correctionFixture.provenance.derivation.kind, 'correction');
assert.equal(retrievalFixture.items_returned, 1);
assert.equal(retrievalFixture.items[0].match.reason, 'Exact phrase: compare-then-choose');
assert.equal(tombstoneFixture.status, 'tombstoned');
assert.equal('body' in tombstoneFixture, false);
assert.equal(lifecycleFixture.restart_reopen.integrity_verified, true);
assert.equal(lifecycleFixture.reconnect_replay.logical_digest_match, true);
assert.equal(lifecycleFixture.conflict.continuation_allowed, false);
assert.equal(lifecycleFixture.unavailable.continuation_allowed, false);
assert.equal(lifecycleFixture.disconnect_preflight.configuration_only, true);
assert.equal(lifecycleFixture.rebuild.logical_digest_match, true);
const roomNote = expectedVaultBytes.files.find((entry) => entry.path.endsWith('/room.md'));
assert.deepEqual(roomNote, {
  bytes: 466,
  path: 'rooms/018f0f6e-7b6a-7c10-8af1-7f4c620b93c1/room.md',
  sha256: 'sha256:153cadaf34056f1e5545c98529ae48738d17c6cecc0b744ea8ac771626071af5'
});
results.push(`Normative memory fixtures: ${fixtureProof}`);
results.push(prototypeFixtureProof);

async function openPage(width, height, reducedMotion = 'no-preference') {
  const context = await browser.newContext({ viewport: { width, height }, reducedMotion });
  const page = await context.newPage();
  const errors = [];
  const consoleErrors = [];
  const external = [];
  page.on('pageerror', (error) => errors.push(String(error)));
  page.on('console', (message) => { if (message.type() === 'error' || message.type() === 'warning') consoleErrors.push(message.text()); });
  page.on('request', (request) => { if (!request.url().startsWith('file:')) external.push(request.url()); });
  await page.goto(url);
  return { context, page, errors, consoleErrors, external };
}

async function assertClean(runtime, label) {
  assert.deepEqual(runtime.errors, [], `${label}: page errors`);
  assert.deepEqual(runtime.consoleErrors, [], `${label}: console errors/warnings`);
  assert.deepEqual(runtime.external, [], `${label}: external requests`);
}

async function assertGeometry(page, label) {
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button,select,summary,input[type=checkbox],input[type=radio]')]
      .filter((element) => !element.disabled && element.offsetParent !== null);
    const targetHeights = controls.map((element) => {
      const target = element.matches('input[type=checkbox],input[type=radio]') ? element.closest('label') : element;
      return target.getBoundingClientRect().height;
    });
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minHeight: Math.min(...targetHeights),
      controls: controls.length
    };
  });
  assert.ok(metrics.overflow <= 1, `${label}: horizontal overflow ${metrics.overflow}px`);
  assert.ok(metrics.minHeight >= 44, `${label}: target below 44px (${metrics.minHeight})`);
  assert.ok(metrics.controls >= 3, `${label}: too few controls`);
  results.push(`${label}: ${metrics.controls} controls, min target ${metrics.minHeight}px, overflow ${metrics.overflow}px`);
}

async function storageSnapshot(page) {
  return page.evaluate(async () => ({
    local: Object.keys(localStorage),
    session: Object.keys(sessionStorage),
    cookie: document.cookie,
    indexedDb: typeof indexedDB.databases === 'function' ? (await indexedDB.databases()).map((db) => db.name) : [],
    caches: typeof caches === 'undefined' ? [] : await caches.keys()
  }));
}

async function consentAndChoose(page, kind) {
  if (kind === 'http' && await page.locator('#advancedSink').getAttribute('open') === null) {
    await page.locator('#advancedSink summary').click();
  }
  await page.locator(`input[value=${kind}]`).check();
  await page.locator('#consent').check();
  await page.locator('#chooseNext').click();
  await expectFocus(page, '#stepTitle', `${kind} location transition`);
  if (kind === 'obsidian') {
    await page.locator('#browseVault').click();
    await page.getByRole('button', { name: /Research Vault/ }).click();
    await page.locator('#chooseFolder').click();
    assert.equal(await page.locator('#vaultPath').inputValue(), 'Research Vault (synthetic picker result)');
  }
  if (kind === 'http') await page.locator('#httpDisclosure').check();
  await page.locator('#locationNext').click();
  await expectFocus(page, '#stepTitle', `${kind} preview transition`);
}

async function expectFocus(page, selector, label) {
  assert.equal(await page.locator(`${selector}:focus`).count(), 1, `${label}: focus is not ${selector}`);
}

async function smokeBackend(page, kind, label) {
  await consentAndChoose(page, kind);
  await assertGeometry(page, `${label}-location`);
  await page.locator('#fixtureState').selectOption('success');
  await page.locator('#runCheck').click();
  await page.locator('#toSample').click();
  await assertGeometry(page, `${label}-rehearsal`);
  await page.locator('#createSample').click();
  await page.locator('#retrievalButton').click();
  await page.locator('#toManage').click();
  await assertGeometry(page, `${label}-manage`);
  if (kind === 'local') {
    assert.match(await page.locator('#connectedCopy').textContent(), /no optional projection or sink lag/);
    assert.equal(await page.locator('#disconnectButton').isDisabled(), true);
  } else {
    assert.match(await page.locator('#connectedCopy').textContent(), /fixed-loopback projection acknowledged 10/);
    await page.locator('#disconnectButton').click();
    assert.match(await page.locator('#eraseTitle').textContent(), /1 room-scoped HTTP projection/);
    await page.keyboard.press('Escape');
  }
}

function luminance(hex) {
  const rgb = hex.match(/[a-f\d]{2}/gi).map((part) => Number.parseInt(part, 16) / 255)
    .map((value) => value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4);
  return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
}
function contrast(a, b) {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

for (const [width, height, name] of [[320, 800, 'mobile-320'], [390, 844, 'mobile-390']]) {
  const runtime = await openPage(width, height);
  await assertGeometry(runtime.page, name);
  await runtime.page.screenshot({ path: join(shotDir, `memory-setup-${name}x${height}.png`) });
  await smokeBackend(runtime.page, width === 320 ? 'local' : 'http', name);
  await assertClean(runtime, name);
  await runtime.context.close();
}

const desktop = await openPage(1440, 1100);
const { page } = desktop;
await assertGeometry(page, 'desktop-1440');
assert.equal(await page.locator('#chooseNext').isDisabled(), true, 'consent gates continuation');
assert.equal(await page.locator('#advancedSink').getAttribute('open'), null, 'HTTP remains behind Advanced by default');
await page.locator('#advancedSink summary').click();
await page.locator('input[value=http]').check();
assert.equal(await page.locator('input[value=http]').isChecked(), true);
assert.equal(await page.locator('#consent').isChecked(), false, 'sink change requires fresh consent');
assert.equal(await page.locator('#chooseNext').isDisabled(), true, 'sink change blocks continuation until re-consent');
await page.locator('input[value=local]').check();
await page.locator('#advancedSink summary').click();
assert.deepEqual(await storageSnapshot(page), { local: [], session: [], cookie: '', indexedDb: [], caches: [] });
await page.screenshot({ path: join(shotDir, 'memory-setup-desktop-1440x1100.png'), fullPage: true });

// An outage fixture cannot invent an optional sink for built-in-only.
await page.locator('#consent').check();
await page.locator('#chooseNext').click();
await page.locator('#locationNext').click();
await page.locator('#fixtureState').selectOption('offline');
await page.locator('#runCheck').click();
assert.equal(await page.locator('#checkStatus h3').textContent(), 'No optional sink selected');
assert.equal(await page.getByRole('button', { name: 'Preview identical retry' }).count(), 0);
assert.equal(await page.locator('#toSample').isDisabled(), true);
await page.getByRole('button', { name: /Choose/ }).click();

await consentAndChoose(page, 'obsidian');
assert.match(await page.locator('#rootSummary').textContent(), /Research Vault \/ Green Room\//);
const tree = await page.locator('#managedTree').innerText();
assert.equal(tree, `Green Room/
├── README.md
├── rooms/
│   └── <room-id>/
│       ├── room.md
│       ├── events/
│       │   └── YYYY-MM.ndjson
│       ├── records/revisions.ndjson
│       ├── episodes/<record-id>.md
│       ├── people/<persona-id>/<record-id>.md
│       ├── relationships/<source-id>--<target-id>/<record-id>.md
│       └── memories/<record-id>.md
├── state/
│   ├── adapter.json
│   ├── managed-files.json
│   ├── operations.ndjson
│   ├── quarantine/
│   └── recovery/
├── user-annotations/<room-id>/<record-id>.md
└── .locks/`);
assert.equal(await page.locator('#vaultPath').getAttribute('readonly'), '');
assert.equal(await page.locator('#subtree').count(), 0, 'fixed Green Room child is not editable');
assert.equal(await page.locator('input[inputmode=url]').count(), 0, 'no arbitrary URL input');

for (const [fixture, heading] of [
  ['permission', 'Permission denied'],
  ['symlink', 'Unsafe path component blocked'],
  ['unsupported', 'Writable mode unsupported here']
]) {
  await page.locator('#fixtureState').selectOption(fixture);
  await page.locator('#runCheck').click();
  assert.equal(await page.locator('#checkStatus h3').textContent(), heading);
  assert.equal(await page.locator('#toSample').isDisabled(), true);
}
for (const [fixture, action, heading] of [
  ['conflict', 'Preview quarantine and authority rebuild', 'Rebuild evidence required'],
  ['offline', 'Preview identical retry', 'Acknowledgement evidence required']
]) {
  await page.locator('#fixtureState').selectOption(fixture);
  await page.locator('#runCheck').click();
  await page.getByRole('button', { name: action }).click();
  assert.equal(await page.locator('#checkStatus h3').textContent(), heading);
  assert.equal(await page.locator('#toSample').isDisabled(), true);
}
await page.locator('#fixtureState').selectOption('migration');
await page.locator('#runCheck').click();
await page.getByRole('button', { name: 'Preview verified backup and migration' }).click();
assert.equal(await page.locator('#checkStatus h3').textContent(), 'Migration preview remains blocked');
assert.equal(await page.locator('#toSample').isDisabled(), true);

// Restore the Obsidian fixture after the offline fixture deliberately selected HTTP.
await page.getByRole('button', { name: /Choose/ }).click();
await page.locator('input[value=obsidian]').check();
await page.locator('#consent').check();
await page.locator('#chooseNext').click();
await page.locator('#browseVault').click();
await page.getByRole('button', { name: /Research Vault/ }).click();
await page.locator('#chooseFolder').click();
await page.locator('#locationNext').click();
await page.locator('#fixtureState').selectOption('success');
await page.locator('#runCheck').click();
await page.locator('#toSample').click();
await page.locator('#createSample').click();
await expectFocus(page, '#sampleStatus h3', 'validated fixture status');
assert.match(await page.locator('#sampleStatus').innerText(), /Authority fixture sequence: 10.*projection acknowledged sequence: 10.*lag: 0.*no real operation/);
assert.equal(await page.locator('#revealNote').isEnabled(), true);
await page.locator('#retrievalButton').click();
await expectFocus(page, '#retrievalResult', 'bounded retrieval result');
assert.match(await page.locator('#retrievalResult').innerText(), /1 item.*512 bytes.*1 ms/);
assert.match(await page.locator('#retrievalResult').innerText(), /Why matched: exact phrase/);
assert.match(await page.locator('#retrievalResult').innerText(), /Memory is data, not instructions/i);
await page.locator('#toManage').click();

await page.locator('#editMemory').click();
await expectFocus(page, '#editText', 'correction dialog');
await page.locator('#editText').fill(correctionFixture.body);
await page.locator('#saveEdit').click();
assert.equal(await page.locator('#memoryText').textContent(), correctionFixture.body);
assert.match(await page.locator('#memoryCard .tag').textContent(), /correction behavior preview.*revision 2/);
await page.locator('#exportButton').click();
assert.match(await page.locator('#toast').textContent(), /baseline export response.*deterministic.*zero credentials.*not encrypted/i);
await page.locator('#forgetMemory').click();
assert.match(await page.locator('#forgetDialog').innerText(), /1 derived record, 0 events/i);
await page.locator('#confirmForget').click();
assert.match(await page.locator('#memoryCard').innerText(), /Expected production behavior: default retrieval returns 0 items/);
assert.match(await page.locator('#memoryCard').innerText(), /No data changed here/);
await page.locator('#disconnectButton').click();
assert.match(await page.locator('#disconnectDialog').innerText(), /Disconnect removes only local Obsidian sink configuration/i);
await page.locator('#eraseData').check();
await page.locator('#confirmDisconnect').click();
assert.match(await page.locator('#connectedCopy').textContent(), /Obsidian erase\/disconnect preview/);
assert.match(await page.locator('#connectedCopy').textContent(), /11 manifest-listed fixture files.*nothing changed/);
await page.screenshot({ path: join(shotDir, 'memory-setup-manage-desktop-1440x1100.png'), fullPage: true });
assert.deepEqual(await storageSnapshot(page), { local: [], session: [], cookie: '', indexedDb: [], caches: [] });
await assertClean(desktop, 'desktop-flow');

// Changing a fixture invalidates downstream evidence and returns to preflight.
await page.locator('#fixtureState').selectOption('conflict');
await expectFocus(page, '#stepTitle', 'fixture invalidation transition');
assert.equal(await page.locator('.panel[data-panel="3"]').isVisible(), true);
assert.equal(await page.locator('#toSample').isDisabled(), true);
assert.equal(await page.locator('#toManage').isDisabled(), true);
assert.equal(await page.locator('.step[data-step="4"]').isDisabled(), true);
assert.equal(await page.locator('.step[data-step="5"]').isDisabled(), true);
assert.match(await page.locator('#memoryCard .tag').textContent(), /active revision 1/);
assert.equal(await page.locator('#memoryText').textContent(), retrievalFixture.items[0].record.body);
assert.equal(await page.locator('#memoryCard .memory-actions').getAttribute('hidden'), null);

// Native controls, focus visibility, Escape, and keyboard progress.
await page.getByRole('button', { name: /Choose/ }).click();
await page.locator('input[value=obsidian]').focus();
await page.keyboard.press('Space');
assert.equal(await page.locator('input[value=obsidian]').isChecked(), true);
const focusStyle = await page.locator('input[value=obsidian]').evaluate((element) => getComputedStyle(element.closest('.choice')).outlineWidth);
assert.equal(focusStyle, '4px');
await page.locator('#consent').check();
await page.locator('#chooseNext').click();
await page.locator('#browseVault').click();
assert.equal(await page.getByRole('dialog', { name: 'Simulated OS folder picker' }).isVisible(), true);
await page.keyboard.press('Escape');
assert.equal(await page.getByRole('dialog', { name: 'Simulated OS folder picker' }).isVisible(), false);

for (const [foreground, background, minimum, label] of [
  ['121411', 'fffdf4', 7, 'ink/surface'],
  ['625f55', 'fffdf4', 4.5, 'muted/surface'],
  ['2746da', 'f3efdf', 3, 'focus/paper'],
  ['8d2118', 'fffdf4', 4.5, 'danger/surface']
]) assert.ok(contrast(foreground, background) >= minimum, `${label} contrast too low`);
results.push('Contrast: ink, muted copy, focus, and danger tokens meet their asserted WCAG thresholds');
await desktop.context.close();

const reduced = await openPage(390, 844, 'reduce');
assert.equal(await reduced.page.locator('.mark').evaluate((element) => getComputedStyle(element).transform), 'none');
assert.equal(await reduced.page.locator('html').evaluate((element) => getComputedStyle(element).scrollBehavior), 'auto');
await assertClean(reduced, 'reduced-motion');
results.push('Reduced motion: decorative transform removed and smooth scrolling disabled');
await reduced.context.close();

const zoomed = await openPage(1440, 1100);
const cdp = await zoomed.context.newCDPSession(zoomed.page);
await cdp.send('Emulation.setPageScaleFactor', { pageScaleFactor: 2 });
const zoomMetrics = await zoomed.page.evaluate(() => ({
  visualWidth: visualViewport.width,
  overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth
}));
assert.ok(zoomMetrics.visualWidth <= 721, `200% browser scale did not reduce visual viewport: ${zoomMetrics.visualWidth}`);
assert.ok(zoomMetrics.overflow <= 1, `200% browser scale introduced document overflow: ${zoomMetrics.overflow}`);
await assertClean(zoomed, '200%-scale');
results.push(`200% browser scale: visual viewport ${zoomMetrics.visualWidth}px, document overflow ${zoomMetrics.overflow}px`);
await zoomed.context.close();

const sources = `${await readFile(join(here, 'index.html'), 'utf8')}\n${await readFile(join(here, 'app.js'), 'utf8')}`;
for (const forbidden of [
  /localStorage\s*\.(?:setItem|getItem)/,
  /sessionStorage\s*\.(?:setItem|getItem)/,
  /fetch\s*\(/,
  /XMLHttpRequest/,
  /WebSocket\s*\(/,
  /https?:\/\/(?!127\.0\.0\.1:8787)/,
  /accept any certificate/i,
  /end-to-end encrypted|\bE2EE\b/i,
  /production adapter (?:is|ships|available)/i
]) assert.doesNotMatch(sources, forbidden, `forbidden prototype surface: ${forbidden}`);
assert.match(sources, /not deployed/i);
assert.match(sources, /SQLite remains authoritative/i);
results.push('Static boundary: no persistence/network APIs, arbitrary remote URL, encryption/E2EE promise, or production-adapter claim');

await browser.close();
console.log(results.join('\n'));
