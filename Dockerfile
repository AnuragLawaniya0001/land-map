# ==============================================================================
# STAGE 1: Build React Frontend
# ==============================================================================
FROM node:20-alpine AS frontend-builder
WORKDIR /app/frontend

COPY frontend/package*.json ./
RUN npm install

COPY frontend/ ./
ENV VITE_API_BASE_URL=/api
RUN npm run build

# ==============================================================================
# STAGE 2: Python Backend + Nginx + Supervisor (Unified Single Container)
# ==============================================================================
FROM python:3.11-slim-bookworm

WORKDIR /app

# Install system dependencies: GIS libraries, build tools, Nginx, and Supervisor
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc \
    g++ \
    libcairo2-dev \
    libpango1.0-dev \
    pkg-config \
    libxml2-dev \
    libxslt1-dev \
    python3-dev \
    libgl1 \
    libglib2.0-0 \
    nginx \
    supervisor \
    curl \
    && rm -rf /var/lib/apt/lists/* \
    && rm -f /etc/nginx/sites-enabled/default

# Install Python backend dependencies
COPY backend/requirements.txt /app/backend/
RUN pip install --no-cache-dir -r /app/backend/requirements.txt

# Copy Backend application code
COPY backend/ /app/backend/

# Copy built frontend assets from Stage 1 into Nginx web root
COPY --from=frontend-builder /app/frontend/dist /app/frontend/dist

# Copy Nginx and Supervisor configurations
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY supervisord.conf /etc/supervisor/conf.d/supervisord.conf
COPY entrypoint.sh /app/entrypoint.sh
COPY entrypoint.py /app/entrypoint.py
RUN sed -i 's/\r$//' /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Ensure persistent directories exist
RUN mkdir -p /app/backend/storage /app/backend/models

# Set working directory to backend
WORKDIR /app/backend

# Expose Frontend (4800) and Backend (4801)
EXPOSE 4800 4801

# Start via entrypoint
ENTRYPOINT ["python", "/app/entrypoint.py"]
