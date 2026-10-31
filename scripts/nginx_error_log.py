"""Receive Nginx Unix syslog and remove private request/error context."""
from datetime import datetime
import ipaddress
import json
from pathlib import Path
import re
import socket


def redact_error(raw):
    text = raw.decode('utf-8', errors='replace')
    level = re.search(r'\[(debug|info|notice|warn|error|crit|alert|emerg)\]', text)
    connection = re.search(r'\*(\d+)\s', text)
    client = re.search(r', client: ([0-9a-fA-F:.]+)(?:,|$)', text)
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


def main():
    path = Path('/run/nodelane-nginx-errors/error.sock')
    path.unlink(missing_ok=True)
    with socket.socket(socket.AF_UNIX, socket.SOCK_DGRAM) as receiver:
        receiver.bind(str(path))
        path.chmod(0o660)
        while True:
            payload = receiver.recv(65536)
            # Open per error so logrotate needs no signal or copytruncate.
            with Path('/var/log/nodelane-nginx-errors/error.log').open('a', encoding='utf-8') as handle:
                handle.write(json.dumps(redact_error(payload), ensure_ascii=False) + '\n')


if __name__ == '__main__':
    main()
