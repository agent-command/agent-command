/** Build-only sidecars for the server's Accept-Encoding negotiation; never compress on the request path. */
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { brotliCompress, constants, gzip } from 'node:zlib';

const brotli = promisify(brotliCompress);
const gz = promisify(gzip);
const extensions = { '.html': true, '.js': true, '.css': true, '.json': true, '.svg': true, '.txt': true, '.wasm': true };

async function precompress(directory) {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      await precompress(path);
    } else if (entry.isFile() && Object.hasOwn(extensions, extname(entry.name))) {
      const source = await readFile(path);
      const [br, gzip] = await Promise.all([
        brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } }),
        gz(source, { level: 9 }),
      ]);
      await Promise.all([writeFile(`${path}.br`, br), writeFile(`${path}.gz`, gzip)]);
    }
  }
}

await precompress(fileURLToPath(new URL('../dist/', import.meta.url)));
