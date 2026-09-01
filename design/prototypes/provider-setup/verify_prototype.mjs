import { chromium } from 'playwright';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  try {
    const resolved = path.resolve(ROOT, file);
    if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== path.join(ROOT, 'index.html')) throw new Error('outside root');
    res.writeHead(200, {'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream'});
    res.end(await fs.readFile(resolved));
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const origin = new URL(url).origin;
const browser = await chromium.launch({headless: true});
const context = await browser.newContext();
const page = await context.newPage();
const requests = [];
const errors = [];
page.on('request', request => requests.push({method: request.method(), url: request.url(), headers: request.headers(), body: request.postData() || ''}));
page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
page.on('pageerror', error => errors.push(error.message));

const resultHidden = () => page.locator('#test-result').isHidden();
const saveDisabled = () => page.locator('#save-button').isDisabled();
const profileHidden = () => page.locator('#profile').isHidden();
const chooseFixture = state => page.locator('#demo-state').selectOption(state);
const assertInvalidated = async label => {
  assert.equal(await resultHidden(), true, `${label} must hide the obsolete result`);
  assert.equal(await saveDisabled(), true, `${label} must require a new current-draft test`);
};
const reload = async () => {
  await page.goto(url);
  await page.evaluate(() => { localStorage.clear(); sessionStorage.clear(); });
  await page.reload();
};

try {
  await reload();

  // Truthful startup: no result, no saved/active preview, and no save eligibility.
  assert.equal(await page.locator('#demo-state').inputValue(), 'default');
  assert.equal(await resultHidden(), true);
  assert.equal(await profileHidden(), true);
  assert.equal(await saveDisabled(), true);
  assert.equal((await page.locator('body').innerText()).includes('Active · tested'), false);

  // Visible provider/capability choices stay within the frozen main contracts.
  assert.deepEqual(await page.locator('input[name="provider"]').evaluateAll(inputs => inputs.map(input => input.value)), ['lmstudio', 'ollama', 'openai-cloud', 'anthropic']);
  assert.equal(await page.locator('#endpoint').isEditable(), false, 'adapter-owned endpoint must not become an arbitrary URL input');
  assert.match(await page.locator('.capability').innerText(), /required model capability\s+chat/i);
  assert.match(await page.locator('.capability').innerText(), /cancellation.+local runtime/i);

  // A delayed test belongs to one immutable draft token and cannot bless a changed draft.
  await page.locator('#test-button').click();
  assert.match(await page.locator('#result-title').textContent(), /testing connection/i);
  await page.locator('input[name="provider"][value="ollama"]').check();
  await page.waitForTimeout(850);
  await assertInvalidated('provider change during delayed test');

  // Every test-relevant input invalidates a successful result and saved eligibility.
  const cases = [
    ['path', async () => page.locator('input[name="path"][value="cloud"]').check()],
    ['provider', async () => page.locator('input[name="provider"][value="ollama"]').check()],
    ['model', async () => page.locator('#model').selectOption('discover')],
    ['key requirement', async () => page.locator('#needs-local-key').check()],
    ['key', async () => { await page.locator('#needs-local-key').check(); await chooseFixture('success'); await page.locator('#provider-key').fill('changed-key'); }],
    ['cloud acknowledgment', async () => { await page.locator('input[name="path"][value="cloud"]').check(); await page.locator('#provider-key').fill('fixture-key'); await page.locator('#cloud-ack').check(); await chooseFixture('success'); await page.locator('#cloud-ack').uncheck(); }]
  ];
  for (const [label, mutate] of cases) {
    await reload();
    await chooseFixture('success');
    assert.equal(await saveDisabled(), false, `${label} setup must begin eligible`);
    await mutate();
    await assertInvalidated(label);
  }

  // Submitting without a successful test for the current draft cannot save or fabricate success.
  await reload();
  await page.locator('#setup-form').evaluate(form => form.requestSubmit());
  assert.equal(await profileHidden(), true);
  assert.equal(await saveDisabled(), true);
  assert.match(await page.locator('#result-title').textContent(), /test current draft/i);

  // Explicit success fixture marks exactly the current revision; only then can save activate it.
  await reload();
  await chooseFixture('success');
  assert.equal(await saveDisabled(), false);
  await page.locator('#save-button').click();
  assert.equal(await profileHidden(), false);
  assert.match(await page.locator('#profile-status').textContent(), /active · tested/i);
  assert.equal(await page.locator('#profile-model').textContent(), 'qwen/qwen3.6-35b-a3b');

  // Every displayed failure fixture stays non-saveable and identifies its recovery state.
  for (const [fixture, title] of [['invalid-key', /key was not accepted/i], ['model-unavailable', /model unavailable/i], ['offline', /local server offline/i]]) {
    await reload();
    await chooseFixture(fixture);
    assert.equal(await saveDisabled(), true, `${fixture} cannot grant save eligibility`);
    assert.equal(await profileHidden(), true, `${fixture} cannot create a profile preview`);
    assert.match(await page.locator('#result-title').textContent(), title);
  }

  // Capability-limitation fixture is saveable only because its copy explicitly claims safe deterministic fallbacks.
  await reload();
  await chooseFixture('limited');
  assert.equal(await saveDisabled(), false);
  assert.match(await page.locator('#result-title').textContent(), /connected with limitations/i);

  // Cloud labels remain truthful, and sensitive draft state is cleared across provider paths.
  await reload();
  await page.locator('input[name="path"][value="cloud"]').check();
  assert.equal(await page.locator('#endpoint-label').textContent(), 'Provider definition');
  assert.equal(await page.locator('#key-label').textContent(), 'Provider API key');
  await page.locator('#provider-key').fill('discard-on-path-change');
  await page.locator('#cloud-ack').check();
  await page.locator('input[name="path"][value="local"]').check();
  assert.equal(await page.locator('#provider-key').inputValue(), '');
  assert.equal(await page.locator('#needs-local-key').isChecked(), false);
  assert.equal(await page.locator('#key-field').isHidden(), true);

  // Neither local nor cloud default test controls can invent provider success in this offline prototype.
  for (const pathValue of ['local', 'cloud']) {
    await reload();
    if (pathValue === 'cloud') await page.locator('input[name="path"][value="cloud"]').check();
    await page.locator('#test-button').click();
    await page.waitForTimeout(850);
    assert.equal(await saveDisabled(), true, `${pathValue} test cannot fabricate success`);
    assert.match(await page.locator('#result-title').textContent(), /prototype cannot test connections/i);
  }

  // Secret sentinel remains only in the password control: no rendering, storage, or request data.
  const sentinel = 'SENTINEL_PROVIDER_KEY_7391';
  await reload();
  await page.locator('input[name="path"][value="cloud"]').check();
  await page.locator('#provider-key').fill(sentinel);
  await page.locator('#cloud-ack').check();
  await chooseFixture('success');
  await page.locator('#save-button').click();
  assert.equal((await page.locator('body').innerText()).includes(sentinel), false);
  assert.deepEqual(await page.evaluate(async () => ({
    local: {...localStorage},
    session: {...sessionStorage},
    cookie: document.cookie,
    indexedDB: 'databases' in indexedDB ? (await indexedDB.databases()).map(database => database.name) : [],
    caches: 'caches' in window ? await caches.keys() : []
  })), {local: {}, session: {}, cookie: '', indexedDB: [], caches: []});
  assert.equal(JSON.stringify(requests).includes(sentinel), false, 'sentinel must not enter a request URL, headers, or body');
  assert.deepEqual([...new Set(requests.map(request => new URL(request.url).origin).filter(requestOrigin => requestOrigin !== origin))], []);
  assert.deepEqual([...new Set(requests.map(request => request.method).filter(method => method !== 'GET'))], []);

  // Refresh truthful default screenshots and check documented responsive geometry/targets.
  await reload();
  await fs.mkdir(path.join(ROOT, 'screenshots'), {recursive: true});
  for (const [width, height, name] of [[320, 844, null], [390, 844, 'provider-setup-mobile-390x844.png'], [760, 900, null], [1050, 900, null], [1440, 1100, 'provider-setup-desktop-1440x1100.png']]) {
    await page.setViewportSize({width, height});
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px horizontal overflow`);
    const undersized = await page.locator('button, select, input:not([type="radio"]):not([type="checkbox"]), label.toggle, label.choice').evaluateAll(controls => controls.filter(control => {
      const style = getComputedStyle(control);
      const bounds = control.getBoundingClientRect();
      if (style.display === 'none' || style.visibility === 'hidden' || control.closest('[hidden]') || bounds.width === 0 || bounds.height === 0) return false;
      return bounds.height < 44;
    }).map(control => control.id || control.outerHTML.slice(0, 80)));
    assert.deepEqual(undersized, [], `${width}px visible controls and checkbox labels must be at least 44px high`);
    if (name) await page.screenshot({path: path.join(ROOT, 'screenshots', name), fullPage: true});
  }

  // Native dialog keyboard cancellation is nondestructive and restores focus.
  await reload();
  await chooseFixture('success');
  await page.locator('#save-button').click();
  await page.locator('#disable-button').click();
  assert.match(await page.locator('#profile-status').textContent(), /disabled · no calls/i);
  await page.locator('#disable-button').click();
  assert.match(await page.locator('#profile-status').textContent(), /active · tested/i);
  await page.locator('#delete-button').click();
  assert.equal(await page.locator('#delete-dialog').getAttribute('open'), '');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'keep-button');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'confirm-delete');
  await page.keyboard.press('Shift+Tab');
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'keep-button');
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#delete-dialog').getAttribute('open'), null);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'delete-button');
  await page.locator('#delete-button').click();
  await page.locator('#confirm-delete').click();
  assert.equal(await profileHidden(), true);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'test-button');

  assert.deepEqual(errors, [], `console/page errors: ${errors}`);
  console.log('PASS truthful default, stale delayed result, and every current-draft invalidation');
  console.log('PASS exact-revision save gate, failure states, and no fabricated local/cloud success');
  console.log('PASS no key rendering/storage/network; origin-only GETs; desktop/mobile screenshots refreshed');
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
