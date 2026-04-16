#!/usr/bin/env bash
#
# Apply schema.sql to $DATABASE_URL using psql.
# Equivalent to `bun run src/cli.ts init-schema` but useful when you want
# the raw psql output (constraint errors, NOTICE/WARNING messages, etc.).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCHEMA_PATH="$SCRIPT_DIR/../schema.sql"

if [ -f "$SCRIPT_DIR/../.env" ]; then
  set -a
  # shellcheck disable=SC1091
  source "$SCRIPT_DIR/../.env"
  set +a
fi

if [ -z "${DATABASE_URL:-}" ]; then
  echo "DATABASE_URL is not set. Copy .env.example to .env and fill it in." >&2
  exit 1
fi

echo "Applying $SCHEMA_PATH..."
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$SCHEMA_PATH"
echo "Done."
