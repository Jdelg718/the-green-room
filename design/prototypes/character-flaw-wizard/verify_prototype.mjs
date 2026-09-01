import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer(async (request, response) => {
  const pathname = new URL(request.url, 'http://local').pathname;
  const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
  try {
    const resolved = path.resolve(ROOT, relative);
    if (!resolved.startsWith(`${ROOT}${path.sep}`)) throw new Error('outside prototype');
    const type = relative.endsWith('.html') ? 'text/html; charset=utf-8' : relative.endsWith('.js') ? 'text/javascript; charset=utf-8' : 'application/octet-stream';
    response.writeHead(200, {'content-type':type, 'cache-control':'no-store'});
    response.end(await fs.readFile(resolved));
  } catch {
    response.writeHead(404); response.end('not found');
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const origin = new URL(url).origin;
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({acceptDownloads:true});

// Any browser persistence or client-initiated network API use fails the test immediately.
await context.addInitScript(() => {
  const blocked = (name) => () => { throw new Error(`PROHIBITED_API:${name}`); };
  for (const name of ['localStorage','sessionStorage','indexedDB','caches']) {
    try { Object.defineProperty(window, name, {configurable:true, get:blocked(name)}); } catch {}
  }
  try { Object.defineProperty(Document.prototype, 'cookie', {configurable:true, get:blocked('cookie.get'), set:blocked('cookie.set')}); } catch {}
  try { Object.defineProperty(navigator, 'serviceWorker', {configurable:true, get:blocked('serviceWorker')}); } catch {}
  window.fetch = blocked('fetch');
  window.XMLHttpRequest = class { constructor(){ throw new Error('PROHIBITED_API:XMLHttpRequest'); } };
  window.WebSocket = class { constructor(){ throw new Error('PROHIBITED_API:WebSocket'); } };
  navigator.sendBeacon = blocked('sendBeacon');
});

const page = await context.newPage();
const consoleErrors = [], pageErrors = [], failedRequests = [], requests = [], downloads = [];
page.on('console', (message) => { if (message.type() === 'error') consoleErrors.push(message.text()); });
page.on('pageerror', (error) => pageErrors.push(error.message));
page.on('requestfailed', (request) => failedRequests.push(request.url()));
page.on('request', (request) => requests.push(request.url()));
page.on('download', (download) => downloads.push(download.suggestedFilename()));
const go = async (step) => page.locator(`[data-step="${step}"]`).evaluate((button) => button.click());
const bodyText = () => page.locator('body').textContent();

try {
  await page.goto(url, {waitUntil:'load'});
  assert.equal(await page.title(), 'Original Character Workshop — The Green Room');
  assert.match(await page.locator('.privacy').textContent(), /in this tab's memory only.+no browser storage.+external requests.+provider keys.+transcripts.+room memory/is);
  assert.match(await page.locator('.panel').textContent(), /original first.+only authoring path.+researched historical character.+prebuilt.+source-informed educational interpretation.+provenance.+rights.+fidelity.+exact-version review.+does not improvise or approve/is);

  // Empty rehearsal state becomes a deterministic, explicit rehearsal state.
  await go(5);
  assert.match(await page.locator('#rehearsalResult').textContent(), /no rehearsal selected/i);
  await page.locator('[data-scenario="novelty"]').click();
  assert.match(await page.locator('#rehearsalResult').textContent(), /clever exception.+trigger.+temptation.+tell.+consequence.+recovery/is);
  assert.equal(await page.evaluate(() => document.activeElement?.id), 'rehearsalResult');
  await page.locator('[data-scenario="blocked"]').click();
  assert.match(await page.locator('#rehearsalResult').textContent(), /cannot reproduce a living performer.+copied dialogue.+original qualities/is);

  // Canonical file paths, roles, optionality, and model visibility are explicit.
  await go(6);
  const expected = {
    'persona.yaml':['manifest','false','true'],
    'AGENTS.md':['runtime.agents','true','true'],
    'BACKGROUND.md':['runtime.background','true','true'],
    'VOICE.md':['runtime.voice','true','true'],
    'RELATIONSHIPS.md':['runtime.relationships','true','true'],
    'SCENARIOS.md':['runtime.scenarios','true','true'],
    'PROVENANCE.md':['metadata.provenance','false','true'],
    'SOURCES.md':['metadata.sources','false','false'],
    'LICENSE':['metadata.license','false','true'],
    'assets/':['asset','false','false']
  };
  for (const [name,[role,visible,present]] of Object.entries(expected)) {
    const card = page.locator(`[data-file="${name}"]`);
    assert.equal(await card.count(), 1, `${name} appears exactly once`);
    assert.equal(await card.getAttribute('data-role'), role, `${name} role`);
    assert.equal(await card.getAttribute('data-model-visible'), visible, `${name} visibility`);
    assert.equal(await card.getAttribute('data-present'), present, `${name} presence`);
  }
  assert.match(await page.locator('[data-file="persona.yaml"] pre').textContent(), /schema_version: "0.1".+identity:.+type: "original".+external_tools: false.+assets: \{\}/is);
  assert.match(await page.locator('[data-file="AGENTS.md"] pre').textContent(), /core drive and fear.+virtue and shadow.+flaw under pressure.+recovery.+use no shell.+never weaken/is);
  assert.match(await page.locator('.review-grid').textContent(), /deterministic \.greenroom bytes.+greenroom-persona.+cannot produce or download a valid archive/is);
  assert.match(await page.locator('.review-grid').textContent(), /AGENTS\.md → BACKGROUND\.md → VOICE\.md/is);
  assert.equal(await page.locator('a[download], button:has-text("Export"), button:has-text("Download")').count(), 0, 'prototype exposes no fake archive download');

  // Current check is invalidated when any draft input changes.
  await page.locator('#runChecks').click();
  assert.equal(await page.locator('#checkState').getAttribute('data-check-current'), 'true');
  assert.match(await page.locator('#checkState').textContent(), /not a valid archive.+installed pack.+Official Catalog/is);
  await go(0); await page.locator('#purpose').fill('Help a group expose one assumption before choosing a reversible next step.');
  await go(6);
  assert.equal(await page.locator('#checkState').getAttribute('data-check-current'), 'false');
  assert.match(await page.locator('#checkState').textContent(), /draft changed since checks.+stale result cannot authorize handoff/is);

  // Secret-shaped values are blocked before exact, case-folded, or slug-derived forms render.
  const secret = 'sk-AbCdEfGhIjKlMnOpQrStUvWxYz012345';
  const foldedSecret = secret.toLowerCase();
  const sluggedSecret = foldedSecret.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  await go(0);
  await page.locator('#purpose').fill(`Use credential ${secret} to act.`);
  await go(1);
  await page.locator('#name').fill(secret);
  await go(6);
  const renderedBody = (await bodyText()).toLowerCase();
  const renderedFiles = (await page.locator('.file-grid').textContent()).toLowerCase();
  assert.equal(renderedBody.includes(foldedSecret), false, 'case-folded secret absent from rendered text');
  assert.equal(renderedFiles.includes(foldedSecret), false, 'case-folded secret absent from every file preview');
  assert.equal(renderedFiles.includes(sluggedSecret), false, 'slug-derived secret absent from every file preview');
  assert.match(await page.locator('[data-file="persona.yaml"] pre').textContent(), /id: "local\.greenroom\.redacted-sensitive-value\.prototype"/);
  await page.locator('#runChecks').click();
  assert.match(await page.locator('#checkState').textContent(), /blockers found.+secret-shaped value was redacted/is);
  assert.equal((await page.locator('.file-grid').textContent()).toLowerCase().includes(foldedSecret), false, 'secret remains absent after validation');

  // Protected-character/voice request is narrowed and blocked without external tooling.
  await go(3); await page.locator('#voiceNotes').fill('Sound exactly like a living actor and copy their best-known lines.');
  await go(6); await page.locator('#runChecks').click();
  assert.match(await page.locator('#checkState').textContent(), /replace protected-character.+performer-voice.+copied-dialogue/is);

  // Refresh proves the prototype has no browser-persistent draft.
  await page.reload({waitUntil:'load'});
  await go(0);
  assert.equal(await page.locator('#purpose').inputValue(), 'Help a group turn vague disagreement into one clear, reversible next move.');
  await go(3);
  assert.match(await page.locator('#voiceNotes').inputValue(), /Short sentences.+catchphrases/i);

  // Five trust states are distinct and only private draft is current.
  await go(7);
  const statuses = ['Private draft','Local installed','Community submitted','Community reviewed','Official Catalog'];
  assert.equal(await page.locator('[data-status]').count(), 5);
  for (const status of statuses) assert.equal(await page.locator(`[data-status="${status}"]`).count(), 1, `${status} shown`);
  assert.equal(await page.locator('[data-status][data-current="true"]').getAttribute('data-status'), 'Private draft');
  assert.match(await page.locator('[data-status="Private draft"]').textContent(), /current.+unvalidated.+not saved.+not installed/is);
  assert.match(await page.locator('[data-status="Local installed"]').textContent(), /unavailable.+greenroom-persona-approved.+not endorsement/is);
  assert.match(await page.locator('[data-status="Community submitted"]').textContent(), /unavailable.+separate deliberate submission.+not reviewed/is);
  assert.match(await page.locator('[data-status="Community reviewed"]').textContent(), /unavailable.+independent.+not Official/is);
  assert.match(await page.locator('[data-status="Official Catalog"]').textContent(), /unavailable.+version\/digest-specific.+No manifest exists/is);
  assert.match(await page.locator('.panel').textContent(), /no save, install, export, upload, submit, review, approval, publish, or network action/is);
  await page.locator('#handoff').click();
  assert.match(await page.locator('#handoffResult').textContent(), /contract reviewed—not executed.+no storage.+network action/is);
  assert.equal(await downloads.length, 0);

  // Keyboard focus and skip behavior.
  await page.locator('.skip').focus();
  assert.equal(await page.locator('.skip').evaluate((element) => getComputedStyle(element).left), '10px');
  await page.keyboard.press('Enter');
  assert.equal(await page.evaluate(() => document.activeElement.id), 'main');
  await go(0); await page.locator('#next').focus(); await page.keyboard.press('Enter');
  assert.equal(await page.locator('[data-step="1"]').getAttribute('aria-current'), 'step');
  assert.equal(await page.locator('h3').evaluate((element) => document.activeElement === element), true);

  // Required responsive widths: no overflow and at least 44 px for actionable controls.
  await fs.mkdir(path.join(ROOT, 'screenshots'), {recursive:true});
  for (const [width,height] of [[1440,1100],[800,900],[390,844],[320,720]]) {
    await page.setViewportSize({width,height});
    for (let step = 0; step < 8; step += 1) {
      await go(step);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px step ${step} has no horizontal overflow`);
      const small = await page.locator('button,input:not([type="range"]):not([type="checkbox"]):not([type="radio"]),select,textarea,label.choice').evaluateAll((nodes) => nodes.filter((element) => {
        const box = element.getBoundingClientRect(); return box.width && box.height && (box.width < 44 || box.height < 44);
      }).map((element) => `${element.tagName}.${element.className}:${Math.round(element.getBoundingClientRect().width)}x${Math.round(element.getBoundingClientRect().height)}`));
      assert.deepEqual(small, [], `${width}px step ${step} small targets: ${small}`);
      for (let index = 0; index < 8; index += 1) {
        assert.match(await page.locator(`[data-step="${index}"]`).getAttribute('aria-label'), new RegExp(`^Step ${index+1}: .+`), `${width}px step ${index} has a meaningful accessible name`);
      }
    }
  }

  // Fresh text-only screenshot evidence.
  await page.reload({waitUntil:'load'});
  await page.setViewportSize({width:1440,height:1100}); await go(0); await page.screenshot({path:path.join(ROOT,'screenshots','desktop-1440-gray-flaw-activated.png'),fullPage:true});
  await page.setViewportSize({width:1440,height:1100}); await go(6); await page.locator('#runChecks').click(); await page.locator('#toast').evaluate((element) => { element.hidden = true; });
  await page.screenshot({path:path.join(ROOT,'screenshots','desktop-1440-pack-review.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844}); await go(2); await page.locator('#toast').evaluate((element) => { element.hidden = true; });
  await page.screenshot({path:path.join(ROOT,'screenshots','mobile-390-flaw-program.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844}); await go(5); await page.locator('[data-scenario="novelty"]').click(); await page.locator('#toast').evaluate((element) => { element.hidden = true; });
  await page.screenshot({path:path.join(ROOT,'screenshots','mobile-390-rehearsal.png'),fullPage:true});
  await page.setViewportSize({width:320,height:720}); await go(6); await page.locator('#toast').evaluate((element) => { element.hidden = true; });
  await page.screenshot({path:path.join(ROOT,'screenshots','mobile-320-files-export.png'),fullPage:true});
  await page.setViewportSize({width:320,height:720}); await go(7); await page.locator('#toast').evaluate((element) => { element.hidden = true; });
  await page.screenshot({path:path.join(ROOT,'screenshots','mobile-320-status-handoff.png'),fullPage:true});

  // Reduced motion is honored.
  const reduced = await browser.newContext({reducedMotion:'reduce'});
  await reduced.addInitScript(() => {
    for (const name of ['localStorage','sessionStorage','indexedDB','caches']) try { Object.defineProperty(window,name,{configurable:true,get(){throw new Error(`PROHIBITED_API:${name}`);}}); } catch {}
  });
  const reducedPage = await reduced.newPage(); await reducedPage.goto(url);
  assert.equal(await reducedPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.equal(await reducedPage.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
  await reduced.close();

  assert.deepEqual(await context.cookies(), [], 'no cookies created');
  assert.deepEqual(consoleErrors, [], `console errors: ${consoleErrors}`);
  assert.deepEqual(pageErrors, [], `page errors: ${pageErrors}`);
  assert.deepEqual(failedRequests, [], `failed requests: ${failedRequests}`);
  assert.deepEqual([...new Set(requests.map((requestUrl) => new URL(requestUrl).origin).filter((requestOrigin) => requestOrigin !== origin))], [], `external origins: ${requests}`);
  assert.deepEqual(downloads, [], 'no downloads initiated');

  console.log('PASS 1/8 in-memory-only: storage, cookies, service workers, caches, downloads, and client network APIs prohibited');
  console.log('PASS 2/8 canonical pack review: 10 paths/roles, optionality, model visibility, and fixed runtime order');
  console.log('PASS 3/8 preview-check currency invalidates after draft mutation');
  console.log('PASS 4/8 secret and protected-character/voice inputs are blocked without rendering secrets');
  console.log('PASS 5/8 five lifecycle/trust states are distinct and status-honest');
  console.log('PASS 6/8 empty, rehearsal, boundary, blocker, stale, and handoff states exercised');
  console.log('PASS 7/8 all 8 steps at 1440/800/390/320: no overflow, 44px controls, and named navigation');
  console.log('PASS 8/8 keyboard focus, refresh discard, reduced motion, and screenshots');
} finally {
  await browser.close();
  await new Promise((resolve) => server.close(resolve));
}
