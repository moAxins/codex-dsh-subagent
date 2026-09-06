import { writeFile } from 'node:fs/promises';
import path from 'node:path';

const args = process.argv.slice(2);
if (args[0] !== '--profile' || args[1] !== 'headless') process.exit(2);
const prompt = args[2] ?? '';
if (prompt.includes('[SLEEP]')) await new Promise(resolve => setTimeout(resolve, 1500));
if (prompt.includes('[TIMEOUT]')) await new Promise(resolve => setTimeout(resolve, 10_000));
if (prompt.includes('[EDIT]')) await writeFile(path.join(process.cwd(), 'delegated.txt'), 'uncommitted delegated change\n');
await new Promise((resolve, reject) => {
  process.stdout.write(`headless:${path.basename(process.cwd())}`, error => error ? reject(error) : resolve());
});
