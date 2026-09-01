(() => {
  'use strict';

  const $ = id => document.getElementById(id);
  const titles = {
    1: ['Step 1 of 5 · storage call', 'Where should memory live?', 'Built-in Local is easiest. Obsidian keeps readable notes. An adapter is for an existing self-hosted service.', 'Your storage · your call'],
    2: ['Step 2 of 5 · location', 'Choose a place you recognize', 'Green Room writes only to the dedicated location shown here.', 'No surprise folders'],
    3: ['Step 3 of 5 · safety check', 'See exactly what we manage', 'Review the subtree, then run a permission and test-write check.', 'Show the work'],
    4: ['Step 4 of 5 · rehearsal', 'Try one harmless memory', 'Create a sample note, reveal it, and prove Green Room can retrieve it.', 'Nothing hidden'],
    5: ['Step 5 of 5 · control desk', 'Manage your Margin Notes', 'Correct, forget, export, or disconnect without losing your files.', 'You own the notes']
  };
  const config = {
    backend: 'obsidian',
    vaultName: 'My Vault',
    vaultPath: '/Users/you/Documents/Obsidian/My Vault',
    subtree: 'Green Room'
  };
  let step = 1;
  let reached = 1;
  let state = 'success';
  let checked = false;
  let sampled = false;
  let toastTimer;

  function announce(text) {
    const toast = $('toast');
    toast.textContent = text;
    toast.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { toast.hidden = true; }, 2800);
  }

  function normalizedSubtree() {
    const value = $('subtree').value.trim().replace(/^\/+|\/+$/g, '');
    return value || 'Green Room';
  }

  function syncConfigFromControls() {
    config.backend = document.querySelector('input[name=backend]:checked').value;
    config.vaultPath = $('vaultPath').value;
    config.subtree = normalizedSubtree();
    $('subtree').value = config.subtree;
  }

  function targetLabel() {
    if (config.backend === 'obsidian') return `${config.vaultName} / ${config.subtree}/`;
    if (config.backend === 'local') return 'Green Room private app data';
    return 'Adapter-managed storage at 127.0.0.1';
  }

  function notePath() {
    return config.backend === 'obsidian'
      ? `${config.subtree}/rooms/sample-room/memories/memory-sample-tea.md`
      : 'rooms/sample-room/memories/memory-sample-tea.md';
  }

  function updateTargetCopy() {
    syncConfigFromControls();
    $('rootSummary').textContent = targetLabel();
    $('managedTree').textContent = `${config.backend === 'obsidian' ? `${config.subtree}/` : 'Green Room/'}\n├── README.md\n└── rooms/<room-id>/\n    ├── room.md\n    ├── events/YYYY-MM.ndjson\n    ├── episodes/<episode-id>.md\n    ├── people/<persona-id>.md\n    ├── relationships/\n    │   └── <source>--<target>.md\n    ├── memories/<memory-id>.md\n    └── state/index.json`;
    $('connectedCopy').textContent = config.backend === 'obsidian'
      ? `Obsidian · ${targetLabel()} · last checked just now`
      : config.backend === 'local'
        ? 'Built-in Local · this device · last checked just now'
        : 'Self-hosted Adapter · 127.0.0.1 · last checked just now';
    $('eraseLabel').innerHTML = `<b>Also erase managed ${config.backend === 'obsidian' ? `${config.subtree}/` : 'Green Room'} data</b><small>Optional and destructive. ${targetLabel()} is the only target included; other notes are never included.</small>`;
  }

  function showStep(next) {
    step = next;
    reached = Math.max(reached, next);
    updateTargetCopy();
    document.querySelectorAll('.panel').forEach(panel => {
      panel.hidden = Number(panel.dataset.panel) !== next;
    });
    document.querySelectorAll('.step-link').forEach(button => {
      const buttonStep = Number(button.dataset.step);
      button.disabled = buttonStep > reached;
      button.setAttribute('aria-current', buttonStep === next ? 'step' : 'false');
      button.classList.toggle('done', buttonStep < next && buttonStep <= reached);
    });
    const copy = titles[next];
    $('stepEyebrow').textContent = copy[0];
    $('stepTitle').textContent = copy[1];
    $('stepIntro').textContent = copy[2];
    $('ticket').textContent = copy[3];
    document.querySelector('.stage').scrollIntoView({ behavior: 'instant', block: 'start' });
    $('stepTitle').focus({ preventScroll: true });
  }

  function applyBackend() {
    syncConfigFromControls();
    const backend = config.backend;
    $('chooseNext').textContent = backend === 'obsidian' ? 'Choose Obsidian →' : backend === 'local' ? 'Choose Built-in Local →' : 'Choose adapter →';
    $('localCopy').innerHTML = backend === 'obsidian'
      ? `Only the dedicated <b>${config.subtree}/</b> subtree is managed. The rest of your vault is not indexed, changed, or sent anywhere by this prototype.`
      : backend === 'local'
        ? 'The private app-data store stays on this device. Green Room hosts nothing and sends no telemetry by default.'
        : 'Only bounded memory records and searches go to the endpoint you provide. Your whole vault is never sent by default.';
    ['obsidianLocation', 'localLocation', 'adapterLocation'].forEach(id => { $(id).hidden = true; });
    $({ obsidian: 'obsidianLocation', local: 'localLocation', adapter: 'adapterLocation' }[backend]).hidden = false;
    checked = false;
    $('toSample').disabled = true;
    updateTargetCopy();
  }

  function saveConfig() {
    syncConfigFromControls();
    localStorage.setItem('green-room-memory-prototype-config', JSON.stringify(config));
  }

  function setCheckResult(tone, title, body, actions = []) {
    const box = $('checkStatus');
    box.dataset.tone = tone;
    box.querySelector('h3').textContent = title;
    box.querySelector('p').textContent = body;
    box.querySelector('.status-actions')?.remove();
    if (actions.length) {
      const actionBox = document.createElement('div');
      actionBox.className = 'status-actions';
      for (const action of actions) {
        const button = document.createElement('button');
        button.className = 'btn small';
        button.id = action.id || '';
        button.textContent = action.label;
        button.addEventListener('click', action.run);
        actionBox.append(button);
      }
      box.append(actionBox);
    }
  }

  function focusCheckResult(preferAction = false) {
    const target = preferAction ? $('checkStatus').querySelector('.status-actions button') : $('checkStatus').querySelector('h3');
    target?.focus({ preventScroll: true });
  }

  function completeRecovery(title, body) {
    state = 'success';
    checked = true;
    $('toSample').disabled = false;
    setCheckResult('success', title, body);
    focusCheckResult();
  }

  function runCheck() {
    updateTargetCopy();
    const items = [...$('checkList').querySelectorAll('.dot')];
    items.forEach((dot, index) => {
      dot.className = 'dot';
      dot.textContent = String(index + 1);
    });
    checked = state === 'success';
    let tone = 'success';
    let title = 'Access check passed';
    let body = `Temporary test file written inside ${targetLabel()}, read back, and removed. No other folders were touched.`;
    let actions = [];

    if (state === 'error') {
      tone = 'error';
      title = 'We could not use this folder';
      body = `The system denied the test write in ${targetLabel()}. Nothing was saved. Choose another folder or update its permissions.`;
    } else if (state === 'readonly') {
      tone = 'error';
      title = 'This folder is read-only';
      body = `${targetLabel()} can be read but cannot safely accept additions or corrections. Choose a writable folder.`;
    } else if (state === 'outside') {
      tone = 'error';
      title = 'That path leaves your vault';
      body = `${config.subtree}/ must stay inside ${config.vaultName}. We blocked the path before writing anything.`;
      actions = [{
        id: 'safePath',
        label: `Use “${config.subtree}” inside ${config.vaultName}`,
        run: () => completeRecovery('Path corrected', `${targetLabel()} is now bounded to the selected vault. Run may continue without touching neighboring folders.`)
      }];
    } else if (state === 'conflict') {
      tone = 'warning';
      title = 'A sync copy changed too';
      body = `Another device changed the sample in ${targetLabel()} while we were checking. Nothing was overwritten.`;
      actions = [
        { label: 'Use vault copy', run: () => completeRecovery('Vault copy selected', 'The vault version is active; this device copy was left unchanged.') },
        { label: 'Use this device', run: () => completeRecovery('This device selected', 'This device version is active; the vault copy remains in correction history.') },
        { label: 'Keep both', run: () => completeRecovery('Both copies kept', 'Both versions were preserved with distinct names for later review.') }
      ];
    } else if (state === 'offline') {
      tone = 'error';
      title = 'Adapter is offline';
      body = 'No reply from 127.0.0.1:8787. Existing memory was not changed.';
      actions = [{
        id: 'retryAdapter',
        label: 'Retry connection',
        run: () => completeRecovery('Adapter connection restored', 'The adapter replied to a bounded health check. Existing memory was not changed.')
      }];
    }

    setCheckResult(tone, title, body, actions);
    items.forEach((dot, index) => {
      if (checked) {
        dot.className = 'dot ok';
        dot.textContent = '✓';
      } else if (index === 0 && state !== 'outside') {
        dot.className = 'dot ok';
        dot.textContent = '✓';
      } else {
        dot.className = 'dot bad';
        dot.textContent = '!';
      }
    });
    $('toSample').disabled = !checked;
    if (checked) saveConfig();
    focusCheckResult(actions.length > 0);
  }

  function closeState() {
    $('stateMenu').hidden = true;
    $('stateButton').setAttribute('aria-expanded', 'false');
  }

  function setState(next) {
    state = next;
    document.querySelectorAll('[data-state]').forEach(button => {
      button.setAttribute('aria-current', String(button.dataset.state === state));
    });
    const labels = { success: 'Success', error: 'Permission error', readonly: 'Read-only folder', outside: 'Path outside vault root', conflict: 'Sync conflict', offline: 'Adapter offline' };
    $('stateButton').textContent = `Prototype state: ${labels[state]} ▾`;
    if (state === 'offline') {
      document.querySelector('input[value=adapter]').checked = true;
      applyBackend();
    }
    checked = false;
    $('toSample').disabled = true;
    closeState();
  }

  document.querySelectorAll('input[name=backend]').forEach(radio => radio.addEventListener('change', applyBackend));
  $('subtree').addEventListener('input', updateTargetCopy);
  $('chooseNext').addEventListener('click', () => { applyBackend(); showStep(2); });
  document.querySelectorAll('[data-next]').forEach(button => button.addEventListener('click', () => showStep(Number(button.dataset.next))));
  document.querySelectorAll('[data-back]').forEach(button => button.addEventListener('click', () => showStep(Number(button.dataset.back))));
  document.querySelectorAll('.step-link').forEach(button => button.addEventListener('click', () => showStep(Number(button.dataset.step))));

  $('browseVault').addEventListener('click', () => $('folderDialog').showModal());
  document.querySelectorAll('.folder').forEach(button => button.addEventListener('click', () => {
    document.querySelectorAll('.folder').forEach(candidate => candidate.setAttribute('aria-selected', String(candidate === button)));
    $('newFolderField').hidden = !button.dataset.create;
    $('chooseFolder').textContent = button.dataset.create ? 'Create and use vault' : 'Use this vault';
    if (button.dataset.create) $('newFolderName').focus();
  }));
  $('chooseFolder').addEventListener('click', () => {
    const selection = document.querySelector('.folder[aria-selected=true]');
    if (selection.dataset.create) {
      const name = $('newFolderName').value.trim();
      if (!name) {
        $('newFolderName').setCustomValidity('Name the simulated vault folder.');
        $('newFolderName').reportValidity();
        $('newFolderName').focus();
        return;
      }
      $('newFolderName').setCustomValidity('');
      config.vaultName = name;
      config.vaultPath = `/Users/you/Documents/Obsidian/${name}`;
    } else {
      config.vaultName = selection.dataset.name;
      config.vaultPath = selection.dataset.path;
    }
    $('vaultPath').value = config.vaultPath;
    $('folderDialog').close();
    updateTargetCopy();
    announce(`Vault selected: ${config.vaultName}`);
    $('browseVault').focus();
  });
  document.querySelectorAll('[data-close]').forEach(button => button.addEventListener('click', () => $(button.dataset.close).close()));

  $('runCheck').addEventListener('click', runCheck);
  $('createSample').addEventListener('click', () => {
    sampled = true;
    updateTargetCopy();
    $('sampleStatus').dataset.tone = 'success';
    $('sampleStatus').querySelector('h3').textContent = 'Sample created';
    $('sampleStatus').querySelector('p').textContent = `One room event and one derived Markdown memory were written inside ${targetLabel()}.`;
    $('sampleNote').querySelector('.note-body').innerHTML = '<span class="source-tag">Sample · source event sample-001</span><h3>Sam brings mint tea</h3><p>Sam brings mint tea to Thursday rooms.</p><p><small>Created by Green Room · safe to edit · provenance preserved</small></p>';
    $('revealNote').disabled = false;
    $('retrievalButton').disabled = false;
    $('toManage').disabled = false;
    saveConfig();
    announce('Sample memory created.');
    $('sampleStatus').querySelector('h3').focus({ preventScroll: true });
  });
  $('revealNote').addEventListener('click', () => announce(`Revealed: ${notePath()}`));
  $('retrievalButton').addEventListener('click', () => {
    $('retrievalResult').hidden = false;
    announce('Retrieval succeeded: 1 relevant memory found.');
    $('retrievalResult').setAttribute('tabindex', '-1');
    $('retrievalResult').focus({ preventScroll: true });
  });

  $('editMemory').addEventListener('click', () => {
    $('editDialog').showModal();
    $('editText').focus();
    $('editText').select();
  });
  $('saveEdit').addEventListener('click', () => {
    const value = $('editText').value.trim();
    if (!value) return;
    $('memoryText').textContent = value;
    $('editDialog').close();
    announce('Correction saved with its history.');
    const heading = $('memoryCard').querySelector('h3');
    heading.setAttribute('tabindex', '-1');
    heading.focus({ preventScroll: true });
  });
  $('forgetMemory').addEventListener('click', () => {
    $('forgetTarget').textContent = `“${$('memoryText').textContent}” will no longer be available to the room. The authoritative sample event remains until the room is reset.`;
    $('forgetDialog').showModal();
  });
  $('confirmForget').addEventListener('click', () => {
    $('forgetDialog').close();
    $('memoryCard').innerHTML = '<div class="memory-top"><h3 tabindex="-1">Memory forgotten</h3><span class="tag red">Removed</span></div><p>The derived memory is no longer available to the room. The authoritative sample event remains until the room is reset.</p>';
    announce('Memory forgotten.');
    $('memoryCard').querySelector('h3').focus({ preventScroll: true });
  });
  $('inspectSource').addEventListener('click', () => announce(`Source: sample event sample-001 · ${notePath()}`));
  $('exportButton').addEventListener('click', () => announce(`Export prepared from ${targetLabel()}: memories and provenance, no credentials.`));
  $('disconnectButton').addEventListener('click', () => {
    updateTargetCopy();
    $('eraseData').checked = false;
    $('disconnectTitle').textContent = 'Disconnect memory?';
    $('confirmDisconnect').textContent = 'Disconnect';
    $('disconnectDialog').showModal();
  });
  $('eraseData').addEventListener('change', () => {
    const erase = $('eraseData').checked;
    $('disconnectTitle').textContent = erase ? `Erase ${config.subtree}/ and disconnect?` : 'Disconnect memory?';
    $('confirmDisconnect').textContent = erase ? `Erase ${config.subtree}/ and disconnect` : 'Disconnect';
  });
  $('confirmDisconnect').addEventListener('click', () => {
    const erase = $('eraseData').checked;
    const disconnectedTarget = targetLabel();
    $('disconnectDialog').close();
    localStorage.removeItem('green-room-memory-prototype-config');
    $('connectedCopy').textContent = `Disconnected · ${disconnectedTarget} · ${erase ? 'managed data erased' : 'notes left in place'}`;
    $('connectedCopy').focus({ preventScroll: true });
    announce(erase ? `Disconnected and erased only ${disconnectedTarget}.` : 'Disconnected. Your notes remain in place.');
  });
  $('doneButton').addEventListener('click', () => {
    saveConfig();
    announce(`Memory setup complete for ${targetLabel()}.`);
    $('connectedCopy').focus({ preventScroll: true });
  });

  $('stateButton').addEventListener('click', () => {
    const open = $('stateMenu').hidden;
    $('stateMenu').hidden = !open;
    $('stateButton').setAttribute('aria-expanded', String(open));
    if (open) $('stateMenu').querySelector('[aria-current=true]').focus();
  });
  $('stateMenu').addEventListener('click', event => {
    const button = event.target.closest('[data-state]');
    if (button) {
      setState(button.dataset.state);
      $('stateButton').focus();
    }
  });
  $('stateMenu').addEventListener('keydown', event => {
    const buttons = [...event.currentTarget.querySelectorAll('button')];
    const index = buttons.indexOf(document.activeElement);
    if (event.key === 'Escape') {
      closeState();
      $('stateButton').focus();
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length].focus();
    }
  });
  document.addEventListener('click', event => {
    if (!event.target.closest('.state-control')) closeState();
  });
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', event => {
    if (event.target === dialog) dialog.close();
  }));

  applyBackend();
})();
