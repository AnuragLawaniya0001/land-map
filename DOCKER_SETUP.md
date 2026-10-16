# LiveMap Docker Setup

This document provides instructions for running LiveMap with Docker for MongoDB and Frontend, while running the Python Backend locally.

## Prerequisites

- Docker Desktop installed and running
- Python 3.11+ installed locally
- Node.js (already in Docker)

## Quick Start

### Step 1: Start Docker Services (MongoDB + Frontend)
```bash
docker compose up -d
```

### Step 2: Start Python Backend Locally
```bash
cd backend/python
.venv\Scripts\python.exe -m uvicorn app.server:app --host 127.0.0.1 --port 8001 --reload
```

### Step 3: Access the application
- Frontend: http://localhost:5173
- Backend API: http://localhost:8001
- MongoDB: mongodb://livemap:livemap_password@localhost:27017

## Services

### MongoDB (Docker)
- Port: 27017
- Username: `livemap`
- Password: `livemap_password`
- Database: `spacer_land`
- Data persistence: Docker volumes

### Frontend (Docker - React/Vite)
- Port: 5173
- Hot module replacement enabled
- Proxies API requests to local backend

### Backend (Local - Python/FastAPI)
- Port: 8001
- Auto-reload enabled for development
- Connects to Docker MongoDB via localhost:27017

## Environment Variables

### Docker Services (docker-compose.yml)
**MongoDB:**
- `MONGODB_URI=mongodb://livemap:livemap_password@mongodb:27017`
- `MONGODB_DB=spacer_land`

**Frontend:**
- `VITE_API_BASE_URL=/api`
- `VITE_BACKEND_URL=http://localhost:8001`

### Local Backend (backend/python/.env)
```
PORT=8001
HOST=0.0.0.0
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
MONGODB_URI=mongodb://livemap:livemap_password@localhost:27017
MONGODB_DB=spacer_land
JWT_SECRET=livemap-dev-secret-change-in-prod-docker-environment
TOKEN_TTL_SECONDS=86400
JWT_COOKIE_NAME=access_token
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
INTERNAL_GIS_SECRET=dev-internal-secret-key-change-in-prod-docker
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=./storage
```

## Common Commands

### Docker Services:
```bash
# Start Docker services
docker compose up -d

# View Docker logs
docker compose logs -f

# Stop Docker services
docker compose down

# Stop and remove volumes (cleans database)
docker compose down -v

# Rebuild frontend
docker compose up -d --build frontend
```

### Local Backend:
```bash
# Start backend (Windows)
cd backend/python
.venv\Scripts\python.exe -m uvicorn app.server:app --host 127.0.0.1 --port 8001 --reload

# Start backend (Linux/Mac)
cd backend/python
.venv/bin/python -m uvicorn app.server:app --host 127.0.0.1 --port 8001 --reload
```

### MongoDB Operations:
```bash
# Access MongoDB shell
docker exec -it livemap-mongodb mongosh -u livemap -p livemap_password

# Backup MongoDB data
docker exec livemap-mongodb mongodump --uri="mongodb://livemap:livemap_password@localhost:27017" --archive=/tmp/backup.archive
docker cp livemap-mongodb:/tmp/backup.archive ./backup.archive

# Restore MongoDB data
docker cp ./backup.archive livemap-mongodb:/tmp/backup.archive
docker exec livemap-mongodb mongorestore --uri="mongodb://livemap:livemap_password@localhost:27017" --archive=/tmp/backup.archive
```

## Troubleshooting

### MongoDB connection issues
- Ensure MongoDB container is healthy: `docker compose ps`
- Check MongoDB logs: `docker compose logs mongodb`
- Verify backend .env has correct MONGODB_URI

### Backend not starting
- Ensure Python virtual environment is activated
- Check MongoDB is running: `docker compose ps`
- Verify port 8001 is not in use
- Check backend .env configuration

### Frontend not accessible
- Check if frontend container is running: `docker compose ps`
- View frontend logs: `docker compose logs frontend`
- Ensure port 5173 is not in use

### Frontend can't connect to backend
- Ensure backend is running locally on port 8001
- Check backend logs for errors
- Verify VITE_BACKEND_URL in docker-compose.yml

## Storage

MongoDB data is stored in Docker volumes:
- `mongodb_data`: MongoDB database files
- `mongodb_config`: MongoDB configuration

Backend files are stored locally:
- `backend/python/storage`: Local file storage (uploads, etc.)

To view volumes:
```bash
docker volume ls
```

To remove volumes (⚠️ deletes all data):
```bash
docker compose down -v
```
