#!/bin/bash
# Issue one HTTPS certificate for track.customer.com and serve it on this machine.
# Installed as root at /usr/local/sbin/inboxflow-issue-tracking-cert.
set -euo pipefail

host="${1:-}"
if [[ ! "$host" =~ ^track\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)+$ ]]; then
  echo "refusing host" >&2
  exit 2
fi

# The existing port 80 default server already uses this root, so the challenge is reachable.
webroot=/var/www/inboxflow
mkdir -p "$webroot/.well-known/acme-challenge"
certbot certonly --webroot -w "$webroot" -d "$host" \
  --non-interactive --agree-tos --keep-until-expiring --register-unsafely-without-email

conf="/etc/nginx/sites-enabled/tracking-${host}.conf"
cat > "$conf" <<EOF
server {
    listen 443 ssl;
    listen [::]:443 ssl;
    server_name ${host};

    ssl_certificate /etc/letsencrypt/live/${host}/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/${host}/privkey.pem;
    include /etc/letsencrypt/options-ssl-nginx.conf;
    ssl_dhparam /etc/letsencrypt/ssl-dhparams.pem;

    client_max_body_size 30m;

    location = /health {
        proxy_pass http://127.0.0.1:3001/health;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
    }

    location /api/ {
        proxy_pass http://127.0.0.1:3001;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto https;
        proxy_read_timeout 60s;
    }

    location / {
        return 404;
    }
}
EOF

nginx -t
systemctl reload nginx
