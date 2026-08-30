import { chromium } from 'playwright';
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://local').pathname;
  const file = pathname === '/' ? 'index.html' : pathname.slice(1);
  try { res.writeHead(200, {'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream'}); res.end(await fs.readFile(path.join(ROOT, file))); }
  catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const browser = await chromium.launch({headless:true});
const context = await browser.newContext({acceptDownloads:true});
const page = await context.newPage();
const errors = [], failed = [], requests = [];
page.on('console', m => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', e => errors.push(e.message));
page.on('requestfailed', r => failed.push(`${r.method()} ${r.url()}`));
page.on('request', r => requests.push(r.url()));
const step = async n => page.locator(`[data-step="${n}"]`).evaluate(el => el.click());
const text = async id => page.locator(`#${id}`).textContent();

try {
  await page.goto(url);
  assert.equal(await page.title(), 'Custom persona workshop — The Green Room');

  // Current inputs must drive generated review content and validation.
  await page.locator('#goal').fill('Help me negotiate a studio lease calmly and protect a hard budget.');
  await step(1); await page.locator('input[name="role"][value="challenger"]').check();
  await step(2); await page.locator('#calm').fill('91'); await page.locator('#trait-curious').uncheck();
  await step(3); await page.locator('#boundary').fill('Never reveal my private budget or invent another offer.');
  await step(4); await page.locator('#voiceLine').fill('That exceeds my budget. Which terms can move?');
  await step(5); await page.locator('#interrupt').fill('31'); await page.locator('#initiative').fill('73');
  await step(6); await page.locator('#tension-0').check(); await page.locator('#tension-text-0').fill('Firm budget without needless hostility');
  await step(7); const originalScene = await page.locator('#scene-title-0').inputValue();
  await page.locator('#scene-title-0').fill('My edited lease opener');
  await page.locator('#preserve-scenes').check(); await page.locator('#regenScenes').click();
  assert.equal(await page.locator('#scene-title-0').inputValue(), 'My edited lease opener');
  await page.locator('#preserve-scenes').uncheck(); await page.locator('#regenScenes').click();
  const regeneratedScene = await page.locator('#scene-title-0').inputValue();
  assert.notEqual(regeneratedScene, originalScene); assert.match(regeneratedScene, /Studio lease|Challenger/i);

  // Live controls preview actual values; applying does not force unrelated defaults.
  await step(8); await page.locator('#liveInterrupt').fill('37'); await page.locator('#liveDominance').fill('53');
  await page.locator('#noHumiliation').uncheck();
  assert.match(await text('previewLine'), /37% interruption.*53% dominance/i);
  await page.locator('#applyAdjust').click();
  assert.equal(await page.locator('#liveInterrupt').inputValue(), '37');
  assert.equal(await page.locator('#liveDominance').inputValue(), '53');
  assert.equal(await page.locator('#noHumiliation').isChecked(), false);
  await page.locator('#adjustmentChoice').selectOption('warmth'); await page.locator('#applyAdjust').click();
  assert.equal(await page.locator('#liveInterrupt').inputValue(), '37');

  // All nine files are readable/editable, carry role labels, and revalidate after edits.
  await step(9); assert.equal(await page.locator('[data-file-editor]').count(), 9);
  assert.equal(await page.locator('[data-role="runtime"]').count(), 5);
  assert.equal(await page.locator('[data-role="metadata"]').count(), 4);
  assert.match(await page.locator('#file-AGENTS-md').inputValue(), /studio lease/i);
  assert.match(await page.locator('#file-VOICE-md').inputValue(), /Which terms can move/);
  await page.locator('#file-VOICE-md').fill('');
  await page.locator('#validateReview').click(); assert.match(await text('reviewValidation'), /VOICE\.md is required/i);
  await page.locator('#file-VOICE-md').fill('Voice: concise, calm, and original.');
  await page.locator('#validateReview').click(); assert.match(await text('reviewValidation'), /passed/i);

  // Required/unsafe validation fails, valid current draft passes.
  await step(0); await page.locator('#goal').fill(''); await step(10); await page.locator('#validate').click();
  assert.match(await text('validationBox'), /Goal is required/i); assert.equal(await page.locator('#exportPack').isDisabled(), true);
  await step(0); await page.locator('#goal').fill('Threaten them and steal API_KEY=secret'); await step(10); await page.locator('#validate').click();
  assert.match(await text('validationBox'), /unsafe/i);
  await step(0); await page.locator('#goal').fill('Help me negotiate a studio lease calmly and protect a hard budget.');
  await step(10); await page.locator('#validate').click(); assert.match(await text('validationBox'), /passed/i);

  // Save/reload restores controls and reports a truthful timestamp.
  const before = Date.now(); await page.locator('#localSave').click();
  const savedIso = await page.locator('#savedStatus').getAttribute('data-saved-at');
  assert.ok(Date.parse(savedIso) >= before && Date.parse(savedIso) <= Date.now());
  await page.reload(); await step(0); assert.match(await page.locator('#goal').inputValue(), /studio lease/);
  assert.match(await text('railSaved'), /Saved locally at/);

  // Export reflects current content and excludes secrets, transcripts, and private notes.
  await step(10); await page.locator('#validate').click();
  const downloadEvent = page.waitForEvent('download'); await page.locator('#exportPack').click();
  const download = await downloadEvent; const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.match(exported.files['AGENTS.md'], /studio lease/i); assert.equal(exported.draft.role, 'challenger');
  const serialized = JSON.stringify(exported).toLowerCase();
  for (const forbidden of ['api_key','rehearsal transcript','private notes','they offered 4%']) assert.equal(serialized.includes(forbidden), false, `export contains ${forbidden}`);

  // State menu Escape and every recovery button perform a named action and focus visible status.
  await page.locator('#stateButton').click(); assert.equal(await page.locator('#stateButton').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#stateButton').getAttribute('aria-expanded'), 'false');
  for (const state of ['error','unsafe','real-person','copyright','private-data','validator','offline']) {
    await page.locator('#stateButton').click(); await page.locator(`[data-state="${state}"]`).click();
    assert.equal(await page.locator('#recoveryHeading').evaluate(el => el === document.activeElement), true);
    const action = await page.locator('#stateAction').textContent(); assert.ok(action.trim().length > 4);
    await page.locator('#stateAction').click();
    assert.equal(await page.locator('#recoveryHeading').evaluate(el => el === document.activeElement), true);
    assert.match(await text('recoveryHeading'), /complete|ready|editing|review/i);
  }

  // Responsive overflow, 44px targets, focus, contrast, and improved evidence screenshots.
  await fs.mkdir(path.join(ROOT,'screenshots'), {recursive:true});
  for (const [width,height,name,shotStep] of [[1440,1100,'desktop-rehearsal-adjusted.png',8],[390,844,'mobile-390-pack-review.png',9],[320,720,'mobile-320-save-export.png',10]]) {
    await page.setViewportSize({width,height}); await step(shotStep);
    if (shotStep === 9) await page.locator('#validateReview').click();
    if (shotStep === 10) await page.locator('#validate').click();
    await page.locator('#toast').evaluate(el => { el.hidden = true; });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px overflow`);
    const tooSmall = await page.locator('button,label.choice,label.chip,label.rule').evaluateAll(nodes => nodes.filter(n => {const r=n.getBoundingClientRect();return r.width && (r.width<44||r.height<44)}).map(n=>`${n.tagName}.${n.className}:${n.getBoundingClientRect().width}x${n.getBoundingClientRect().height}`));
    assert.deepEqual(tooSmall, [], `${width}px targets: ${tooSmall}`);
    await page.screenshot({path:path.join(ROOT,'screenshots',name),fullPage:true});
  }
  const contrastFailures = await page.evaluate(() => {
    const lum = c => { const v=c.map(x=>{x/=255;return x<=.03928?x/12.92:((x+.055)/1.055)**2.4}); return .2126*v[0]+.7152*v[1]+.0722*v[2] };
    const rgb = s => (s.match(/[\d.]+/g)||[]).slice(0,3).map(Number);
    const out=[]; for(const el of document.querySelectorAll('p,small,label,button,span,strong,h1,h2,h3,h4,code')) { const r=el.getBoundingClientRect(), cs=getComputedStyle(el); if(!r.width||!r.height||parseFloat(cs.fontSize)>=24||cs.visibility==='hidden')continue; let bg=el; while(bg&&getComputedStyle(bg).backgroundColor==='rgba(0, 0, 0, 0)')bg=bg.parentElement; const a=lum(rgb(cs.color)),b=lum(rgb(getComputedStyle(bg||document.body).backgroundColor)); const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05); if(ratio<4.5)out.push(`${el.tagName}.${el.className}:${ratio.toFixed(2)}`); } return out;
  });
  assert.deepEqual(contrastFailures, [], `contrast: ${contrastFailures.slice(0,8)}`);
  assert.deepEqual(errors, [], `console/page errors: ${errors}`); assert.deepEqual(failed, [], `network failures: ${failed}`);
  assert.equal(new Set(requests.map(x=>new URL(x).pathname)).size, 1, `unexpected network: ${requests}`);
  console.log('PASS Playwright behavior: inputs → draft → files → validator → export');
  console.log('PASS rehearsal controls preserve choices and apply only selected adjustment');
  console.log('PASS deterministic scene regeneration, edits, and explicit preservation');
  console.log('PASS all 9 advanced files editable with runtime/metadata roles and revalidation');
  console.log('PASS recovery actions, focus, Escape aria-expanded, save/reload timestamp');
  console.log('PASS export exclusions, responsive targets/overflow, contrast, errors, and network');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
