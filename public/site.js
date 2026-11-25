import { createReceiptTracker } from './receipt.js';
import { boot } from './runtime/index.js';

const tracker = createReceiptTracker();
const receiptList = document.getElementById('receipt-list');
const receiptNote = document.getElementById('receipt-note');

function renderReceipt() {
  if (!receiptList) return;
  receiptList.replaceChildren(
    ...tracker.lines().map((line) => {
      const item = document.createElement('li');
      item.textContent = line;
      return item;
    })
  );
}

let runtime = null;
try {
  runtime = boot({
    mount: '#agent-panel',
    manifest: '/agent-manifest.json',
    actions: '/actions/doctor-actions.js'
  });
} catch (error) {
  receiptNote.textContent = `Agent panel unavailable: ${error.message}`;
}

if (runtime && typeof runtime.on === 'function') {
  runtime.on('activity', (event) => {
    tracker.observe(event);
    renderReceipt();
  });
  receiptNote.textContent = 'Derived from runtime activity in this browser. No analytics, no telemetry.';
} else if (runtime) {
  receiptNote.textContent = 'Runtime activity is unavailable; only locally observable facts are shown.';
}

if (runtime) runtime.ready.catch(() => {});
renderReceipt();
