/**
 * Media module - Voice, video, and file handling
 *
 * This module provides:
 * - WebRTC signaling for voice/video calls
 * - Encrypted media file upload/download
 * - Audio transcription via OpenAI Whisper
 */

export {
	WebRTCSignalingServer,
	createWebRTCSignalingServer,
	type SignalingMessage,
	type SignalingMessageType,
	type Room,
	type RoomParticipant,
} from "./webrtc-signaling.js";

export {
	MediaUploadService,
	createMediaUploadService,
	type MediaMetadata,
	type MediaType,
	type UploadOptions,
} from "./upload-service.js";

export {
	TranscriptionService,
	createTranscriptionService,
	type TranscriptionResult,
	type TranscriptionSegment,
	type TranscriptionOptions,
} from "./transcription-service.js";
