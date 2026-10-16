@echo off
REM Setup Docker environment files for Windows

echo Creating backend/python/.env...
(
echo PORT=8001
echo HOST=0.0.0.0
echo NODE_ENV=development
echo FRONTEND_URL=http://localhost:5173
echo MONGODB_URI=mongodb://livemap:livemap_password@mongodb:27017
echo MONGODB_DB=spacer_land
echo JWT_SECRET=livemap-dev-secret-change-in-prod-docker-environment
echo TOKEN_TTL_SECONDS=86400
echo JWT_COOKIE_NAME=access_token
echo COOKIE_SECURE=false
echo COOKIE_SAME_SITE=lax
echo INTERNAL_GIS_SECRET=dev-internal-secret-key-change-in-prod-docker
echo STORAGE_DRIVER=local
echo LOCAL_STORAGE_PATH=/app/storage
) > backend\python\.env

echo Creating frontend/.env...
(
echo VITE_API_BASE_URL=/api
echo VITE_BACKEND_URL=http://localhost:8001
) > frontend\.env

echo.
echo Docker environment files created successfully!
echo Run: docker-compose up -d
pause
