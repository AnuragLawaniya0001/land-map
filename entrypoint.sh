#!/bin/bash
set -e

echo "=== LiveMap Container Starting ==="

# Ensure persistent directories exist
mkdir -p /app/backend/storage /app/backend/models

echo "Starting Supervisord immediately (Backend on port 4801, Frontend on port 4800, Models in background)..."
exec /usr/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf