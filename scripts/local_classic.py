"""Explicit local deployment setup; credentials never appear in console output.

The controller itself still does not seed text providers from environment files.
This operator command provisions the chosen provider through the admin API.
"""
import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import secrets
import ssl
import subprocess
import time

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from cryptography.x509.oid import ExtendedKeyUsageOID, NameOID
from dotenv import dotenv_values
import httpx

ROOT = Path(__file__).resolve().parents[1]
SERVICE = ROOT / 'services/classic-engine'
STATE = ROOT / 'data/classic-local'
ENV = ROOT / 'deploy/.env.classic-local'
NODE = SERVICE / 'node.local.json'


def save_json(path, value):
    path.write_text(json.dumps(value, ensure_ascii=False, indent=2) + '\n', encoding='utf-8')


def certificates():
    directory = STATE / 'tls'
    directory.mkdir(parents=True, exist_ok=True)
    ca_path, cert_path, key_path = (directory / name for name in ('ca.pem', 'server.pem', 'server.key'))
    if all(path.is_file() for path in (ca_path, cert_path, key_path)):
        cert = x509.load_pem_x509_certificate(cert_path.read_bytes())
        if cert.not_valid_after_utc > datetime.now(timezone.utc) + timedelta(days=7):
            return ca_path
    key = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    subject = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, 'Node Comics local control')])
    at = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(subject).issuer_name(subject)
        .public_key(key.public_key()).serial_number(x509.random_serial_number())
        .not_valid_before(at - timedelta(minutes=5)).not_valid_after(at + timedelta(days=365))
        .add_extension(x509.BasicConstraints(ca=True, path_length=0), critical=True)
        .add_extension(x509.ExtendedKeyUsage([ExtendedKeyUsageOID.SERVER_AUTH]), critical=False)
        .add_extension(x509.SubjectAlternativeName([x509.DNSName('localhost'),
            x509.IPAddress(ipaddress.ip_address('127.0.0.1'))]), critical=False)
        .sign(key, hashes.SHA256()))
    public = cert.public_bytes(serialization.Encoding.PEM)
    ca_path.write_bytes(public)
    cert_path.write_bytes(public)
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8, serialization.NoEncryption()))
    return ca_path


def prepare():
    cfg = dotenv_values(ROOT / '.env')
    required = ('OPENAI_BASE_URL', 'OPENAI_API_KEY', 'R2_ENDPOINT_URL', 'R2_BUCKET',
                'R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY')
    if not all(cfg.get(key) for key in required):
        raise RuntimeError('Root .env must configure the real provider and R2')
    local = dotenv_values(ROOT / 'deploy/.env.local')
    if not local.get('POSTGRES_PASSWORD') or len(local.get('DEV_AUTH_SECRET', '')) < 32:
        raise RuntimeError('Run scripts/bootstrap.ps1 to prepare local credentials')
    ca = certificates()
    node = json.loads((NODE if NODE.is_file() else SERVICE / 'node.example.json').read_text(encoding='utf-8-sig'))
    node.update(control_url='https://localhost:18443', control_ca=str(ca), r2_origin=cfg['R2_ENDPOINT_URL'])
    if not NODE.is_file():
        node.update(node_id='pending-provisioning', node_token='pending-provisioning',
                    resource_id=os.environ.get('COMPUTERNAME', 'local').lower() + ':classic:vulkan:0')
    save_json(NODE, node)
    check = subprocess.run([str(SERVICE / '.venv-ncnn/Scripts/python.exe'), '-m', 'classic_node',
        'check', '--config', str(NODE)], cwd=SERVICE, capture_output=True, text=True, encoding='utf-8')
    if check.returncode:
        raise RuntimeError('Node model/font check failed; run classic_node check for diagnostics')
    report = json.loads(check.stdout.strip().splitlines()[-1])
    previous = dotenv_values(ENV) if ENV.is_file() else {}
    admin = previous.get('ADMIN_WEB_PATH') or local.get('ADMIN_WEB_PATH') or '/console-' + secrets.token_hex(16) + '/'
    # Separate local metadata and object namespace from publicly deployed data.
    prefix = cfg.get('R2_KEY_PREFIX', 'node-comics/').rstrip('/') + '/classic-local/'
    ENV.write_text('APP_ENV=development\nDEV_AUTH=true\nCLASSIC_ENABLED=true\n'
        + 'CLASSIC_ENGINE_VERSION=' + report['version'] + '\n'
        + 'R2_KEY_PREFIX=' + prefix + '\nADMIN_WEB_PATH=' + admin + '\n', encoding='utf-8')
    save_json(STATE / 'runtime.json', report)
    print(json.dumps({'ready': True, 'engine_version': report['version']}))


def api_client():
    return httpx.Client(base_url='https://localhost:18443', trust_env=False, timeout=120,
        verify=ssl.create_default_context(cafile=str(STATE / 'tls/ca.pem')))


def checked(response):
    if not response.is_success:
        try:
            code = response.json().get('error', {}).get('code', 'REQUEST_FAILED')
        except (ValueError, AttributeError):
            code = 'REQUEST_FAILED'
        raise RuntimeError(f'Local control HTTP {response.status_code}: {code}')
    return response.json()


def provision(model, protocol):
    cfg = dotenv_values(ROOT / '.env')
    local = dotenv_values(ROOT / 'deploy/.env.local')
    with api_client() as client:
        for _ in range(120):
            try:
                checked(client.get('/health/live'))
                break
            except (httpx.HTTPError, RuntimeError):
                time.sleep(1)
        else:
            raise RuntimeError('Local HTTPS API did not start')
        login = checked(client.post('/v1/auth/dev', json={'username': 'admin'}))
        client.headers['Authorization'] = 'Bearer ' + login['access_token']
        base = cfg['OPENAI_BASE_URL'].rstrip('/')
        base = base if base.endswith('/v1') else base + '/v1'
        body = {'name': 'Local .env text provider', 'channel': 'openai', 'enabled': True,
            'api_key': cfg['OPENAI_API_KEY'], 'config': {'base_url': base, 'model': model,
                'protocol': protocol, 'timeout_seconds': 120, 'max_attempts': 3,
                'max_output_tokens': 2048, 'group_bytes': 1800,
                'user_agent': local.get('OPENAI_USER_AGENT') or 'NodeComics/0.1',
                'pricing_version': 'operator-estimate-v1', 'requests_per_minute': 60}}
        providers = checked(client.get('/v1/admin/translation-providers'))['items']
        previous = next((item for item in providers if item['name'] == body['name']), None)
        provider = checked(client.put('/v1/admin/translation-providers/' + previous['id'], json=body)
            if previous else client.post('/v1/admin/translation-providers', json=body))
        checked(client.post('/v1/admin/translation-providers/' + provider['id'] + '/default'))
        node = json.loads(NODE.read_text(encoding='utf-8'))
        if node['node_id'] == 'pending-provisioning':
            created = checked(client.post('/v1/admin/compute-nodes', json={
                'name': 'Local AMD classic v2', 'resource_id': node['resource_id'],
                'config': {'execution_slots': node['max_leases'], 'allowed_languages': node['languages']}}))
            node['node_id'], node['node_token'] = created['node_id'], created['token']
            save_json(NODE, node)
        else:
            checked(client.get('/v1/admin/compute-nodes/' + node['node_id'] + '/config'))
        print(json.dumps({'provider_model': model, 'provider_protocol': protocol, 'node_id': node['node_id']}))


def ready():
    with api_client() as client:
        for _ in range(120):
            try:
                reply = client.get('/health/ready')
                if reply.is_success:
                    config = dotenv_values(ENV)
                    print(json.dumps({'status': 'ready', 'checks': reply.json()['checks'],
                        'admin_url': 'http://127.0.0.1:18088' + config['ADMIN_WEB_PATH']}))
                    return
            except httpx.HTTPError:
                pass
            time.sleep(1)
    raise RuntimeError('Control workers or image node did not become ready; inspect service logs')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('command', choices=['prepare', 'provision', 'ready'])
    parser.add_argument('--text-model', default='gpt-5.6-luna')
    parser.add_argument('--text-protocol', choices=['responses', 'chat_completions'], default='responses')
    args = parser.parse_args()
    try:
        {'prepare': prepare, 'provision': lambda: provision(args.text_model, args.text_protocol), 'ready': ready}[args.command]()
    except Exception as error:
        # Network exception strings can contain URLs; never print request/response bodies.
        print(str(error) if isinstance(error, RuntimeError) else type(error).__name__)
        raise SystemExit(1)
