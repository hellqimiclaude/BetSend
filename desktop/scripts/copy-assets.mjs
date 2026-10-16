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

/*
 * The setup window is a local page shown before the server address is even
 * known, so it cannot use the web app's self-hosted fonts. Carry the three
 * faces it needs -- Latin only; this window is chrome, not content.
 */
const fontSource = path.resolve(root, '..', 'web', 'public', 'fonts');
const fonts = ['inter-400-latin.woff2', 'inter-600-latin.woff2', 'montserrat-700-latin.woff2'];
fs.mkdirSync(path.join(root, 'dist', 'fonts'), { recursive: true });
for (const font of fonts) {
  const from = path.join(fontSource, font);
  if (!fs.existsSync(from)) {
    throw new Error(`${font} is missing from web/public/fonts — run \`npm run fonts -w web\``);
  }
  fs.copyFileSync(from, path.join(root, 'dist', 'fonts', font));
}
console.log(`copied ${fonts.length} font files -> dist/fonts/`);

const icon = path.join(root, 'build', 'icon.png');
if (fs.existsSync(icon)) {
  fs.copyFileSync(icon, path.join(root, 'dist', 'icon.png'));
  console.log('copied build/icon.png -> dist/icon.png');
} else {
  console.warn('no build/icon.png - the tray will fall back to a blank icon');
}
