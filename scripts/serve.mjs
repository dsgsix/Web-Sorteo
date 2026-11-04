import http from 'node:http';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
};

export function createStaticServer({ root = projectRoot } = {}) {
  return http.createServer(async (request, response) => {
    const send = (status, text) => {
      response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
      response.end(request.method === 'HEAD' ? undefined : text);
    };
    if (request.method !== 'GET' && request.method !== 'HEAD') {
      response.setHeader('Allow', 'GET, HEAD');
      send(405, 'Método no permitido');
      return;
    }

    let pathname;
    try {
      pathname = decodeURIComponent((request.url ?? '/').split('?')[0]);
    } catch {
      send(400, 'Ruta no válida');
      return;
    }
    const segments = pathname.split('/');
    if (!pathname.startsWith('/') || pathname.includes('\\') || pathname.includes('\0') || segments.some(segment => segment.startsWith('.'))) {
      send(404, 'No encontrado');
      return;
    }
    const relative = pathname === '/' ? 'index.html' : pathname.slice(1);
    // Both development and production expose only the public application files.
    if (relative !== 'index.html' && !relative.startsWith('src/')) {
      send(404, 'No encontrado');
      return;
    }

    try {
      const rootPath = await realpath(root);
      const targetPath = await realpath(path.join(rootPath, relative));
      if (!targetPath.startsWith(`${rootPath}${path.sep}`) || !(await stat(targetPath)).isFile()) {
        send(404, 'No encontrado');
        return;
      }
      const data = await readFile(targetPath);
      response.writeHead(200, {
        'Content-Type': contentTypes[path.extname(targetPath)] ?? 'application/octet-stream',
        'Content-Length': data.length,
        'Cache-Control': 'no-cache',
        'X-Content-Type-Options': 'nosniff',
      });
      response.end(request.method === 'HEAD' ? undefined : data);
    } catch (error) {
      if (['ENOENT', 'ENOTDIR', 'EACCES', 'ELOOP'].includes(error.code)) {
        send(404, 'No encontrado');
      } else {
        console.error('Error al servir un archivo:', error.message);
        send(500, 'Error del servidor');
      }
    }
  });
}

function readOptions(args) {
  const options = { host: '127.0.0.1', port: 5173, root: projectRoot };
  for (let index = 0; index < args.length; index += 2) {
    const [flag, value] = [args[index], args[index + 1]];
    if (!value || !['--host', '--port', '--dir'].includes(flag)) {
      throw new Error('Uso: node scripts/serve.mjs [--host HOST] [--port PUERTO] [--dir dist]');
    }
    if (flag === '--host') options.host = value;
    if (flag === '--port') {
      if (!/^\d+$/.test(value) || Number(value) < 0 || Number(value) > 65535) throw new Error('Puerto no válido');
      options.port = Number(value);
    }
    if (flag === '--dir') {
      if (value !== 'dist') throw new Error('El único directorio alternativo permitido es dist');
      options.root = path.join(projectRoot, 'dist');
    }
  }
  return options;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = readOptions(process.argv.slice(2));
    await accessIndex(options.root);
    const server = createStaticServer(options);
    server.once('error', error => {
      console.error(`No se pudo iniciar Sortea: ${error.message}`);
      process.exitCode = 1;
    });
    server.listen(options.port, options.host, () => {
      console.log(`Sortea escuchando en ${options.host}:${server.address().port} (${options.root})`);
    });
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}

async function accessIndex(root) {
  await stat(path.join(root, 'index.html'));
}
