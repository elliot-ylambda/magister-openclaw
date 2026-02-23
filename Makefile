.PHONY: up down logs seed reset \
	webapp-clean webapp-install webapp-dev webapp-lint webapp-build \
	supabase-start supabase-migrate supabase-reset connect-local-db \
	gateway-install gateway-dev gateway-test gateway-lint \
	health status chat provision

# ─── Docker Compose ───────────────────────────────────────────

up:
	docker compose up --build -d

down:
	docker compose down

logs:
	docker compose logs -f

seed:
	cd webapp && pnpm supabase db reset --local

reset: down
	docker compose down -v
	$(MAKE) seed
	$(MAKE) up

# ─── Webapp ───────────────────────────────────────────────────

webapp-clean:
	$(MAKE) -C webapp clean

webapp-install:
	$(MAKE) -C webapp install

webapp-dev:
	$(MAKE) -C webapp dev

webapp-lint:
	$(MAKE) -C webapp lint

webapp-build:
	$(MAKE) -C webapp build

# ─── Supabase ─────────────────────────────────────────────────

supabase-start:
	$(MAKE) -C webapp supabase-start-local

supabase-migrate:
	$(MAKE) -C webapp supabase-migrate-local

supabase-reset:
	$(MAKE) -C webapp supabase-reset-local

connect-local-db:
	$(MAKE) -C webapp connect-local-db

# ─── Gateway ──────────────────────────────────────────────────

gateway-install:
	$(MAKE) -C gateway install

gateway-dev:
	$(MAKE) -C gateway dev

gateway-test:
	$(MAKE) -C gateway test

gateway-lint:
	$(MAKE) -C gateway lint

# ─── Local Dev Testing ────────────────────────────────────────

# Helper: get a JWT for the dev user (used by other targets)
define get_dev_token
$(shell ANON_KEY=$$(grep NEXT_PUBLIC_SUPABASE_ANON_KEY webapp/.env.local | cut -d= -f2); \
	curl -s -X POST "http://localhost:54321/auth/v1/token?grant_type=password" \
		-H "apikey: $$ANON_KEY" \
		-H "Content-Type: application/json" \
		-d '{"email":"dev@magister.local","password":"dev-password-not-for-production"}' \
	| python3 -c "import sys,json; print(json.load(sys.stdin)['access_token'])")
endef

health:
	curl -s http://localhost:8080/health | python3 -m json.tool

status:
	@TOKEN=$(get_dev_token); \
	curl -s http://localhost:8080/api/status \
		-H "Authorization: Bearer $$TOKEN" | python3 -m json.tool

provision:
	curl -s -X POST http://localhost:8080/api/provision \
		-H "Authorization: Bearer dev-gateway-api-key-local-unsafe" \
		-H "Content-Type: application/json" \
		-d '{"user_id": "00000000-0000-0000-0000-000000000001", "plan": "cmo"}' \
	| python3 -m json.tool

# Usage: make chat m="Hello"                        (returns JSON, default)
#        make chat m="Hello" s=true                  (streams SSE)
#        make chat m="Hello" sid=<session_id>        (continue conversation)
s ?= false
sid ?=
chat:
ifeq ($(s),true)
	@TOKEN=$(get_dev_token); \
	SID_JSON=""; \
	if [ -n "$(sid)" ]; then SID_JSON=', "session_id": "$(sid)"'; fi; \
	curl -N -X POST http://localhost:8080/api/chat \
		-H "Authorization: Bearer $$TOKEN" \
		-H "Content-Type: application/json" \
		-d "{\"message\": \"$(m)\", \"stream\": true$$SID_JSON}"
else
	@TOKEN=$(get_dev_token); \
	SID_JSON=""; \
	if [ -n "$(sid)" ]; then SID_JSON=', "session_id": "$(sid)"'; fi; \
	curl -s -X POST http://localhost:8080/api/chat \
		-H "Authorization: Bearer $$TOKEN" \
		-H "Content-Type: application/json" \
		-d "{\"message\": \"$(m)\", \"stream\": false$$SID_JSON}" | python3 -m json.tool
endif
