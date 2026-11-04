import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createStaticServer } from '../scripts/serve.mjs';

const browserPath = process.env.BROWSER_PATH || '/usr/bin/chromium';

async function until(check, message, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = await check();
    if (result) return result;
    await delay(30);
  }
  throw new Error(`Tiempo agotado: ${message}`);
}

async function connectCDP(url, onEvent) {
  const socket = new WebSocket(url);
  await once(socket, 'open');
  let nextId = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (!message.id) {
      onEvent(message);
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) return;
    pending.delete(message.id);
    clearTimeout(entry.timer);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
  });
  socket.addEventListener('close', () => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(new Error('El navegador cerró la conexión CDP'));
    }
    pending.clear();
  });
  return {
    send(method, params = {}) {
      const id = ++nextId;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP no respondió: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer });
        socket.send(JSON.stringify({ id, method, params }));
      });
    },
    close() { socket.close(); },
  };
}

test('Sortea funciona en Chromium de escritorio y móvil', { timeout: 60000 }, async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sortea-browser-'));
  const profile = path.join(temporary, 'profile');
  const downloads = path.join(temporary, 'downloads');
  await mkdir(downloads);
  const server = createStaticServer(process.env.BROWSER_TEST_DIST === '1'
    ? { root: new URL('../dist/', import.meta.url).pathname }
    : undefined);
  let browser;
  let cdp;
  let browserOutput = '';
  t.after(async () => {
    cdp?.close();
    if (browser && browser.exitCode === null) {
      const exited = once(browser, 'exit');
      browser.kill('SIGTERM');
      const stopped = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
      if (!stopped) {
        browser.kill('SIGKILL');
        await exited;
      }
    }
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = spawn(browserPath, [
    '--headless=new', '--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu',
    '--disable-background-networking', '--no-first-run', '--no-default-browser-check',
    '--disable-features=MediaRouter', '--remote-debugging-port=0',
    `--user-data-dir=${profile}`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  let launchError;
  browser.on('error', error => { launchError = error; });
  browser.stderr.on('data', chunk => { browserOutput = (browserOutput + chunk.toString()).slice(-10000); });
  const debugPort = await until(async () => {
    if (launchError) throw launchError;
    if (browser.exitCode !== null) throw new Error(`Chromium terminó antes de arrancar: ${browserOutput}`);
    try {
      return Number((await readFile(path.join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]);
    } catch { return false; }
  }, 'Chromium debe abrir el puerto de depuración');
  const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json/list`)).json();
  const page = targets.find(target => target.type === 'page');
  assert.ok(page?.webSocketDebuggerUrl, 'Chromium debe ofrecer una página depurable');
  const errors = [];
  cdp = await connectCDP(page.webSocketDebuggerUrl, event => {
    if (event.method === 'Runtime.exceptionThrown') errors.push(event.params.exceptionDetails.exception?.description || event.params.exceptionDetails.text);
    if (event.method === 'Runtime.consoleAPICalled' && event.params.type === 'error') errors.push(event.params.args.map(argument => argument.value || argument.description).join(' '));
    if (event.method === 'Log.entryAdded' && event.params.entry.level === 'error') errors.push(event.params.entry.text);
  });
  await cdp.send('Page.enable');
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });

  async function evaluate(expression) {
    const response = await cdp.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (response.exceptionDetails) throw new Error(response.exceptionDetails.exception?.description || response.exceptionDetails.text);
    return response.result.value;
  }
  const text = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).textContent`);
  const click = selector => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const fill = (selector, value) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', {bubbles: true})); })()`);
  const winners = () => evaluate(`[...document.querySelectorAll('#winner-list .winner-name')].map(node => node.textContent)`);
  const waitFor = (expression, message) => until(() => evaluate(expression), message);
  const screenshot = async filename => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(filename, Buffer.from(shot.data, 'base64'));
  };
  await cdp.send('Page.navigate', { url: origin });
  await waitFor(`document.readyState === 'complete' && document.getElementById('draw-button')`, 'la aplicación debe cargar');
  await screenshot('/tmp/sortea-desktop.png');

  await t.test('valida un sorteo vacío y deduplica participantes', async () => {
    await click('#draw-button');
    assert.equal(await evaluate(`document.getElementById('form-error').hidden`), false);
    assert.match(await text('#form-error'), /Añade al menos un participante/);
    await fill('#participants', 'Ana\n ana \nBruno\nCarla\nDiego');
    await fill('#raffle-title', 'Sorteo de prueba');
    await fill('#winner-count', '2');
    assert.equal(await text('#participants-count'), '4 participantes');
    assert.match(await text('#participants-hint'), /1 duplicado omitido/);
  });

  let firstWinners;
  await t.test('elige ganadores únicos y excluye ganadores anteriores', async () => {
    await click('#draw-button');
    await waitFor(`document.getElementById('history-count').textContent === '1'`, 'el primer sorteo debe terminar');
    firstWinners = await winners();
    assert.equal(firstWinners.length, 2);
    assert.equal(new Set(firstWinners).size, 2);
    assert.ok(firstWinners.every(name => ['Ana', 'Bruno', 'Carla', 'Diego'].includes(name)));
    assert.match(await text('#participants-hint'), /2 ya ganaron; 2 en juego/);
    await click('#draw-button');
    await waitFor(`document.getElementById('history-count').textContent === '2'`, 'el segundo sorteo debe terminar');
    const secondWinners = await winners();
    assert.equal(secondWinners.length, 2);
    assert.equal(new Set([...firstWinners, ...secondWinners]).size, 4);
    await click('#draw-button');
    assert.match(await text('#form-error'), /Todos estos participantes ya ganaron/);
  });

  await t.test('recupera datos al recargar y abre resultados del historial', async () => {
    await cdp.send('Page.reload');
    await waitFor(`document.getElementById('history-count')?.textContent === '2'`, 'el historial debe persistir');
    assert.equal(await evaluate(`document.getElementById('raffle-title').value`), 'Sorteo de prueba');
    assert.equal(await evaluate(`document.getElementById('winner-count').value`), '2');
    await click('#history-list li:last-child button');
    assert.deepEqual(await winners(), firstWinners);
    assert.equal(await text('#result-raffle-title'), 'Sorteo de prueba');
  });

  await t.test('descarga el resultado visible como CSV', async () => {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await click('#download-results');
    const filename = await until(async () => (await readdir(downloads)).find(name => name.endsWith('.csv')), 'se debe descargar el CSV');
    const csv = await readFile(path.join(downloads, filename), 'utf8');
    assert.ok(csv.includes('Sorteo de prueba'));
    assert.ok(firstWinners.every(name => csv.includes(name)));
  });

  await t.test('permite cancelar y confirmar el borrado del historial', async () => {
    await click('#clear-history');
    assert.equal(await evaluate(`document.getElementById('clear-dialog').open`), true);
    await click('#clear-dialog .dialog-secondary');
    assert.equal(await text('#history-count'), '2');
    await click('#clear-history');
    await click('#confirm-clear');
    assert.equal(await text('#history-count'), '0');
    assert.equal(await evaluate(`document.getElementById('history-empty').hidden`), false);
    assert.match(await text('#stage-status'), /4 en juego/);
  });

  await t.test('importa TXT, conserva nombres y muestra texto potencialmente HTML literalmente', async () => {
    await fill('#participants', 'Base');
    const literalName = '<img src=x onerror=window.__xss=true>';
    const file = path.join(temporary, 'participantes.txt');
    await writeFile(file, `Elena\nFernán\nbase\n${literalName}`, 'utf8');
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' });
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
    await waitFor(`document.getElementById('participants-count').textContent === '4 participantes'`, 'el archivo debe aportar participantes');
    assert.match(await evaluate(`document.getElementById('participants').value`), /^Base\nElena\nFernán/);
    await fill('#winner-count', '4');
    await click('#draw-button');
    await waitFor(`document.getElementById('history-count').textContent === '1'`, 'el sorteo importado debe terminar');
    assert.ok((await winners()).includes(literalName));
    assert.equal(await evaluate(`document.querySelector('#winner-list img')`), null);
    assert.equal(await evaluate(`Boolean(window.__xss)`), false);
  });

  await t.test('se adapta a móvil y abre/cierra la ayuda accesible', async () => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('/tmp/sortea-mobile.png');
    assert.ok(await evaluate('document.documentElement.scrollWidth <= window.innerWidth'), 'no debe desbordar horizontalmente');
    await click('#help-button');
    assert.equal(await evaluate(`document.getElementById('help-dialog').open`), true);
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    assert.equal(await evaluate(`document.getElementById('help-dialog').open`), false);
  });

  await t.test('no genera errores de JavaScript ni errores de carga', () => {
    assert.deepEqual(errors, []);
  });
});
