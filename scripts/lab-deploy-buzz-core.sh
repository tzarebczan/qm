#!/bin/bash
set -euo pipefail
cd /srv/lab/qm
IMG_TAR="${1:-/tmp/qm-core-buzz-surface.tar.gz}"
IMG_TAG="qm-core:buzz-surface"

if [[ -f "$IMG_TAR" ]]; then
  echo "Loading $IMG_TAR ..."
  if [[ "$IMG_TAR" == *.gz ]]; then
    gunzip -c "$IMG_TAR" | docker load
  else
    docker load -i "$IMG_TAR"
  fi
fi

docker image inspect "$IMG_TAG" >/dev/null
test -f /srv/lab/qm/.env.buzz

ENVFILE=$(mktemp)
docker inspect qm-tz-core --format '{{range .Config.Env}}{{println .}}{{end}}' \
  | grep -v '^ADMIN_GRANTS=' \
  | grep -v '^BUZZ_' > "$ENVFILE" || true
if grep -q '^ADMIN_GRANTS=' /srv/lab/qm/.env 2>/dev/null; then
  grep '^ADMIN_GRANTS=' /srv/lab/qm/.env >> "$ENVFILE"
fi
grep -E '^BUZZ_[A-Z0-9_]+=' /srv/lab/qm/.env.buzz >> "$ENVFILE"

if [[ -f /srv/lab/qm/.env ]]; then
  grep -vE '^BUZZ_' /srv/lab/qm/.env > /srv/lab/qm/.env.tmp || true
  cat /srv/lab/qm/.env.buzz >> /srv/lab/qm/.env.tmp
  mv /srv/lab/qm/.env.tmp /srv/lab/qm/.env
  chmod 600 /srv/lab/qm/.env
fi

NET=$(docker inspect qm-tz-core --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{end}}')
DGID=$(getent group docker | cut -d: -f3)

docker stop qm-tz-core
docker rm qm-tz-core
docker run -d --name qm-tz-core \
  --network "$NET" --network-alias core --restart unless-stopped -p 8080:8080 \
  --add-host=host.docker.internal:host-gateway \
  --env-file "$ENVFILE" \
  -v qm-tz-coredata:/data \
  -v /srv/lab/qm/sandbox/skills:/layer/skills:ro \
  -v /srv/lab/qm/sandbox/tools:/layer/tools:ro \
  -v /var/run/docker.sock:/var/run/docker.sock \
  -v /srv/lab/qm/bin/docker:/usr/local/bin/docker:ro \
  -e SANDBOX_BACKEND=local -e DEPLOYMENT_LAYER=/layer \
  --group-add "$DGID" --label "qm.org=tz" --label "qm.buzz=1" "$IMG_TAG"
rm -f "$ENVFILE"

bash /srv/lab/qm/scripts/patch-zen-baseurl.sh || true
bash /srv/lab/qm/scripts/patch-sandbox-host.sh || true

echo "waiting for core..."
for i in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8080/health >/dev/null 2>&1 || curl -sf http://127.0.0.1:8080/v1/health >/dev/null 2>&1; then
    echo "core healthy"
    break
  fi
  sleep 2
done

echo "--- buzz-related logs ---"
docker logs qm-tz-core 2>&1 | grep -iE 'buzz|listening|error' | tail -50
echo "DONE image=$(docker inspect qm-tz-core --format '{{.Config.Image}}')"