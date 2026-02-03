# Testing the Moltbot SaaS Platform

This guide explains how to run and test the SaaS application locally.

## Prerequisites

- Docker and Docker Compose
- Node.js 22+
- pnpm (or npm)
- curl and jq (for API testing)

## Quick Start

### 1. Start the Development Environment

```bash
cd saas

# Start all services (PostgreSQL, Vault, API)
docker compose -f docker-compose.dev.yaml up -d

# Check services are running
docker compose -f docker-compose.dev.yaml ps
```

Expected output:
```
NAME                  STATUS
moltbot-saas-api      running
moltbot-saas-db       running
moltbot-saas-vault    running
```

### 2. Run Database Migrations

```bash
# Connect to the database and run migrations
docker exec -i moltbot-saas-db psql -U moltbot -d moltbot_saas < src/db/schema.sql
docker exec -i moltbot-saas-db psql -U moltbot -d moltbot_saas < src/db/migrations/002_encrypted_storage.sql
docker exec -i moltbot-saas-db psql -U moltbot -d moltbot_saas < src/db/migrations/003_media_storage.sql
```

### 3. Run the API Tests

```bash
# Make the test script executable
chmod +x scripts/test-api.sh

# Run tests
./scripts/test-api.sh
```

## Manual API Testing

### Authentication

```bash
BASE_URL="http://localhost:3000"

# Health check
curl -s "$BASE_URL/health" | jq

# Sign up
curl -s -X POST "$BASE_URL/api/auth/signup" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "SecurePass123"}' | jq

# Login
LOGIN=$(curl -s -X POST "$BASE_URL/api/auth/login" \
  -H "Content-Type: application/json" \
  -d '{"email": "test@example.com", "password": "SecurePass123"}')
TOKEN=$(echo $LOGIN | jq -r '.tokens.accessToken')

# Get current user
curl -s "$BASE_URL/api/auth/me" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Agent Management

```bash
# Check agent status
curl -s "$BASE_URL/api/agent/status" \
  -H "Authorization: Bearer $TOKEN" | jq

# Provision agent (requires Kubernetes)
curl -s -X POST "$BASE_URL/api/agent/provision" \
  -H "Authorization: Bearer $TOKEN" | jq

# Get agent logs
curl -s "$BASE_URL/api/agent/logs" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Media Upload & Transcription

```bash
# Upload a file
curl -s -X POST "$BASE_URL/api/media/upload" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/file.jpg" | jq

# List files
curl -s "$BASE_URL/api/media/files" \
  -H "Authorization: Bearer $TOKEN" | jq

# Get storage usage
curl -s "$BASE_URL/api/media/usage" \
  -H "Authorization: Bearer $TOKEN" | jq

# Transcribe audio (requires OpenAI API key configured)
curl -s -X POST "$BASE_URL/api/media/transcribe" \
  -H "Authorization: Bearer $TOKEN" \
  -F "file=@/path/to/audio.mp3" | jq

# List transcriptions
curl -s "$BASE_URL/api/media/transcriptions" \
  -H "Authorization: Bearer $TOKEN" | jq
```

### Billing & Usage

```bash
# Get available plans
curl -s "$BASE_URL/api/billing/plans" \
  -H "Authorization: Bearer $TOKEN" | jq

# Get current usage
curl -s "$BASE_URL/api/usage" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Testing the Web Frontend

### 1. Start the Web Dev Server

```bash
cd saas/web

# Install dependencies
pnpm install

# Start dev server
pnpm dev
```

The web app will be available at http://localhost:5173

### 2. Test Features

1. **Sign Up/Login**: Create an account and log in
2. **Chat**: Send messages (requires agent to be provisioned)
3. **Voice Input**: Click the microphone icon to record and transcribe
4. **File Upload**: Drag and drop or click to upload files

## Testing WebRTC Voice Calls

The WebRTC signaling server runs on `/rtc` websocket endpoint.

```javascript
// In browser console
const ws = new WebSocket(`ws://localhost:3000/rtc?token=${yourToken}`);

ws.onopen = () => {
  ws.send(JSON.stringify({ type: 'join', roomId: 'test-room' }));
};

ws.onmessage = (event) => {
  console.log('Received:', JSON.parse(event.data));
};
```

## Environment Variables

Create a `.env` file in the `saas` directory:

```bash
# Database
DATABASE_URL=postgres://moltbot:moltbot@localhost:5432/moltbot_saas

# JWT Secrets (generate with: openssl rand -hex 32)
JWT_ACCESS_SECRET=your-access-secret-here
JWT_REFRESH_SECRET=your-refresh-secret-here

# Vault (optional, for production)
VAULT_ADDR=http://localhost:8200
VAULT_TOKEN=dev-token

# OpenAI (for transcription)
OPENAI_API_KEY=sk-...
```

## Testing with Kubernetes (Full Stack)

For testing the full orchestration with Kubernetes:

### 1. Install Minikube or Kind

```bash
# Using minikube
minikube start

# Or using kind
kind create cluster --name moltbot-saas
```

### 2. Build and Load the Agent Image

```bash
# Build agent image
docker build -f docker/Dockerfile.agent -t moltbot-agent:latest .

# Load into minikube
minikube image load moltbot-agent:latest

# Or for kind
kind load docker-image moltbot-agent:latest --name moltbot-saas
```

### 3. Apply Control Plane Network Policies

```bash
kubectl apply -f k8s/templates/control-plane-network-policy.yaml
```

### 4. Test Agent Provisioning

```bash
# Provision a tenant agent
curl -s -X POST "$BASE_URL/api/agent/provision" \
  -H "Authorization: Bearer $TOKEN" | jq

# Check status (should show provisioning -> active)
curl -s "$BASE_URL/api/agent/status" \
  -H "Authorization: Bearer $TOKEN" | jq
```

## Troubleshooting

### Database Connection Issues

```bash
# Check if PostgreSQL is running
docker logs moltbot-saas-db

# Connect directly
docker exec -it moltbot-saas-db psql -U moltbot -d moltbot_saas
```

### Vault Issues

```bash
# Check Vault status
curl -s http://localhost:8200/v1/sys/health | jq

# Check Vault logs
docker logs moltbot-saas-vault
```

### API Logs

```bash
# View API logs
docker logs -f moltbot-saas-api
```

### Reset Everything

```bash
# Stop and remove all containers and volumes
docker compose -f docker-compose.dev.yaml down -v

# Start fresh
docker compose -f docker-compose.dev.yaml up -d
```

## Running Tests Programmatically

```bash
# From the saas directory
cd saas

# Install dependencies
pnpm install

# Run unit tests (when available)
pnpm test

# Run with coverage
pnpm test:coverage
```
