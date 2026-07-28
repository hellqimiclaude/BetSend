// Copies non-TS assets that tsc ignores (currently just the SQL schema) into dist/.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const pairs = [['src/db/schema.sql', 'dist/db/schema.sql']];

for (const [from, to] of pairs) {
  const src = path.join(here, '..', from);
  const dest = path.join(here, '..', to);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  fs.copyFileSync(src, dest);
  console.log(`copied ${from} -> ${to}`);
}
