"""Administrative metadata from the ASGI peer; never trust request headers here."""
from ipaddress import ip_address


def client_ip(request):
    try:
        return str(ip_address(request.client.host)) if request.client else None
    except ValueError:
        return None
