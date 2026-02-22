.PHONY: install dev test lint

install:
	python -m venv .venv
	.venv/bin/pip install -r requirements.txt

dev:
	.venv/bin/uvicorn app.main:app --reload --host 0.0.0.0 --port 8080

test:
	.venv/bin/python -m pytest tests/ -v

lint:
	.venv/bin/python -m py_compile app/config.py
	.venv/bin/python -m py_compile app/models.py
	.venv/bin/python -m py_compile app/main.py
