# Main-site example: use a separate fixed filename for each server, matching
# nginxpulse_config.json. Never include the same request in multiple streams.
access_log /var/log/nginx/nginxpulse/comics.access.log nodelane_nginxpulse buffer=32k flush=5s if=$pulse_public;
error_log syslog:server=unix:/run/nodelane-nginx-errors/error.sock,tag=nodelane warn;
