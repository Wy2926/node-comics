"""HTTPX transport that connects only to an address checked at the socket boundary."""
import ipaddress
import socket
import ssl
from contextlib import contextmanager
import httpcore
import httpx
from ..errors import ProcessingError


@contextmanager
def mapped_errors():
    try:
        yield
    except (httpcore.TimeoutException, httpcore.NetworkError, httpcore.ProtocolError) as exc:
        target = getattr(httpx, type(exc).__name__, httpx.NetworkError)
        raise target("Provider transport failed") from exc


class CheckedBackend(httpcore.SyncBackend):
    def __init__(self, allow_private=False):
        self.allow_private = allow_private

    def connect_tcp(self, host, port, timeout=None, local_address=None, socket_options=None):
        try:
            addresses = [ipaddress.ip_address(row[4][0]) for row in socket.getaddrinfo(host, port, type=socket.SOCK_STREAM)]
        except OSError as exc:
            raise httpcore.ConnectError("Provider hostname resolution failed") from exc
        if not addresses or (not self.allow_private and any(not address.is_global for address in addresses)):
            raise ProcessingError("UNSAFE_PROVIDER_URL", "供应商连接地址不允许访问内部网络")
        # The core request retains the original hostname for Host, certificate validation and TLS SNI.
        return super().connect_tcp(str(addresses[0]), port, timeout=timeout, local_address=local_address, socket_options=socket_options)


class ResponseStream(httpx.SyncByteStream):
    def __init__(self, stream):
        self.stream = stream

    def __iter__(self):
        with mapped_errors():
            yield from self.stream

    def close(self):
        self.stream.close()


class CheckedTransport(httpx.BaseTransport):
    def __init__(self, allow_private=False):
        self.pool = httpcore.ConnectionPool(ssl_context=ssl.create_default_context(), retries=0,
                                           network_backend=CheckedBackend(allow_private), max_connections=1)

    def handle_request(self, request):
        core_request = httpcore.Request(method=request.method, url=httpcore.URL(scheme=request.url.raw_scheme, host=request.url.raw_host,
                                                                               port=request.url.port, target=request.url.raw_path),
                                        headers=request.headers.raw, content=request.stream, extensions=request.extensions)
        with mapped_errors():
            response = self.pool.handle_request(core_request)
        return httpx.Response(response.status, headers=response.headers, stream=ResponseStream(response.stream), extensions=response.extensions)

    def close(self):
        self.pool.close()
