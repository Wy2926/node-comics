"""Independent, bounded Nginx statistics. No application or database dependencies."""
import argparse
from contextlib import contextmanager
from datetime import datetime, timedelta
import gzip
import hashlib
import html
import ipaddress
import json
from pathlib import Path
import re
import socket
import subprocess
import tempfile
import time
import urllib.request
from zoneinfo import ZoneInfo

CONFIG = Path('/etc/nodelane/traffic.json')
ERROR_LOG = Path('/var/log/nodelane-traffic/error.log')
VIEWS = {
    'overview': ('全部请求', 'access', []),
    'website': ('网站 PV / UV', 'pages', ['--ignore-crawlers']),
    'bots': ('网站已知爬虫', 'web', ['--crawlers-only']),
    'services': ('API / 节点 / Auth', 'services', []),
    'streams': ('SSE / 长轮询', 'streams', []),
}


def atomic_write(path, content):
    temporary = path.with_name('.' + path.name + '.tmp')
    try:
        temporary.write_text(content, encoding='utf-8')
        temporary.chmod(0o640)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


@contextmanager
def locked(path):
    import fcntl
    with path.open('a') as handle:
        fcntl.flock(handle, fcntl.LOCK_EX)
        yield


def page(title, body):
    return ('<!doctype html><html lang="zh-CN"><meta charset="utf-8">'
        '<meta name="viewport" content="width=device-width,initial-scale=1">'
        f'<title>{html.escape(title)} · NodeLane</title><style>'
        'body{font:16px/1.7 system-ui;background:#f3f6fa;color:#23344b;margin:0;padding:40px 24px}'
        'main{max-width:1000px;margin:auto}h1{font-size:32px}a{color:#1769b3}'
        '.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:16px}'
        '.card{background:white;border:1px solid #dce3ee;border-radius:12px;padding:24px;text-decoration:none}'
        '.card strong{font-size:20px;display:block}.muted{color:#5d6a7b;font-size:14px}'
        '</style><main>' + body + '<p class="muted">'
        '<a href="https://goaccess.io/" rel="noreferrer">GoAccess</a> · '
        '<a href="https://db-ip.com/" rel="noreferrer">IP Geolocation by DB-IP</a>'
        '</p></main></html>')


def inputs(log_dir, stem):
    """Uncompressed rotation preserves GoAccess's native inode/line tracking."""
    return sorted((path for path in log_dir.glob(stem + '.log*')
                   if path.is_file() and not path.is_symlink() and path.stat().st_size
                   and not path.name.endswith('.gz')), key=lambda path: path.stat().st_mtime)


def expire_calendar_days(command, metadata, database, cfg):
    """GoAccess keep-last counts populated dates, not elapsed calendar days."""
    data = json.loads(metadata.read_text())
    dates = [str(row['data']) for row in data['visitors']['data']]
    cutoff = (datetime.now(ZoneInfo(cfg['timezone'])).date() - timedelta(days=cfg['report_days'] - 1)).strftime('%Y%m%d')
    current = sum(date >= cutoff for date in dates)
    if current == len(dates):
        return data
    if not current:
        # Only this view's GoAccess cache expired. Raw logs and other views are untouched.
        for path in database.glob('*.db'):
            path.unlink()
        return None
    trimmed = [arg for arg in command if not arg.startswith('--keep-last=') and arg != '--restore']
    result = subprocess.run(trimmed + ['--restore', '--keep-last=' + str(current)], input=b'', capture_output=True)
    if result.returncode:
        raise RuntimeError('GoAccess calendar retention failed (raw parser output withheld)')
    return json.loads(metadata.read_text())


def report(cfg):
    root, logs = Path(cfg['state_dir']), Path(cfg['log_dir'])
    reports = root / 'reports'
    reports.mkdir(exist_ok=True)
    with locked(root / 'report.lock'), tempfile.TemporaryDirectory(prefix='.report-', dir=root) as work:
        cards, metrics = [], {}
        started = time.monotonic()
        for name, (title, stem, flags) in VIEWS.items():
            database = root / 'db' / name
            database.mkdir(parents=True, exist_ok=True)
            files = inputs(logs, stem)
            candidate = Path(work) / (name + '.html')
            metadata = Path(work) / (name + '.json')
            command = ['goaccess', '--no-global-config', '-p', '/etc/nodelane/goaccess.conf',
                '--persist', '--db-path=' + str(database), '--keep-last=' + str(cfg['report_days']),
                '--tz=' + cfg['timezone'], '--html-report-title=NodeLane · ' + title,
                '-o', str(candidate), '-o', str(metadata)] + flags
            cached = any(database.glob('*.db'))
            if cached:
                command.append('--restore')
            for geo in sorted((root / 'geoip').glob('*.mmdb')):
                command.append('--geoip-database=' + str(geo))
            data = None
            if files or cached:
                result = subprocess.run(command + [str(p) for p in files], input=b'', capture_output=True)
                data = expire_calendar_days(command, metadata, database, cfg) if not result.returncode else None
                if result.returncode:
                    if b'No valid hits' not in result.stderr and b'Nothing valid to process' not in result.stderr:
                        raise RuntimeError('GoAccess failed for ' + name + ' (raw parser output withheld)')
            if data is None:
                content = page(title, '<a href="./">← 统计首页</a><h1>' + title + '</h1><p>尚无符合条件的访问。</p>')
                general = {'valid_requests': 0, 'unique_visitors': 0}
            else:
                content = candidate.read_text()
                content = content.replace('</body>', '<footer style="padding:12px;text-align:center">'
                    '<a href="./">NodeLane 统计首页</a> · '
                    '<a href="https://db-ip.com/" rel="noreferrer">IP Geolocation by DB-IP</a>'
                    '</footer></body>')
                general = data.get('general', {})
            atomic_write(reports / (name + '.html'), content)
            count, visitors = general.get('valid_requests', 0), general.get('unique_visitors', 0)
            metrics[name] = {'requests': count, 'visitors': visitors}
            cards.append(f'<a class="card" href="{name}.html"><strong>{title}</strong>'
                         f'{count:,} 次请求 · {visitors:,} 个估算访客</a>')
        stamp = datetime.now(ZoneInfo(cfg['timezone'])).strftime('%Y-%m-%d %H:%M:%S')
        error_rows = []
        if ERROR_LOG.exists():
            with ERROR_LOG.open('rb') as handle:
                handle.seek(max(0, ERROR_LOG.stat().st_size - 65536))
                for line in handle.read().splitlines()[-100:]:
                    try:
                        entry = json.loads(line)
                        error_rows.append('<tr>' + ''.join('<td>' + html.escape(str(entry.get(key, ''))) + '</td>'
                            for key in ('time', 'level', 'client', 'connection', 'message')) + '</tr>')
                    except (ValueError, UnicodeError):
                        continue  # The first line may start in the middle of a record.
        atomic_write(reports / 'errors.html', page('最近错误', '<a href="./">← 统计首页</a><h1>最近错误</h1>'
            '<p>当前错误日志最近 100 条；完整日志保留 7 天。请求地址和上游地址不写入错误正文。</p>'
            '<div style="overflow:auto"><table><tr><th>时间</th><th>级别</th><th>IP</th><th>连接号</th><th>错误</th></tr>'
            + ''.join(reversed(error_rows)) + '</table></div>'))
        cards.append('<a class="card" href="errors.html"><strong>最近错误</strong>脱敏 Nginx 错误详情</a>')
        content = page('访问统计', '<p class="muted">NODELANE / TRAFFIC</p><h1>网站访问统计</h1>'
            f'<p>最近 {cfg["report_days"]} 天 · 北京时间 {stamp} 更新 · 每分钟刷新统计</p>'
            '<div class="grid">' + ''.join(cards) + '</div>'
            '<p>网站 PV 只统计公开 HTML 页面，排除已知爬虫、预取、API、静态资源及探针。'
            'UV 按 IP、User-Agent 和日期估算，不是登录人数；多日 UV 不是跨日去重人数。</p>'
            '<p>“网站已知爬虫”仅统计网站请求，排除正常节点/API 调用；按 User-Agent 识别，不能识别所有伪装爬虫。'
            'IP 位置是出口的大致位置，城市可能缺失。API 与长连接分别统计，避免耗时误判。</p>'
            f'<p class="muted">原始日志保留 {cfg["raw_days"]} 天，统计保留 {cfg["report_days"]} 天。'
            '容量超限时提前删除最旧日志；统计从启用时开始，无历史回填。</p>')
        atomic_write(reports / 'index.html', content)
        print(json.dumps({'reports': metrics, 'seconds': round(time.monotonic() - started, 3)}))


def geoip(cfg):
    import maxminddb
    directory = Path(cfg['state_dir']) / 'geoip'
    directory.mkdir(exist_ok=True)
    # These downloaded public databases are also mounted read-only by the API
    # container (UID 10001). Do not relax permissions on logs or traffic reports.
    directory.chmod(0o755)
    for database in directory.glob('*.mmdb'):
        database.chmod(0o644)
    month = datetime.now(ZoneInfo(cfg['timezone'])).strftime('%Y-%m')
    manifest = directory / 'sources.json'
    previous = json.loads(manifest.read_text()) if manifest.exists() else {}
    if previous.get('month') == month and all((directory / (kind + '.mmdb')).exists() for kind in ('city', 'asn')):
        print('GeoIP databases already current')
        return
    sources = {}
    for kind in ('city', 'asn'):
        url = f'https://download.db-ip.com/free/dbip-{kind}-lite-{month}.mmdb.gz'
        target = directory / (kind + '.mmdb')
        temporary = directory / ('.' + kind + '.tmp')
        digest = hashlib.sha256()
        try:
            request = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0 NodeLane-GeoIP/1.0',
                'Referer': 'https://db-ip.com/'})
            with urllib.request.urlopen(request, timeout=60) as response, gzip.GzipFile(fileobj=response) as reader, temporary.open('wb') as writer:
                while chunk := reader.read(1024 * 1024):
                    writer.write(chunk)
                    digest.update(chunk)
            with maxminddb.open_database(str(temporary)) as database:
                if kind.lower() not in database.metadata().database_type.lower():
                    raise RuntimeError('Unexpected GeoIP database type')
                database.get('8.8.8.8')
            temporary.chmod(0o644)
            temporary.replace(target)
            sources[kind] = {'url': url, 'sha256': digest.hexdigest(), 'bytes': target.stat().st_size}
        finally:
            temporary.unlink(missing_ok=True)
    atomic_write(manifest, json.dumps({'month': month, 'license': 'CC-BY-4.0', 'attribution': 'https://db-ip.com/', 'sources': sources}, indent=2))
    print(json.dumps({'geoip_month': month, 'sources': sources}))


def clean_archives(directories, days, maximum, *, at=None):
    cutoff = (at or time.time()) - days * 86400
    active, archives = [], []
    for directory in directories:
        for path in directory.glob('*.log*'):
            if path.is_file() and not path.is_symlink():
                (active if path.name.endswith('.log') else archives).append(path)
    archives.sort(key=lambda path: path.stat().st_mtime)
    total = sum(path.stat().st_size for path in active + archives)
    removed = 0
    for path in archives:
        if path.stat().st_mtime >= cutoff and total <= maximum:
            continue
        size = path.stat().st_size
        path.unlink()
        total -= size
        removed += size
    return {'removed_bytes': removed, 'remaining_bytes': total}


def rotate(cfg):
    logs = Path(cfg['log_dir'])
    common = (f'daily\nmaxsize {cfg["rotate_bytes"]}\nrotate {cfg["raw_days"] * 96}\n'
        f'maxage {cfg["raw_days"]}\nmissingok\nnotifempty\nnocompress\n'
        'dateext\ndateformat -%Y%m%d-%H%M%S\n')
    content = (str(logs / '*.log') + ' {\n' + common + 'create 0640 www-data adm\nsharedscripts\n'
        'postrotate\n /usr/sbin/nginx -s reopen\nendscript\n}\n' + str(ERROR_LOG) + ' {\n' + common +
        'create 0640 nodelane-traffic www-data\n}\n')
    path = Path('/etc/nodelane/traffic.logrotate')
    atomic_write(path, content)
    subprocess.run(['logrotate', '-s', '/var/lib/logrotate/nodelane-traffic.status', str(path)], check=True)
    print(json.dumps(clean_archives([logs, ERROR_LOG.parent], cfg['raw_days'], cfg['raw_max_bytes'])))


def redact_error(raw):
    text = raw.decode('utf-8', errors='replace')
    level = re.search(r'\[(debug|info|notice|warn|error|crit|alert|emerg)\]', text)
    connection = re.search(r'\*(\d+)\s', text)
    client = re.search(r', client: ([0-9a-fA-F:.]+)(?:,|$)', text)
    # Discard the complete request/upstream/referrer context, not individual query keys.
    message = re.split(r', (?:client|server|request|upstream|host|referrer):', text, maxsplit=1)[0]
    message = re.sub(r'^.*?\[(?:debug|info|notice|warn|error|crit|alert|emerg)\]\s*\d+#\d+:\s*(?:\*\d+\s*)?', '', message)
    message = re.sub(r'"(?:\\.|[^"\\])*"', '[redacted]', message)
    message = re.sub(r'https?://\S+|(?<!\w)/\S+', '[redacted]', message)
    value = {'time': datetime.now().astimezone().isoformat(), 'level': level[1] if level else 'error',
        'connection': connection[1] if connection else None, 'message': message[:1024]}
    if client:
        try:
            value['client'] = str(ipaddress.ip_address(client[1]))
        except ValueError:
            pass
    return value


def errors():
    path = Path('/run/nodelane-traffic/error.sock')
    path.unlink(missing_ok=True)
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as receiver:
        receiver.bind(str(path))
        path.chmod(0o660)
        while True:
            payload = receiver.recv(65536)
            # Reopen each rare error so rotation never leaves an unlinked file open.
            with ERROR_LOG.open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(redact_error(payload), ensure_ascii=False) + '\n')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=('report', 'geoip', 'rotate', 'errors'))
    parser.add_argument('--config', type=Path, default=CONFIG)
    args = parser.parse_args()
    if args.command == 'errors':
        errors()
    else:
        cfg = json.loads(args.config.read_text())
        for field in ('raw_days', 'report_days', 'raw_max_bytes', 'rotate_bytes'):
            if type(cfg[field]) is not int or cfg[field] <= 0:
                raise ValueError('Expected positive retention setting: ' + field)
        globals()[args.command](cfg)


if __name__ == '__main__':
    main()
