import { Hono } from "hono";
import { zValidator } from "@hono/zod-validator";
import { z } from "zod";
import { stream } from "hono/streaming";
import type { DbClient } from "../../db/client.js";
import { MediaUploadService, createMediaUploadService } from "../../media/upload-service.js";
import {
	TranscriptionService,
	createTranscriptionService,
} from "../../media/transcription-service.js";
import { authMiddleware, type AuthContext } from "../../auth/middleware.js";
import { writeFile, mkdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const mediaRoutes = new Hono<AuthContext>();

// Apply auth middleware to all routes
mediaRoutes.use("*", authMiddleware());

/**
 * Upload a file
 */
mediaRoutes.post("/upload", async (c) => {
	const db = c.get("db") as DbClient;
	const user = c.get("user")!;
	const tenantId = c.get("tenantId")!;

	const uploadService = createMediaUploadService(db);
	await uploadService.initialize();

	// Parse multipart form data
	const formData = await c.req.formData();
	const file = formData.get("file");
	const expiresInHours = formData.get("expiresInHours");

	if (!file || !(file instanceof File)) {
		return c.json({ error: "No file provided" }, 400);
	}

	// Save to temp file
	const tempDir = join(tmpdir(), "moltbot-uploads");
	await mkdir(tempDir, { recursive: true });
	const tempPath = join(tempDir, `${crypto.randomUUID()}-${file.name}`);

	try {
		const buffer = Buffer.from(await file.arrayBuffer());
		await writeFile(tempPath, buffer);

		// Upload with encryption
		const metadata = await uploadService.upload(
			tenantId,
			{
				path: tempPath,
				originalName: file.name,
				mimeType: file.type,
				size: file.size,
			},
			{
				expiresInHours: expiresInHours
					? parseInt(expiresInHours.toString(), 10)
					: undefined,
			}
		);

		return c.json({
			success: true,
			file: {
				id: metadata.id,
				originalName: metadata.originalName,
				mimeType: metadata.mimeType,
				mediaType: metadata.mediaType,
				size: metadata.size,
				createdAt: metadata.createdAt.toISOString(),
				expiresAt: metadata.expiresAt?.toISOString(),
			},
		});
	} catch (error) {
		// Clean up temp file on error
		try {
			await unlink(tempPath);
		} catch {}

		return c.json(
			{
				error: error instanceof Error ? error.message : "Upload failed",
			},
			400
		);
	}
});

/**
 * Download a file
 */
mediaRoutes.get("/files/:fileId", async (c) => {
	const db = c.get("db") as DbClient;
	const tenantId = c.get("tenantId")!;
	const fileId = c.req.param("fileId");

	const uploadService = createMediaUploadService(db);

	try {
		const { stream: fileStream, metadata } = await uploadService.download(
			tenantId,
			fileId
		);

		c.header("Content-Type", metadata.mimeType);
		c.header(
			"Content-Disposition",
			`attachment; filename="${metadata.originalName}"`
		);
		c.header("Content-Length", metadata.size.toString());

		return stream(c, async (stream) => {
			for await (const chunk of fileStream) {
				await stream.write(chunk);
			}
		});
	} catch (error) {
		return c.json(
			{
				error: error instanceof Error ? error.message : "Download failed",
			},
			404
		);
	}
});

/**
 * Delete a file
 */
mediaRoutes.delete("/files/:fileId", async (c) => {
	const db = c.get("db") as DbClient;
	const tenantId = c.get("tenantId")!;
	const fileId = c.req.param("fileId");

	const uploadService = createMediaUploadService(db);

	const deleted = await uploadService.delete(tenantId, fileId);

	if (!deleted) {
		return c.json({ error: "File not found" }, 404);
	}

	return c.json({ success: true });
});

/**
 * List files
 */
mediaRoutes.get(
	"/files",
	zValidator(
		"query",
		z.object({
			mediaType: z.enum(["image", "audio", "video", "document"]).optional(),
			limit: z.coerce.number().min(1).max(100).optional(),
			offset: z.coerce.number().min(0).optional(),
		})
	),
	async (c) => {
		const db = c.get("db") as DbClient;
		const tenantId = c.get("tenantId")!;
		const { mediaType, limit, offset } = c.req.valid("query");

		const uploadService = createMediaUploadService(db);

		const files = await uploadService.listFiles(tenantId, {
			mediaType,
			limit: limit ?? 50,
			offset: offset ?? 0,
		});

		return c.json({
			files: files.map((f) => ({
				id: f.id,
				originalName: f.originalName,
				mimeType: f.mimeType,
				mediaType: f.mediaType,
				size: f.size,
				createdAt: f.createdAt.toISOString(),
				expiresAt: f.expiresAt?.toISOString(),
			})),
		});
	}
);

/**
 * Get storage usage
 */
mediaRoutes.get("/usage", async (c) => {
	const db = c.get("db") as DbClient;
	const tenantId = c.get("tenantId")!;

	const uploadService = createMediaUploadService(db);
	const usage = await uploadService.getStorageUsage(tenantId);

	return c.json({
		totalFiles: usage.totalFiles,
		totalSize: usage.totalSize,
		totalSizeMB: Math.round((usage.totalSize / 1024 / 1024) * 100) / 100,
		byType: usage.byType,
	});
});

/**
 * Transcribe audio file
 */
mediaRoutes.post(
	"/transcribe",
	zValidator(
		"query",
		z.object({
			language: z.string().optional(),
			translate: z.coerce.boolean().optional(),
		})
	),
	async (c) => {
		const db = c.get("db") as DbClient;
		const tenantId = c.get("tenantId")!;
		const { language, translate } = c.req.valid("query");

		const transcriptionService = createTranscriptionService(db);

		// Parse multipart form data
		const formData = await c.req.formData();
		const file = formData.get("file");

		if (!file || !(file instanceof File)) {
			return c.json({ error: "No audio file provided" }, 400);
		}

		// Validate audio file
		const allowedTypes = [
			"audio/mpeg",
			"audio/wav",
			"audio/ogg",
			"audio/webm",
			"audio/mp4",
			"audio/flac",
		];
		if (!allowedTypes.includes(file.type)) {
			return c.json({ error: "Invalid audio file type" }, 400);
		}

		try {
			const buffer = Buffer.from(await file.arrayBuffer());

			let result;
			if (translate) {
				result = await transcriptionService.translate(
					tenantId,
					buffer,
					file.name,
					{}
				);
			} else {
				result = await transcriptionService.transcribe(
					tenantId,
					buffer,
					file.name,
					{ language }
				);
			}

			return c.json({
				success: true,
				transcription: {
					id: result.id,
					text: result.text,
					language: result.language,
					duration: result.duration,
					segments: result.segments,
					createdAt: result.createdAt.toISOString(),
				},
			});
		} catch (error) {
			return c.json(
				{
					error: error instanceof Error ? error.message : "Transcription failed",
				},
				400
			);
		}
	}
);

/**
 * Get transcription by ID
 */
mediaRoutes.get("/transcriptions/:transcriptionId", async (c) => {
	const db = c.get("db") as DbClient;
	const tenantId = c.get("tenantId")!;
	const transcriptionId = c.req.param("transcriptionId");

	const transcriptionService = createTranscriptionService(db);

	const result = await transcriptionService.getTranscription(
		tenantId,
		transcriptionId
	);

	if (!result) {
		return c.json({ error: "Transcription not found" }, 404);
	}

	return c.json({
		transcription: {
			id: result.id,
			text: result.text,
			language: result.language,
			duration: result.duration,
			segments: result.segments,
			createdAt: result.createdAt.toISOString(),
		},
	});
});

/**
 * List transcriptions
 */
mediaRoutes.get(
	"/transcriptions",
	zValidator(
		"query",
		z.object({
			limit: z.coerce.number().min(1).max(100).optional(),
			offset: z.coerce.number().min(0).optional(),
		})
	),
	async (c) => {
		const db = c.get("db") as DbClient;
		const tenantId = c.get("tenantId")!;
		const { limit, offset } = c.req.valid("query");

		const transcriptionService = createTranscriptionService(db);

		const transcriptions = await transcriptionService.listTranscriptions(
			tenantId,
			{
				limit: limit ?? 50,
				offset: offset ?? 0,
			}
		);

		return c.json({
			transcriptions: transcriptions.map((t) => ({
				id: t.id,
				language: t.language,
				duration: t.duration,
				createdAt: t.createdAt.toISOString(),
			})),
		});
	}
);

/**
 * Delete transcription
 */
mediaRoutes.delete("/transcriptions/:transcriptionId", async (c) => {
	const db = c.get("db") as DbClient;
	const tenantId = c.get("tenantId")!;
	const transcriptionId = c.req.param("transcriptionId");

	const transcriptionService = createTranscriptionService(db);

	const deleted = await transcriptionService.deleteTranscription(
		tenantId,
		transcriptionId
	);

	if (!deleted) {
		return c.json({ error: "Transcription not found" }, 404);
	}

	return c.json({ success: true });
});

export { mediaRoutes };
