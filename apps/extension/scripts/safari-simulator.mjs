// Local iOS simulator workflow. No developer team, signing, upload or deployment.
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync} from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const action = process.argv[2] ?? 'doctor';
const deviceId = process.argv[3];
const generated = path.join(root, '.output/safari-project');
const derived = path.join(root, '.output/safari-derived-data');
const appName = 'NodeLaneSafari';
// The packager derives the app ID's last component from --app-name; matching
// it keeps the embedded extension's identifier under its containing app.
const bundle = `net.nodelane.comics.safari.${appName}`;
const env = {...process.env};
if (!env.DEVELOPER_DIR && existsSync('/Applications/Xcode.app/Contents/Developer'))
  env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer';

function run(command, args, capture = false) {
  const result = spawnSync(command, args, {cwd: root, env, encoding: 'utf8', stdio: capture ? ['ignore', 'pipe', 'pipe'] : 'inherit'});
  if (result.error || result.status !== 0)
    throw Error(`${command} failed${capture ? ': ' + (result.stderr || result.stdout || result.error?.message || '').trim() : ''}`);
  return result.stdout?.trim();
}
function tool(name) {
  const result = spawnSync('xcrun', ['--find', name], {env, encoding: 'utf8'});
  return result.status === 0 ? result.stdout.trim() : undefined;
}
function children(directory, suffix) {
  return existsSync(directory) ? readdirSync(directory, {withFileTypes: true})
    .filter(entry => entry.isDirectory() && entry.name.endsWith(suffix)).map(entry => path.join(directory, entry.name)) : [];
}
function projectPath() {
  const candidates = [...children(generated, '.xcodeproj'), ...children(path.join(generated, appName), '.xcodeproj')];
  if (candidates.length !== 1) throw Error('Run npm run safari:simulator -- prepare to generate the Xcode project.');
  return candidates[0];
}
function syncNativeHandler(project) {
  copyFileSync(path.join(root, 'safari/SafariWebExtensionHandler.swift'),
    path.join(path.dirname(project), `${appName} Extension/SafariWebExtensionHandler.swift`));
}
function devices() {
  const result = JSON.parse(run('xcrun', ['simctl', 'list', 'devices', 'available', '--json'], true));
  return Object.entries(result.devices).filter(([runtime]) => runtime.includes('.iOS-'))
    .flatMap(([runtime, entries]) => entries.filter(entry => entry.isAvailable).map(entry => ({...entry, runtime})));
}
function selectDevice() {
  if (!deviceId) throw Error('Select an iOS simulator UDID from doctor, then run: npm run safari:simulator -- install <UDID>');
  const device = devices().find(value => value.udid === deviceId);
  if (!device) throw Error('The selected iOS simulator is not available. Run doctor to list available devices.');
  const major = Number(device.runtime.match(/\.iOS-(\d+)/)?.[1]);
  if (!Number.isInteger(major) || major < 26) throw Error('This prototype requires an iOS 26 or newer simulator.');
  return device;
}

try {
  if (!['doctor', 'prepare', 'install'].includes(action)) throw Error('Usage: npm run safari:simulator -- <doctor|prepare|install [UDID]>');
  if (process.platform !== 'darwin' || !tool('simctl'))
    throw Error('Full Xcode is required (Command Line Tools is insufficient). Install Xcode and an iOS 26+ simulator runtime; set DEVELOPER_DIR if Xcode is elsewhere. No paid developer membership is needed.');
  run('xcodebuild', ['-version']);
  if (action === 'doctor') {
    const available = devices();
    if (!available.length) throw Error('No iOS simulator is installed. Use Xcode Settings → Components, or xcodebuild -downloadPlatform iOS.');
    for (const device of available) console.log(`${device.udid}  ${device.name}  ${device.runtime}  ${device.state}`);
  } else if (action === 'prepare') {
    const packager = tool('safari-web-extension-packager') ?? tool('safari-web-extension-converter');
    if (!packager) throw Error('This Xcode installation has no Safari web extension packager.');
    run('npm', ['run', 'build:safari'], true);
    console.log('Safari MV3 resources built.');
    const resources = path.join(root, '.output/safari-mv3');
    const manifest = JSON.parse(readFileSync(path.join(resources, 'manifest.json'), 'utf8'));
    if (manifest.manifest_version !== 3 || ['identity', 'webRequest', 'contextMenus'].some(permission => manifest.permissions.includes(permission)))
      throw Error('Expected the iOS Safari MV3 manifest without unsupported permissions.');
    mkdirSync(generated, {recursive: true});
    // This directory only contains reproducible generated files, never signing assets.
    run(packager, [resources, '--project-location', generated, '--app-name', appName,
      '--bundle-identifier', bundle, '--swift', '--ios-only', '--no-prompt', '--no-open', '--force']);
    syncNativeHandler(projectPath());
    console.log(`Generated: ${projectPath()}`);
    console.log('Next: npm run safari:simulator -- doctor');
  } else {
    const project = projectPath(), device = selectDevice();
    syncNativeHandler(project);
    const metadata = JSON.parse(run('xcodebuild', ['-list', '-json', '-project', project], true));
    const schemes = (metadata.project?.schemes ?? []).filter(name => name === appName || name === `${appName} (iOS)`);
    if (schemes.length !== 1) throw Error('Could not identify the generated iOS app scheme. Inspect the Xcode project before building.');
    run('xcodebuild', ['-quiet', '-project', project, '-scheme', schemes[0], '-configuration', 'Debug',
      '-sdk', 'iphonesimulator', '-destination', `id=${device.udid}`, '-derivedDataPath', derived,
      'IPHONEOS_DEPLOYMENT_TARGET=26.0', 'CODE_SIGNING_ALLOWED=NO', 'build']);
    const apps = children(path.join(derived, 'Build/Products/Debug-iphonesimulator'), '.app');
    if (apps.length !== 1) throw Error('Expected one built simulator app.');
    if (device.state !== 'Booted') run('xcrun', ['simctl', 'boot', device.udid]);
    run('xcrun', ['simctl', 'bootstatus', device.udid, '-b']);
    run('xcrun', ['simctl', 'install', device.udid, apps[0]]);
    const installedBundle = run('/usr/libexec/PlistBuddy', ['-c', 'Print :CFBundleIdentifier', path.join(apps[0], 'Info.plist')], true);
    run('xcrun', ['simctl', 'launch', device.udid, installedBundle]);
    const developer = env.DEVELOPER_DIR ?? run('xcode-select', ['-p'], true);
    const simulator = [path.join(developer, '../Applications/DeviceHub.app'),
      path.join(developer, 'Applications/Simulator.app')].find(existsSync);
    if (!simulator) throw Error('App installed, but the Xcode simulator UI was not found. Open Device Hub from Xcode.');
    run('open', simulator.endsWith('DeviceHub.app')
      ? ['-a', simulator, `devices://device/open?id=${device.udid}`]
      : ['-a', simulator, '--args', '-CurrentDeviceUDID', device.udid]);
    console.log('Installed in the simulator. Enable NodeLane in Safari and allow website access before testing.');
    console.log('Installation alone does not verify login, source images or translation.');
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
