.PHONY: clean install dev lint build supabase-start migrate-local supabase-reset

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
	pnpm exec next dev --port $$PORT

lint:
	pnpm run lint

build:
	pnpm run build

supabase-start-local:
	supabase start --local

supabase-migrate-local:
	supabase unlink || true
	supabase migration up --local

supabase-reset-local:
	supabase db reset --local

# Connect to local database
connect-local-db:
	psql 'postgresql://postgres:postgres@localhost:54322/postgres'
