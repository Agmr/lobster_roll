import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, unlink, stat } from "node:fs/promises";
import { join, extname } from "node:path";
import { pipeline } from "node:stream/promises";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import type { DbClient } from "../db/client.js";
import { TenantKeyManager, getTenantKeyManager } from "../crypto/index.js";

/**
 * Supported media types
 */
export type MediaType = "image" | "audio" | "video" | "document";

export interface MediaMetadata {
	id: string;
	tenantId: string;
	filename: string;
	originalName: string;
	mimeType: string;
	mediaType: MediaType;
	size: number;
	encryptionIv: string;
	createdAt: Date;
	expiresAt?: Date;
}

export interface UploadOptions {
	expiresInHours?: number;
	metadata?: Record<string, string>;
}

// Allowed MIME types
const ALLOWED_MIME_TYPES: Record<MediaType, string[]> = {
	image: ["image/jpeg", "image/png", "image/gif", "image/webp"],
	audio: ["audio/mpeg", "audio/wav", "audio/ogg", "audio/webm", "audio/mp4"],
	video: ["video/mp4", "video/webm", "video/quicktime"],
	document: ["application/pdf", "text/plain", "application/json"],
};

// Max file sizes per type (in bytes)
const MAX_FILE_SIZES: Record<MediaType, number> = {
	image: 10 * 1024 * 1024, // 10 MB
	audio: 50 * 1024 * 1024, // 50 MB
	video: 100 * 1024 * 1024, // 100 MB
	document: 20 * 1024 * 1024, // 20 MB
};

/**
 * Media Upload Service
 * Handles encrypted file uploads with tenant isolation
 */
export class MediaUploadService {
	private keyManager: TenantKeyManager;
	private storageDir: string;

	constructor(
		private db: DbClient,
		storageDir?: string
	) {
		this.keyManager = getTenantKeyManager(db);
		this.storageDir = storageDir ?? join(process.cwd(), "data", "media");
	}

	/**
	 * Initialize storage directories
	 */
	async initialize(): Promise<void> {
		await mkdir(this.storageDir, { recursive: true });
	}

	/**
	 * Upload and encrypt a file
	 */
	async upload(
		tenantId: string,
		file: {
			path: string;
			originalName: string;
			mimeType: string;
			size: number;
		},
		options: UploadOptions = {}
	): Promise<MediaMetadata> {
		// Validate file
		const mediaType = this.getMediaType(file.mimeType);
		if (!mediaType) {
			throw new Error(`Unsupported file type: ${file.mimeType}`);
		}

		const maxSize = MAX_FILE_SIZES[mediaType];
		if (file.size > maxSize) {
			throw new Error(
				`File too large. Maximum size for ${mediaType} is ${maxSize / 1024 / 1024}MB`
			);
		}

		// Generate file ID and paths
		const fileId = crypto.randomUUID();
		const ext = extname(file.originalName) || this.getExtension(file.mimeType);
		const filename = `${fileId}${ext}.enc`;
		const tenantDir = join(this.storageDir, tenantId);
		const filePath = join(tenantDir, filename);

		// Ensure tenant directory exists
		await mkdir(tenantDir, { recursive: true });

		// Get encryption key and generate IV
		const key = await this.keyManager.getTenantKey(tenantId);
		const iv = randomBytes(16);

		// Encrypt and write file
		const cipher = createCipheriv(
			"aes-256-gcm",
			Buffer.from(key, "hex"),
			iv
		);

		const input = createReadStream(file.path);
		const output = createWriteStream(filePath);

		await pipeline(input, cipher, output);

		// Get auth tag
		const authTag = cipher.getAuthTag();

		// Calculate expiration
		const expiresAt = options.expiresInHours
			? new Date(Date.now() + options.expiresInHours * 60 * 60 * 1000)
			: undefined;

		// Store metadata in database
		const result = await this.db.query<{
			id: string;
			tenant_id: string;
			filename: string;
			original_name: string;
			mime_type: string;
			media_type: string;
			size: number;
			encryption_iv: string;
			auth_tag: string;
			created_at: Date;
			expires_at: Date | null;
		}>(
			`INSERT INTO media_files (
				id, tenant_id, filename, original_name, mime_type, media_type,
				size, encryption_iv, auth_tag, expires_at, metadata
			) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
			RETURNING *`,
			[
				fileId,
				tenantId,
				filename,
				file.originalName,
				file.mimeType,
				mediaType,
				file.size,
				iv.toString("hex"),
				authTag.toString("hex"),
				expiresAt,
				JSON.stringify(options.metadata ?? {}),
			]
		);

		const record = result.rows[0]!;

		// Clean up temp file
		try {
			await unlink(file.path);
		} catch {
			// Ignore cleanup errors
		}

		return {
			id: record.id,
			tenantId: record.tenant_id,
			filename: record.filename,
			originalName: record.original_name,
			mimeType: record.mime_type,
			mediaType: record.media_type as MediaType,
			size: record.size,
			encryptionIv: record.encryption_iv,
			createdAt: record.created_at,
			expiresAt: record.expires_at ?? undefined,
		};
	}

	/**
	 * Download and decrypt a file
	 */
	async download(
		tenantId: string,
		fileId: string
	): Promise<{
		stream: NodeJS.ReadableStream;
		metadata: MediaMetadata;
	}> {
		// Get file metadata
		const result = await this.db.query<{
			id: string;
			tenant_id: string;
			filename: string;
			original_name: string;
			mime_type: string;
			media_type: string;
			size: number;
			encryption_iv: string;
			auth_tag: string;
			created_at: Date;
			expires_at: Date | null;
		}>(
			`SELECT * FROM media_files WHERE id = $1 AND tenant_id = $2`,
			[fileId, tenantId]
		);

		if (result.rows.length === 0) {
			throw new Error("File not found");
		}

		const record = result.rows[0]!;

		// Check expiration
		if (record.expires_at && new Date(record.expires_at) < new Date()) {
			throw new Error("File has expired");
		}

		// Get decryption key
		const key = await this.keyManager.getTenantKey(tenantId);
		const iv = Buffer.from(record.encryption_iv, "hex");
		const authTag = Buffer.from(record.auth_tag, "hex");

		// Create decryption stream
		const filePath = join(this.storageDir, tenantId, record.filename);
		const decipher = createDecipheriv(
			"aes-256-gcm",
			Buffer.from(key, "hex"),
			iv
		);
		decipher.setAuthTag(authTag);

		const input = createReadStream(filePath);

		// Pipe through decipher
		const decryptedStream = input.pipe(decipher);

		return {
			stream: decryptedStream,
			metadata: {
				id: record.id,
				tenantId: record.tenant_id,
				filename: record.filename,
				originalName: record.original_name,
				mimeType: record.mime_type,
				mediaType: record.media_type as MediaType,
				size: record.size,
				encryptionIv: record.encryption_iv,
				createdAt: record.created_at,
				expiresAt: record.expires_at ?? undefined,
			},
		};
	}

	/**
	 * Delete a file
	 */
	async delete(tenantId: string, fileId: string): Promise<boolean> {
		const result = await this.db.query<{ filename: string }>(
			`DELETE FROM media_files WHERE id = $1 AND tenant_id = $2 RETURNING filename`,
			[fileId, tenantId]
		);

		if (result.rows.length === 0) {
			return false;
		}

		const filename = result.rows[0]!.filename;
		const filePath = join(this.storageDir, tenantId, filename);

		try {
			await unlink(filePath);
		} catch {
			// File may already be deleted
		}

		return true;
	}

	/**
	 * List files for a tenant
	 */
	async listFiles(
		tenantId: string,
		options?: {
			mediaType?: MediaType;
			limit?: number;
			offset?: number;
		}
	): Promise<MediaMetadata[]> {
		let query = `SELECT * FROM media_files WHERE tenant_id = $1`;
		const params: (string | number)[] = [tenantId];

		if (options?.mediaType) {
			query += ` AND media_type = $${params.length + 1}`;
			params.push(options.mediaType);
		}

		query += ` ORDER BY created_at DESC`;

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
			tenant_id: string;
			filename: string;
			original_name: string;
			mime_type: string;
			media_type: string;
			size: number;
			encryption_iv: string;
			created_at: Date;
			expires_at: Date | null;
		}>(query, params);

		return result.rows.map((row) => ({
			id: row.id,
			tenantId: row.tenant_id,
			filename: row.filename,
			originalName: row.original_name,
			mimeType: row.mime_type,
			mediaType: row.media_type as MediaType,
			size: row.size,
			encryptionIv: row.encryption_iv,
			createdAt: row.created_at,
			expiresAt: row.expires_at ?? undefined,
		}));
	}

	/**
	 * Clean up expired files
	 */
	async cleanupExpired(): Promise<number> {
		const result = await this.db.query<{
			id: string;
			tenant_id: string;
			filename: string;
		}>(
			`DELETE FROM media_files WHERE expires_at < NOW() RETURNING id, tenant_id, filename`
		);

		// Delete physical files
		for (const row of result.rows) {
			const filePath = join(this.storageDir, row.tenant_id, row.filename);
			try {
				await unlink(filePath);
			} catch {
				// Ignore errors
			}
		}

		return result.rows.length;
	}

	/**
	 * Get storage usage for a tenant
	 */
	async getStorageUsage(tenantId: string): Promise<{
		totalFiles: number;
		totalSize: number;
		byType: Record<MediaType, { count: number; size: number }>;
	}> {
		const result = await this.db.query<{
			media_type: string;
			count: string;
			total_size: string;
		}>(
			`SELECT media_type, COUNT(*) as count, SUM(size) as total_size
			 FROM media_files
			 WHERE tenant_id = $1
			 GROUP BY media_type`,
			[tenantId]
		);

		const byType: Record<MediaType, { count: number; size: number }> = {
			image: { count: 0, size: 0 },
			audio: { count: 0, size: 0 },
			video: { count: 0, size: 0 },
			document: { count: 0, size: 0 },
		};

		let totalFiles = 0;
		let totalSize = 0;

		for (const row of result.rows) {
			const type = row.media_type as MediaType;
			const count = parseInt(row.count, 10);
			const size = parseInt(row.total_size, 10);

			byType[type] = { count, size };
			totalFiles += count;
			totalSize += size;
		}

		return { totalFiles, totalSize, byType };
	}

	/**
	 * Get media type from MIME type
	 */
	private getMediaType(mimeType: string): MediaType | null {
		for (const [type, mimes] of Object.entries(ALLOWED_MIME_TYPES)) {
			if (mimes.includes(mimeType)) {
				return type as MediaType;
			}
		}
		return null;
	}

	/**
	 * Get file extension from MIME type
	 */
	private getExtension(mimeType: string): string {
		const extensions: Record<string, string> = {
			"image/jpeg": ".jpg",
			"image/png": ".png",
			"image/gif": ".gif",
			"image/webp": ".webp",
			"audio/mpeg": ".mp3",
			"audio/wav": ".wav",
			"audio/ogg": ".ogg",
			"audio/webm": ".webm",
			"audio/mp4": ".m4a",
			"video/mp4": ".mp4",
			"video/webm": ".webm",
			"video/quicktime": ".mov",
			"application/pdf": ".pdf",
			"text/plain": ".txt",
			"application/json": ".json",
		};
		return extensions[mimeType] ?? "";
	}
}

/**
 * Create a media upload service instance
 */
export function createMediaUploadService(
	db: DbClient,
	storageDir?: string
): MediaUploadService {
	return new MediaUploadService(db, storageDir);
}
