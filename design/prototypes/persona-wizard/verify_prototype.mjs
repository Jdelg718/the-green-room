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
  try {
    const resolved = path.resolve(ROOT, file);
    if (!resolved.startsWith(`${ROOT}${path.sep}`) && resolved !== path.join(ROOT, 'index.html')) throw new Error('outside root');
    res.writeHead(200, {'content-type': file.endsWith('.html') ? 'text/html' : 'application/octet-stream'});
    res.end(await fs.readFile(resolved));
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}/`;
const origin = new URL(url).origin;
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
const fileValue = async name => page.locator(`#file-${name.replace(/[^a-zA-Z0-9]/g,'-')}`).inputValue();
const scenes = async () => page.locator('[id^="scene-title-"],[id^="scene-body-"]').evaluateAll(nodes => nodes.map(n => n.value));
const openState = async state => { await page.locator('#stateButton').click(); await page.locator(`[data-state="${state}"]`).click(); };
const returnGuided = async () => { await page.locator('#returnGuided').click(); };

try {
  await page.goto(url);
  await page.evaluate(() => localStorage.clear());
  await page.reload();
  assert.equal(await page.title(), 'Custom persona workshop — The Green Room');
  assert.match(await page.locator('.prototype-bar').textContent(), /prototype checks only.+not production validation/i);

  // 1. Advanced review never freezes generated files; only explicit edits become overrides.
  await step(9);
  const initialAgents = await fileValue('AGENTS.md');
  assert.equal(await page.locator('[data-override-indicator]').count(), 0, 'opening Advanced must not dirty files');
  await step(0);
  await page.locator('#goal').fill('Help me negotiate a studio lease calmly and protect a hard budget.');
  await step(9);
  assert.notEqual(await fileValue('AGENTS.md'), initialAgents);
  assert.match(await fileValue('AGENTS.md'), /studio lease/i, 'unmodified AGENTS must regenerate from current goal');
  await page.locator('#file-AGENTS-md').fill('My deliberate AGENTS override');
  assert.equal(await page.locator('[data-override-indicator="AGENTS.md"]').isVisible(), true);
  assert.equal(await page.locator('[data-reset-file="AGENTS.md"]').isVisible(), true);
  await step(0); await page.locator('#goal').fill('Help me negotiate a salary without losing the relationship.'); await step(9);
  assert.equal(await fileValue('AGENTS.md'), 'My deliberate AGENTS override', 'explicit override must survive regeneration');
  await page.locator('[data-reset-file="AGENTS.md"]').click();
  assert.match(await fileValue('AGENTS.md'), /salary/i, 'reset must restore current deterministic generation');
  assert.equal(await page.locator('[data-override-indicator="AGENTS.md"]').count(), 0);

  // 2. Every requested posture and turn-discipline control maps visibly and exactly.
  await step(2);
  for (const [id, value, expected] of [['direct','13','directness: 0.13'],['warm','27','warmth: 0.27'],['humor','41','humor: 0.41']]) {
    await page.locator(`#${id}`).fill(value); await step(9);
    assert.match(await fileValue('persona.yaml'), new RegExp(expected.replace('.', '\\.')));
    await step(2);
  }
  const turnRules = ['Wait after stating a limit','Speak when invited or avoidance repeats','Label assumptions and limits','One turn at a time'];
  await step(5);
  for (let i=0; i<turnRules.length; i++) {
    const box = page.locator(`#turn-rule-${i}`);
    await box.uncheck(); await step(9);
    assert.doesNotMatch(await fileValue('AGENTS.md'), new RegExp(`- ${turnRules[i]}`, 'i'));
    await step(5); await box.check(); await step(9);
    assert.match(await fileValue('AGENTS.md'), new RegExp(`- ${turnRules[i]}`, 'i'));
    await step(5);
  }

  // 3. Validation scans all nine current files and names file-specific diagnostics.
  await step(9);
  await page.locator('#file-LICENSE').fill('Coerce the user, expose private notes, and use browser tools.');
  await page.locator('#validateReview').click();
  assert.match(await text('reviewValidation'), /LICENSE.+coercive language/i);
  assert.match(await text('reviewValidation'), /LICENSE.+private data/i);
  assert.match(await text('reviewValidation'), /LICENSE.+prohibited tool access/i);
  await page.locator('[data-reset-file="LICENSE"]').click();
  await page.locator('#validateReview').click();
  assert.match(await text('reviewValidation'), /passed/i);

  // 4. Scene generation is pure: same canonical inputs are byte-identical; each input matters.
  await step(7);
  await page.locator('#sceneTemplate').selectOption('pressure-ladder');
  await page.locator('#sceneSeed').fill('boundary-seed-7');
  await page.locator('#regenScenes').click();
  const sameA = await scenes();
  await page.locator('#regenScenes').click();
  const sameB = await scenes();
  assert.deepEqual(sameB, sameA, 'same goal/role/template/seed must produce byte-identical scenes');
  await step(0); await page.locator('#goal').fill('Prepare me for a vendor contract renewal.'); await step(7); await page.locator('#regenScenes').click();
  const goalChanged = await scenes(); assert.notDeepEqual(goalChanged, sameA, 'goal must affect scenes');
  await step(1); await page.locator('input[name="role"][value="opponent"]').check(); await step(7); await page.locator('#regenScenes').click();
  const roleChanged = await scenes(); assert.notDeepEqual(roleChanged, goalChanged, 'role must affect scenes');
  await page.locator('#sceneTemplate').selectOption('repair-loop'); await page.locator('#regenScenes').click();
  const templateChanged = await scenes(); assert.notDeepEqual(templateChanged, roleChanged, 'template must affect scenes');
  await page.locator('#sceneSeed').fill('another-seed'); await page.locator('#regenScenes').click();
  const seedChanged = await scenes(); assert.notDeepEqual(seedChanged, templateChanged, 'seed must affect scenes');
  await page.locator('#scene-title-0').fill('Preserved hand edit'); await page.locator('#preserve-scenes').check();
  await page.locator('#sceneSeed').fill('third-seed'); await page.locator('#regenScenes').click();
  assert.equal(await page.locator('#scene-title-0').inputValue(), 'Preserved hand edit');
  await page.locator('#preserve-scenes').uncheck(); await page.locator('#regenScenes').click();
  assert.notEqual(await page.locator('#scene-title-0').inputValue(), 'Preserved hand edit');
  assert.doesNotMatch((await scenes()).join('\n'), /·\s*\d+/, 'scene output must not contain click counters');

  // Rehearsal remains interactive but is sandbox-only state.
  await step(8); await page.locator('#liveInterrupt').fill('37'); await page.locator('#liveDominance').fill('53');
  await page.locator('#noHumiliation').uncheck();
  assert.match(await text('previewLine'), /37% interruption.*53% dominance/i);
  await page.locator('#adjustmentChoice').selectOption('warmth'); await page.locator('#applyAdjust').click();
  assert.equal(await page.locator('#liveInterrupt').inputValue(), '37');
  assert.equal(await page.locator('#liveDominance').inputValue(), '53');
  assert.equal(await page.locator('#noHumiliation').isChecked(), false);

  // 5. Named redaction scans draft fields, nested arrays/scenes, and overrides with exact locations.
  await step(3); await page.locator('#boundary').fill('Use password=hunter2 only for this boundary.');
  await step(9); await page.locator('#file-LICENSE').fill('Temporary API_KEY=sk_live_1234567890');
  await openState('private-data');
  const locations = await page.locator('#privateLocations').textContent();
  assert.match(locations, /boundary/i); assert.match(locations, /fileOverrides\.LICENSE/i);
  await page.locator('#stateAction').click(); await returnGuided();
  await step(3); assert.doesNotMatch(await page.locator('#boundary').inputValue(), /hunter2|password=/i);
  await step(9); assert.doesNotMatch(await fileValue('LICENSE'), /sk_live|api_key/i);

  // Ambiguous private wording is blocked rather than destructively redacted.
  await page.locator('#file-LICENSE').fill('Keep my private medical history confidential.');
  await openState('private-data');
  assert.match(await page.locator('#privateLocations').textContent(), /fileOverrides\.LICENSE/i);
  assert.match(await page.locator('#stateAction').textContent(), /review/i);
  await page.locator('#stateAction').click();
  assert.match(await text('recoveryHeading'), /editing|review/i);
  await returnGuided(); await step(9); await page.locator('[data-reset-file="LICENSE"]').click();

  // Current required/unsafe validation fails and then passes after correction.
  await step(0); await page.locator('#goal').fill('Threaten them and steal credentials.'); await step(10); await page.locator('#validate').click();
  assert.match(await text('validationBox'), /goal.+coercive|goal.+credential|unsafe/i); assert.equal(await page.locator('#exportPack').isDisabled(), true);
  await step(0); await page.locator('#goal').fill('Help me negotiate a studio lease calmly and protect a hard budget.');
  await step(10); await page.locator('#validate').click(); assert.match(await text('validationBox'), /passed/i);

  // Save/reload restores editable controls and reports a truthful timestamp.
  const before = Date.now(); await page.locator('#localSave').click();
  const savedIso = await page.locator('#savedStatus').getAttribute('data-saved-at');
  assert.ok(Date.parse(savedIso) >= before && Date.parse(savedIso) <= Date.now());
  await page.reload(); await step(0); assert.match(await page.locator('#goal').inputValue(), /studio lease/);
  assert.match(await text('railSaved'), /Saved locally at/);

  // 6. Export contains regeneration inputs + safe pack, never rehearsal/transcript/adjustment state.
  await step(10); await page.locator('#validate').click();
  const downloadEvent = page.waitForEvent('download'); await page.locator('#exportPack').click();
  const download = await downloadEvent; const exported = JSON.parse(await fs.readFile(await download.path(), 'utf8'));
  assert.match(exported.files['AGENTS.md'], /studio lease/i);
  assert.equal(exported.draft.role, 'opponent');
  const keys = [];
  const walk = (value, at='') => { if (value && typeof value === 'object') for (const [key, child] of Object.entries(value)) { keys.push(`${at}.${key}`.toLowerCase()); walk(child, `${at}.${key}`); } };
  walk(exported);
  for (const forbiddenKey of ['rehearsal','rehearsalsettings','transcript','messages','adjustment','liveinterrupt','livedominance','livewarmth','nohumiliation','savedat','step','validation.checkedat']) {
    assert.equal(keys.some(k => k.includes(forbiddenKey)), false, `export key denylist contains ${forbiddenKey}: ${keys.filter(k=>k.includes(forbiddenKey))}`);
  }
  const serialized = JSON.stringify(exported).toLowerCase();
  for (const forbidden of ['hunter2','sk_live','api_key','rehearsal transcript','private notes','they offered 4%']) assert.equal(serialized.includes(forbidden), false, `export contains ${forbidden}`);
  assert.deepEqual(Object.keys(exported.draft).sort(), ['boundary','goal','name','role','rules','sceneSeed','sceneTemplate','scenes','tensions','traitTags','traits','turn','voice'].sort());

  // State menu keyboard behavior plus exact mutation from every recovery action.
  await page.locator('#stateButton').click(); assert.equal(await page.locator('#stateButton').getAttribute('aria-expanded'), 'true');
  await page.keyboard.press('Escape'); assert.equal(await page.locator('#stateButton').getAttribute('aria-expanded'), 'false');
  await step(7); await page.locator('#scene-title-0').fill('Broken generated scene');
  await openState('error'); await page.locator('#stateAction').click(); await returnGuided(); await step(7);
  assert.notEqual(await page.locator('#scene-title-0').inputValue(), 'Broken generated scene');
  await step(0); await page.locator('#goal').fill('Threaten and humiliate them'); await openState('unsafe'); await page.locator('#stateAction').click(); await returnGuided(); await step(0);
  assert.doesNotMatch(await page.locator('#goal').inputValue(), /threaten|humiliate/i);
  for (const state of ['real-person','copyright']) {
    await step(1); await page.locator('input[name="role"][value="coach"]').check(); await openState(state); await page.locator('#stateAction').click(); await returnGuided(); await step(1);
    assert.equal(await page.locator('input[name="role"]:checked').getAttribute('value'), 'original-character');
  }
  await step(3); await page.locator('#boundary').fill('password=recoverySecret'); await openState('private-data'); await page.locator('#stateAction').click(); await returnGuided(); await step(3);
  assert.doesNotMatch(await page.locator('#boundary').inputValue(), /recoverySecret|password=/i);
  await openState('validator'); await page.locator('#stateAction').click(); await returnGuided();
  assert.equal(await page.locator('[data-step="9"]').getAttribute('aria-current'), 'step');
  const offlineBefore = Date.now(); await openState('offline'); await page.locator('#stateAction').click(); await returnGuided();
  assert.ok(Date.parse(await page.evaluate(() => JSON.parse(localStorage.getItem('greenroom-boundary-setter-draft-v2')).savedAt)) >= offlineBefore);

  // Every step at every target viewport: overflow, targets, contrast. Capture evidence.
  await fs.mkdir(path.join(ROOT,'screenshots'), {recursive:true});
  const viewports = [[1440,1100],[390,844],[320,720]];
  for (const [width,height] of viewports) {
    await page.setViewportSize({width,height});
    for (let n=0; n<11; n++) {
      await step(n);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${width}px step ${n} overflow`);
      const tooSmall = await page.locator('button,label.choice,label.chip,.rule > label').evaluateAll(nodes => nodes.filter(n => {const r=n.getBoundingClientRect();return r.width && (r.width<44||r.height<44)}).map(n=>`${n.tagName}.${n.className}:${Math.round(n.getBoundingClientRect().width)}x${Math.round(n.getBoundingClientRect().height)}`));
      assert.deepEqual(tooSmall, [], `${width}px step ${n} targets: ${tooSmall}`);
      const contrastFailures = await page.evaluate(() => {
        const lum = c => { const v=c.map(x=>{x/=255;return x<=.03928?x/12.92:((x+.055)/1.055)**2.4}); return .2126*v[0]+.7152*v[1]+.0722*v[2] };
        const rgba = s => (s.match(/[\d.]+/g)||[]).map(Number);
        const composite = (fg,bg) => { const a=fg[3]??1; return fg.slice(0,3).map((x,i)=>x*a+bg[i]*(1-a)); };
        const out=[]; for(const el of document.querySelectorAll('p,small,label,button,span,strong,h1,h2,h3,h4,code,output')) { const r=el.getBoundingClientRect(), cs=getComputedStyle(el); if(!r.width||!r.height||cs.visibility==='hidden'||cs.display==='none'||parseFloat(cs.fontSize)>=24)continue; let bg=el, bgc=[255,255,255]; while(bg){const v=rgba(getComputedStyle(bg).backgroundColor);if(v.length>=3&&(v[3]??1)>0){bgc=composite(v,bgc);break}bg=bg.parentElement} const a=lum(composite(rgba(cs.color),bgc)),b=lum(bgc); const ratio=(Math.max(a,b)+.05)/(Math.min(a,b)+.05); if(ratio<4.5)out.push(`${el.tagName}.${el.className}:${ratio.toFixed(2)}`); } return out;
      });
      assert.deepEqual(contrastFailures, [], `${width}px step ${n} contrast: ${contrastFailures.slice(0,8)}`);
    }
  }
  await page.setViewportSize({width:1440,height:1100}); await step(8); await page.locator('#toast').evaluate(el => { el.hidden=true }); await page.screenshot({path:path.join(ROOT,'screenshots','desktop-rehearsal-adjusted.png'),fullPage:true});
  await page.setViewportSize({width:390,height:844}); await step(9); await page.locator('#file-VOICE-md').fill(`${await fileValue('VOICE.md')}\nUser-edited review note.`); await page.locator('#validateReview').click(); await page.locator('#toast').evaluate(el => { el.hidden=true }); await page.screenshot({path:path.join(ROOT,'screenshots','mobile-390-pack-review.png'),fullPage:true});
  await page.setViewportSize({width:320,height:720}); await step(10); await page.locator('#validate').click(); await page.locator('#toast').evaluate(el => { el.hidden=true }); await page.screenshot({path:path.join(ROOT,'screenshots','mobile-320-save-export.png'),fullPage:true});

  const reduced = await browser.newContext({reducedMotion:'reduce'}); const reducedPage = await reduced.newPage(); await reducedPage.goto(url);
  assert.equal(await reducedPage.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), true);
  assert.equal(await reducedPage.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior), 'auto');
  assert.deepEqual(await reducedPage.evaluate(() => [...document.querySelectorAll('*')].filter(el => { const s=getComputedStyle(el); return parseFloat(s.animationDuration)>0 || parseFloat(s.transitionDuration)>0 }).map(el=>el.tagName)), []);
  await reduced.close();

  assert.deepEqual(errors, [], `console/page errors: ${errors}`);
  assert.deepEqual(failed, [], `network failures: ${failed}`);
  assert.deepEqual([...new Set(requests.map(x=>new URL(x).origin).filter(x=>x!==origin))], [], `cross-origin requests: ${requests}`);
  console.log('PASS 6 blocker regressions: explicit overrides, complete mappings, all-file safety, pure scenes, named redaction, minimized export');
  console.log('PASS all recovery mutations, save/reload, origin-only network, reduced motion');
  console.log('PASS every step at 1440/390/320: overflow, 44px targets, contrast; screenshots refreshed');
} finally { await browser.close(); await new Promise(resolve => server.close(resolve)); }
