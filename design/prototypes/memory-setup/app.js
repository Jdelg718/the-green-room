(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);
  const titles = {
    1: ['Step 1 of 5 · optional projection', 'Choose where copies appear', 'Built-in SQLite always stays on. Optional sinks are disabled until a local human reviews and consents.', 'SQLite first'],
    2: ['Step 2 of 5 · local location', 'Choose a bounded destination', 'Only a local OS picker or a closed loopback definition can select a destination.', 'No arbitrary paths'],
    3: ['Step 3 of 5 · consented preview', 'Preview, preflight, then create', 'Review the exact managed scope. Production must pass every platform and filesystem safety check.', 'No writes yet'],
    4: ['Step 4 of 5 · contract rehearsal', 'Prove authority before projection', 'Validated checked-in fixtures show SQLite-first ordering, acknowledgement, lag, provenance, and bounded retrieval without making a real commit.', 'Fixture sequence 10'],
    5: ['Step 5 of 5 · lifecycle controls', 'Correct, forget, export, or disconnect', 'Every action names its scope. Sink delay never revives forgotten data in provider context.', 'You remain in control']
  };
  const config = { backend: 'local', vaultName: null, sync: 'none' };
  let step = 1;
  let reached = 1;
  let preflightPassed = false;
  let sampleCreated = false;
  let forgotten = false;
  let toastTimer;

  function announce(message) {
    const toast = $('toast');
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 3000);
  }

  function addTextElement(parent, tagName, text, className = '') {
    const element = document.createElement(tagName);
    if (className) element.className = className;
    element.textContent = text;
    parent.append(element);
    return element;
  }

  function backend() {
    return document.querySelector('input[name=backend]:checked').value;
  }

  function targetLabel() {
    if (config.backend === 'obsidian') return `${config.vaultName || 'selected vault'} / Green Room/`;
    if (config.backend === 'http') return 'loopback HTTP sink at 127.0.0.1:8787';
    return 'built-in SQLite authority only';
  }

  function sinkTree() {
    if (config.backend === 'local') return 'No optional sink selected.\nSQLite remains authoritative.';
    if (config.backend === 'http') return 'Closed HTTP contract paths only:\n/greenroom/memory/v1/<operation>\n\nNo path, URL, callback, or file handle\nis accepted in an operation.';
    return `Green Room/\n├── README.md\n├── rooms/\n│   └── <room-id>/\n│       ├── room.md\n│       ├── events/\n│       │   └── YYYY-MM.ndjson\n│       ├── records/revisions.ndjson\n│       ├── episodes/<record-id>.md\n│       ├── people/<persona-id>/<record-id>.md\n│       ├── relationships/<source-id>--<target-id>/<record-id>.md\n│       └── memories/<record-id>.md\n├── state/\n│   ├── adapter.json\n│   ├── managed-files.json\n│   ├── operations.ndjson\n│   ├── quarantine/\n│   └── recovery/\n├── user-annotations/<room-id>/<record-id>.md\n└── .locks/`;
  }

  function syncControls() {
    config.backend = backend();
    config.sync = document.querySelector('input[name=sync]:checked')?.value || 'none';
  }

  function updateTarget() {
    syncControls();
    $('managedTree').textContent = sinkTree();
    $('rootSummary').textContent = config.backend === 'local'
      ? 'Built-in authority only; no optional sink tree.'
      : `Proposed destination: ${targetLabel()}`;
    $('notePath').textContent = config.backend === 'obsidian'
      ? 'Green Room/rooms/<room-id>/room.md'
      : config.backend === 'http' ? 'HTTP projection has no revealable file' : 'Authority preview · no sink file';
  }

  function updateLifecycleCopy() {
    if (config.backend === 'local') {
      $('connectedCopy').textContent = 'Built-in-only fixture · authority sequence 10 · no optional projection or sink lag · no real operation';
      $('disconnectFact').textContent = 'Built-in SQLite authority cannot be disconnected. Export, reset, or erase are separate authority actions.';
      $('disconnectButton').disabled = true;
      return;
    }
    $('disconnectButton').disabled = false;
    if (config.backend === 'obsidian') {
      $('connectedCopy').textContent = 'Obsidian fixture · authority sequence 10 · projection acknowledged 10 · lag 0 · restart/replay digest matched · no real operation';
      $('disconnectFact').textContent = 'Removes only local Obsidian sink configuration; 11 manifest-listed fixture files remain under Green Room/.';
    } else {
      $('connectedCopy').textContent = 'HTTP fixture · authority sequence 10 · fixed-loopback projection acknowledged 10 · lag 0 · restart/replay digest matched · no real operation';
      $('disconnectFact').textContent = 'Removes only local HTTP sink configuration/secret reference; the user-operated service keeps its room-scoped projection unless separately erased.';
    }
  }

  function showStep(next) {
    step = next;
    reached = Math.max(reached, next);
    updateTarget();
    document.querySelectorAll('.panel').forEach((panel) => { panel.hidden = Number(panel.dataset.panel) !== next; });
    document.querySelectorAll('.step').forEach((button) => {
      const number = Number(button.dataset.step);
      button.disabled = number > reached;
      button.setAttribute('aria-current', number === next ? 'step' : 'false');
      button.classList.toggle('done', number < next && number <= reached);
    });
    const copy = titles[next];
    $('stepEyebrow').textContent = copy[0];
    $('stepTitle').textContent = copy[1];
    $('stepIntro').textContent = copy[2];
    $('ticket').textContent = copy[3];
    if (next === 5) updateLifecycleCopy();
    document.querySelector('.stage').scrollIntoView({ behavior: 'instant', block: 'start' });
    $('stepTitle').focus({ preventScroll: true });
  }

  function applyBackend() {
    syncControls();
    $('obsidianLocation').hidden = config.backend !== 'obsidian';
    $('localLocation').hidden = config.backend !== 'local';
    $('httpLocation').hidden = config.backend !== 'http';
    $('chooseNext').textContent = config.backend === 'obsidian' ? 'Choose Obsidian copy →' : config.backend === 'http' ? 'Review advanced HTTP sink →' : 'Keep built-in only →';
    preflightPassed = false;
    $('toSample').disabled = true;
    updateTarget();
  }

  function resetSamplePresentation() {
    const card = $('memoryCard');
    card.querySelector('.tag').textContent = 'Fixture · active revision 1';
    card.querySelector('h3').textContent = 'Compare, then choose';
    $('memoryText').textContent = 'Decisions in this room use a compare-then-choose convention.';
    card.querySelector('small').textContent = 'Producer: human · evidence event 018f0f6f-a3d2-7d09-bd19-d6325d4bc77a · source remains inspectable in fixture history.';
    card.querySelector('.memory-actions').hidden = false;
  }

  function invalidateForBackendChange() {
    config.vaultName = null;
    $('vaultPath').value = 'No vault selected';
    $('httpDisclosure').checked = false;
    $('consent').checked = false;
    $('chooseNext').disabled = true;
    preflightPassed = false;
    sampleCreated = false;
    forgotten = false;
    reached = 1;
    $('toSample').disabled = true;
    $('retrievalButton').disabled = true;
    $('retrievalResult').hidden = true;
    $('toManage').disabled = true;
    resetSamplePresentation();
    applyBackend();
  }

  function locationReady() {
    if (config.backend === 'obsidian') return Boolean(config.vaultName);
    if (config.backend === 'http') return $('httpDisclosure').checked;
    return true;
  }

  function setStatus(tone, heading, body, actions = []) {
    const status = $('checkStatus');
    status.dataset.tone = tone;
    status.querySelector('h3').textContent = heading;
    status.querySelector('p').textContent = body;
    status.querySelector('.status-actions')?.remove();
    if (actions.length) {
      const row = document.createElement('div');
      row.className = 'status-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.className = 'btn small';
        button.textContent = action.label;
        button.addEventListener('click', action.run);
        row.append(button);
      }
      status.append(row);
    }
    const focusTarget = status.querySelector('.status-actions button') || status.querySelector('h3');
    focusTarget.focus({ preventScroll: true });
  }

  function showDots(ok) {
    [...$('checkList').querySelectorAll('.dot')].forEach((dot, index) => {
      dot.className = `dot ${ok ? 'ok' : 'bad'}`;
      dot.textContent = ok ? '✓' : index === 0 ? '!' : '—';
    });
  }

  function showBlockedRecovery(title, body) {
    preflightPassed = false;
    $('toSample').disabled = true;
    showDots(false);
    setStatus('warning', title, body);
  }

  function runPreflight() {
    updateTarget();
    const fixture = $('fixtureState').value;
    if (fixture === 'offline' && config.backend === 'local') {
      preflightPassed = false;
      $('toSample').disabled = true;
      showDots(false);
      setStatus('error', 'No optional sink selected', 'Built-in-only has no projection sink to mark unavailable. Choose Obsidian, or explicitly open Advanced and select HTTP, before using this fixture.');
      return;
    }
    preflightPassed = fixture === 'success';
    $('toSample').disabled = !preflightPassed;
    if (fixture === 'success') {
      showDots(true);
      setStatus('success', 'Simulated preflight passed', `Fixture verified ${targetLabel()}: owner marker, identity, no links/reparse points, user-only access, lock contention, same-filesystem replace, durable flush, space, and case/Unicode behavior. No real write occurred.`);
      return;
    }
    showDots(false);
    const states = {
      permission: ['error', 'Permission denied', 'Choose another destination or correct permissions. No partial tree was created.'],
      symlink: ['error', 'Unsafe path component blocked', 'The managed root fixture contains a symlink/reparse point. Choose another folder; there is no bypass checkbox.'],
      conflict: ['warning', 'External edit conflict', 'Projection stopped without overwrite. SQLite remains authoritative; quarantine or restore expected generated bytes, then replay.'],
      offline: ['error', 'Optional sink unavailable', 'The room commit remains acknowledged at SQLite. One bounded idempotent outbox operation is pending; no failover sink was chosen.'],
      migration: ['warning', 'Migration approval required', 'Open read-only, create and verify an authority export, preview migration steps, then ask for explicit approval.'],
      unsupported: ['error', 'Writable mode unsupported here', 'Safe locking, no-follow traversal, permissions, or durable replacement could not be proven. Export/recover or use built-in local memory.']
    };
    const [tone, title, body] = states[fixture];
    const actions = fixture === 'conflict'
      ? [{ label: 'Preview quarantine and authority rebuild', run: () => showBlockedRecovery('Rebuild evidence required', 'The lifecycle fixture requires quarantine, restart/reopen, authority replay, and matching logical digest before continuation. This preview remains blocked.') }]
      : fixture === 'offline'
        ? [{ label: 'Preview identical retry', run: () => showBlockedRecovery('Acknowledgement evidence required', 'The lifecycle fixture requires identical idempotent replay and an acknowledged sequence/digest match. This preview remains blocked and no failover writer is selected.') }]
        : fixture === 'migration'
          ? [{
              label: 'Preview verified backup and migration',
              run: () => {
                preflightPassed = false;
                $('toSample').disabled = true;
                setStatus('warning', 'Migration preview remains blocked', 'Fixture shows a verified backup digest and proposed steps only. Explicit approval, execution, restart/reopen, and post-check evidence are still required before setup can continue.');
              }
            }]
          : [];
    setStatus(tone, title, body, actions);
  }

  function closeDialog(id, returnTo) {
    $(id).close();
    if (returnTo) $(returnTo).focus();
  }

  document.querySelectorAll('input[name=backend]').forEach((radio) => radio.addEventListener('change', invalidateForBackendChange));
  $('consent').addEventListener('change', () => { $('chooseNext').disabled = !$('consent').checked; });
  $('chooseNext').addEventListener('click', () => { applyBackend(); showStep(2); });
  document.querySelectorAll('[data-next]').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.next))));
  document.querySelectorAll('[data-back]').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.back))));
  document.querySelectorAll('.step').forEach((button) => button.addEventListener('click', () => showStep(Number(button.dataset.step))));
  document.querySelectorAll('input[name=sync]').forEach((radio) => radio.addEventListener('change', syncControls));

  $('browseVault').addEventListener('click', () => $('folderDialog').showModal());
  document.querySelectorAll('.folder').forEach((button) => button.addEventListener('click', () => {
    document.querySelectorAll('.folder').forEach((candidate) => candidate.setAttribute('aria-selected', String(candidate === button)));
  }));
  $('chooseFolder').addEventListener('click', () => {
    const selected = document.querySelector('.folder[aria-selected=true]');
    config.vaultName = selected.dataset.name;
    $('vaultPath').value = `${config.vaultName} (synthetic picker result)`;
    closeDialog('folderDialog', 'browseVault');
    updateTarget();
    announce(`Selected synthetic vault: ${config.vaultName}. Fixed child: Green Room/.`);
  });
  $('locationNext').addEventListener('click', () => {
    syncControls();
    if (!locationReady()) {
      const target = config.backend === 'obsidian' ? $('browseVault') : $('httpDisclosure');
      announce(config.backend === 'obsidian' ? 'Choose a vault with the simulated OS picker.' : 'Acknowledge that you operate the loopback service.');
      target.focus();
      return;
    }
    showStep(3);
  });
  $('runCheck').addEventListener('click', runPreflight);

  $('createSample').addEventListener('click', () => {
    sampleCreated = true;
    forgotten = false;
    resetSamplePresentation();
    $('sampleStatus').dataset.tone = 'success';
    $('sampleStatus').querySelector('h3').textContent = 'Validated fixture results loaded';
    $('sampleStatus').querySelector('p').textContent = config.backend === 'local'
      ? 'Authority fixture sequence: 10 · no optional sink · 1 event / 1 active revision · no real operation.'
      : 'Authority fixture sequence: 10 · projection acknowledged sequence: 10 · lag: 0 · 1 event / 1 active revision · no real operation.';
    const noteBody = $('noteBody');
    noteBody.replaceChildren();
    addTextElement(noteBody, 'span', 'Checked-in Obsidian fixture · room.md', 'source');
    addTextElement(noteBody, 'h3', 'Sample room');
    addTextElement(noteBody, 'p', 'This clearly labeled sample verifies local event and derived-memory storage.');
    addTextElement(noteBody, 'small', 'Room 018f0f6e-7b6a-7c10-8af1-7f4c620b93c1 · 466 bytes · sha256:153cadaf34056f1e5545c98529ae48738d17c6cecc0b744ea8ac771626071af5 · never instructions');
    $('revealNote').disabled = config.backend !== 'obsidian';
    $('retrievalButton').disabled = false;
    $('toManage').disabled = false;
    $('sampleStatus').querySelector('h3').focus({ preventScroll: true });
    announce('Validated checked-in fixture results loaded. No persistence or projection occurred.');
  });
  $('revealNote').addEventListener('click', () => announce('Reveal target preview: Green Room/rooms/018f0f6e-7b6a-7c10-8af1-7f4c620b93c1/room.md. No OS action occurred.'));
  $('retrievalButton').addEventListener('click', () => {
    $('retrievalResult').hidden = false;
    $('retrievalResult').focus({ preventScroll: true });
  });

  $('editMemory').addEventListener('click', () => { $('editDialog').showModal(); $('editText').focus(); $('editText').select(); });
  $('saveEdit').addEventListener('click', () => {
    const value = $('editText').value.trim();
    if (!value) { $('editText').focus(); return; }
    $('memoryText').textContent = value;
    $('memoryCard').querySelector('.tag').textContent = 'In-memory correction behavior preview · proposed revision 2';
    closeDialog('editDialog');
    $('memoryCard').querySelector('h3').focus({ preventScroll: true });
    announce('Correction behavior preview applied in memory. Nothing was validated, committed, or projected.');
  });
  $('forgetMemory').addEventListener('click', () => $('forgetDialog').showModal());
  $('confirmForget').addEventListener('click', () => {
    forgotten = true;
    closeDialog('forgetDialog');
    const card = $('memoryCard');
    card.querySelector('.tag').textContent = 'Tombstone behavior preview · history retained';
    const heading = card.querySelector('h3');
    heading.textContent = 'Forget preview';
    $('memoryText').textContent = 'Expected production behavior: default retrieval returns 0 items and provider context excludes the record immediately from SQLite authority; sink cleanup can remain pending. No data changed here.';
    card.querySelector('small').textContent = 'Scope: 1 derived record · 0 events · no claim about sync history, exports, backups, or provider copies.';
    card.querySelector('.memory-actions').hidden = true;
    heading.focus({ preventScroll: true });
    announce('Tombstone behavior previewed. No local or sink data changed.');
  });
  $('inspectSource').addEventListener('click', () => announce('Fixture provenance: human producer, event 018f0f6f-a3d2-7d09-bd19-d6325d4bc77a, authority sequence 10, room-scoped and visible.'));
  $('exportButton').addEventListener('click', () => announce(`Checked-in baseline export response: authority sequence 10, 4 active fixture revisions, 1 event, 1024 bytes, deterministic digests, zero credentials, zero absolute paths, not encrypted. ${forgotten ? 'The in-memory tombstone preview is not included.' : 'In-memory correction previews are not included.'}`));
  $('rebuildButton').addEventListener('click', () => announce('Rebuild preview: restore into new/reset SQLite authority first; replay committed IDs to the optional sink; compare logical digests.'));
  $('disconnectButton').addEventListener('click', () => {
    $('eraseData').checked = false;
    $('confirmDisconnect').textContent = 'Preview disconnect only';
    if (config.backend === 'obsidian') {
      $('disconnectScopeTitle').textContent = 'Default: leave Green Room/ in place.';
      $('disconnectScopeCopy').textContent = 'Disconnect removes only local Obsidian sink configuration. SQLite authority and 11 manifest-listed fixture files remain; reconnect verifies and replays. This prototype changes nothing.';
      $('eraseTitle').textContent = 'Instead, preview local erase of 11 manifest-listed fixture files after export';
      $('eraseCopy').textContent = 'Unknown files and user annotations stay. Synced/versioned/backup copies cannot be claimed erased.';
    } else {
      $('disconnectScopeTitle').textContent = 'Default: leave the HTTP projection in place.';
      $('disconnectScopeCopy').textContent = 'Disconnect removes only local HTTP sink configuration/secret reference. SQLite authority and the user-operated service copy remain. This prototype changes nothing.';
      $('eraseTitle').textContent = 'Instead, preview erase of 1 room-scoped HTTP projection after export';
      $('eraseCopy').textContent = 'The service must report capability and result; independent backups and received copies remain outside Green Room control.';
    }
    $('disconnectDialog').showModal();
  });
  $('eraseData').addEventListener('change', () => { $('confirmDisconnect').textContent = $('eraseData').checked ? 'Preview erase scope and disconnect' : 'Preview disconnect only'; });
  $('confirmDisconnect').addEventListener('click', () => {
    const erase = $('eraseData').checked;
    closeDialog('disconnectDialog');
    $('connectedCopy').textContent = erase
      ? config.backend === 'obsidian'
        ? 'Obsidian erase/disconnect preview · 11 manifest-listed fixture files · annotations/unknown/external copies would remain · nothing changed'
        : 'HTTP erase/disconnect preview · 1 room-scoped projection · service capability/result required · external copies would remain · nothing changed'
      : `${config.backend === 'obsidian' ? 'Obsidian' : 'HTTP'} disconnect preview · only local sink configuration would be removed · authority and projected copy would remain · nothing changed`;
    $('connectedCopy').focus({ preventScroll: true });
    announce(erase ? 'Scoped erase preview complete; no files changed and external copies would remain.' : 'Disconnect-without-deletion preview complete; nothing changed.');
  });
  $('doneButton').addEventListener('click', () => {
    announce('Prototype complete. No production setup, adapter, vault write, browser persistence, or deployment occurred.');
    $('connectedCopy').focus({ preventScroll: true });
  });

  document.querySelectorAll('[data-close]').forEach((button) => button.addEventListener('click', () => closeDialog(button.dataset.close)));
  document.querySelectorAll('dialog').forEach((dialog) => dialog.addEventListener('click', (event) => { if (event.target === dialog) dialog.close(); }));
  $('fixtureState').addEventListener('change', () => {
    preflightPassed = false;
    sampleCreated = false;
    forgotten = false;
    $('toSample').disabled = true;
    $('retrievalButton').disabled = true;
    $('retrievalResult').hidden = true;
    $('toManage').disabled = true;
    resetSamplePresentation();
    reached = Math.min(reached, 3);
    if (step > 3) showStep(3);
  });

  applyBackend();
})();
