import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, mkdir, open, readFile, readdir, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import process from 'node:process';

export const controllerRoot = process.env.CODEX_HOME
  ? path.join(process.env.CODEX_HOME, 'deepseek-subagent')
  : path.join(os.homedir(), '.codex', 'deepseek-subagent');
export const jobsRoot = path.join(controllerRoot, 'jobs');
export const worktreesRoot = path.join(controllerRoot, 'worktrees');

export async function ensureRoots() {
  await mkdir(jobsRoot, { recursive: true });
  await mkdir(worktreesRoot, { recursive: true });
}

export async function readJson(file) { return JSON.parse(await readFile(file, 'utf8')); }

export async function writeJsonAtomic(file, value) {
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temp, file);
}

export async function appendJsonLine(file, value) {
  const handle = await open(file, 'a');
  try { await handle.write(`${JSON.stringify(value)}\n`); } finally { await handle.close(); }
}

export function jobDir(jobId) { return path.join(jobsRoot, jobId); }
export function stateFile(jobId) { return path.join(jobDir(jobId), 'state.json'); }

export function parseArgs(argv) {
  const [operation, ...rest] = argv;
  const options = {};
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i];
    if (!token.startsWith('--')) throw new Error(`Unexpected argument: ${token}`);
    const key = token.slice(2);
    const value = rest[i + 1];
    if (value === undefined || value.startsWith('--')) options[key] = true;
    else { options[key] = value; i += 1; }
  }
  return { operation, options };
}

export async function run(command, args, options = {}) {
  return await new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      windowsHide: true,
      shell: false,
    });
    let stdout = ''; let stderr = '';
    child.stdout?.setEncoding('utf8'); child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', chunk => { stdout += chunk; });
    child.stderr?.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => {
      if (code === 0 || options.allowFailure) resolve({ code, stdout, stderr });
      else reject(new Error(`${command} exited ${code}: ${stderr || stdout}`));
    });
  });
}

export async function git(args, cwd, allowFailure = false) {
  return await run('git', args, { cwd, allowFailure });
}

export function isInside(root, candidate) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

export async function exists(file) {
  try { await access(file, constants.F_OK); return true; } catch { return false; }
}

async function pathCommand(name) {
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const found = await run(locator, [name], { allowFailure: true });
  if (found.code !== 0) return undefined;
  return found.stdout.split(/\r?\n/).map(value => value.trim()).find(Boolean);
}

async function sourceLauncher(root) {
  const cli = path.join(root, 'apps', 'cli', 'src', 'bin.ts');
  const tsx = path.join(root, 'node_modules', 'tsx', 'dist', 'cli.mjs');
  if (!(await exists(cli)) || !(await exists(tsx))) return undefined;
  return { command: process.execPath, args: [tsx, cli], root };
}

export async function discoverHarness() {
  const fromPath = await pathCommand('dsh');
  if (fromPath) return { command: fromPath, args: [], source: 'PATH' };

  if (process.env.DEEPSEEK_HARNESS_ROOT) {
    const launcher = await sourceLauncher(path.resolve(process.env.DEEPSEEK_HARNESS_ROOT));
    if (launcher) return { ...launcher, source: 'DEEPSEEK_HARNESS_ROOT' };
    throw new Error('DEEPSEEK_HARNESS_ROOT does not contain a prepared DeepSeek Harness source checkout.');
  }

  const configFile = path.join(controllerRoot, 'config.json');
  if (await exists(configFile)) {
    const config = await readJson(configFile);
    if (config.harnessRoot) {
      const launcher = await sourceLauncher(path.resolve(config.harnessRoot));
      if (launcher) return { ...launcher, source: 'user-config' };
      throw new Error('Configured harnessRoot is not a prepared DeepSeek Harness source checkout.');
    }
    if (config.command) {
      return { command: config.command, args: Array.isArray(config.args) ? config.args : [], source: 'user-config' };
    }
  }

  throw new Error('DeepSeek Harness was not found. Install dsh on PATH, set DEEPSEEK_HARNESS_ROOT, or create ~/.codex/deepseek-subagent/config.json.');
}

export async function loadState(jobId) {
  try { return await readJson(stateFile(jobId)); }
  catch (error) { if (error.code === 'ENOENT') throw new Error(`Unknown job: ${jobId}`); throw error; }
}

export async function acquireLock(name, fn) {
  await ensureRoots();
  const lockPath = path.join(controllerRoot, `${name}.lock`);
  for (let attempt = 0; attempt < 100; attempt += 1) {
    let handle;
    try {
      handle = await open(lockPath, 'wx');
      try { return await fn(); } finally { await handle.close(); await rm(lockPath, { force: true }); }
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
  }
  throw new Error(`Timed out waiting for ${name} lock.`);
}

export async function listJobIds() {
  await ensureRoots();
  return await readdir(jobsRoot);
}

export function isTerminal(status) {
  return ['completed', 'failed', 'timed_out', 'stopped', 'cleaned'].includes(status);
}

export function processAlive(pid) {
  if (!Number.isInteger(pid)) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}
