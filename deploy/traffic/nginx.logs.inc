access_log /var/log/nginx/traffic/access.log nodelane_traffic buffer=32k flush=5s if=$traffic_loggable;
access_log /var/log/nginx/traffic/web.log nodelane_traffic buffer=32k flush=5s if=$traffic_log_web;
access_log /var/log/nginx/traffic/pages.log nodelane_traffic buffer=32k flush=5s if=$traffic_log_page;
access_log /var/log/nginx/traffic/services.log nodelane_traffic buffer=32k flush=5s if=$traffic_log_service;
access_log /var/log/nginx/traffic/streams.log nodelane_traffic buffer=32k flush=5s if=$traffic_log_stream;
# The local receiver removes request/upstream/referrer fields before writing.
error_log syslog:server=unix:/run/nodelane-traffic/error.sock,tag=nodelane warn;
