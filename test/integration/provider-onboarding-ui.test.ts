import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const html = readFileSync(resolve("public/index.html"), "utf8");
const script = readFileSync(resolve("public/app.js"), "utf8");
const styles = readFileSync(resolve("public/styles.css"), "utf8");
const API_CREDIT_COPY = "A ChatGPT subscription does not include OpenAI API credits. Green Room needs an API account/key from OpenRouter or another listed API provider; that provider may bill usage separately.";
const CLOUD_COPY = "Using this cloud provider sends bounded persona instructions and conversation context from this device to the selected provider (and, for OpenRouter, potentially its upstream inference provider). Green Room’s project website does not receive it.";

test("provider onboarding is accessible, responsive, and contains the required disclosures verbatim", () => {
  assert.ok(html.includes(API_CREDIT_COPY));
  assert.ok(html.includes(CLOUD_COPY));
  assert.match(html, /<button[^>]+id="open-provider-setup"[^>]+aria-controls="provider-setup"/);
  assert.match(html, /<dialog[^>]+id="provider-setup"[^>]+aria-labelledby="provider-setup-title"/);
  assert.match(html, /<fieldset[\s\S]*?<legend>Choose where replies run<\/legend>/);
  assert.match(html, /type="radio"[^>]+value="lmstudio"[\s\S]*?LM Studio[\s\S]*?No cloud/);
  assert.match(html, /<input[^>]+id="provider-key"[^>]+type="password"[^>]+autocomplete="off"[^>]+spellcheck="false"/);
  assert.match(html, /<select[^>]+id="provider-model"[^>]+required/);
  assert.match(html, /<input[^>]+id="provider-disclosure-ack"[^>]+type="checkbox"[^>]+required/);
  assert.match(html, /id="provider-revision-status"[^>]+aria-live="polite"/);
  assert.match(styles, /\.provider-setup-panel[\s\S]*max-width/);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.provider-actions/);
});

test("provider UI uses same-origin JSON only and has no browser persistence or key copies", () => {
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|serviceWorker|sendBeacon|document\.cookie/);
  assert.doesNotMatch(script, /console\.(?:log|debug|info|warn|error)/);
  assert.match(script, /providerKey\.value\s*=\s*""/);
  assert.match(script, /acknowledgedConnectionRevision/);
  assert.match(script, /API_PATHS\.providerConnections/);
  assert.doesNotMatch(html, /value="sk-|https?:\/\/openrouter\.ai/);
});
