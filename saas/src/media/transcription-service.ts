import type { DbClient } from "../db/client.js";
import {
	EncryptedCredentialStore,
	getOpenAIKey,
} from "../crypto/index.js";
import { TenantKeyManager, getTenantKeyManager } from "../crypto/index.js";

/**
 * Transcription result
 */
export interface TranscriptionResult {
	id: string;
	mediaFileId: string;
	text: string;
	language?: string;
	duration?: number;
	segments?: TranscriptionSegment[];
	createdAt: Date;
}

export interface TranscriptionSegment {
	start: number;
	end: number;
	text: string;
}

export interface TranscriptionOptions {
	language?: string;
	prompt?: string;
	responseFormat?: "json" | "text" | "srt" | "vtt";
	timestampGranularities?: ("word" | "segment")[];
}

/**
 * Audio Transcription Service
 * Integrates with OpenAI Whisper API for speech-to-text
 */
export class TranscriptionService {
	private credentialStore: EncryptedCredentialStore;
	private keyManager: TenantKeyManager;

	constructor(private db: DbClient) {
		this.keyManager = getTenantKeyManager(db);
		this.credentialStore = new EncryptedCredentialStore(db, this.keyManager);
	}

	/**
	 * Transcribe an audio file
	 */
	async transcribe(
		tenantId: string,
		audioData: Buffer | NodeJS.ReadableStream,
		filename: string,
		options: TranscriptionOptions = {}
	): Promise<TranscriptionResult> {
		// Get OpenAI API key for tenant
		const openAIKey = await getOpenAIKey(this.credentialStore, tenantId);
		if (!openAIKey) {
			throw new Error("OpenAI API key not configured for tenant");
		}

		// Prepare form data
		const formData = new FormData();

		// Convert to Blob if Buffer
		let audioBlob: Blob;
		if (Buffer.isBuffer(audioData)) {
			audioBlob = new Blob([audioData]);
		} else {
			// Read stream to buffer
			const chunks: Buffer[] = [];
			for await (const chunk of audioData) {
				chunks.push(Buffer.from(chunk));
			}
			audioBlob = new Blob([Buffer.concat(chunks)]);
		}

		formData.append("file", audioBlob, filename);
		formData.append("model", "whisper-1");

		if (options.language) {
			formData.append("language", options.language);
		}

		if (options.prompt) {
			formData.append("prompt", options.prompt);
		}

		formData.append("response_format", options.responseFormat ?? "verbose_json");

		if (options.timestampGranularities) {
			for (const granularity of options.timestampGranularities) {
				formData.append("timestamp_granularities[]", granularity);
			}
		}

		// Call OpenAI API
		const response = await fetch(
			"https://api.openai.com/v1/audio/transcriptions",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${openAIKey}`,
				},
				body: formData,
			}
		);

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Transcription failed: ${error}`);
		}

		const result = (await response.json()) as {
			text: string;
			language?: string;
			duration?: number;
			segments?: Array<{
				start: number;
				end: number;
				text: string;
			}>;
		};

		// Store transcription in database
		const transcriptionId = crypto.randomUUID();
		const segments = result.segments?.map((s) => ({
			start: s.start,
			end: s.end,
			text: s.text,
		}));

		// Encrypt the transcription text
		const encryptedText = await this.keyManager.encryptForTenant(
			tenantId,
			result.text
		);

		await this.db.query(
			`INSERT INTO transcriptions (
				id, tenant_id, text_encrypted, text_iv, text_auth_tag,
				language, duration, segments, key_version
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
			[
				transcriptionId,
				tenantId,
				encryptedText.ciphertext,
				encryptedText.iv,
				encryptedText.authTag,
				result.language,
				result.duration,
				segments ? JSON.stringify(segments) : null,
				encryptedText.keyVersion,
			]
		);

		return {
			id: transcriptionId,
			mediaFileId: "", // Would be set if linked to a media file
			text: result.text,
			language: result.language,
			duration: result.duration,
			segments,
			createdAt: new Date(),
		};
	}

	/**
	 * Get a transcription by ID
	 */
	async getTranscription(
		tenantId: string,
		transcriptionId: string
	): Promise<TranscriptionResult | null> {
		const result = await this.db.query<{
			id: string;
			media_file_id: string | null;
			text_encrypted: string;
			text_iv: string;
			text_auth_tag: string;
			language: string | null;
			duration: number | null;
			segments: string | null;
			key_version: number;
			created_at: Date;
		}>(
			`SELECT * FROM transcriptions WHERE id = $1 AND tenant_id = $2`,
			[transcriptionId, tenantId]
		);

		if (result.rows.length === 0) {
			return null;
		}

		const row = result.rows[0]!;

		// Decrypt text
		const text = await this.keyManager.decryptForTenant(tenantId, {
			ciphertext: row.text_encrypted,
			iv: row.text_iv,
			authTag: row.text_auth_tag,
			keyVersion: row.key_version,
		});

		return {
			id: row.id,
			mediaFileId: row.media_file_id ?? "",
			text,
			language: row.language ?? undefined,
			duration: row.duration ?? undefined,
			segments: row.segments ? JSON.parse(row.segments) : undefined,
			createdAt: row.created_at,
		};
	}

	/**
	 * List transcriptions for a tenant
	 */
	async listTranscriptions(
		tenantId: string,
		options?: { limit?: number; offset?: number }
	): Promise<Array<Omit<TranscriptionResult, "text" | "segments">>> {
		let query = `SELECT id, media_file_id, language, duration, created_at
			FROM transcriptions WHERE tenant_id = $1 ORDER BY created_at DESC`;
		const params: (string | number)[] = [tenantId];

		if (options?.limit) {
			query += ` LIMIT $${params.length + 1}`;
			params.push(options.limit);
		}

		if (options?.offset) {
			query += ` OFFSET $${params.length + 1}`;
			params.push(options.offset);
		}

		const result = await this.db.query<{
			id: string;
			media_file_id: string | null;
			language: string | null;
			duration: number | null;
			created_at: Date;
		}>(query, params);

		return result.rows.map((row) => ({
			id: row.id,
			mediaFileId: row.media_file_id ?? "",
			language: row.language ?? undefined,
			duration: row.duration ?? undefined,
			createdAt: row.created_at,
		}));
	}

	/**
	 * Delete a transcription
	 */
	async deleteTranscription(
		tenantId: string,
		transcriptionId: string
	): Promise<boolean> {
		const result = await this.db.query(
			`DELETE FROM transcriptions WHERE id = $1 AND tenant_id = $2`,
			[transcriptionId, tenantId]
		);

		return (result.rowCount ?? 0) > 0;
	}

	/**
	 * Translate audio to English
	 */
	async translate(
		tenantId: string,
		audioData: Buffer | NodeJS.ReadableStream,
		filename: string,
		options: Omit<TranscriptionOptions, "language"> = {}
	): Promise<TranscriptionResult> {
		const openAIKey = await getOpenAIKey(this.credentialStore, tenantId);
		if (!openAIKey) {
			throw new Error("OpenAI API key not configured for tenant");
		}

		const formData = new FormData();

		let audioBlob: Blob;
		if (Buffer.isBuffer(audioData)) {
			audioBlob = new Blob([audioData]);
		} else {
			const chunks: Buffer[] = [];
			for await (const chunk of audioData) {
				chunks.push(Buffer.from(chunk));
			}
			audioBlob = new Blob([Buffer.concat(chunks)]);
		}

		formData.append("file", audioBlob, filename);
		formData.append("model", "whisper-1");

		if (options.prompt) {
			formData.append("prompt", options.prompt);
		}

		formData.append("response_format", options.responseFormat ?? "verbose_json");

		const response = await fetch(
			"https://api.openai.com/v1/audio/translations",
			{
				method: "POST",
				headers: {
					Authorization: `Bearer ${openAIKey}`,
				},
				body: formData,
			}
		);

		if (!response.ok) {
			const error = await response.text();
			throw new Error(`Translation failed: ${error}`);
		}

		const result = (await response.json()) as {
			text: string;
			duration?: number;
		};

		// Store translation
		const translationId = crypto.randomUUID();

		const encryptedText = await this.keyManager.encryptForTenant(
			tenantId,
			result.text
		);

		await this.db.query(
			`INSERT INTO transcriptions (
				id, tenant_id, text_encrypted, text_iv, text_auth_tag,
				language, duration, key_version
			) VALUES ($1, $2, $3, $4, $5, 'en', $6, $7)`,
			[
				translationId,
				tenantId,
				encryptedText.ciphertext,
				encryptedText.iv,
				encryptedText.authTag,
				result.duration,
				encryptedText.keyVersion,
			]
		);

		return {
			id: translationId,
			mediaFileId: "",
			text: result.text,
			language: "en",
			duration: result.duration,
			createdAt: new Date(),
		};
	}
}

/**
 * Create a transcription service instance
 */
export function createTranscriptionService(db: DbClient): TranscriptionService {
	return new TranscriptionService(db);
}
