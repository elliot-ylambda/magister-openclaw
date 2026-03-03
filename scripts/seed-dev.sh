#!/usr/bin/env bash
# Seeds the local dev user + machine for Docker-based development.
# Called by `make db-reset` after migrations are applied.
set -euo pipefail

SUPABASE_URL="${SUPABASE_URL:-http://127.0.0.1:54321}"
DB_URL="${DB_URL:-postgresql://postgres:postgres@127.0.0.1:54322/postgres}"

# Pull service role key from webapp/.env.local
ENV_FILE="webapp/.env.local"
if [[ ! -f "$ENV_FILE" ]]; then
  echo "ERROR: $ENV_FILE not found. Run 'make env' first." >&2
  exit 1
fi

SERVICE_ROLE_KEY=$(grep SUPABASE_SERVICE_ROLE_KEY "$ENV_FILE" | cut -d= -f2)
if [[ -z "$SERVICE_ROLE_KEY" ]]; then
  echo "ERROR: SUPABASE_SERVICE_ROLE_KEY not set in $ENV_FILE" >&2
  exit 1
fi

# 1. Create dev user via GoTrue admin API
#    Uses 422 (already exists) as a success case for idempotency.
HTTP_CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
  "$SUPABASE_URL/auth/v1/admin/users" \
  -H "apikey: $SERVICE_ROLE_KEY" \
  -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "id": "00000000-0000-0000-0000-000000000001",
    "email": "dev@magister.local",
    "password": "dev-password-not-for-production",
    "email_confirm": true,
    "user_metadata": {"name": "Dev User"}
  }')

if [[ "$HTTP_CODE" == "200" ]]; then
  echo "Dev user created (dev@magister.local)"
elif [[ "$HTTP_CODE" == "422" ]]; then
  echo "Dev user already exists (dev@magister.local)"
else
  echo "ERROR: GoTrue returned HTTP $HTTP_CODE when creating dev user" >&2
  exit 1
fi

# 2. Insert dev machine row via psql
psql "$DB_URL" -q -c "
INSERT INTO public.user_machines (id, user_id, fly_app_name, fly_machine_id, fly_region, status, plan, gateway_token, gateway_token_hash)
VALUES (
  '00000000-0000-0000-0000-000000000002',
  '00000000-0000-0000-0000-000000000001',
  'magister-dev-local',
  'dev-machine-local',
  'local',
  'running',
  'cmo',
  'dev-local-token-magister-2026',
  encode(sha256('dev-local-token-magister-2026'::bytea), 'hex')
) ON CONFLICT (id) DO NOTHING;
"

echo "Dev machine row seeded"
