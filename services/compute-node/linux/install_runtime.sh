#!/usr/bin/env bash
# First installation only, for an existing Ubuntu 24.04 CUDA GPU container.
set -euo pipefail
if [[ $# != 3 ]]; then
  printf 'Usage: bash install_runtime.sh ARCHIVE SHA256 PRIVATE_NODE_CONFIG\n' >&2
  exit 2
fi
archive=$(realpath "$1")
checksum=$2
config=$(realpath "$3")
script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
[[ $EUID == 0 && $checksum =~ ^[a-f0-9]{64}$ ]]
. /etc/os-release
[[ $ID == ubuntu && $VERSION_ID == 24.04 && $(uname -m) == x86_64 ]]
python3 -c 'import sys; assert sys.version_info[:2] == (3, 12)'
command -v supervisorctl >/dev/null
[[ ! -e /opt/node && ! -L /opt/node && ! -e /var/lib/node-comics && ! -L /var/lib/node-comics ]]
[[ ! -e /etc/supervisor/conf.d/node-comics.conf ]]
if getent passwd 10001 >/dev/null || getent group 10001 >/dev/null || \
   getent passwd node-comics >/dev/null || getent group node-comics >/dev/null; then
  printf 'UID/GID 10001 or node-comics account already exists; inspect before installing\n' >&2
  exit 1
fi
printf '%s  %s\n' "$checksum" "$archive" | sha256sum -c -
groupadd --gid 10001 node-comics
useradd --uid 10001 --gid 10001 --no-create-home --home-dir /var/lib/node-comics --shell /usr/sbin/nologin node-comics
install -d -m 755 /opt/node
tar -xzf "$archive" -C /opt/node --no-same-owner
install -d -o 10001 -g 10001 -m 700 /var/lib/node-comics
install -o 10001 -g 10001 -m 600 "$config" /var/lib/node-comics/node.json
runuser -u node-comics -- env PYTHONPATH=/opt/node/engine PYTHONDONTWRITEBYTECODE=1 \
  /opt/node/venv/bin/python /opt/node/source/compute-node/linux/verify_assets.py
runuser -u node-comics -- env PYTHONPATH=/opt/node/engine PYTHONDONTWRITEBYTECODE=1 \
  /opt/node/venv/bin/python -m classic_node check --config /var/lib/node-comics/node.json --bundle-root /opt/node
# Do not touch other Supervisor programs or expose any listening port.
install -m 644 "$script_dir/node-comics.supervisor.conf" /etc/supervisor/conf.d/node-comics.conf
supervisorctl reread
supervisorctl update node-comics
supervisorctl status node-comics
