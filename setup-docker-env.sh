#!/bin/bash
# Setup Docker environment files

# Backend .env
cat > backend/python/.env << 'EOF'
PORT=8001
HOST=0.0.0.0
NODE_ENV=development
FRONTEND_URL=http://localhost:5173
MONGODB_URI=mongodb://livemap:livemap_password@mongodb:27017
MONGODB_DB=spacer_land
JWT_SECRET=livemap-dev-secret-change-in-prod-docker-environment
TOKEN_TTL_SECONDS=86400
JWT_COOKIE_NAME=access_token
COOKIE_SECURE=false
COOKIE_SAME_SITE=lax
INTERNAL_GIS_SECRET=dev-internal-secret-key-change-in-prod-docker
STORAGE_DRIVER=local
LOCAL_STORAGE_PATH=/app/storage
EOF

# Frontend .env
cat > frontend/.env << 'EOF'
VITE_API_BASE_URL=/api
VITE_BACKEND_URL=http://localhost:8001
EOF

echo "Docker environment files created successfully!"
echo "Run: docker-compose up -d"
