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
  assert.match(styles, /#provider-setup\s*\{[^}]*width:\s*100vw;[^}]*height:\s*100dvh;[^}]*max-width:\s*none;/);
  assert.match(styles, /\.provider-setup-panel\s*\{[^}]*width:\s*min\(100%,\s*1100px\);[^}]*min-height:\s*100dvh;/);
  assert.match(styles, /\.provider-setup-heading\s*\{[^}]*position:\s*sticky;/);
  assert.match(styles, /@media\s*\(max-width:\s*760px\)[\s\S]*\.provider-actions/);
});

test("provider UI uses same-origin JSON only and has no browser persistence or key copies", () => {
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|serviceWorker|sendBeacon|document\.cookie/);
  assert.doesNotMatch(script, /console\.(?:log|debug|info|warn|error)/);
  assert.match(script, /providerKey\.value\s*=\s*""/);
  assert.match(script, /acknowledgedConnectionRevision/);
  assert.match(script, /API_PATHS\.providerConnections/);
  assert.match(script, /providerCapabilities\.lmStudio/);
  assert.match(script, /providerAction\("local"\)/);
  assert.match(script, /provider:\s*"lmstudio"/);
  assert.match(script, /providerBinding\?\.execution\s*===\s*"cloud"/);
  assert.match(script, /room\s*!==\s*null\s*&&\s*\(providerCapabilities\.cloud\s*\|\|\s*providerCapabilities\.lmStudio\)/);
  assert.match(script, /Model setup is unavailable in source mode/);
  assert.match(script, /providerConnectionId\.addEventListener\("input", \(\) =>/);
  assert.match(script, /mutationId:\s*providerCredentialMutationId \?\?= crypto\.randomUUID\(\)/);
  assert.match(script, /providerKey\.addEventListener\("input", clearProviderAcknowledgement\)/);
  assert.doesNotMatch(html, /value="sk-|https?:\/\/openrouter\.ai/);
});

test("cloud acknowledgement identity follows the exact live connection proposal", async () => {
  const contract = await import(`data:text/javascript;base64,${Buffer.from(script).toString("base64")}`) as {
    providerDisclosureProposal(value: {
      cloud: boolean;
      connection: null | { id: string; revision: number; state: string; definitionId: string };
      connectionId: string;
      definitionId: string;
      credentialPresent: boolean;
    }): null | { revision: number; token: string };
  };
  const creation = contract.providerDisclosureProposal({
    cloud: true, connection: null, connectionId: "openrouter-main", definitionId: "openrouter", credentialPresent: false,
  })!;
  assert.equal(creation.revision, 1);
  assert.equal(creation.token, "openrouter-main\u0000openrouter\u00001");
  const replacement = contract.providerDisclosureProposal({
    cloud: true,
    connection: { id: "openrouter-main", revision: 1, state: "enabled", definitionId: "openrouter" },
    connectionId: "openrouter-main", definitionId: "openrouter", credentialPresent: true,
  })!;
  assert.equal(replacement.revision, 2);
  assert.notEqual(replacement.token, creation.token);
  assert.notEqual(contract.providerDisclosureProposal({
    cloud: true, connection: null, connectionId: "other", definitionId: "openrouter", credentialPresent: false,
  })!.token, creation.token);
  assert.equal(contract.providerDisclosureProposal({
    cloud: false, connection: null, connectionId: "openrouter-main", definitionId: "openrouter", credentialPresent: false,
  }), null);
});

test("cloud model rebinding remains enabled until the exact selected model revision is bound", async () => {
  const contract = await import(`data:text/javascript;base64,${Buffer.from(script).toString("base64")}`) as {
    providerBindDisabled(value: {
      acknowledged: boolean;
      binding: null | {
        execution: string;
        binding: { model: { profileId: string; revision: number } };
        modelProfile: { profile: { id: string; revision: number; modelId: string; connection: { profileId: string; revision: number } } };
      };
      connection: { id: string; revision: number };
      ready: boolean;
      selectedModel: string;
      testedModel: null | string;
    }): boolean;
  };
  const connection = { id: "openrouter-main", revision: 1 };
  const boundA = {
    execution: "cloud",
    binding: { model: { profileId: "main-model", revision: 1 } },
    modelProfile: { profile: { id: "main-model", revision: 1, modelId: "provider/model-a", connection: { profileId: connection.id, revision: connection.revision } } },
  };
  assert.equal(contract.providerBindDisabled({
    acknowledged: true, binding: boundA, connection, ready: true,
    selectedModel: "provider/model-b", testedModel: "provider/model-b",
  }), false);

  const boundB = {
    execution: "cloud",
    binding: { model: { profileId: "main-model", revision: 2 } },
    modelProfile: { profile: { id: "main-model", revision: 2, modelId: "provider/model-b", connection: { profileId: connection.id, revision: connection.revision } } },
  };
  assert.equal(contract.providerBindDisabled({
    acknowledged: true, binding: boundB, connection, ready: true,
    selectedModel: "provider/model-b", testedModel: "provider/model-b",
  }), true);
});
