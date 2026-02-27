FROM python:3.12-slim

RUN apt-get update && apt-get install -y --no-install-recommends socat \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /srv

# Install dependencies (cached layer)
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

# Copy application code
COPY app/ app/

EXPOSE 8080 8081

# Port 8080: IPv4 for Fly's external proxy
# Port 8081: IPv6 bridge for Fly 6PN internal traffic (user machines → gateway)
CMD ["/bin/sh", "-c", "socat TCP6-LISTEN:8081,fork,reuseaddr,bind=[::] TCP4:127.0.0.1:8080 & exec uvicorn app.main:app --host 0.0.0.0 --port 8080"]
