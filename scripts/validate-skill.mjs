import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skill = path.join(root, 'skills', 'deepseek-subagent');
const required = [
  'README.md', 'LICENSE',
  'skills/deepseek-subagent/SKILL.md',
  'skills/deepseek-subagent/agents/openai.yaml',
  'skills/deepseek-subagent/scripts/dsh-subagent.mjs',
  'skills/deepseek-subagent/scripts/worker.mjs',
  'skills/deepseek-subagent/references/protocol.md',
];

const missing = [];
for (const relative of required) {
  try { await access(path.join(root, relative)); } catch { missing.push(relative); }
}
if (missing.length) throw new Error(`Missing required files: ${missing.join(', ')}`);

const text = await readFile(path.join(skill, 'SKILL.md'), 'utf8');
if (!/^---\r?\nname: deepseek-subagent\r?\ndescription: .+\r?\n---\r?\n/.test(text)) throw new Error('SKILL.md frontmatter is invalid.');
if (text.includes('TODO')) throw new Error('SKILL.md still contains TODO text.');
for (const operation of ['spawn', 'wait', 'followup', 'interrupt', 'result', 'cleanup']) {
  if (!text.includes(operation)) throw new Error(`SKILL.md does not document ${operation}.`);
}
process.stdout.write('Skill structure and instructions are valid.\n');
