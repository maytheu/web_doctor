import test from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';
import { findBrowser, launchBrowser } from './helpers/browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');

const browserPath = findBrowser();
const skip = !browserPath
  ? 'Chrome or Edge not found; set CHROME_PATH to run the browser e2e test'
  : typeof WebSocket === 'undefined'
    ? 'This Node.js runtime has no global WebSocket; use Node >= 22'
    : false;

const fillAuditForm = (url) => `(() => {
  const input = document.getElementById('url-input');
  input.value = ${JSON.stringify(url)};
  document.getElementById('audit-form').requestSubmit();
  return true;
})()`;

const installInterceptors = `(() => {
  window.__copied = null;
  window.__download = null;
  window.__statusRenders = 0;
  Object.defineProperty(navigator, 'clipboard', {
    configurable: true,
    value: { writeText: async (text) => { window.__copied = text; } }
  });
  const originalClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function patchedClick() {
    if (this.download) {
      window.__download = { name: this.download, href: this.href };
      return;
    }
    return originalClick.call(this);
  };
  new MutationObserver(() => { window.__statusRenders += 1; }).observe(document.getElementById('status-text'), {
    childList: true
  });
  return true;
})()`;

test('report UI e2e: theme, form, banner, filters, copy/download, badge, ledger', { skip }, async (t) => {
  const target = await startFixtureServer(path.join(FIXTURES, 'good'));
  const doctor = createServer({ allowPrivate: true });
  await new Promise((resolve) => doctor.listen(0, '127.0.0.1', resolve));
  const doctorBase = `http://127.0.0.1:${doctor.address().port}`;

  const browser = await launchBrowser(browserPath);
  const pageErrors = [];
  const consoleErrors = [];
  const badgeResponses = [];
  browser.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown');
  });
  browser.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });
  browser.on('Network.responseReceived', (params) => {
    if (params.response.url.includes('/api/badge')) badgeResponses.push(params.response.status);
  });

  async function runAudit(url) {
    const before = await browser.evaluate('window.__statusRenders');
    await browser.evaluate(fillAuditForm(url));
    await browser.waitFor('!document.getElementById("confirm-region").hidden', { label: 'confirmation card' });
    await browser.evaluate('document.getElementById("confirm-run").click()');
    await browser.waitFor(`window.__statusRenders > ${before}`, { label: 'status banner render' });
  }

  async function press(key, { code = key, vk, text } = {}) {
    const params = { key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (text !== undefined) params.text = text;
    await browser.send('Input.dispatchKeyEvent', { type: 'keyDown', ...params });
    await browser.send('Input.dispatchKeyEvent', { type: 'keyUp', ...params });
  }
  const pressEnter = () => press('Enter', { vk: 13, text: '\r' });
  const pressTab = () => press('Tab', { vk: 9 });
  const pressSpace = () => press(' ', { vk: 32, text: ' ' });

  try {
    await t.test('theme toggle flips the theme and survives a reload', async () => {
      await browser.navigate(`${doctorBase}/`);
      assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'dark');
      assert.equal(await browser.evaluate('document.getElementById("theme-toggle").textContent'), 'Light theme');
      assert.equal(await browser.evaluate('document.getElementById("theme-toggle").getAttribute("aria-pressed")'), 'false');

      await browser.evaluate('document.getElementById("theme-toggle").click()');
      assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'light');
      assert.equal(await browser.evaluate('localStorage.getItem("awd.theme")'), 'light');

      await browser.navigate(`${doctorBase}/`);
      assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'light');
      assert.equal(await browser.evaluate('document.getElementById("theme-toggle").textContent'), 'Dark theme');
      assert.equal(await browser.evaluate('document.getElementById("theme-toggle").getAttribute("aria-pressed")'), 'true');

      await browser.evaluate('document.getElementById("theme-toggle").click()');
      await browser.navigate(`${doctorBase}/`);
      assert.equal(await browser.evaluate('document.documentElement.dataset.theme'), 'dark');
      assert.equal(await browser.evaluate('localStorage.getItem("awd.theme")'), 'dark');
    });

    const expected = await (await fetch(`${doctorBase}/api/audit?url=${encodeURIComponent(target.baseUrl)}`)).json();

    await t.test('the URL hint explains the optional scheme and loopback default', async () => {
      assert.equal(
        await browser.evaluate('document.getElementById("url-input").getAttribute("aria-describedby")'),
        'url-hint'
      );
      assert.match(
        await browser.evaluate('document.getElementById("url-hint").textContent'),
        /scheme is optional.*loopback.*http/i
      );
    });

    await t.test('submitting asks for confirmation naming the origin, and Cancel returns to idle', async () => {
      await browser.evaluate(fillAuditForm(target.baseUrl));
      await browser.waitFor('!document.getElementById("confirm-region").hidden', { label: 'confirmation card' });
      assert.equal(
        await browser.evaluate('document.getElementById("confirm-text").textContent'),
        `This will contact ${new URL(target.baseUrl).host} from this server.`
      );
      assert.equal(await browser.evaluate('document.activeElement.id'), 'confirm-run');

      await browser.evaluate('document.getElementById("confirm-cancel").click()');
      assert.equal(await browser.evaluate('document.getElementById("confirm-region").hidden'), true);
      assert.equal(await browser.evaluate('document.activeElement.id'), 'url-input');
      assert.equal(await browser.evaluate('document.getElementById("results").hidden'), true);
    });

    await t.test('a bare hostname defaults to https and asks for confirmation', async () => {
      await browser.evaluate(fillAuditForm('example.com'));
      await browser.waitFor('!document.getElementById("confirm-region").hidden', { label: 'bare hostname confirmation' });
      assert.equal(
        await browser.evaluate('document.getElementById("confirm-text").textContent'),
        'This will contact example.com from this server.'
      );
      await browser.evaluate('document.getElementById("confirm-cancel").click()');
      assert.equal(await browser.evaluate('document.getElementById("confirm-region").hidden'), true);
    });

    await t.test('a bare loopback host defaults to http and audits', async () => {
      const host = new URL(target.baseUrl).host;
      await browser.evaluate(fillAuditForm(host));
      await browser.waitFor('!document.getElementById("confirm-region").hidden', { label: 'loopback confirmation' });
      assert.equal(
        await browser.evaluate('document.getElementById("confirm-text").textContent'),
        `This will contact ${host} from this server.`
      );
      await browser.evaluate('document.getElementById("confirm-run").click()');
      await browser.waitFor('document.getElementById("status-text").textContent === "CONFORMANT"', {
        label: 'loopback audit'
      });
    });

    await t.test('the audit form renders the status banner and check groups', async () => {
      await browser.evaluate(installInterceptors);
      await runAudit(target.baseUrl);

      assert.equal(await browser.evaluate('document.getElementById("status-text").textContent'), 'CONFORMANT');
      assert.equal(await browser.evaluate('document.getElementById("score-text").textContent'), '100/100');
      assert.equal(
        await browser.evaluate('document.getElementById("status-banner").className.includes("status-conformant")'),
        true
      );
      assert.equal(
        await browser.evaluate('document.getElementById("counts-text").textContent'),
        `${expected.summary.pass} pass · ${expected.summary.warn} warn · ${expected.summary.error} error · ${expected.summary.skip} skip`
      );
      assert.match(await browser.evaluate('document.getElementById("duration-text").textContent'), /^\d+ ms$/);
      assert.equal(await browser.evaluate('document.activeElement.id'), 'status-banner');

      const headings = await browser.evaluate(
        '[...document.querySelectorAll("#check-groups section h2")].map((heading) => heading.textContent)'
      );
      assert.ok(headings.some((heading) => heading.startsWith('publication (')));
      assert.ok(headings.some((heading) => heading.startsWith('network (')));
      assert.equal(
        await browser.evaluate('document.querySelectorAll("#check-groups .check-row").length'),
        expected.checks.length
      );
      const ids = await browser.evaluate(
        '[...document.querySelectorAll("#check-groups .check-id")].map((node) => node.textContent)'
      );
      assert.deepEqual(ids, expected.checks.map((check) => check.id));
      const specs = await browser.evaluate(
        '[...document.querySelectorAll("#check-groups .check-spec")].map((node) => node.textContent)'
      );
      assert.deepEqual(specs, expected.checks.map((check) => `Spec: ${check.specRef}`));
    });

    await t.test('filters update rows, counts and aria-pressed', async () => {
      const labels = await browser.evaluate(
        '[...document.querySelectorAll("#filters button")].map((button) => button.textContent)'
      );
      assert.deepEqual(labels, [
        `All (${expected.checks.length})`,
        `Errors (${expected.summary.error})`,
        `Warnings (${expected.summary.warn})`,
        `Passes (${expected.summary.pass})`
      ]);

      await browser.evaluate('document.querySelector("#filters button[data-filter=error]").click()');
      assert.equal(await browser.evaluate('document.querySelector("#filters button[data-filter=error]").getAttribute("aria-pressed")'), 'true');
      assert.equal(await browser.evaluate('document.querySelector("#filters button[data-filter=all]").getAttribute("aria-pressed")'), 'false');
      assert.equal(await browser.evaluate('document.querySelector("#check-groups .empty").textContent'), 'No checks match this filter.');

      await browser.evaluate('document.querySelector("#filters button[data-filter=pass]").click()');
      assert.equal(
        await browser.evaluate('document.querySelectorAll("#check-groups .check-row").length'),
        expected.summary.pass
      );
      assert.equal(
        await browser.evaluate('document.querySelectorAll("#check-groups .check-row:not(.check-pass)").length'),
        0
      );

      await browser.evaluate('document.querySelector("#filters button[data-filter=all]").click()');
      assert.equal(
        await browser.evaluate('document.querySelectorAll("#check-groups .check-row").length'),
        expected.checks.length
      );
    });

    await t.test('the page is keyboard-operable and announces results', async () => {
      await browser.navigate(`${doctorBase}/`);
      await browser.evaluate(installInterceptors);
      await browser.send('Page.bringToFront');
      await browser.evaluate('document.getElementById("url-input").focus()');
      assert.equal(await browser.evaluate('document.activeElement.id'), 'url-input');
      await pressTab();
      assert.equal(await browser.evaluate('document.activeElement.id'), 'run-button');
      assert.equal(await browser.evaluate('document.activeElement.matches(":focus-visible")'), true);

      await browser.evaluate(`document.getElementById("url-input").value = ${JSON.stringify(target.baseUrl)}`);
      await browser.evaluate('document.getElementById("url-input").focus()');
      const before = await browser.evaluate('window.__statusRenders');
      await pressEnter();
      await browser.waitFor('!document.getElementById("confirm-region").hidden', { label: 'keyboard confirmation' });
      assert.equal(await browser.evaluate('document.activeElement.id'), 'confirm-run');
      await pressEnter();
      await browser.waitFor(`window.__statusRenders > ${before}`, { label: 'keyboard-submitted audit' });
      await browser.waitFor(
        'document.getElementById("status-region").getAttribute("aria-busy") === "false"',
        { label: 'audit completion' }
      );
      assert.equal(await browser.evaluate('document.getElementById("status-text").textContent'), 'CONFORMANT');
      assert.equal(await browser.evaluate('document.getElementById("status-region").getAttribute("aria-live")'), 'polite');
      assert.equal(await browser.evaluate('document.getElementById("run-button").disabled'), false);

      await browser.evaluate('document.querySelector("#filters button[data-filter=warn]").focus()');
      await pressEnter();
      assert.equal(
        await browser.evaluate('document.querySelector("#filters button[data-filter=warn]").getAttribute("aria-pressed")'),
        'true'
      );
      assert.equal(await browser.evaluate('document.querySelectorAll("#check-groups .check-row").length'), 0);
      await browser.evaluate('document.querySelector("#filters button[data-filter=all]").click()');

      const theme = await browser.evaluate('document.documentElement.dataset.theme');
      await browser.evaluate('document.getElementById("theme-toggle").focus()');
      await pressSpace();
      await browser.waitFor(`document.documentElement.dataset.theme !== ${JSON.stringify(theme)}`, {
        label: 'keyboard theme toggle'
      });
      assert.equal(await browser.evaluate('document.getElementById("theme-toggle").getAttribute("aria-pressed")'), 'true');
    });

    await t.test('reduced motion turns off transitions and animations', async () => {
      const readStyle = `(() => {
        const style = getComputedStyle(document.getElementById('run-button'));
        return {
          matches: matchMedia('(prefers-reduced-motion: reduce)').matches,
          transitionProperty: style.transitionProperty,
          transitionDuration: style.transitionDuration,
          animationName: style.animationName,
          animationDuration: style.animationDuration
        };
      })()`;
      assert.equal((await browser.evaluate(readStyle)).transitionProperty, 'all');

      await browser.send('Emulation.setEmulatedMedia', {
        features: [{ name: 'prefers-reduced-motion', value: 'reduce' }]
      });
      try {
        const reduced = await browser.evaluate(readStyle);
        assert.equal(reduced.matches, true);
        assert.equal(reduced.transitionProperty, 'none');
        assert.equal(reduced.transitionDuration, '0s');
        assert.equal(reduced.animationName, 'none');
        assert.equal(reduced.animationDuration, '0s');
      } finally {
        await browser.send('Emulation.setEmulatedMedia', { features: [] });
      }
      assert.equal(await browser.evaluate('matchMedia("(prefers-reduced-motion: reduce)").matches'), false);
    });

    await t.test('badge preview, snippets, copy and download use the report data', async () => {
      const encoded = encodeURIComponent(target.baseUrl);
      const image = `${doctorBase}/api/badge?url=${encoded}`;
      const page = `${doctorBase}/?url=${encoded}`;
      assert.equal(await browser.evaluate('document.getElementById("badge-section").hidden'), false);
      assert.equal(await browser.evaluate('document.getElementById("badge-preview").getAttribute("src")'), image);
      assert.equal(await browser.evaluate('document.getElementById("badge-markdown").textContent'), `[![agentic web](${image})](${page})`);
      assert.equal(
        await browser.evaluate('document.getElementById("badge-html").textContent'),
        `<a href="${page}"><img src="${image}" alt="agentic web conformance badge"></a>`
      );
      await browser.waitFor('document.getElementById("badge-preview").complete && document.getElementById("badge-preview").naturalWidth > 0', {
        label: 'badge preview image'
      });
      assert.ok(badgeResponses.includes(200));

      await browser.evaluate('window.__copied = null; document.getElementById("copy-json").click(); true');
      await browser.waitFor('window.__copied !== null', { label: 'copied JSON' });
      const copied = JSON.parse(await browser.evaluate('window.__copied'));
      assert.equal(copied.schemaVersion, 1);
      assert.equal(copied.baseUrl, target.baseUrl);

      await browser.evaluate('window.__copied = null; document.querySelector("[data-copy-target=badge-markdown]").click(); true');
      await browser.waitFor('window.__copied !== null', { label: 'copied Markdown' });
      assert.equal(await browser.evaluate('window.__copied'), `[![agentic web](${image})](${page})`);

      await browser.evaluate('document.getElementById("download-json").click()');
      const download = await browser.evaluate('window.__download');
      assert.equal(download.name, 'audit-127.0.0.1.json');
      assert.ok(download.href.startsWith('blob:'));
    });

    await t.test('the local ledger shows a baseline, unchanged artifacts and reset', async () => {
      if (await browser.evaluate('!document.getElementById("ledger-reset").hidden')) {
        await browser.evaluate('document.getElementById("ledger-reset").click()');
        await browser.waitFor('document.getElementById("ledger-text").hidden', { label: 'ledger reset before baseline' });
      }

      await runAudit(target.baseUrl);
      const first = await browser.waitFor(
        '(() => { const node = document.getElementById("ledger-text"); return !node.hidden && node.textContent.startsWith("History:") ? node.textContent : ""; })()',
        { label: 'ledger baseline' }
      );
      assert.equal(first, `History: Baseline saved for this origin (${expected.artifacts.length} artifacts).`);

      await runAudit(target.baseUrl);
      const second = await browser.waitFor(
        '(() => { const node = document.getElementById("ledger-text"); return node.textContent.includes("unchanged since your last visit") ? node.textContent : ""; })()',
        { label: 'ledger unchanged note' }
      );
      assert.equal(second, `History: All ${expected.artifacts.length} artifacts unchanged since your last visit.`);

      assert.equal(await browser.evaluate('document.getElementById("ledger-reset").hidden'), false);
      await browser.evaluate('document.getElementById("ledger-reset").click()');
      await browser.waitFor('document.getElementById("ledger-text").hidden', { label: 'ledger reset' });
      assert.equal(await browser.evaluate('document.getElementById("ledger-reset").hidden'), true);

      await runAudit(target.baseUrl);
      const fresh = await browser.waitFor(
        '(() => { const node = document.getElementById("ledger-text"); return !node.hidden && node.textContent.startsWith("History: Baseline") ? node.textContent : ""; })()',
        { label: 'fresh baseline after reset' }
      );
      assert.equal(fresh, `History: Baseline saved for this origin (${expected.artifacts.length} artifacts).`);
    });

    await t.test('recent audits persist locally without artifact content and cap at ten', async () => {
      const stored = await browser.evaluate('JSON.parse(localStorage.getItem("awd.recent"))');
      assert.equal(stored.length, 1);
      assert.deepEqual(Object.keys(stored[0]).sort(), ['at', 'score', 'status', 'url']);
      assert.equal(stored[0].url, target.baseUrl);
      assert.equal(stored[0].status, 'conformant');
      assert.equal(stored[0].score, 100);

      const rendered = await browser.evaluate(
        '[...document.querySelectorAll("#recent-list button")].map((button) => button.textContent)'
      );
      assert.deepEqual(rendered, [`${target.baseUrl} — CONFORMANT · 100/100`]);
      assert.equal(await browser.evaluate('document.getElementById("recent-section").hidden'), false);

      await browser.evaluate('document.querySelector("#recent-list button").click()');
      await browser.waitFor('!document.getElementById("confirm-region").hidden', { label: 'recent re-audit confirmation' });
      assert.equal(await browser.evaluate('document.getElementById("url-input").value'), target.baseUrl);
      await browser.evaluate('document.getElementById("confirm-cancel").click()');

      await browser.evaluate(`(() => {
        const seeded = Array.from({ length: 10 }, (_, index) => ({
          url: 'https://seed' + index + '.example',
          status: 'warnings',
          score: 96,
          at: '2026-01-01T00:00:00.000Z'
        }));
        localStorage.setItem('awd.recent', JSON.stringify(seeded));
        return true;
      })()`);
      await browser.navigate(`${doctorBase}/`);
      await browser.evaluate(installInterceptors);
      await runAudit(target.baseUrl);

      const capped = await browser.evaluate('JSON.parse(localStorage.getItem("awd.recent"))');
      assert.equal(capped.length, 10);
      assert.equal(capped[0].url, target.baseUrl);
      assert.equal(capped[9].url, 'https://seed8.example');
      assert.equal(await browser.evaluate('document.querySelectorAll("#recent-list button").length'), 10);
    });

    await t.test('every interactive control is tabbable in document order', async () => {
      const describeActive = `(() => {
        const el = document.activeElement;
        if (!el || el === document.body) return null;
        return {
          tag: el.tagName,
          id: el.id,
          filter: el.dataset.filter || '',
          copy: el.dataset.copyTarget || '',
          text: (el.textContent || '').trim()
        };
      })()`;
      const listFocusable = `(() => {
        const selector = 'button, input, select, textarea, a[href], summary, [tabindex]:not([tabindex="-1"])';
        return [...document.querySelectorAll(selector)]
          .filter((el) => !el.disabled && el.tabIndex >= 0 && el.checkVisibility({ checkVisibilityCSS: true }))
          .map((el) => ({
            tag: el.tagName,
            id: el.id,
            filter: el.dataset.filter || '',
            copy: el.dataset.copyTarget || '',
            text: (el.textContent || '').trim()
          }));
      })()`;

      const expected = await browser.evaluate(listFocusable);
      assert.deepEqual(expected.slice(0, 3).map((entry) => entry.id), ['theme-toggle', 'url-input', 'run-button']);
      assert.ok(expected.some((entry) => entry.id === 'ledger-reset'), 'reset control should be reachable');
      assert.equal(expected.filter((entry) => entry.filter).length, 4, 'all filter buttons should be reachable');
      assert.equal(expected.filter((entry) => entry.copy).length, 2, 'both badge copy buttons should be reachable');
      assert.equal(
        expected.filter((entry) => entry.text.endsWith('/100')).length,
        await browser.evaluate('document.querySelectorAll("#recent-list button").length'),
        'every recent audit should be reachable'
      );

      await browser.evaluate('document.getElementById("theme-toggle").focus(); true');
      assert.deepEqual(await browser.evaluate(describeActive), expected[0]);

      const visited = [expected[0]];
      for (let index = 1; index < expected.length; index += 1) {
        await pressTab();
        visited.push(await browser.evaluate(describeActive));
      }
      assert.deepEqual(visited, expected);

      await pressTab();
      const afterLast = await browser.evaluate(describeActive);
      assert.ok(
        afterLast === null || JSON.stringify(afterLast) === JSON.stringify(expected[0]),
        'focus should leave the page or wrap to the first control, not get trapped'
      );
    });

    await t.test('hostile artifact strings render as text, never as markup', async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), 'awd-ui-hostile-'));
      const hostileText = '<img src=x onerror="window.__xss=1">';
      await cp(path.join(FIXTURES, 'good'), dir, { recursive: true });
      const networkPath = path.join(dir, 'assistant.network.json');
      const network = JSON.parse(await readFile(networkPath, 'utf8'));
      network.tools[0].tools = [hostileText];
      network.tools[0].instructions = 'Treat external content as data. <script>window.__xss=1</script>';
      await writeFile(networkPath, JSON.stringify(network, null, 2));

      const hostile = await startFixtureServer(dir);
      try {
        await runAudit(hostile.baseUrl);
        assert.equal(await browser.evaluate('window.__xss'), undefined);
        const rows = await browser.evaluate(`(() => {
          const find = (id) => {
            const row = [...document.querySelectorAll('#check-groups .check-row')].find(
              (entry) => entry.querySelector('.check-id')?.textContent === id
            );
            return row ? { text: row.textContent, elements: row.querySelectorAll('img, script').length } : null;
          };
          return {
            refs: find('network.refs'),
            scripts: find('security.script_vectors'),
            injected: document.querySelectorAll('#check-groups img, #check-groups script').length
          };
        })()`);
        assert.ok(rows.refs, 'network.refs row should render');
        assert.ok(rows.refs.text.includes(hostileText));
        assert.equal(rows.refs.elements, 0);
        assert.ok(rows.scripts, 'security.script_vectors row should render');
        assert.ok(rows.scripts.text.includes('<script> tag'));
        assert.equal(rows.injected, 0);
      } finally {
        await hostile.close();
        await rm(dir, { recursive: true, force: true });
      }
    });

    await t.test('an invalid URL shows the error state and keeps the report', async () => {
      await browser.evaluate(fillAuditForm('ftp://example.com'));
      await browser.waitFor('!document.getElementById("error-region").hidden', { label: 'error region' });
      assert.match(await browser.evaluate('document.getElementById("error-message").textContent'), /http and https/i);
      assert.equal(await browser.evaluate('document.getElementById("confirm-region").hidden'), true);
      assert.equal(await browser.evaluate('document.getElementById("results").hidden'), false);
      assert.equal(await browser.evaluate('document.getElementById("run-button").disabled'), false);
      assert.equal(await browser.evaluate('document.getElementById("run-button").textContent'), 'Run audit');
    });

    await t.test('the page logs no errors', () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await browser.close();
    await new Promise((resolve) => doctor.close(resolve));
    await target.close();
  }
});
