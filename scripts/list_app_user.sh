#!/bin/bash
APP_ID=$(sed -n 's/^GITHUB_APP_ID=//p' .env | tr -d '[:space:]')
b64url() { openssl base64 -A | tr '+/' '-_' | tr -d '='; }
NOW=$(date +%s)
HEADER=$(printf '{"alg":"RS256","typ":"JWT"}' | b64url)
PAYLOAD=$(printf '{"iat":%s,"exp":%s,"iss":"%s"}' "$((NOW-60))" "$((NOW+540))" "$APP_ID" | b64url)
SIG=$(printf '%s.%s' "$HEADER" "$PAYLOAD" | openssl dgst -sha256 -sign software-factory-worker.pem | b64url)
JWT="$HEADER.$PAYLOAD.$SIG"
curl -s -H "Authorization: Bearer $JWT" \
  -H "Accept: application/vnd.github+json" \
  "https://api.github.com/app/installations?per_page=100" | jq -r '.[] | [.id, .account.login, .account.type, .repository_selection] | @tsv'
