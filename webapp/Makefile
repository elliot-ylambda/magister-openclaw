.PHONY: clean install dev lint build

clean:
	rm -rf .next node_modules

install:
	pnpm install

dev:
	@if [ -f .env.local ]; then \
		PORT=$$(grep NEXT_PUBLIC_APP_URL .env.local 2>/dev/null | sed -E 's/.*:([0-9]+).*/\1/'); \
		PORT=$${PORT:-3000}; \
	else \
		PORT=3000; \
	fi; \
	echo "Starting dev server on port $$PORT"; \
	pnpm exec next dev --port $$PORT

lint:
	pnpm run lint

build:
	pnpm run build
