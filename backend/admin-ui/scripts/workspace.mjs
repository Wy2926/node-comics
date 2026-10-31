/** Local synthetic preview and immutable static packaging; no remote deployment. */
import {spawn} from 'node:child_process';
import {existsSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const ui = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const backend = resolve(ui, '..');
const root = resolve(backend, '..');
const localPython = join(backend, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const python = process.env.ADMIN_PYTHON || (existsSync(localPython) ? localPython : process.platform === 'win32' ? 'python' : 'python3');
const children = new Set();
let stopping = false;
function stop(code) {
  if (stopping) return;
  stopping = true;
  process.exitCode = code;
  for (const child of children) child.kill('SIGTERM');
}
process.on('SIGINT', () => stop(0));
process.on('SIGTERM', () => stop(0));
function start(command, args, env = process.env) {
  const child = spawn(command, args, {cwd: ui, env, stdio: 'inherit'});
  children.add(child);
  child.once('error', error => {console.error(error.message); stop(1);});
  child.once('exit', code => {children.delete(child); stop(code ?? 1);});
  return child;
}
async function run(command, args) {
  const child = spawn(command, args, {cwd: ui, stdio: 'inherit'});
  children.add(child);
  const code = await new Promise((done, reject) => {child.once('error', reject); child.once('exit', done);});
  children.delete(child);
  if (code !== 0) throw new Error(`Command exited with ${code ?? 'a signal'}`);
}
async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (mode === 'demo') {
    const port = Number(process.env.ADMIN_FIXTURE_PORT || 18090);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('ADMIN_FIXTURE_PORT must be 1024–65535');
    const origin = `http://127.0.0.1:${port}`;
    start(python, [join(backend, 'tests/manual_admin_workspace_server.py')], {...process.env, ADMIN_FIXTURE_PORT: String(port)});
    let ready = false;
    for (let attempt = 0; attempt < 120 && !stopping; attempt++) {
      try {ready = (await fetch(`${origin}/v1/auth/config`, {signal: AbortSignal.timeout(500)})).ok;} catch {}
      if (ready) break;
      await new Promise(done => setTimeout(done, 250));
    }
    if (stopping) return;
    if (!ready) throw new Error('Preview API did not start. Install backend/requirements-test.txt into backend/.venv.');
    console.log('Isolated preview · username: admin · synthetic data and model responses only');
    start(process.execPath, [join(ui, 'node_modules/vite/bin/vite.js'), '--host', '127.0.0.1', '--port', process.env.ADMIN_UI_PORT || '5175', '--strictPort'], {...process.env, ADMIN_API_ORIGIN: origin});
  } else if (mode === 'release') {
    for (const required of ['--release', '--destination', '--admin-path']) {
      if (!args.includes(required)) throw new Error(`Missing ${required}; see docs/ADMIN_CONSOLE.md`);
    }
    await run(process.execPath, [process.env.npm_execpath, 'run', 'build']);
    if (stopping) return;
    await run(python, [join(root, 'scripts/prepare_static_release.py'), 'admin', '--source', join(backend, 'app/admin_web/dist'), ...args]);
  } else throw new Error('Expected demo or release');
}
main().catch(error => {console.error(error.message); stop(1);});
