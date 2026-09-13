#!/bin/bash
# One-Click Backend Deployment Script for VPS
set -e

echo "🚀 Deploying Backend Container..."

if ! command -v docker &> /dev/null; then
    echo "📦 Installing Docker..."
    curl -fsSL https://get.docker.com -o get-docker.sh
    sh get-docker.sh && rm get-docker.sh
fi

if [ ! -f .env ]; then
    if [ -f .env.example ]; then
        cp .env.example .env
        echo "📝 Created .env from .env.example. Please update BACKEND_URL in .env if needed."
    fi
fi

docker compose --env-file .env up --build -d
echo "✅ Backend container running on port 3000!"
docker compose ps
