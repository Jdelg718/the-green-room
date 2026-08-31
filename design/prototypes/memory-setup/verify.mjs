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
  page.on('pageerror', error => errors.push(String(error)));
  page.on('request', request => {
    if (!request.url().startsWith('file:')) external.push(request.url());
  });
  await page.goto(url);
  return { page, errors, external };
}

async function geometry(page, label) {
  const metrics = await page.evaluate(() => {
    const controls = [...document.querySelectorAll('button:not([hidden]),input:not([type=radio]):not([hidden]),select:not([hidden]),summary')]
      .filter(element => !element.disabled && element.offsetParent !== null);
    return {
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      minTarget: Math.min(...controls.map(element => Math.min(element.getBoundingClientRect().width, element.getBoundingClientRect().height))),
      controls: controls.length
    };
  });
  assert.ok(metrics.overflow <= 0, `${label}: horizontal overflow ${metrics.overflow}px`);
  assert.ok(metrics.minTarget >= 44, `${label}: target below 44px (${metrics.minTarget})`);
  assert.ok(metrics.controls >= 4, `${label}: too few rendered controls (${metrics.controls})`);
  results.push(`${label}: ${metrics.controls} controls, min target ${metrics.minTarget}px, overflow ${metrics.overflow}px`);
}

async function expectFocus(page, selector, label) {
  assert.equal(await page.locator(`${selector}:focus`).count(), 1, `${label}: focus did not move to ${selector}`);
}

async function chooseState(page, label) {
  await page.getByRole('button', { name: /Prototype state/ }).click();
  await page.getByRole('menuitem', { name: label }).click();
}

for (const [width, height, name] of [[390, 844, 'mobile-390'], [320, 800, 'mobile-320']]) {
  const { page, errors, external } = await pageAt(width, height);
  await geometry(page, name);
  await page.locator('.stage').scrollIntoViewIfNeeded();
  await page.screenshot({ path: join(shotDir, `memory-setup-${name}x${height}.png`) });
  assert.deepEqual(errors, [], `${name}: page errors`);
  assert.deepEqual(external, [], `${name}: external requests`);
  await page.close();
}

const { page, errors, external } = await pageAt(1440, 1100);
await geometry(page, 'desktop-1440');
await page.screenshot({ path: join(shotDir, 'memory-setup-desktop-1440x1100.png'), fullPage: true });

// Every step transition moves focus into the newly rendered step.
await page.getByRole('button', { name: /Choose Obsidian/ }).click();
await expectFocus(page, '#stepTitle', 'location transition');

// Existing vault selection drives every downstream representation of the target.
await page.getByRole('button', { name: 'Choose folder…' }).click();
await page.getByRole('option', { name: /Writing/ }).click();
await page.getByRole('button', { name: 'Use this vault' }).click();
assert.equal(await page.locator('#vaultPath').inputValue(), '/Users/you/Documents/Writing');
assert.match(await page.locator('#toast').textContent(), /Writing/);

// New-folder simulation must collect a name, create it, and select that exact target.
await page.getByRole('button', { name: 'Choose folder…' }).click();
await page.getByRole('option', { name: /Create a new vault folder/ }).click();
assert.ok(await page.locator('#newFolderName').isVisible(), 'new folder name control is visible');
await page.locator('#newFolderName').fill('Research Vault');
await page.getByRole('button', { name: 'Create and use vault' }).click();
assert.equal(await page.locator('#vaultPath').inputValue(), '/Users/you/Documents/Obsidian/Research Vault');
assert.match(await page.locator('#toast').textContent(), /Research Vault/);

await page.locator('#subtree').fill('Private Memory');
await page.getByRole('button', { name: /Review managed files/ }).click();
await expectFocus(page, '#stepTitle', 'review transition');
const exactTarget = 'Research Vault / Private Memory/';
assert.equal((await page.locator('#rootSummary').innerText()).trim(), exactTarget);
assert.match(await page.locator('.tree').innerText(), /^Private Memory\//);
await page.getByRole('button', { name: 'Run access check' }).click();
await expectFocus(page, '#checkStatus h3', 'successful access check');
assert.match(await page.locator('#checkStatus').innerText(), /Research Vault \/ Private Memory\//);
const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('green-room-memory-prototype-config')));
assert.deepEqual(saved, {
  backend: 'obsidian',
  vaultName: 'Research Vault',
  vaultPath: '/Users/you/Documents/Obsidian/Research Vault',
  subtree: 'Private Memory'
});

for (const [prototypeState, heading] of [
  ['Permission error', 'We could not use this folder'],
  ['Read-only folder', 'This folder is read-only']
]) {
  await chooseState(page, prototypeState);
  await expectFocus(page, '#stateButton', `${prototypeState} state selection`);
  await page.getByRole('button', { name: 'Run access check' }).click();
  await expectFocus(page, '#checkStatus h3', `${prototypeState} result`);
  assert.equal(await page.locator('#checkStatus h3').textContent(), heading);
  assert.match(await page.locator('#checkStatus').innerText(), /Research Vault \/ Private Memory\//);
}

// Recovery actions perform the mutation named on the button and leave focus at the result.
await chooseState(page, 'Path outside vault root');
await page.getByRole('button', { name: 'Run access check' }).click();
await expectFocus(page, '#safePath', 'outside-path recovery offered');
await page.getByRole('button', { name: /Use “Private Memory” inside Research Vault/ }).click();
await expectFocus(page, '#checkStatus h3', 'outside-path recovered');
assert.match(await page.locator('#checkStatus h3').textContent(), /Path corrected/);
assert.equal(await page.locator('#subtree').inputValue(), 'Private Memory');

for (const [action, heading] of [
  ['Use vault copy', 'Vault copy selected'],
  ['Use this device', 'This device selected'],
  ['Keep both', 'Both copies kept']
]) {
  await chooseState(page, 'Sync conflict');
  await page.getByRole('button', { name: 'Run access check' }).click();
  await page.getByRole('button', { name: action }).click();
  await expectFocus(page, '#checkStatus h3', `${action} recovery`);
  assert.equal(await page.locator('#checkStatus h3').textContent(), heading);
}

await chooseState(page, 'Adapter offline');
await page.getByRole('button', { name: 'Run access check' }).click();
await expectFocus(page, '#retryAdapter', 'adapter retry offered');
await page.getByRole('button', { name: 'Retry connection' }).click();
await expectFocus(page, '#checkStatus h3', 'adapter retry result');
assert.equal(await page.locator('#checkStatus h3').textContent(), 'Adapter connection restored');

// Return to the exact Obsidian configuration and complete the setup.
await page.getByRole('button', { name: /Choose storage/ }).click();
await expectFocus(page, '#stepTitle', 'storage recovery transition');
await page.locator('input[value=obsidian]').check();
await page.getByRole('button', { name: /Choose Obsidian/ }).click();
await page.locator('#vaultPath').evaluate((element) => { element.value = '/Users/you/Documents/Obsidian/Research Vault'; });
await page.locator('#subtree').fill('Private Memory');
await page.getByRole('button', { name: /Review managed files/ }).click();
await chooseState(page, 'Success');
await page.getByRole('button', { name: 'Run access check' }).click();
await page.getByRole('button', { name: /Create a sample/ }).click();
await expectFocus(page, '#stepTitle', 'sample transition');
await page.getByRole('button', { name: 'Create sample memory' }).click();
await expectFocus(page, '#sampleStatus h3', 'sample creation');
assert.match(await page.locator('#sampleStatus').innerText(), /Research Vault \/ Private Memory\//);
await page.getByRole('button', { name: /Test retrieval/ }).click();
assert.ok(await page.getByText('Found 1 relevant memory').isVisible());
await page.getByRole('button', { name: /Manage memory/ }).click();
await expectFocus(page, '#stepTitle', 'management transition');
assert.match(await page.locator('#connectedCopy').textContent(), /Research Vault \/ Private Memory\//);

await page.getByRole('button', { name: 'Correct' }).click();
await expectFocus(page, '#editText', 'correction dialog primary task');
await page.locator('#editText').fill('Sam brings ginger tea to Friday rooms.');
await page.getByRole('button', { name: 'Save correction' }).click();
assert.equal(await page.locator('#memoryText').textContent(), 'Sam brings ginger tea to Friday rooms.');
await expectFocus(page, '#memoryCard h3', 'correction result');

await page.getByRole('button', { name: 'Forget' }).click();
assert.ok(await page.getByRole('dialog', { name: 'Forget this memory?' }).isVisible());
assert.match(await page.locator('#forgetTarget').textContent(), /Sam brings ginger tea to Friday rooms/);
assert.equal(await page.locator('#memoryCard h3').textContent(), 'Sam brings mint tea');
await page.getByRole('button', { name: 'Forget this memory', exact: true }).click();
assert.equal(await page.locator('#memoryCard h3').textContent(), 'Memory forgotten');
await expectFocus(page, '#memoryCard h3', 'forget result');

await page.getByRole('button', { name: /Disconnect/ }).click();
assert.match(await page.getByText(/Also erase managed/).textContent(), /Private Memory/);
await page.locator('#eraseData').check();
assert.equal(await page.locator('#disconnectTitle').textContent(), 'Erase Private Memory/ and disconnect?');
await page.getByRole('button', { name: 'Erase Private Memory/ and disconnect', exact: true }).click();
assert.match(await page.locator('#connectedCopy').textContent(), /Disconnected/);
assert.match(await page.locator('#connectedCopy').textContent(), /Research Vault \/ Private Memory\//);
await expectFocus(page, '#connectedCopy', 'destructive disconnect result');
assert.equal(await page.evaluate(() => localStorage.getItem('green-room-memory-prototype-config')), null);
await page.screenshot({ path: join(shotDir, 'memory-setup-manage-desktop-1440x1100.png'), fullPage: true });

await page.locator('#stateButton').focus();
await page.keyboard.press('Enter');
await page.keyboard.press('ArrowDown');
assert.equal(await page.locator('[role=menuitem]:focus').count(), 1, 'state menu keyboard focus');
await page.keyboard.press('Escape');
assert.equal(await page.locator('#stateButton:focus').count(), 1, 'state button focus return');

assert.deepEqual(errors, [], `desktop: page errors ${errors.join('; ')}`);
assert.deepEqual(external, [], `desktop: external requests ${external.join('; ')}`);
results.push('Exact target: selected and newly created vaults plus subtree propagate through review, tree, check, sample, saved config, management, and erase copy');
results.push('Recovery/focus: step transitions, outside-path correction, all conflict choices, adapter retry, correction, forget, and destructive disconnect');
results.push('Network: zero external requests; console: zero page errors');
await browser.close();
console.log(results.join('\n'));
