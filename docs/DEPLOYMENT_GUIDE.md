# Production Deployment and Operations Guide

This guide details the steps to build, configure, deploy, and monitor the LiveMap Colony GIS Platform in a production environment.

---

## 1. Prerequisites and System Requirements

* **Operating System**: Linux (Ubuntu 22.04 LTS / Debian 12 / RHEL 9) or Windows Server
* **Python**: Python 3.11+
* **Node.js**: Node 20 LTS or Node 22 LTS
* **Database**: MongoDB 6.0+ (Replica Set recommended for atomic transactions)
* **Hardware**:
  * Minimum: 2 vCPU, 4 GB RAM, 20 GB SSD
  * Recommended: 4 vCPU, 8 GB RAM, 50 GB NVMe SSD (for high-volume PDF rendering)

---

## 2. Environment Configuration

1. Copy the example configuration template:
   ```bash
   cp backend/python/.env.production.example backend/python/.env
   ```
2. Configure mandatory production secrets:
   * Generate a 64-character JWT Secret:
     ```bash
     python -c "import secrets; print(secrets.token_hex(32))"
     ```
   * Set `JWT_SECRET` and `INTERNAL_GIS_SECRET` in `.env`.
   * Configure `MONGODB_URI` pointing to your managed MongoDB cluster.

---

## 3. Building and Serving

### Step 1: Build Frontend Assets
```bash
cd frontend
npm ci
npm run build
```
The compiled bundle will be output to `frontend/dist/`.

### Step 2: Install Backend Dependencies
```bash
cd ../backend/python
python -m venv .venv
source .venv/bin/activate  # On Windows: .venv\Scripts\activate
pip install -r requirements.txt
```

### Step 3: Initialize Database Indexes
```bash
python -c "import asyncio; from app.server import DB; from app.gis.canonical.init_db_indexes import init_canonical_indexes; asyncio.run(init_canonical_indexes(DB))"
```

### Step 4: Launch Production Server
```bash
uvicorn app.server:app \
  --host 0.0.0.0 \
  --port 8001 \
  --workers 4 \
  --log-level info
```

---

## 4. Reverse Proxy (Nginx) Configuration

```nginx
server {
    listen 80;
    server_name map.yourdomain.com;
    return 301 https://$host$request_uri;
}

server {
    listen 443 ssl http2;
    server_name map.yourdomain.com;

    ssl_certificate /etc/letsencrypt/live/map.yourdomain.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/map.yourdomain.com/privkey.pem;

    client_max_body_size 50M;

    location / {
        proxy_pass http://127.0.0.1:8001;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }

    location /api/health {
        proxy_pass http://127.0.0.1:8001/api/health;
        access_log off;
    }
}
```

---

## 5. Observability & Health Monitoring

Configure automated uptime probes pointing to `/api/health`.
* Interval: 30 seconds
* Timeout: 5 seconds
* Healthy response: HTTP 200 with `"status": "HEALTHY"`
* Unhealthy threshold: 2 consecutive failures triggers alerting
