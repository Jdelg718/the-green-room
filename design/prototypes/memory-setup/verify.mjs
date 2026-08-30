import { chromium } from 'playwright';
import { mkdir } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';
import assert from 'node:assert/strict';

const here = dirname(fileURLToPath(import.meta.url));
const shotDir = join(here, 'screenshots');
await mkdir(shotDir, { recursive: true });
const url = pathToFileURL(join(here, 'index.html')).href;
const browser = await chromium.launch({ headless: true });
const results = [];

async function pageAt(width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  const errors = [];
  const external = [];
  page.on('pageerror', e => errors.push(String(e)));
  page.on('request', r => { if (!r.url().startsWith('file:')) external.push(r.url()); });
  await page.goto(url);
  return { page, errors, external };
}

async function geometry(page, label) {
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button:not([hidden]),input:not([type=radio]):not([hidden]),select:not([hidden]),summary')].filter(el => !el.disabled && el.offsetParent !== null);
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minTarget: Math.min(...controls.map(el => Math.max(el.getBoundingClientRect().width, el.getBoundingClientRect().height))),
      controls: controls.length
    };
  });
  assert.ok(metrics.overflow <= 0, `${label}: horizontal overflow ${metrics.overflow}px`);
  assert.ok(metrics.minTarget >= 44, `${label}: target below 44px (${metrics.minTarget})`);
  assert.ok(metrics.controls >= 4, `${label}: too few rendered controls (${metrics.controls})`);
  results.push(`${label}: ${metrics.controls} controls, min target ${metrics.minTarget}px, overflow ${metrics.overflow}px`);
}

for (const [width, height, name] of [[390,844,'mobile-390'],[320,800,'mobile-320']]) {
  const { page, errors, external } = await pageAt(width, height);
  await geometry(page, name);
  await page.locator('.stage').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shotDir, `memory-setup-${name.replace('mobile-','mobile-')}x${height}.png`) });
  assert.deepEqual(errors, [], `${name}: page errors`);
  assert.deepEqual(external, [], `${name}: external requests`);
  await page.close();
}

const { page, errors, external } = await pageAt(1440, 1100);
await geometry(page, 'desktop-1440');
await page.screenshot({ path: join(shotDir, 'memory-setup-desktop-1440x1100.png'), fullPage: true });

await page.getByRole('button', { name: /Choose Obsidian/ }).click();
await page.getByRole('button', { name: 'Choose folder…' }).click();
assert.ok(await page.getByRole('dialog', { name: /Choose your Obsidian vault/ }).isVisible());
await page.keyboard.press('Escape');
await page.getByRole('button', { name: /Review managed files/ }).click();
for (const label of ['Permission error','Read-only folder','Path outside vault root','Sync conflict','Adapter offline','Success']) {
  await page.getByRole('button', { name: /Prototype state/ }).click();
  await page.getByRole('menuitem', { name: label }).click();
  await page.getByRole('button', { name: 'Run access check' }).click();
  const heading = await page.locator('#checkStatus h3').textContent();
  assert.ok(heading && heading.length > 5, `${label}: missing state copy`);
  results.push(`${label}: ${heading}`);
}
assert.equal(await page.getByRole('button', { name: /Create a sample/ }).isDisabled(), false);
await page.getByRole('button', { name: /Choose storage/ }).click();
await page.locator('input[value=obsidian]').check();
await page.getByRole('button', { name: /Choose Obsidian/ }).click();
await page.getByRole('button', { name: /Review managed files/ }).click();
await page.getByRole('button', { name: 'Run access check' }).click();
await page.getByRole('button', { name: /Create a sample/ }).click();
await page.getByRole('button', { name: 'Create sample memory' }).click();
await page.getByRole('button', { name: /Test retrieval/ }).click();
assert.ok(await page.getByText('Found 1 relevant memory').isVisible());
await page.getByRole('button', { name: /Manage memory/ }).click();
await page.getByRole('button', { name: 'Correct' }).click();
await page.locator('#editText').fill('Sam brings ginger tea to Friday rooms.');
await page.getByRole('button', { name: 'Save correction' }).click();
assert.equal(await page.locator('#memoryText').textContent(), 'Sam brings ginger tea to Friday rooms.');
await page.getByRole('button', { name: /Disconnect/ }).click();
assert.ok(await page.getByText('Default: leave every note in place.').isVisible());
await page.keyboard.press('Escape');
await page.screenshot({ path: join(shotDir, 'memory-setup-manage-desktop-1440x1100.png'), fullPage: true });

await page.locator('#stateButton').focus();
await page.keyboard.press('Enter');
await page.keyboard.press('ArrowDown');
assert.equal(await page.locator('[role=menuitem]:focus').count(), 1, 'state menu keyboard focus');
await page.keyboard.press('Escape');
assert.equal(await page.locator('#stateButton:focus').count(), 1, 'state button focus return');

assert.deepEqual(errors, [], `desktop: page errors ${errors.join('; ')}`);
assert.deepEqual(external, [], `desktop: external requests ${external.join('; ')}`);
results.push('Happy path: folder dialog, access check, sample note, retrieval, correction, disconnect-without-deletion copy');
results.push('Keyboard: menu Arrow navigation and Escape focus return');
results.push('Network: zero external requests; console: zero page errors');
await browser.close();
console.log(results.join('\n'));
