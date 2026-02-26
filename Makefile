.PHONY: up down logs seed reset \
	image-build image-push \
	webapp-clean webapp-install webapp-dev webapp-lint webapp-build \
	supabase-start supabase-migrate supabase-reset connect-local-db \
	gateway-install gateway-dev gateway-test gateway-lint \
	health status chat provision slack-challenge \
	deploy-gateway deploy-image deploy-machines deploy-all

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

# ─── OpenClaw Image ──────────────────────────────────────────

IMAGE_NAME ?= magister-openclaw
IMAGE_TAG  ?= latest

image-build:
	docker build -t $(IMAGE_NAME):$(IMAGE_TAG) ./openclaw-image

image-push:
	docker push $(IMAGE_NAME):$(IMAGE_TAG)

# ─── Production Deploy ───────────────────────────────────────

FLY_IMAGE     ?= registry.fly.io/magister-user-machine
FLY_IMAGE_TAG ?= latest
GATEWAY_APP   ?= magister-gateway

# Deploy gateway to Fly.io
deploy-gateway:
	cd gateway && flyctl deploy -a $(GATEWAY_APP)

# Build and push user machine image to Fly registry
deploy-image:
	flyctl auth docker
	docker build -t $(FLY_IMAGE):$(FLY_IMAGE_TAG) ./openclaw-image
	docker push $(FLY_IMAGE):$(FLY_IMAGE_TAG)

# Rolling update all user machines to the latest image.
# - Running machines: restart with new image
# - Stopped/suspended machines: update config only (--skip-start)
deploy-machines:
	@IMAGE="$(FLY_IMAGE):$(FLY_IMAGE_TAG)"; \
	echo "Rolling update to $$IMAGE"; \
	echo "---"; \
	APPS=$$(flyctl apps list --json 2>/dev/null \
		| python3 -c "import json,sys; \
			skip={'$(GATEWAY_APP)','magister-user-machine'}; \
			apps=[a['Name'] for a in json.load(sys.stdin) if a['Name'].startswith('magister-') and a['Name'] not in skip]; \
			print('\n'.join(apps))" \
	); \
	if [ -z "$$APPS" ]; then echo "No user machines found."; exit 0; fi; \
	TOTAL=$$(echo "$$APPS" | wc -l | tr -d ' '); \
	echo "Found $$TOTAL user machine app(s)"; \
	echo "---"; \
	I=0; FAILED=0; \
	for APP in $$APPS; do \
		I=$$((I + 1)); \
		echo "[$$I/$$TOTAL] $$APP"; \
		MACHINE_INFO=$$(flyctl machines list -a $$APP --json 2>/dev/null); \
		MACHINE_ID=$$(echo "$$MACHINE_INFO" | python3 -c "import json,sys; ms=json.load(sys.stdin); print(ms[0]['id'] if ms else '')" 2>/dev/null); \
		STATE=$$(echo "$$MACHINE_INFO" | python3 -c "import json,sys; ms=json.load(sys.stdin); print(ms[0].get('state','') if ms else '')" 2>/dev/null); \
		if [ -z "$$MACHINE_ID" ]; then \
			echo "  SKIP: no machines found"; \
			continue; \
		fi; \
		echo "  machine=$$MACHINE_ID state=$$STATE"; \
		if [ "$$STATE" = "started" ] || [ "$$STATE" = "running" ]; then \
			if flyctl machine update $$MACHINE_ID --image $$IMAGE -a $$APP --yes 2>&1; then \
				echo "  OK: restarted with new image"; \
			else \
				echo "  FAIL: update failed"; \
				FAILED=$$((FAILED + 1)); \
			fi; \
		else \
			if flyctl machine update $$MACHINE_ID --image $$IMAGE -a $$APP --skip-start --yes 2>&1; then \
				echo "  OK: config updated (machine stays $$STATE)"; \
			else \
				echo "  FAIL: update failed"; \
				FAILED=$$((FAILED + 1)); \
			fi; \
		fi; \
	done; \
	echo "---"; \
	echo "Done: $$((I - FAILED))/$$TOTAL succeeded."; \
	if [ $$FAILED -gt 0 ]; then echo "WARNING: $$FAILED machine(s) failed."; exit 1; fi

# Deploy everything: image + gateway + rolling update machines
deploy-all: deploy-image deploy-gateway deploy-machines

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

# Slack webhook: test URL verification challenge
# Requires SLACK_SIGNING_SECRET in .env.gateway.docker
slack-challenge:
	@SECRET=$$(grep SLACK_SIGNING_SECRET .env.gateway.docker 2>/dev/null | cut -d= -f2); \
	if [ -z "$$SECRET" ]; then echo "Error: SLACK_SIGNING_SECRET not set in .env.gateway.docker"; exit 1; fi; \
	BODY='{"type":"url_verification","challenge":"make-test-challenge"}'; \
	TS=$$(date +%s); \
	SIG="v0=$$(echo -n "v0:$${TS}:$${BODY}" | openssl dgst -sha256 -hmac "$$SECRET" | awk '{print $$2}')"; \
	curl -s -X POST http://localhost:8080/webhooks/slack \
		-H "Content-Type: application/json" \
		-H "x-slack-request-timestamp: $$TS" \
		-H "x-slack-signature: $$SIG" \
		-d "$$BODY" | python3 -m json.tool
