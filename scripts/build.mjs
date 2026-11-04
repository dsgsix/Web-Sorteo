import { cp, mkdir, rm, access } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const projectRoot = fileURLToPath(new URL('../', import.meta.url));
const output = new URL('../dist/', import.meta.url);

// Check inputs before replacing the previous build.
await access(new URL('../index.html', import.meta.url));
await access(new URL('../src/app.js', import.meta.url));
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(new URL('../index.html', import.meta.url), new URL('index.html', output));
await cp(new URL('../src/', import.meta.url), new URL('src/', output), { recursive: true });
console.log(`Compilación lista en ${projectRoot}dist/`);
