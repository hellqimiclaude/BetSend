// tsc only emits JavaScript. The setup window's page, its script and the tray
// icon have to be carried across by hand, the same way the server copies its
// schema.sql.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const assets = ['setup.html', 'setup.js'];

fs.mkdirSync(path.join(root, 'dist'), { recursive: true });

for (const asset of assets) {
  const from = path.join(root, 'src', asset);
  const to = path.join(root, 'dist', asset);
  fs.copyFileSync(from, to);
  console.log(`copied src/${asset} -> dist/${asset}`);
}

const icon = path.join(root, 'build', 'icon.png');
if (fs.existsSync(icon)) {
  fs.copyFileSync(icon, path.join(root, 'dist', 'icon.png'));
  console.log('copied build/icon.png -> dist/icon.png');
} else {
  console.warn('no build/icon.png - the tray will fall back to a blank icon');
}
