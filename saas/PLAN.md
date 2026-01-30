# Moltbot SaaS Transformation Plan

## Executive Summary

Transform moltbot from a self-hosted personal assistant into a multi-tenant SaaS platform where each customer gets an isolated, secure moltbot agent instance with web-based chat, voice, and media communication.

---

## Architecture Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    Load Balancer (Ingress)                   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│                   Control Plane (saas-api)                   │
│   ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐   │
│   │   Auth   │  │ Billing  │  │Orchesttic│  │  WebUI   │   │
│   └──────────┘  └──────────┘  └──────────┘  └──────────┘   │
└─────────────────────────┬───────────────────────────────────┘
                          │
┌─────────────────────────▼───────────────────────────────────┐
│              Tenant Namespace (ns-{user_id})                 │
│   ┌─────────────────────────────────────────────────────┐   │
│   │              Moltbot Agent Pod                       │   │
│   │  ┌─────────┐  ┌─────────┐  ┌─────────────────────┐  │   │
│   │  │ Gateway │  │  Agent  │  │ Encrypted Storage   │  │   │
│   │  │  :18789 │  │ Runtime │  │  (PVC + LUKS/Vault) │  │   │
│   │  └─────────┘  └─────────┘  └─────────────────────┘  │   │
│   └─────────────────────────────────────────────────────┘   │
│   NetworkPolicy: egress whitelist only                       │
└─────────────────────────────────────────────────────────────┘
```

---

## Phase 1: Foundation - User Management & Authentication

### 1.1 Authentication Service (`saas/auth/`)

**New Components:**
- User signup/login with email + password (Argon2id hashing)
- OAuth providers (Google, GitHub, Microsoft)
- JWT-based session management
- Email verification and password reset flows
- TOTP-based 2FA support

**Database Schema (PostgreSQL):**
```sql
-- users, subscriptions, api_keys, sessions tables
-- Customer data isolated by user_id foreign keys
```

**Key Files:**
- `saas/auth/service.ts` - Authentication logic
- `saas/auth/jwt.ts` - Token generation/validation
- `saas/auth/middleware.ts` - Auth middleware for routes
- `saas/db/schema.sql` - Database schema
- `saas/db/migrations/` - Database migrations

### 1.2 Subscription & Billing

**Features:**
- Stripe integration for payments
- Free tier with limits (messages/day, compute hours)
- Paid tiers with higher limits and features
- Usage metering and billing

---

## Phase 2: Compute Orchestration

### 2.1 Architecture Decision

**Recommended: Kubernetes with isolated pods per user**

### 2.2 Orchestrator Service (`saas/orchestrator/`)

**Responsibilities:**
- Provision new tenant namespace + pod on signup
- Scale down idle instances (cost optimization)
- Automatic wake-on-request for sleeping instances
- Health monitoring and auto-restart
- Resource limits enforcement (CPU, memory, storage)

**Key Files:**
- `saas/orchestrator/service.ts` - Orchestration logic
- `saas/orchestrator/k8s-client.ts` - Kubernetes API wrapper
- `saas/orchestrator/templates/` - Pod/service YAML templates
- `saas/orchestrator/scaling.ts` - Scale-to-zero logic

### 2.3 Tenant Lifecycle

```
Signup → Create namespace → Deploy pod → Initialize encrypted storage
       → Configure agent → Proxy ready → User can connect
```

**Cold Start Optimization:**
- Warm pool of pre-provisioned pods (configurable size)
- Container image caching on nodes
- Pre-loaded common dependencies

---

## Phase 3: Web Interface

### 3.1 Frontend Application (`saas/web/`)

**Tech Stack:**
- React/Next.js (SSR for SEO, CSR for app)
- WebSocket for real-time chat
- WebRTC for voice/video
- IndexedDB for offline message queue

**Features:**
- **Chat Interface:**
  - Real-time bidirectional messaging
  - Message history with pagination
  - Markdown rendering
  - Code syntax highlighting
  - File/image/video upload and preview
  - Message search

- **Voice Communication:**
  - WebRTC-based voice calls
  - Push-to-talk and continuous modes
  - Speech-to-text integration (existing moltbot voice support)
  - Voice activity detection

- **Media Support:**
  - Image upload with preview
  - Video upload with transcoding status
  - Document attachments (PDF, etc.)
  - Camera/screenshot capture
  - Canvas rendering (existing moltbot feature)

### 3.2 WebSocket Gateway (`saas/gateway-proxy/`)

**Purpose:** Secure proxy between web UI and tenant moltbot pods

```
Browser ←(WSS)→ Gateway Proxy ←(WS)→ Tenant Pod (Gateway:18789)
                     │
                     ├─ JWT validation
                     ├─ Rate limiting
                     ├─ Audit logging
                     └─ Message encryption
```

**Key Files:**
- `saas/gateway-proxy/server.ts` - WebSocket proxy server
- `saas/gateway-proxy/auth.ts` - JWT validation middleware
- `saas/gateway-proxy/routing.ts` - Route to correct tenant
- `saas/gateway-proxy/rate-limit.ts` - Per-user rate limiting

### 3.3 REST API (`saas/api/`)

**Endpoints:**
```
POST   /api/auth/signup
POST   /api/auth/login
POST   /api/auth/logout
GET    /api/auth/me

GET    /api/agent/status
POST   /api/agent/wake
POST   /api/agent/restart

GET    /api/messages?cursor=...&limit=...
POST   /api/messages/upload
GET    /api/messages/:id/media

GET    /api/config
PUT    /api/config

GET    /api/usage
GET    /api/billing
```

---

## Phase 4: Data Security & Encryption

### 4.1 Encryption Architecture

**Layers:**
1. **Transport:** TLS 1.3 for all connections
2. **At Rest:** Per-tenant encrypted volumes
3. **Application:** Field-level encryption for secrets
4. **Key Management:** HashiCorp Vault (or AWS KMS)

### 4.2 Per-Tenant Encryption

**Storage Encryption:**
```
┌─────────────────────────────────────────┐
│          Kubernetes PVC                  │
│  ┌───────────────────────────────────┐  │
│  │     LUKS-encrypted volume         │  │
│  │  ┌─────────────────────────────┐  │  │
│  │  │    Tenant Data              │  │  │
│  │  │  - moltbot.json (config)    │  │  │
│  │  │  - sessions/                │  │  │
│  │  │  - credentials/             │  │  │
│  │  │  - knowledge/               │  │  │
│  │  └─────────────────────────────┘  │  │
│  │  Key: Vault + tenant_id derived   │  │
│  └───────────────────────────────────┘  │
└─────────────────────────────────────────┘
```

### 4.3 Secrets Management (`saas/secrets/`)

**New Components:**
- `saas/secrets/vault-client.ts` - Vault integration
- `saas/secrets/key-derivation.ts` - Per-tenant key derivation
- `saas/secrets/crypto.ts` - Encryption primitives

**Key Derivation:**
```typescript
// Per-tenant master key derived from:
// - Vault master key
// - Tenant ID
// - Optional user-provided passphrase (for extra security tier)
```

### 4.4 Modifications to Existing Code

**Files to Modify:**

| File | Change |
|------|--------|
| `src/config/sessions/store.ts` | Add encryption layer before write, decrypt after read |
| `src/config/config.ts` | Encrypt sensitive fields in moltbot.json |
| `src/web/auth-store.ts` | Encrypt WhatsApp credentials |
| `src/agents/auth-profiles/` | Encrypt API keys at rest |
| `src/infra/file-io.ts` | Add transparent encryption wrapper |

**New Encryption Wrapper:**
```typescript
// src/infra/encrypted-file-io.ts
export async function readEncrypted(path: string, key: Buffer): Promise<string>
export async function writeEncrypted(path: string, data: string, key: Buffer): Promise<void>
```

---

## Phase 5: Network Security

### 5.1 Network Policies (Kubernetes)

**Tenant Pod Policy:**
```yaml
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: tenant-isolation
spec:
  podSelector:
    matchLabels:
      app: moltbot-agent
  policyTypes:
    - Ingress
    - Egress
  ingress:
    - from:
        - namespaceSelector:
            matchLabels:
              name: saas-control-plane
          podSelector:
            matchLabels:
              app: gateway-proxy
  egress:
    # Only allow outbound to:
    - to: # AI provider APIs
        - ipBlock:
            cidr: 0.0.0.0/0
      ports:
        - port: 443
          protocol: TCP
    # Deny direct internet access except allowed APIs
```

### 5.2 Egress Whitelist

**Allowed Outbound Destinations:**
- Anthropic API (`api.anthropic.com`)
- OpenAI API (`api.openai.com`)
- Google AI (`generativelanguage.googleapis.com`)
- Telegram API (`api.telegram.org`)
- Discord API (`discord.com`)
- WhatsApp Web (`web.whatsapp.com`)
- (configurable per-tenant for external integrations)

### 5.3 Security Components

**Ingress:**
- Cloudflare/AWS WAF for DDoS protection
- Rate limiting at edge
- Geographic restrictions (optional)
- Bot detection

**Internal:**
- mTLS between services (Istio/Linkerd service mesh)
- Network segmentation (tenant namespaces)
- No direct pod-to-pod communication across tenants

**Monitoring:**
- Network flow logs
- Anomaly detection
- Alert on unusual egress patterns

---

## Phase 6: Directory Structure

```
lobster_roll/
├── src/                          # Existing moltbot source
│   └── infra/
│       └── encrypted-file-io.ts  # NEW: Encryption wrapper
├── saas/                         # NEW: SaaS components
│   ├── api/                      # REST API server
│   │   ├── server.ts
│   │   ├── routes/
│   │   │   ├── auth.ts
│   │   │   ├── agent.ts
│   │   │   ├── messages.ts
│   │   │   └── config.ts
│   │   └── middleware/
│   ├── auth/                     # Authentication service
│   │   ├── service.ts
│   │   ├── jwt.ts
│   │   ├── oauth/
│   │   └── middleware.ts
│   ├── db/                       # Database
│   │   ├── schema.sql
│   │   ├── migrations/
│   │   └── client.ts
│   ├── orchestrator/             # Kubernetes orchestration
│   │   ├── service.ts
│   │   ├── k8s-client.ts
│   │   ├── scaling.ts
│   │   └── templates/
│   │       ├── namespace.yaml
│   │       ├── pod.yaml
│   │       ├── service.yaml
│   │       ├── pvc.yaml
│   │       └── network-policy.yaml
│   ├── gateway-proxy/            # WebSocket proxy
│   │   ├── server.ts
│   │   ├── auth.ts
│   │   ├── routing.ts
│   │   └── rate-limit.ts
│   ├── secrets/                  # Secrets management
│   │   ├── vault-client.ts
│   │   ├── key-derivation.ts
│   │   └── crypto.ts
│   ├── billing/                  # Stripe integration
│   │   ├── service.ts
│   │   └── webhooks.ts
│   └── web/                      # Frontend
│       ├── package.json
│       ├── src/
│       │   ├── pages/
│       │   │   ├── index.tsx
│       │   │   ├── login.tsx
│       │   │   ├── signup.tsx
│       │   │   └── chat.tsx
│       │   ├── components/
│       │   │   ├── ChatWindow.tsx
│       │   │   ├── MessageList.tsx
│       │   │   ├── VoiceCall.tsx
│       │   │   └── MediaUpload.tsx
│       │   ├── hooks/
│       │   │   ├── useWebSocket.ts
│       │   │   ├── useWebRTC.ts
│       │   │   └── useAuth.ts
│       │   └── lib/
│       │       ├── api.ts
│       │       └── crypto.ts
│       └── public/
├── k8s/                          # Kubernetes manifests
│   ├── control-plane/
│   │   ├── api-deployment.yaml
│   │   ├── proxy-deployment.yaml
│   │   └── orchestrator-deployment.yaml
│   ├── infrastructure/
│   │   ├── vault.yaml
│   │   ├── postgres.yaml
│   │   └── redis.yaml
│   └── tenant-templates/
└── docker/
    ├── Dockerfile.api
    ├── Dockerfile.proxy
    ├── Dockerfile.agent
    └── docker-compose.dev.yaml
```

---

## Phase 7: Implementation Sprints

### Sprint 1: Core Infrastructure (Weeks 1-2) ✅ COMPLETED
1. ✅ Set up PostgreSQL database with user/subscription schema
2. ✅ Implement authentication service (signup, login, JWT)
3. ✅ Create basic REST API skeleton
4. ✅ Set up Docker development environment

### Sprint 2: Orchestration (Weeks 3-4)
1. Create Kubernetes templates for tenant pods
2. Implement orchestrator service
3. Pod provisioning on signup
4. Health monitoring and restart

### Sprint 3: Web Interface - Chat (Weeks 5-6)
1. Build React frontend with authentication
2. Implement WebSocket gateway proxy
3. Connect to existing moltbot gateway protocol
4. Basic chat functionality

### Sprint 4: Encryption (Weeks 7-8)
1. Set up HashiCorp Vault
2. Implement per-tenant key derivation
3. Add encryption layer to file I/O
4. Encrypt existing data stores (sessions, credentials, config)

### Sprint 5: Network Security (Week 9)
1. Implement Kubernetes NetworkPolicies
2. Configure egress whitelist
3. Set up service mesh (optional)
4. Add WAF/rate limiting at edge

### Sprint 6: Voice & Media (Weeks 10-11)
1. Implement WebRTC for voice calls
2. Add media upload/download
3. Integrate with existing moltbot media pipeline
4. Test end-to-end media flow

### Sprint 7: Billing & Polish (Week 12)
1. Stripe integration
2. Usage metering
3. Scale-to-zero optimization
4. Production hardening

---

## Phase 8: Security Checklist

- [ ] All data encrypted at rest (LUKS volumes, encrypted fields)
- [ ] TLS 1.3 for all network traffic
- [ ] Per-tenant key isolation (Vault + tenant ID)
- [ ] JWT tokens with short expiry + refresh
- [ ] Rate limiting at multiple layers
- [ ] Network isolation between tenants
- [ ] Egress whitelist enforced
- [ ] Audit logging for all operations
- [ ] Secret rotation capability
- [ ] Penetration testing before launch
- [ ] SOC 2 Type II compliance roadmap

---

## Configuration Questions

Before production deployment, decide:

1. **Cloud Provider:** AWS, GCP, or Azure?
2. **Scaling Target:** Expected number of concurrent users?
3. **Billing Model:** Per-message, per-hour, flat monthly, or hybrid?
4. **Existing Channels:** Support all channels (Telegram, Discord, etc.) or just web chat initially?
5. **Compliance Requirements:** GDPR, HIPAA, SOC 2, or other?
