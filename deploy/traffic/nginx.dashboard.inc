location = /traffic { return 308 /traffic/; }
location ^~ /traffic/ {
    alias /var/lib/nodelane-traffic/reports/;
    index index.html;
    autoindex off;
    auth_basic "NodeLane traffic (administrator only)";
    auth_basic_user_file /etc/nodelane/traffic.htpasswd;
    access_log off;
    limit_except GET HEAD { deny all; }
    add_header Cache-Control "private, no-store" always;
    add_header X-Robots-Tag "noindex, nofollow" always;
    add_header X-Content-Type-Options "nosniff" always;
    add_header Referrer-Policy "no-referrer" always;
    add_header Strict-Transport-Security "max-age=31536000" always;
    # GoAccess bundles Hogan templates compiled at runtime; scoped to this dashboard only.
    add_header Content-Security-Policy "default-src 'none'; script-src 'self' 'unsafe-inline' 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; font-src 'self' data:; connect-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'" always;
}
