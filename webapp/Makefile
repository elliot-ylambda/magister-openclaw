.PHONY: clean install dev lint build supabase-start migrate-local supabase-reset broadcast-test broadcast-send broadcast

clean:
	rm -rf .next node_modules

install:
	pnpm install

dev:
	@if [ -f .env.local ]; then \
		PORT=$$(grep NEXT_PUBLIC_APP_URL .env.local 2>/dev/null | sed -E 's/.*:([0-9]+).*/\1/'); \
		PORT=$${PORT:-3020}; \
	else \
		PORT=3020; \
	fi; \
	PID=$$(lsof -ti :$$PORT 2>/dev/null); \
	if [ -n "$$PID" ]; then \
		echo "Killing existing process on port $$PORT (PID $$PID)"; \
		kill -9 $$PID 2>/dev/null || true; \
		sleep 1; \
	fi; \
	echo "Starting dev server on port $$PORT"; \
	stripe listen --forward-to localhost:$$PORT/api/billing/webhook & \
	STRIPE_PID=$$!; \
	trap "kill $$STRIPE_PID 2>/dev/null" EXIT; \
	pnpm exec next dev --port $$PORT

lint:
	pnpm run lint

build:
	pnpm run build

supabase-start-local:
	supabase start

supabase-migrate-local:
	supabase migration up --local

supabase-reset-local:
	supabase db reset --local

SUPABASE_PROJECT_REF ?= $(shell grep NEXT_PUBLIC_SUPABASE_URL .env.production 2>/dev/null | sed -E 's|.*https://([^.]+)\.supabase\.co.*|\1|')

supabase-push-prod:
	@if [ -z "$(SUPABASE_PROJECT_REF)" ]; then echo "Error: Could not determine SUPABASE_PROJECT_REF from .env.local"; exit 1; fi
	supabase link --project-ref $(SUPABASE_PROJECT_REF)
	supabase db push

# Connect to local database
connect-local-db:
	psql 'postgresql://postgres:postgres@localhost:54322/postgres'

# ── Email Broadcasts ─────────────────────────────────────────────────────────
# Usage:
#   make broadcast-test to="email1@example.com,email2@example.com" t=waitlist-update-1
#   make broadcast-send to="email@example.com" t=waitlist-update-1
#   make broadcast t=waitlist-update-1

BROADCAST_URL ?= $(shell grep NEXT_PUBLIC_APP_URL .env.local 2>/dev/null | cut -d= -f2)/api/broadcast
BROADCAST_KEY ?= $(shell grep SUPABASE_SERVICE_ROLE_KEY .env.local 2>/dev/null | cut -d= -f2)

# Send test emails (subject prefixed with [TEST])
broadcast-test:
	@if [ -z "$(to)" ] || [ -z "$(t)" ]; then echo "Usage: make broadcast-test to=\"email@example.com\" t=template-name"; exit 1; fi
	@EMAILS=$$(echo '$(to)' | sed 's/,/","/g'); \
	curl -s -X POST $(BROADCAST_URL) \
		-H "Authorization: Bearer $(BROADCAST_KEY)" \
		-H "Content-Type: application/json" \
		-d "{\"template\": \"$(t)\", \"testEmails\": [\"$$EMAILS\"]}" | python3 -m json.tool

# Send to specific email addresses (real send, no [TEST] prefix)
broadcast-send:
	@if [ -z "$(to)" ] || [ -z "$(t)" ]; then echo "Usage: make broadcast-send to=\"email@example.com\" t=template-name"; exit 1; fi
	@EMAILS=$$(echo '$(to)' | sed 's/,/","/g'); \
	curl -s -X POST $(BROADCAST_URL) \
		-H "Authorization: Bearer $(BROADCAST_KEY)" \
		-H "Content-Type: application/json" \
		-d "{\"template\": \"$(t)\", \"to\": [\"$$EMAILS\"]}" | python3 -m json.tool

# Send to all waitlist subscribers
broadcast:
	@if [ -z "$(t)" ]; then echo "Usage: make broadcast t=template-name"; exit 1; fi
	@echo "⚠️  This will send to ALL waitlist subscribers. Press Enter to continue or Ctrl+C to cancel."
	@read _confirm
	@curl -s -X POST $(BROADCAST_URL) \
		-H "Authorization: Bearer $(BROADCAST_KEY)" \
		-H "Content-Type: application/json" \
		-d "{\"template\": \"$(t)\"}" | python3 -m json.tool
