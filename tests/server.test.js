import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import { createStaticServer } from '../scripts/serve.mjs';

test('el servidor entrega la aplicación y protege los archivos privados', async t => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'sortea-server-'));
  const root = path.join(temporary, 'site');
  await mkdir(path.join(root, 'src'), { recursive: true });
  await mkdir(path.join(root, '.git'));
  await writeFile(path.join(root, 'index.html'), '<!doctype html><title>Sortea</title>');
  await writeFile(path.join(root, 'src', 'app.js'), 'export const ready = true;');
  await writeFile(path.join(root, '.git', 'config'), 'private');
  await writeFile(path.join(root, 'package.json'), '{"private":true}');
  await writeFile(path.join(temporary, 'secret.txt'), 'secret');
  await symlink(path.join(temporary, 'secret.txt'), path.join(root, 'src', 'escape.txt'));
  const server = createStaticServer({ root });
  t.after(async () => {
    await new Promise(resolve => server.close(resolve));
    await rm(temporary, { recursive: true, force: true });
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const port = server.address().port;

  function request(route, method = 'GET') {
    return new Promise((resolve, reject) => {
      const req = http.request({ hostname: '127.0.0.1', port, path: route, method }, response => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', chunk => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      req.on('error', reject);
      req.end();
    });
  }

  const page = await request('/');
  assert.equal(page.status, 200);
  assert.match(page.headers['content-type'], /^text\/html/);
  assert.match(page.body, /Sortea/);
  const script = await request('/src/app.js?cache=1');
  assert.equal(script.status, 200);
  assert.match(script.headers['content-type'], /^text\/javascript/);
  assert.equal(script.body, 'export const ready = true;');
  const head = await request('/src/app.js', 'HEAD');
  assert.equal(head.status, 200);
  assert.equal(head.body, '');
  assert.equal(Number(head.headers['content-length']), Buffer.byteLength(script.body));

  for (const route of ['/missing', '/package.json', '/.git/config', '/src/../package.json', '/src/%2e%2e/package.json', '/src/%2ehidden', '/src/escape.txt', '/src/%5c..%5csecret.txt', '/src/%00']) {
    assert.equal((await request(route)).status, 404, route);
  }
  assert.equal((await request('/src/%ZZ')).status, 400);
  const post = await request('/', 'POST');
  assert.equal(post.status, 405);
  assert.equal(post.headers.allow, 'GET, HEAD');
});
