-- Media files table
CREATE TABLE IF NOT EXISTS media_files (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    filename VARCHAR(255) NOT NULL,
    original_name VARCHAR(255) NOT NULL,
    mime_type VARCHAR(127) NOT NULL,
    media_type VARCHAR(20) NOT NULL CHECK (media_type IN ('image', 'audio', 'video', 'document')),
    size BIGINT NOT NULL,
    encryption_iv VARCHAR(64) NOT NULL,
    auth_tag VARCHAR(64) NOT NULL,
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    expires_at TIMESTAMP WITH TIME ZONE,
    CONSTRAINT valid_size CHECK (size > 0)
);

-- Indexes for media_files
CREATE INDEX IF NOT EXISTS idx_media_files_tenant_id ON media_files(tenant_id);
CREATE INDEX IF NOT EXISTS idx_media_files_media_type ON media_files(tenant_id, media_type);
CREATE INDEX IF NOT EXISTS idx_media_files_expires_at ON media_files(expires_at) WHERE expires_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_media_files_created_at ON media_files(tenant_id, created_at DESC);

-- Transcriptions table
CREATE TABLE IF NOT EXISTS transcriptions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    media_file_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
    text_encrypted TEXT NOT NULL,
    text_iv VARCHAR(64) NOT NULL,
    text_auth_tag VARCHAR(64) NOT NULL,
    language VARCHAR(10),
    duration DECIMAL(10, 2),
    segments JSONB,
    key_version INTEGER NOT NULL DEFAULT 1,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Indexes for transcriptions
CREATE INDEX IF NOT EXISTS idx_transcriptions_tenant_id ON transcriptions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_transcriptions_media_file ON transcriptions(media_file_id) WHERE media_file_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_transcriptions_created_at ON transcriptions(tenant_id, created_at DESC);

-- Voice call sessions table (for WebRTC)
CREATE TABLE IF NOT EXISTS voice_sessions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    room_id VARCHAR(100) NOT NULL,
    participant_count INTEGER DEFAULT 0,
    started_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    ended_at TIMESTAMP WITH TIME ZONE,
    duration_seconds INTEGER,
    recording_file_id UUID REFERENCES media_files(id) ON DELETE SET NULL,
    CONSTRAINT valid_duration CHECK (duration_seconds IS NULL OR duration_seconds >= 0)
);

-- Indexes for voice_sessions
CREATE INDEX IF NOT EXISTS idx_voice_sessions_tenant_id ON voice_sessions(tenant_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_room_id ON voice_sessions(room_id);
CREATE INDEX IF NOT EXISTS idx_voice_sessions_active ON voice_sessions(tenant_id, started_at) WHERE ended_at IS NULL;

-- Media processing queue
CREATE TABLE IF NOT EXISTS media_processing_queue (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    media_file_id UUID NOT NULL REFERENCES media_files(id) ON DELETE CASCADE,
    operation VARCHAR(50) NOT NULL,
    status VARCHAR(20) DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'completed', 'failed')),
    priority INTEGER DEFAULT 0,
    attempts INTEGER DEFAULT 0,
    max_attempts INTEGER DEFAULT 3,
    error_message TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    started_at TIMESTAMP WITH TIME ZONE,
    completed_at TIMESTAMP WITH TIME ZONE
);

-- Indexes for processing queue
CREATE INDEX IF NOT EXISTS idx_media_queue_pending ON media_processing_queue(status, priority DESC, created_at)
    WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS idx_media_queue_tenant ON media_processing_queue(tenant_id, status);

-- Function to update voice session duration on end
CREATE OR REPLACE FUNCTION update_voice_session_duration()
RETURNS TRIGGER AS $$
BEGIN
    IF NEW.ended_at IS NOT NULL AND OLD.ended_at IS NULL THEN
        NEW.duration_seconds = EXTRACT(EPOCH FROM (NEW.ended_at - NEW.started_at))::INTEGER;
    END IF;
    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Trigger for voice session duration
DROP TRIGGER IF EXISTS trigger_voice_session_duration ON voice_sessions;
CREATE TRIGGER trigger_voice_session_duration
    BEFORE UPDATE ON voice_sessions
    FOR EACH ROW
    EXECUTE FUNCTION update_voice_session_duration();

-- Add media usage tracking to usage table if not exists
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'usage' AND column_name = 'media_storage_bytes'
    ) THEN
        ALTER TABLE usage ADD COLUMN media_storage_bytes BIGINT DEFAULT 0;
        ALTER TABLE usage ADD COLUMN transcription_seconds DECIMAL(10, 2) DEFAULT 0;
        ALTER TABLE usage ADD COLUMN voice_minutes INTEGER DEFAULT 0;
    END IF;
END $$;

-- View for tenant media stats
CREATE OR REPLACE VIEW tenant_media_stats AS
SELECT
    t.id as tenant_id,
    t.user_id,
    COUNT(DISTINCT mf.id) as total_files,
    COALESCE(SUM(mf.size), 0) as total_storage_bytes,
    COUNT(DISTINCT CASE WHEN mf.media_type = 'image' THEN mf.id END) as image_count,
    COUNT(DISTINCT CASE WHEN mf.media_type = 'audio' THEN mf.id END) as audio_count,
    COUNT(DISTINCT CASE WHEN mf.media_type = 'video' THEN mf.id END) as video_count,
    COUNT(DISTINCT CASE WHEN mf.media_type = 'document' THEN mf.id END) as document_count,
    COUNT(DISTINCT tr.id) as transcription_count,
    COALESCE(SUM(tr.duration), 0) as total_transcription_seconds,
    COUNT(DISTINCT vs.id) as voice_session_count,
    COALESCE(SUM(vs.duration_seconds), 0) as total_voice_seconds
FROM tenants t
LEFT JOIN media_files mf ON mf.tenant_id = t.id
LEFT JOIN transcriptions tr ON tr.tenant_id = t.id
LEFT JOIN voice_sessions vs ON vs.tenant_id = t.id
GROUP BY t.id, t.user_id;
