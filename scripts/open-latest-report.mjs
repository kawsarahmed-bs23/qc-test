import { execSync } from 'node:child_process';
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const envName = (process.argv[2] ?? process.env.TEST_ENV ?? 'local').toLowerCase();
const root = join('reports', envName);

if (!existsSync(root)) {
  console.error(`No reports for '${envName}' yet. Run: npm run test:${envName}`);
  process.exit(1);
}

const latest = readdirSync(root)
  .map((name) => ({ name, time: statSync(join(root, name)).mtimeMs }))
  .filter((entry) => existsSync(join(root, entry.name, 'html', 'index.html')))
  .sort((a, b) => b.time - a.time)[0];

if (!latest) {
  console.error(`No HTML report under ${root}.`);
  process.exit(1);
}

const folder = join(root, latest.name, 'html');
console.log(`Opening ${folder}`);
execSync(`npx playwright show-report "${folder}"`, { stdio: 'inherit' });
