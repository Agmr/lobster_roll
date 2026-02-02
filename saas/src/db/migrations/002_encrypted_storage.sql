-- Migration: Add encrypted storage tables
-- Run after initial schema

-- Tenant configuration (encrypted key-value pairs)
CREATE TABLE IF NOT EXISTS tenant_config (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    key VARCHAR(255) NOT NULL,
    value TEXT NOT NULL,  -- Encrypted JSON
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_tenant_config UNIQUE (tenant_id, key)
);

CREATE INDEX idx_tenant_config_tenant ON tenant_config(tenant_id);

-- Tenant blob storage (encrypted files)
CREATE TABLE IF NOT EXISTS tenant_blobs (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    name VARCHAR(255) NOT NULL,
    encrypted_data TEXT NOT NULL,  -- Encrypted base64
    size BIGINT NOT NULL,
    content_type VARCHAR(255),
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_tenant_blob_name UNIQUE (tenant_id, name)
);

CREATE INDEX idx_tenant_blobs_tenant ON tenant_blobs(tenant_id);
CREATE INDEX idx_tenant_blobs_name ON tenant_blobs(tenant_id, name);

-- Chat history (encrypted messages)
CREATE TABLE IF NOT EXISTS tenant_messages (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    session_id VARCHAR(255) NOT NULL,
    role VARCHAR(20) NOT NULL,  -- 'user', 'assistant', 'system'
    encrypted_content TEXT NOT NULL,  -- Encrypted message content
    key_version INTEGER NOT NULL DEFAULT 1,
    metadata JSONB,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_tenant_messages_tenant ON tenant_messages(tenant_id);
CREATE INDEX idx_tenant_messages_session ON tenant_messages(tenant_id, session_id);
CREATE INDEX idx_tenant_messages_created ON tenant_messages(created_at);

-- Tenant credentials (encrypted API keys, OAuth tokens, etc.)
CREATE TABLE IF NOT EXISTS tenant_credentials (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    provider VARCHAR(100) NOT NULL,  -- 'anthropic', 'openai', 'google', etc.
    name VARCHAR(255) NOT NULL,
    encrypted_data TEXT NOT NULL,  -- Encrypted credential JSON
    key_version INTEGER NOT NULL DEFAULT 1,
    expires_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

    CONSTRAINT unique_tenant_credential UNIQUE (tenant_id, provider, name)
);

CREATE INDEX idx_tenant_credentials_tenant ON tenant_credentials(tenant_id);
CREATE INDEX idx_tenant_credentials_provider ON tenant_credentials(tenant_id, provider);

-- Key rotation history
CREATE TABLE IF NOT EXISTS key_rotation_history (
    id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    old_version INTEGER NOT NULL,
    new_version INTEGER NOT NULL,
    rotated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    completed_at TIMESTAMPTZ,
    records_updated INTEGER DEFAULT 0,
    status VARCHAR(20) NOT NULL DEFAULT 'pending'  -- 'pending', 'in_progress', 'completed', 'failed'
);

CREATE INDEX idx_key_rotation_tenant ON key_rotation_history(tenant_id);

-- Add triggers for updated_at
CREATE TRIGGER update_tenant_config_updated_at BEFORE UPDATE ON tenant_config
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER update_tenant_credentials_updated_at BEFORE UPDATE ON tenant_credentials
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();
