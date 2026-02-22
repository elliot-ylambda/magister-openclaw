.PHONY: up down logs seed reset

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
