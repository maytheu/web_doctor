function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

export function createPanel({ mount }) {
  const root = node('div', 'runtime');
  const heading = node('h2', 'runtime-heading', 'Ask the Doctor');
  heading.id = 'agent-heading';
  const intro = node(
    'p',
    'runtime-intro',
    'Audit a site or ask about a check in natural language. The agent runs in your browser with your own router key.'
  );

  const log = node('div', 'runtime-log');
  log.setAttribute('role', 'log');
  log.setAttribute('aria-live', 'polite');
  log.setAttribute('aria-relevant', 'additions');
  log.setAttribute('aria-label', 'Agent conversation');

  const chatForm = node('form', 'runtime-chat');
  const chatLabel = node('label', 'visually-hidden', 'Message to the agent');
  chatLabel.htmlFor = 'agent-message';
  const chatInput = node('input', 'runtime-message');
  chatInput.id = 'agent-message';
  chatInput.type = 'text';
  chatInput.autocomplete = 'off';
  chatInput.placeholder = 'Is example.com conformant?';
  chatInput.required = true;
  const sendButton = node('button', '', 'Send');
  sendButton.type = 'submit';
  chatForm.append(chatLabel, chatInput, sendButton);

  const status = node('p', 'runtime-status');
  status.setAttribute('role', 'status');

  const settings = node('details', 'runtime-settings');
  settings.append(node('summary', '', 'Router settings (BYOK)'));
  const settingsForm = node('form', 'runtime-settings-form');

  const baseLabel = node('label', '', 'Provider base URL');
  const baseInput = node('input');
  baseInput.name = 'baseUrl';
  baseInput.type = 'url';
  baseInput.required = true;
  baseLabel.append(baseInput);

  const modelLabel = node('label', '', 'Model');
  const modelInput = node('input');
  modelInput.name = 'model';
  modelInput.type = 'text';
  modelInput.required = true;
  modelLabel.append(modelInput);

  const keyLabel = node('label', '', 'API key');
  const keyInput = node('input');
  keyInput.name = 'key';
  keyInput.type = 'password';
  keyInput.autocomplete = 'off';
  keyInput.spellcheck = false;
  keyLabel.append(keyInput);

  const settingsActions = node('div', 'runtime-settings-actions');
  const saveButton = node('button', '', 'Save');
  saveButton.type = 'submit';
  const clearButton = node('button', 'secondary', 'Remove key');
  clearButton.type = 'button';
  settingsActions.append(saveButton, clearButton);

  const settingsStatus = node('p', 'runtime-settings-status');
  settingsStatus.setAttribute('role', 'status');
  const settingsNote = node(
    'p',
    'note',
    'Stored in this browser for this origin only. The key is sent to the router host and nowhere else.'
  );
  settingsForm.append(baseLabel, modelLabel, keyLabel, settingsActions, settingsStatus);
  settings.append(settingsForm, settingsNote);

  const dialog = node('dialog', 'runtime-consent');
  const consentForm = node('form');
  consentForm.method = 'dialog';
  const consentTitle = node('h3', '', 'Allow external contact?');
  const consentLead = node('p', '', 'The agent wants to contact ');
  const consentOrigin = node('code');
  consentLead.append(consentOrigin);
  const consentPurpose = node('p', 'runtime-consent-purpose');
  const consentActions = node('div', 'runtime-consent-actions');
  const allowButton = node('button', '', 'Allow');
  allowButton.type = 'submit';
  allowButton.value = 'allow';
  const denyButton = node('button', 'secondary', 'Deny');
  denyButton.type = 'submit';
  denyButton.value = 'deny';
  denyButton.autofocus = true;
  consentActions.append(allowButton, denyButton);
  consentForm.append(consentTitle, consentLead, consentPurpose, consentActions);
  dialog.append(consentForm);

  root.append(heading, intro, log, chatForm, status, settings, dialog);
  mount.replaceChildren(root);

  let runtime = null;
  let pendingConsent = null;

  dialog.addEventListener('close', () => {
    const resolve = pendingConsent;
    pendingConsent = null;
    resolve?.(dialog.returnValue === 'allow');
  });

  function requestConsent({ origin, purpose }) {
    if (pendingConsent || typeof dialog.showModal !== 'function') return Promise.resolve(false);
    consentOrigin.textContent = origin;
    consentPurpose.textContent = purpose || 'Contact this origin.';
    dialog.returnValue = 'deny';
    return new Promise((resolve) => {
      pendingConsent = resolve;
      dialog.showModal();
    });
  }

  function addBubble(kind, text) {
    const label = kind === 'user' ? 'You' : kind === 'error' ? 'Error' : 'Doctor';
    const bubble = node('article', `runtime-bubble runtime-${kind}`);
    bubble.append(node('span', 'runtime-role', label), node('p', 'runtime-text', text));
    log.append(bubble);
    log.scrollTop = log.scrollHeight;
  }

  function setStatus(message, isError = false) {
    status.textContent = message;
    status.classList.toggle('runtime-error-text', isError);
  }

  function updateKeyState(hasKey) {
    sendButton.disabled = !hasKey;
    sendButton.title = hasKey ? '' : 'Save a router key first';
    if (!hasKey) setStatus('Add your router key in Router settings to start.');
  }

  function showBootError(message) {
    setStatus(`Could not start the runtime: ${message}`, true);
    sendButton.disabled = true;
  }

  chatForm.addEventListener('submit', async (event) => {
    event.preventDefault();
    const message = chatInput.value.trim();
    if (!message || !runtime) return;
    chatInput.value = '';
    addBubble('user', message);
    sendButton.disabled = true;
    chatInput.disabled = true;
    setStatus('Thinking…');
    try {
      const answer = await runtime.send(message);
      addBubble('assistant', answer || '(The router returned no text.)');
      setStatus('');
    } catch (error) {
      addBubble('error', error.message);
      setStatus('The request did not complete.', true);
    } finally {
      chatInput.disabled = false;
      sendButton.disabled = !runtime.getSettings().hasKey;
      if (!chatInput.disabled) chatInput.focus();
    }
  });

  settingsForm.addEventListener('submit', (event) => {
    event.preventDefault();
    if (!runtime) return;
    try {
      const saved = runtime.saveSettings({
        baseUrl: baseInput.value,
        model: modelInput.value,
        key: keyInput.value
      });
      keyInput.value = '';
      keyInput.placeholder = 'Saved locally';
      settingsStatus.textContent = 'Saved. The key is sent only to the configured router.';
      setStatus('Router configured. Ask a question to start.');
      updateKeyState(saved.hasKey);
    } catch (error) {
      settingsStatus.textContent = error.message;
    }
  });

  clearButton.addEventListener('click', () => {
    if (!runtime) return;
    runtime.clearSettings();
    keyInput.value = '';
    keyInput.placeholder = 'Paste router key';
    settingsStatus.textContent = 'Router key removed from this browser.';
    updateKeyState(false);
  });

  function attach(instance) {
    runtime = instance;
    sendButton.disabled = true;
    runtime.ready
      .then(() => {
        const settingsView = runtime.getSettings();
        baseInput.value = settingsView.baseUrl;
        modelInput.value = settingsView.model;
        keyInput.placeholder = settingsView.hasKey ? 'Saved locally' : 'Paste router key';
        updateKeyState(settingsView.hasKey);
      })
      .catch((error) => showBootError(error.message));
  }

  return { root, attach, requestConsent, showBootError };
}
