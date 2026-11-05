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

test('Sortea funciona en Chromium de escritorio y móvil', { timeout: 90000 }, async t => {
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
  const fill = (selector, value) => evaluate(`(() => { const element = document.querySelector(${JSON.stringify(selector)}); element.value = ${JSON.stringify(value)}; element.dispatchEvent(new Event('input', {bubbles: true})); element.dispatchEvent(new Event('change', {bubbles: true})); })()`);
  const winners = () => evaluate(`[...document.querySelectorAll('#winner-list .winner-name')].map(node => node.textContent)`);
  const waitFor = (expression, message) => until(() => evaluate(expression), message);
  const screenshot = async filename => {
    const shot = await cdp.send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false });
    await writeFile(filename, Buffer.from(shot.data, 'base64'));
  };
  await cdp.send('Page.navigate', { url: origin });
  await waitFor(`document.readyState === 'complete' && document.getElementById('draw-button')`, 'la aplicación debe cargar');
  await screenshot('/tmp/sortea-desktop.png');

  const stageSelector = position => `#stages-list .prize-card:nth-child(${position})`;
  const stageNames = () => evaluate(`[...document.querySelectorAll('#stages-list .prize-name')].map(input => input.value)`);
  const assertStageLayout = async width => {
    await cdp.send('Emulation.setDeviceMetricsOverride', { width, height: 1100, deviceScaleFactor: 1, mobile: width <= 760 });
    const layout = await evaluate(`(() => {
      const cards = [...document.querySelectorAll('#stages-list .prize-card')];
      return {
        pageFits: document.documentElement.scrollWidth <= window.innerWidth,
        cards: cards.map(card => {
          const bounds = card.getBoundingClientRect();
          const controls = [...card.querySelectorAll('input:not([hidden]), button')].filter(control => control.getClientRects().length).map(control => {
            const rect = control.getBoundingClientRect();
            return { name: control.className, left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
          });
          return {
            scrollFits: card.scrollWidth <= card.clientWidth + 1,
            outside: controls.filter(control => control.left < bounds.left - 1 || control.right > bounds.right + 1 || control.top < bounds.top - 1 || control.bottom > bounds.bottom + 1),
            overlaps: controls.flatMap((first, index) => controls.slice(index + 1).filter(second => Math.min(first.right, second.right) - Math.max(first.left, second.left) > 1 && Math.min(first.bottom, second.bottom) - Math.max(first.top, second.top) > 1).map(second => [first.name, second.name]))
          };
        })
      };
    })()`);
    assert.equal(layout.pageFits, true, `la página debe caber en ${width}px`);
    for (const [index, card] of layout.cards.entries()) {
      assert.equal(card.scrollFits, true, `la tarjeta ${index + 1} no debe desbordar en ${width}px`);
      assert.deepEqual(card.outside, [], `los controles deben caber dentro de la tarjeta ${index + 1} en ${width}px`);
      assert.deepEqual(card.overlaps, [], `los controles no deben solaparse dentro de la tarjeta ${index + 1} en ${width}px`);
    }
  };
  const statistic = async selector => Number((await text(selector)).match(/[0-9]+/)[0]);
  const historyCount = () => statistic('#history-count');
  const winnerDetails = () => evaluate(`[...document.querySelectorAll('#winner-list li')].map(item => ({name:item.querySelector('.winner-name')?.textContent, meta:item.querySelector('.winner-meta')?.textContent}))`);
  const upload = async (selector, file) => {
    const { root } = await cdp.send('DOM.getDocument');
    const { nodeId } = await cdp.send('DOM.querySelector', { nodeId: root.nodeId, selector });
    assert.ok(nodeId, `debe existir el campo de archivo ${selector}`);
    await cdp.send('DOM.setFileInputFiles', { nodeId, files: [file] });
  };
  const completeDraw = async expectedHistory => {
    assert.equal(await evaluate(`document.getElementById('draw-button').disabled`), false, 'la etapa pendiente debe permitir sortear');
    await click('#draw-button');
    await waitFor(`document.getElementById('history-count').textContent === '${expectedHistory}'`, 'la etapa debe terminar y registrarse');
    assert.equal(await evaluate(`document.getElementById('results').hidden`), false);
  };
  const resetSession = async () => {
    await click('#new-session');
    assert.equal(await evaluate(`document.getElementById('new-session-dialog').open`), true);
    await click('#confirm-new-session');
    await waitFor(`!document.getElementById('new-session-dialog').open`, 'debe cerrar la confirmación');
  };
  const imageVisible = `(() => { const image = document.getElementById('prize-preview'); return !image.hidden && image.complete && image.naturalWidth > 0; })()`;
  await waitFor(`document.querySelectorAll('#stages-list .prize-card').length === 1`, 'debe existir la primera etapa');

  await t.test('valida nombres y cantidades y suma boletos por persona', async () => {
    await click('#draw-button');
    assert.equal(await evaluate(`document.getElementById('form-error').hidden`), false);
    assert.ok((await text('#form-error')).trim());
    for (const invalid of ['Ana;0', 'Ana;-2', 'Ana;1.5', ';2']) {
      await fill('#participants', invalid);
      await click('#draw-button');
      assert.equal(await evaluate(`document.getElementById('form-error').hidden`), false, invalid);
      assert.equal(await historyCount(), 0);
    }
    await fill('#participants', 'Ana;2\n ana \nBruno;2\nCarla\nDiego');
    await fill('#raffle-title', 'Sorteo de prueba');
    assert.equal(await statistic('#participants-count'), 4);
    assert.equal(await statistic('#ticket-total'), 7);
    assert.equal(await statistic('#eligible-total'), 7);
    const rows = await evaluate(`[...document.querySelectorAll('#participants-preview tr')].map(row => [...row.cells].map(cell => cell.textContent))`);
    assert.equal(rows.length, 4);
    const ana = rows.find(row => row[0].trim() === 'Ana');
    assert.ok(ana, 'debe agrupar Ana y ana');
    assert.match(ana[1], /3/);
    const chance = Number(ana[2].replace(',', '.').match(/[0-9]+(?:\.[0-9]+)?/)[0]);
    assert.ok(Math.abs(chance - 300 / 7) < 0.6, `probabilidad inicial esperada de Ana: 3/7, recibida ${chance}%`);
    await fill('#winner-count', '2.5');
    await click('#draw-button');
    assert.equal(await evaluate(`document.getElementById('form-error').hidden`), false);
    await fill('#winner-count', '2');
    assert.equal(await historyCount(), 0);
    await fill(`${stageSelector(1)} .prize-name`, 'Auriculares');
  });

  await t.test('añade, reordena y elimina etapas y sincroniza sus ganadores', async () => {
    await click('#add-stage');
    await fill(`${stageSelector(2)} .prize-name`, 'Tarjeta regalo');
    await click('#add-stage');
    await fill(`${stageSelector(3)} .prize-name`, 'Libro');
    assert.deepEqual(await stageNames(), ['Auriculares', 'Tarjeta regalo', 'Libro']);
    await click(`${stageSelector(1)} .move-stage-down`);
    assert.deepEqual(await stageNames(), ['Tarjeta regalo', 'Auriculares', 'Libro']);
    await click(`${stageSelector(2)} .move-stage-up`);
    assert.deepEqual(await stageNames(), ['Auriculares', 'Tarjeta regalo', 'Libro']);
    for (const width of [1440, 1024, 320, 390]) {
      await assertStageLayout(width);
      await evaluate(`window.scrollTo({ top: document.getElementById('premios').getBoundingClientRect().top + window.scrollY - 24, behavior: 'instant' })`);
      if (width === 1024) await screenshot('/tmp/sortea-stages-desktop.png');
      if (width === 320) await screenshot('/tmp/sortea-stages-mobile.png');
    }
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
    await click(`${stageSelector(3)} .remove-stage`);
    assert.deepEqual(await stageNames(), ['Auriculares', 'Tarjeta regalo']);
    await fill(`${stageSelector(1)} .stage-winner-count`, '2');
    assert.equal(await evaluate(`document.getElementById('winner-count').value`), '2');
    await fill(`${stageSelector(2)} .stage-winner-count`, '2');
    assert.equal(await evaluate(`document.querySelector('${stageSelector(2)} .prepare-stage').disabled`), true, 'no se salta una etapa pendiente');
  });

  const prizeImage = path.join(temporary, 'premio.png');
  await t.test('sube una imagen real, la guarda en IndexedDB y la recupera al recargar', async () => {
    // A real PNG is generated by the browser, exercising signature checks and image decoding.
    const imageData = await evaluate(`(() => { const canvas = document.createElement('canvas'); canvas.width = 96; canvas.height = 64; const ctx = canvas.getContext('2d'); ctx.fillStyle = '#d8ae57'; ctx.fillRect(0,0,96,64); ctx.fillStyle = '#171717'; ctx.fillRect(38,0,20,64); ctx.fillRect(0,22,96,20); return canvas.toDataURL('image/png').split(',')[1]; })()`);
    await writeFile(prizeImage, Buffer.from(imageData, 'base64'));
    await upload(`${stageSelector(1)} .prize-file`, prizeImage);
    await waitFor(imageVisible, 'la foto del premio debe mostrarse');
    assert.match(await evaluate(`document.getElementById('prize-preview').src`), /^blob:/);
    await cdp.send('Page.reload');
    await waitFor(`document.querySelectorAll('#stages-list .prize-card').length === 2`, 'las etapas deben persistir');
    await waitFor(imageVisible, 'la foto debe recuperarse desde IndexedDB');
    assert.deepEqual(await stageNames(), ['Auriculares', 'Tarjeta regalo']);
    assert.equal(await statistic('#ticket-total'), 7);
    await evaluate('window.scrollTo(0, 0)');
    await screenshot('/tmp/sortea-desktop.png');
  });

  await t.test('rechaza SVG, archivos sin imagen y PNG falsos sin reemplazar la foto válida', async () => {
    const previousPhoto = await evaluate(`document.getElementById('prize-preview').src`);
    const previousImageId = await evaluate(`JSON.parse(localStorage.getItem('sortea.workspace.v2')).stages[0].imageId`);
    const invalidImages = [
      ['premio.svg', '<svg xmlns="http://www.w3.org/2000/svg"><rect width="10" height="10"/></svg>', /SVG/],
      ['premio.txt', 'Este archivo no es una imagen.', /JPG, PNG, WebP o GIF/],
      ['falso.png', '<svg xmlns="http://www.w3.org/2000/svg"></svg>', /contenido no corresponde/],
    ];
    for (const [filename, content, expected] of invalidImages) {
      const file = path.join(temporary, filename);
      await writeFile(file, content, 'utf8');
      await upload(`${stageSelector(1)} .prize-file`, file);
      await waitFor(`!document.getElementById('draw-button').disabled && !document.getElementById('toast').hidden`, `${filename} debe terminar de validarse`);
      assert.match(await text('#toast'), expected);
      assert.equal(await evaluate(`document.getElementById('prize-preview').src`), previousPhoto);
      assert.equal(await evaluate(`JSON.parse(localStorage.getItem('sortea.workspace.v2')).stages[0].imageId`), previousImageId);
      assert.equal(await evaluate(imageVisible), true, 'debe conservarse la foto anterior');
    }
  });

  await t.test('conserva premios e imagen si se recarga durante una cantidad inválida', async () => {
    await fill('#winner-count', '');
    await fill(`${stageSelector(2)} .stage-winner-count`, '0');
    await click('#draw-button');
    assert.equal(await evaluate(`document.getElementById('form-error').hidden`), false);
    await cdp.send('Page.reload');
    await waitFor(`document.querySelectorAll('#stages-list .prize-card').length === 2`, 'las cantidades inválidas no deben eliminar etapas');
    await waitFor(imageVisible, 'debe conservar la foto del premio');
    assert.deepEqual(await stageNames(), ['Auriculares', 'Tarjeta regalo']);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('.stage-winner-count')].map(input => input.value)`), ['1', '1']);
    assert.equal(await evaluate(`document.getElementById('winner-count').value`), '1');
    assert.equal(await historyCount(), 0);
    await fill('#winner-count', '2');
    await fill(`${stageSelector(2)} .stage-winner-count`, '2');
  });

  let firstWinners;
  await t.test('sortea varias etapas en orden y excluye personas premiadas del evento', async () => {
    await completeDraw(1);
    firstWinners = await winners();
    assert.equal(firstWinners.length, 2);
    assert.equal(new Set(firstWinners).size, 2);
    assert.ok(firstWinners.every(name => ['Ana', 'Bruno', 'Carla', 'Diego'].includes(name)));
    const remaining = Object.entries({ Ana: 3, Bruno: 2, Carla: 1, Diego: 1 }).filter(([name]) => !firstWinners.includes(name)).reduce((sum, [, tickets]) => sum + tickets, 0);
    assert.equal(await statistic('#eligible-total'), remaining);
    assert.ok((await winnerDetails()).every(winner => /boleto/i.test(winner.meta)));
    assert.equal(await evaluate(`document.getElementById('draw-button').disabled`), true, 'una etapa completada no se repite');
    assert.equal(await evaluate(`document.getElementById('next-stage').hidden`), false);
    await click('#next-stage');
    assert.equal(await evaluate(`document.getElementById('winner-count').value`), '2');
    await completeDraw(2);
    const secondWinners = await winners();
    assert.equal(secondWinners.length, 2);
    assert.equal(new Set([...firstWinners, ...secondWinners]).size, 4);
    assert.equal(await statistic('#eligible-total'), 0);
    assert.match(await text('#stage-progress'), /2.*2/);
  });

  await t.test('recupera etapas completadas y consulta el premio anterior con su foto', async () => {
    await cdp.send('Page.reload');
    await waitFor(`document.getElementById('history-count')?.textContent === '2'`, 'el historial debe persistir');
    assert.equal(await evaluate(`document.getElementById('raffle-title').value`), 'Sorteo de prueba');
    assert.equal(await evaluate(`document.getElementById('draw-button').disabled`), true);
    await click('#history-list li:last-child button');
    assert.deepEqual(await winners(), firstWinners);
    assert.match(await text('#active-stage-label'), /Auriculares/);
    await waitFor(imageVisible, 'consultar el resultado recupera su imagen');
    const frameResult = () => evaluate(`window.scrollTo({ top: document.getElementById('stage-card').getBoundingClientRect().top + window.scrollY - 24, behavior: 'instant' })`);
    await frameResult();
    await screenshot('/tmp/sortea-result-desktop.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 1, mobile: true });
    await frameResult();
    await screenshot('/tmp/sortea-result-mobile.png');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false });
  });

  await t.test('descarga CSV con premio, nombres y números de boletos', async () => {
    await cdp.send('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: downloads });
    await click('#download-results');
    const filename = await until(async () => (await readdir(downloads)).find(name => name.endsWith('.csv')), 'se debe descargar el CSV');
    const csv = await readFile(path.join(downloads, filename), 'utf8');
    assert.ok(csv.includes('Sorteo de prueba'));
    assert.ok(csv.includes('Auriculares'));
    assert.match(csv, /Boleto/);
    assert.ok(firstWinners.every(name => csv.includes(name)));
  });

  await t.test('inicia un nuevo evento conservando participantes, premios, fotos e historial', async () => {
    await click('#new-session');
    await click('#new-session-dialog .dialog-secondary');
    assert.equal(await historyCount(), 2);
    await resetSession();
    assert.equal(await historyCount(), 2);
    assert.equal(await statistic('#ticket-total'), 7);
    assert.equal(await statistic('#eligible-total'), 7);
    assert.deepEqual(await stageNames(), ['Auriculares', 'Tarjeta regalo']);
    assert.equal(await evaluate(`document.getElementById('draw-button').disabled`), false);
    await waitFor(imageVisible, 'el nuevo evento conserva la foto');
  });

  await t.test('permite varios premios por persona pero nunca repite el boleto premiado', async () => {
    await fill('#participants', 'Solo;3');
    await click('#exclude-winners');
    assert.equal(await evaluate(`document.getElementById('exclude-winners').checked`), false);
    await fill('#winner-count', '1');
    await fill(`${stageSelector(2)} .stage-winner-count`, '1');
    await completeDraw(3);
    assert.deepEqual(await winners(), ['Solo']);
    const firstTicket = (await winnerDetails())[0].meta.match(/boleto\s*#?\s*(\d+)/i)?.[1];
    assert.ok(firstTicket, 'el resultado debe indicar el número del boleto');
    assert.equal(await statistic('#eligible-total'), 2);
    await click('#next-stage');
    await completeDraw(4);
    assert.deepEqual(await winners(), ['Solo']);
    const nextTicket = (await winnerDetails())[0].meta.match(/boleto\s*#?\s*(\d+)/i)?.[1];
    assert.ok(nextTicket);
    assert.notEqual(nextTicket, firstTicket);
    assert.equal(await statistic('#eligible-total'), 1);
  });

  await t.test('confirma el borrado del historial, reinicia etapas y permite retirar una foto', async () => {
    await click('#clear-history');
    assert.equal(await evaluate(`document.getElementById('clear-dialog').open`), true);
    await click('#clear-dialog .dialog-secondary');
    assert.equal(await historyCount(), 4);
    await click('#clear-history');
    await click('#confirm-clear');
    assert.equal(await historyCount(), 0);
    assert.equal(await evaluate(`document.getElementById('history-empty').hidden`), false);
    assert.equal(await statistic('#eligible-total'), 3);
    assert.equal(await evaluate(`document.getElementById('draw-button').disabled`), false);
    await waitFor(imageVisible, 'el borrado del historial conserva el premio');
    await click(`${stageSelector(1)} .remove-image`);
    await waitFor(`document.getElementById('prize-preview').hidden`, 'debe retirar la imagen del escenario');
  });

  await t.test('importa cantidades con cabecera, suma nombres y conserva el texto HTML literalmente', async () => {
    await fill('#participants', 'Base;2');
    const literalName = '<img src=x onerror=window.__xss=true>';
    const file = path.join(temporary, 'participantes.txt');
    await writeFile(file, `Nombre;Boletos\nElena;3\nFernán;1\nbase;2\n"${literalName}";1`, 'utf8');
    await upload('#file-input', file);
    await waitFor(`document.getElementById('participants-count').textContent.includes('4')`, 'el archivo debe aportar participantes');
    assert.equal(await statistic('#ticket-total'), 9);
    assert.match(await evaluate(`document.getElementById('participants').value`), /Base/);
    assert.equal(await evaluate(`document.querySelector('#participants-preview img')`), null);
    await click('#exclude-winners');
    assert.equal(await evaluate(`document.getElementById('exclude-winners').checked`), true);
    await fill('#winner-count', '4');
    await completeDraw(1);
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

  await t.test('descarta resultados corruptos con detalles nulos o probabilidades imposibles', async () => {
    await evaluate(`(() => {
      const saved = JSON.parse(localStorage.getItem('sortea.workspace.v2'));
      const valid = saved.history[0];
      saved.history.unshift(
        { ...valid, id: 'corrupt-null', title: 'Corrupto null', winnerDetails: null },
        { ...valid, id: 'corrupt-zero', title: 'Corrupto cero', winnerDetails: valid.winnerDetails.map(detail => ({ ...detail, probability: 0 })) }
      );
      localStorage.setItem('sortea.workspace.v2', JSON.stringify(saved));
    })()`);
    await cdp.send('Page.reload');
    await waitFor(`document.getElementById('history-count')?.textContent === '1'`, 'debe recuperar solo el resultado válido');
    assert.doesNotMatch(await text('#history-list'), /Corrupto/);
    assert.equal(await statistic('#ticket-total'), 9);
  });

  await t.test('migra el historial anterior sin restar boletos al evento nuevo', async () => {
    const previous = {
      version: 1, title: 'Sorteo anterior', participants: 'Pérez, Ana\nLuis "Lucho"\npérez, ana', winnerCount: 1, excludeWinners: true,
      history: [{ id: 'legacy-1', title: 'Premio anterior', createdAt: '2026-01-05T12:00:00.000Z', winners: ['Pérez, Ana'], participantCount: 2 }],
    };
    await evaluate(`localStorage.clear(); localStorage.setItem('sortea.workspace.v1', ${JSON.stringify(JSON.stringify(previous))})`);
    await cdp.send('Page.reload');
    await waitFor(`document.getElementById('history-count')?.textContent === '1'`, 'debe migrar el resultado anterior');
    assert.equal(await statistic('#participants-count'), 2);
    assert.equal(await statistic('#ticket-total'), 2);
    assert.equal(await statistic('#eligible-total'), 2);
    assert.deepEqual(await evaluate(`[...document.querySelectorAll('#participants-preview tr')].map(row => row.cells[0].textContent)`), ['pérez, ana', 'Luis "Lucho"']);
    await click('#history-list li button');
    assert.deepEqual(await winners(), ['Pérez, Ana']);
  });

  await t.test('no genera errores de JavaScript ni errores de carga', () => {
    assert.deepEqual(errors, []);
  });
});
