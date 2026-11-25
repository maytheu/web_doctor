import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { createServer } from '../server.mjs';
import { startFixtureServer } from './helpers/fixture-server.mjs';
import { findBrowser, launchBrowser } from './helpers/browser.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const FIXTURES = path.join(ROOT, 'fixtures');
const SECRET = 'sk-test-browser-e2e';
const PEER_ORIGIN = 'http://127.0.0.1:8788';
const LABEL = 'agentic "web" & <badge>';
const LABEL_QUERY = 'agentic+%22web%22+%26+%3Cbadge%3E';

const browserPath = findBrowser();
const skip = !browserPath
  ? 'Chrome or Edge not found; set CHROME_PATH to run the browser e2e test'
  : typeof WebSocket === 'undefined'
    ? 'This Node.js runtime has no global WebSocket; use Node >= 22'
    : false;

const reply = (content) => ({ choices: [{ message: { content } }] });
const toolCall = (name, args) => ({
  choices: [
    {
      message: {
        content: null,
        tool_calls: [
          { id: `call_${name}`, type: 'function', function: { name, arguments: JSON.stringify(args) } }
        ]
      }
    }
  ]
});

function isPeerPrompt(body) {
  return body.messages?.[0]?.role === 'system' && String(body.messages[0].content).startsWith('You are ');
}

function hasToolResult(body) {
  const messages = body.messages ?? [];
  const lastUser = messages.map((message) => message.role).lastIndexOf('user');
  return messages.slice(lastUser + 1).some((message) => message.role === 'tool');
}

function lastToolResult(calls) {
  for (let index = calls.length - 1; index >= 0; index -= 1) {
    const last = calls[index].body?.messages?.at(-1);
    if (last?.role === 'tool') {
      try {
        return JSON.parse(last.content);
      } catch {
        return null;
      }
    }
  }
  return null;
}

function startRouter() {
  const calls = [];
  let handler = () => reply('No scenario is active.');
  const server = http.createServer(async (req, res) => {
    const cors = {
      'access-control-allow-origin': '*',
      'access-control-allow-methods': 'POST, OPTIONS',
      'access-control-allow-headers': 'content-type, authorization'
    };
    if (req.method === 'OPTIONS') {
      res.writeHead(204, cors);
      res.end();
      return;
    }
    let raw = '';
    for await (const chunk of req) raw += chunk;
    let body = null;
    try {
      body = JSON.parse(raw);
    } catch {
      body = null;
    }
    calls.push({ authorization: req.headers.authorization ?? null, body, raw });
    const out = handler(body ?? { messages: [] }, calls);
    res.writeHead(200, { ...cors, 'content-type': 'application/json' });
    res.end(JSON.stringify(out));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      resolve({
        baseUrl: `http://127.0.0.1:${server.address().port}`,
        calls,
        setHandler: (next) => {
          handler = next;
        },
        close: () => new Promise((done) => server.close(done))
      });
    });
  });
}

const sendScript = (text) => `(() => {
  const input = document.getElementById('agent-message');
  input.value = ${JSON.stringify(text)};
  input.form.requestSubmit();
  return true;
})()`;

const clickConsent = (decision) =>
  `(() => { document.querySelector('.runtime-consent button[value=${decision}]').click(); return true; })()`;

async function sendMessage(browser, text) {
  const before = await browser.evaluate('document.querySelectorAll(".runtime-assistant").length');
  await browser.evaluate(sendScript(text));
  return before;
}

async function waitForAnswer(browser, before) {
  await browser.waitFor(`document.querySelectorAll(".runtime-assistant").length > ${before}`, {
    label: 'assistant answer'
  });
  return browser.evaluate('[...document.querySelectorAll(".runtime-assistant .runtime-text")].at(-1).textContent');
}

test('browser e2e: consent, actions, peer load and receipt in a real page', { skip }, async (t) => {
  const router = await startRouter();
  const target = await startFixtureServer(path.join(FIXTURES, 'good'));
  const deniedTarget = await startFixtureServer(path.join(FIXTURES, 'warn-only'));
  const publicDir = await mkdtemp(path.join(os.tmpdir(), 'awd-public-'));
  await cp(path.join(ROOT, 'public'), publicDir, { recursive: true });
  const linksPath = path.join(publicDir, 'links.json');
  const links = JSON.parse(await readFile(linksPath, 'utf8'));
  links.networks.doctor_audit_assistant.demo_peer = `${PEER_ORIGIN}/demo.network.json`;
  await writeFile(linksPath, JSON.stringify(links, null, 2));
  const doctor = createServer({ allowPrivate: true, publicDir });
  await new Promise((resolve) => doctor.listen(0, '127.0.0.1', resolve));
  const doctorBase = `http://127.0.0.1:${doctor.address().port}`;

  const peerRequests = [];
  let peer = null;
  try {
    peer = await startFixtureServer(path.join(FIXTURES, 'demo-peer'), {
      port: 8788,
      onRequest: (req) => peerRequests.push({ url: req.url, authorization: req.headers.authorization ?? null })
    });
  } catch {
    peer = null;
  }

  const browser = await launchBrowser(browserPath);
  const pageErrors = [];
  const consoleErrors = [];
  const networkUrls = [];
  browser.on('Runtime.exceptionThrown', (params) => {
    pageErrors.push(params.exceptionDetails?.exception?.description ?? params.exceptionDetails?.text ?? 'unknown');
  });
  browser.on('Runtime.consoleAPICalled', (params) => {
    if (params.type === 'error') {
      consoleErrors.push(params.args.map((arg) => arg.value ?? arg.description ?? '').join(' '));
    }
  });
  browser.on('Network.requestWillBeSent', (params) => {
    networkUrls.push(params.request.url);
  });

  try {
    await t.test('boots the runtime and saves BYOK settings through the UI', async () => {
      await browser.navigate(`${doctorBase}/`);
      await browser.waitFor('document.querySelector(".runtime-chat") !== null', { label: 'agent panel' });
      await browser.waitFor('document.querySelector("input[name=model]").value.length > 0', {
        label: 'runtime ready'
      });

      const saved = await browser.evaluate(`(() => {
        const form = document.querySelector('.runtime-settings-form');
        form.querySelector('input[name="baseUrl"]').value = ${JSON.stringify(router.baseUrl)};
        form.querySelector('input[name="model"]').value = 'test-model';
        form.querySelector('input[name="key"]').value = ${JSON.stringify(SECRET)};
        form.requestSubmit();
        return document.querySelector('.runtime-settings-status').textContent;
      })()`);
      assert.match(saved, /Saved/);
      assert.equal(await browser.evaluate('document.querySelector("input[name=key]").value'), '');
      assert.equal(await browser.evaluate('document.querySelector(".runtime-chat button").disabled'), false);

      await browser.evaluate(`(() => {
        window.__consentOpens = 0;
        const dialog = document.querySelector('.runtime-consent');
        const original = dialog.showModal.bind(dialog);
        dialog.showModal = function showModal() {
          window.__consentOpens += 1;
          return original();
        };
        return true;
      })()`);
    });

    await t.test('audits after consent, remembers the allow and keeps the key off the page', async () => {
      router.setHandler((body) => {
        if (hasToolResult(body)) return reply('Audit complete.');
        return toolCall('website_run_audit', { url: target.baseUrl });
      });

      const before = await sendMessage(browser, 'Audit the fixture site.');
      await browser.waitFor('document.querySelector(".runtime-consent").open', { label: 'consent dialog' });
      assert.equal(await browser.evaluate('window.__consentOpens'), 1);
      const originShown = await browser.evaluate(
        'document.querySelector(".runtime-consent code").textContent'
      );
      assert.equal(originShown, target.baseUrl);
      await browser.evaluate(clickConsent('allow'));
      assert.equal(await waitForAnswer(browser, before), 'Audit complete.');

      const audits = networkUrls.filter((url) => url.includes('/api/audit'));
      assert.equal(audits.length, 1);
      assert.ok(audits[0].includes(encodeURIComponent(target.baseUrl)));

      assert.equal(router.calls[0].authorization, `Bearer ${SECRET}`);
      assert.ok(router.calls.every((call) => !call.raw.includes(SECRET)));

      const lines = await browser.evaluate('[...document.querySelectorAll("#receipt-list li")].map((item) => item.textContent)');
      assert.ok(lines.includes('Key sent to peer sites: no'));
      assert.ok(lines.includes('sly_data forwarded to peers: none'));
      assert.ok(lines.includes('Audit artifacts fetched server-side: 3'));
      assert.ok(lines.some((line) => line.startsWith('Router:') && line.includes(new URL(router.baseUrl).host)));
      assert.ok(
        lines.some(
          (line) =>
            line.startsWith('Origins contacted this session:') &&
            line.includes(new URL(target.baseUrl).host) &&
            line.includes(new URL(router.baseUrl).host)
        )
      );
      assert.ok(lines.some((line) => line.startsWith('Consent decisions:') && line.includes(`${target.baseUrl} allowed`)));

      const second = await sendMessage(browser, 'Audit it again.');
      assert.equal(await waitForAnswer(browser, second), 'Audit complete.');
      assert.equal(await browser.evaluate('window.__consentOpens'), 1);
      assert.equal(networkUrls.filter((url) => url.includes('/api/audit')).length, 2);
    });

    await t.test('a denied audit consent contacts nothing and is remembered', async () => {
      router.setHandler((body) => {
        if (hasToolResult(body)) return reply('Contact declined.');
        return toolCall('website_run_audit', { url: deniedTarget.baseUrl });
      });

      const before = await sendMessage(browser, 'Audit the warn-only site.');
      await browser.waitFor('document.querySelector(".runtime-consent").open', { label: 'second consent dialog' });
      assert.equal(await browser.evaluate('window.__consentOpens'), 2);
      await browser.evaluate(clickConsent('deny'));
      assert.equal(await waitForAnswer(browser, before), 'Contact declined.');

      const deniedCalls = networkUrls.filter(
        (url) => url.includes('/api/audit') && url.includes(encodeURIComponent(deniedTarget.baseUrl))
      );
      assert.equal(deniedCalls.length, 0);
      assert.match(lastToolResult(router.calls).error, /declined/);

      const lines = await browser.evaluate('[...document.querySelectorAll("#receipt-list li")].map((item) => item.textContent)');
      assert.ok(lines.some((line) => line.startsWith('Consent decisions:') && line.includes(`${deniedTarget.baseUrl} denied`)));

      const retry = await sendMessage(browser, 'Try the warn-only site once more.');
      assert.equal(await waitForAnswer(browser, retry), 'Contact declined.');
      assert.equal(await browser.evaluate('window.__consentOpens'), 2);
    });

    await t.test('read-only actions return grounded results without new consent', async () => {
      router.setHandler((body) =>
        hasToolResult(body) ? reply('Report loaded.') : toolCall('website_get_last_report', {})
      );
      const reportSend = await sendMessage(browser, 'Show the last report.');
      assert.equal(await waitForAnswer(browser, reportSend), 'Report loaded.');
      const report = lastToolResult(router.calls);
      assert.equal(report.available, true);
      assert.equal(report.status, 'conformant');
      assert.equal(report.artifactCount, 3);

      router.setHandler((body) =>
        hasToolResult(body) ? reply('Check explained.') : toolCall('website_explain_check', { check_id: 'missing.check' })
      );
      const explainSend = await sendMessage(browser, 'Explain check missing.check.');
      assert.equal(await waitForAnswer(browser, explainSend), 'Check explained.');
      const explained = lastToolResult(router.calls);
      assert.equal(explained.found, false);
      assert.match(explained.message, /Unknown check/);
      assert.ok(networkUrls.some((url) => url.endsWith('/api/catalog')));

      router.setHandler((body) =>
        hasToolResult(body)
          ? reply('Badge ready.')
          : toolCall('website_propose_badge', { url: 'https://example.com', label: LABEL })
      );
      const auditsBefore = networkUrls.filter((url) => url.includes('/api/audit')).length;
      const badgesBefore = networkUrls.filter((url) => url.includes('/api/badge')).length;
      const badgeSend = await sendMessage(browser, 'Propose a badge with my label.');
      assert.equal(await waitForAnswer(browser, badgeSend), 'Badge ready.');

      const badge = lastToolResult(router.calls);
      const expectedBadgeUrl = `${doctorBase}/api/badge?url=https%3A%2F%2Fexample.com%2F&label=${LABEL_QUERY}`;
      const expectedPageUrl = `${doctorBase}/?url=https%3A%2F%2Fexample.com%2F`;
      assert.equal(badge.badgeUrl, expectedBadgeUrl);
      assert.equal(badge.pageUrl, expectedPageUrl);
      assert.equal(badge.markdown, `[![${LABEL}](${expectedBadgeUrl})](${expectedPageUrl})`);
      assert.ok(badge.html.includes('alt="agentic &quot;web&quot; &amp; &lt;badge&gt;"'));
      assert.ok(badge.html.includes('&amp;label='));
      assert.ok(!badge.html.includes('<badge>'));
      assert.equal(networkUrls.filter((url) => url.includes('/api/audit')).length, auditsBefore);
      assert.equal(networkUrls.filter((url) => url.includes('/api/badge')).length, badgesBefore);
      assert.equal(await browser.evaluate('window.__consentOpens'), 2);
    });

    await t.test(
      'loads the demo peer after consent without forwarding the key',
      { skip: peer ? false : 'port 8788 is in use; the e2e pins the demo peer to the local fixture' },
      async () => {
        router.setHandler((body) => {
          if (isPeerPrompt(body)) return reply('Peer answer.');
          if (hasToolResult(body)) return reply('Peer loaded.');
          return toolCall('peer_demo_peer', { request: 'Say hi.' });
        });

        const before = await sendMessage(browser, 'Load the demo peer.');
        await browser.waitFor('document.querySelector(".runtime-consent").open', { label: 'peer consent dialog' });
        assert.equal(await browser.evaluate('window.__consentOpens'), 3);
        await browser.evaluate(clickConsent('allow'));
        assert.equal(await waitForAnswer(browser, before), 'Peer loaded.');

        assert.deepEqual(lastToolResult(router.calls), {
          peer: 'demo_peer',
          origin: PEER_ORIGIN,
          frontMan: 'peer_greeter',
          answer: 'Peer answer.'
        });
        assert.ok(peerRequests.some((request) => request.url === '/agent-manifest.json'));
        assert.ok(peerRequests.some((request) => request.url === '/demo.network.json'));
        assert.ok(peerRequests.every((request) => request.authorization === null));

        const peerCall = router.calls.find((call) =>
          String(call.body?.messages?.[0]?.content ?? '').startsWith('You are peer_greeter')
        );
        assert.ok(peerCall);
        assert.equal(peerCall.authorization, `Bearer ${SECRET}`);

        const lines = await browser.evaluate('[...document.querySelectorAll("#receipt-list li")].map((item) => item.textContent)');
        assert.ok(lines.includes('Key sent to peer sites: no'));
        assert.ok(lines.includes('sly_data forwarded to peers: none'));
        assert.ok(lines.some((line) => line.startsWith('Consent decisions:') && line.includes(`${PEER_ORIGIN} allowed`)));
        assert.ok(
          lines.some((line) => line.startsWith('Origins contacted this session:') && line.includes(PEER_ORIGIN))
        );
      }
    );

    await t.test('the page logs no errors', () => {
      assert.deepEqual(pageErrors, []);
      assert.deepEqual(consoleErrors, []);
    });
  } finally {
    await browser.close();
    await new Promise((resolve) => doctor.close(resolve));
    await target.close();
    await deniedTarget.close();
    if (peer) await peer.close();
    await router.close();
    await rm(publicDir, { recursive: true, force: true });
  }
});
