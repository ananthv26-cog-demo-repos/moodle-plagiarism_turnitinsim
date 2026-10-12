#!/usr/bin/env bash
# Brings up Moodle 4.5 + Postgres + the mock Turnitin API, installs Moodle on
# first run, and seeds the Northgate University demo data. Idempotent.
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f .moodle/version.php ]; then
  echo "==> Cloning Moodle 4.5 (MOODLE_405_STABLE)"
  git clone --depth 1 --branch MOODLE_405_STABLE https://github.com/moodle/moodle.git .moodle
fi

echo "==> Starting containers"
docker compose up -d

echo "==> Waiting for Moodle web"
for i in $(seq 1 60); do
  code=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:8080/ || true)
  [ "$code" != "000" ] && break
  sleep 2
done

docker compose exec -T moodle chown -R www-data:www-data /var/www/moodledata

if ! docker compose exec -T db psql -U moodle -tAc "select 1 from mdl_config limit 1" >/dev/null 2>&1; then
  echo "==> Installing Moodle database (takes ~2 min)"
  docker compose exec -T -u www-data moodle php admin/cli/install_database.php \
    --agree-license --adminuser=admin --adminpass='Admin-123!' \
    --adminemail=admin@northgate.edu --fullname='Northgate University' \
    --shortname=Northgate --lang=en >/dev/null
else
  docker compose exec -T -u www-data moodle php admin/cli/upgrade.php --non-interactive >/dev/null
fi

echo "==> Seeding course, users and Turnitin Integrity config"
docker compose exec -T -u www-data moodle php plagiarism/turnitinsim/e2e/cli/seed.php 2>/dev/null | grep -v '^\*\|^ in /'

cat <<MSG

Moodle:        http://localhost:8080   (admin / Admin-123!)
Mock Turnitin: http://localhost:8090   (console + request log)
Instructor:    dana.whitfield / Demo-Pass1!
Students:      priya.nair, marcus.bell, leo.okafor / Demo-Pass1!

Run the suite:  cd playwright && npm install && npx playwright install chromium && npx playwright test
MSG
