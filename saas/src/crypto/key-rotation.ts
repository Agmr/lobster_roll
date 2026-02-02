import { TenantKeyManager, getTenantKeyManager } from "./tenant-keys.js";
import { EncryptedMessageStore } from "./encrypted-messages.js";
import { EncryptedCredentialStore } from "./encrypted-credentials.js";
import { EncryptedConfigStore, EncryptedBlobStore } from "./encrypted-storage.js";
import type { DbClient } from "../db/client.js";

export interface KeyRotationStatus {
	tenantId: string;
	oldVersion: number;
	newVersion: number;
	status: "pending" | "in_progress" | "completed" | "failed";
	recordsUpdated: number;
	startedAt: Date;
	completedAt?: Date;
	error?: string;
}

export interface KeyRotationProgress {
	messages: { updated: number; total: number };
	credentials: { updated: number; total: number };
	config: { updated: number; total: number };
	blobs: { updated: number; total: number };
}

/**
 * Key rotation service for tenant encryption keys
 * Handles the full lifecycle of rotating keys and re-encrypting data
 */
export class KeyRotationService {
	private keyManager: TenantKeyManager;
	private messageStore: EncryptedMessageStore;
	private credentialStore: EncryptedCredentialStore;
	private configStore: EncryptedConfigStore;
	private blobStore: EncryptedBlobStore;

	constructor(private db: DbClient) {
		this.keyManager = getTenantKeyManager(db);
		this.messageStore = new EncryptedMessageStore(db, this.keyManager);
		this.credentialStore = new EncryptedCredentialStore(db, this.keyManager);
		this.configStore = new EncryptedConfigStore(db, this.keyManager);
		this.blobStore = new EncryptedBlobStore(db, this.keyManager);
	}

	/**
	 * Start a key rotation for a tenant
	 */
	async startRotation(tenantId: string): Promise<KeyRotationStatus> {
		// Get current key version
		const oldVersion = await this.keyManager.getKeyVersion(tenantId);

		// Create rotation record
		const result = await this.db.query<{
			id: string;
			old_version: number;
			new_version: number;
			status: string;
			rotated_at: Date;
		}>(
			`INSERT INTO key_rotation_history (tenant_id, old_version, new_version, status)
			 VALUES ($1, $2, $3, 'pending')
			 RETURNING id, old_version, new_version, status, rotated_at`,
			[tenantId, oldVersion, oldVersion + 1]
		);

		const record = result.rows[0]!;

		// Update status to in_progress
		await this.db.query(
			`UPDATE key_rotation_history SET status = 'in_progress' WHERE id = $1`,
			[record.id]
		);

		// Rotate the key in Vault/key manager
		await this.keyManager.rotateTenantKey(tenantId);

		return {
			tenantId,
			oldVersion: record.old_version,
			newVersion: record.new_version,
			status: "in_progress",
			recordsUpdated: 0,
			startedAt: record.rotated_at,
		};
	}

	/**
	 * Re-encrypt all data for a tenant after key rotation
	 * This can be run in batches to avoid long-running transactions
	 */
	async reEncryptData(
		tenantId: string,
		batchSize: number = 100
	): Promise<KeyRotationProgress> {
		const progress: KeyRotationProgress = {
			messages: { updated: 0, total: 0 },
			credentials: { updated: 0, total: 0 },
			config: { updated: 0, total: 0 },
			blobs: { updated: 0, total: 0 },
		};

		// Re-encrypt messages
		const messageResult = await this.messageStore.reEncryptMessages(tenantId, batchSize);
		progress.messages = messageResult;

		// Re-encrypt credentials
		const credentialCount = await this.credentialStore.reEncryptCredentials(tenantId);
		progress.credentials = { updated: credentialCount, total: credentialCount };

		// Re-encrypt config
		const configCount = await this.reEncryptConfig(tenantId, batchSize);
		progress.config = configCount;

		// Re-encrypt blobs
		const blobCount = await this.reEncryptBlobs(tenantId, batchSize);
		progress.blobs = blobCount;

		// Update rotation history
		const totalUpdated =
			progress.messages.updated +
			progress.credentials.updated +
			progress.config.updated +
			progress.blobs.updated;

		await this.db.query(
			`UPDATE key_rotation_history
			 SET records_updated = records_updated + $1
			 WHERE tenant_id = $2 AND status = 'in_progress'`,
			[totalUpdated, tenantId]
		);

		return progress;
	}

	/**
	 * Re-encrypt config entries
	 */
	private async reEncryptConfig(
		tenantId: string,
		batchSize: number
	): Promise<{ updated: number; total: number }> {
		const currentVersion = await this.keyManager.getKeyVersion(tenantId);

		// Get config entries with old key versions
		// Note: tenant_config doesn't have key_version column in current schema
		// This would need to be added for proper key rotation tracking
		// For now, we'll re-encrypt all config entries

		const result = await this.db.query<{
			id: string;
			key: string;
			value: string;
		}>(
			`SELECT id, key, value FROM tenant_config
			 WHERE tenant_id = $1
			 LIMIT $2`,
			[tenantId, batchSize]
		);

		let updated = 0;

		for (const row of result.rows) {
			try {
				// Get current value (already decrypted by config store)
				const currentValue = await this.configStore.getConfig(tenantId, row.key);
				if (currentValue !== null) {
					// Re-set to encrypt with new key
					await this.configStore.setConfig(tenantId, row.key, currentValue);
					updated++;
				}
			} catch {
				// Skip entries that fail to decrypt (may already be on new key)
			}
		}

		return { updated, total: result.rows.length };
	}

	/**
	 * Re-encrypt blob entries
	 */
	private async reEncryptBlobs(
		tenantId: string,
		batchSize: number
	): Promise<{ updated: number; total: number }> {
		// Get blob metadata (without loading full data)
		const result = await this.db.query<{
			id: string;
			name: string;
		}>(
			`SELECT id, name FROM tenant_blobs
			 WHERE tenant_id = $1
			 LIMIT $2`,
			[tenantId, batchSize]
		);

		let updated = 0;

		for (const row of result.rows) {
			try {
				// Get current blob
				const blob = await this.blobStore.getBlob(tenantId, row.name);
				if (blob) {
					// Re-store to encrypt with new key
					await this.blobStore.storeBlob(
						tenantId,
						row.name,
						blob.data,
						blob.contentType
					);
					updated++;
				}
			} catch {
				// Skip entries that fail to decrypt
			}
		}

		return { updated, total: result.rows.length };
	}

	/**
	 * Check if re-encryption is complete
	 */
	async isReEncryptionComplete(tenantId: string): Promise<boolean> {
		const currentVersion = await this.keyManager.getKeyVersion(tenantId);

		// Check messages
		const messageCount = await this.db.query<{ count: string }>(
			`SELECT COUNT(*) as count FROM tenant_messages
			 WHERE tenant_id = $1 AND key_version < $2`,
			[tenantId, currentVersion]
		);

		if (parseInt(messageCount.rows[0]?.count ?? "0", 10) > 0) {
			return false;
		}

		// Check credentials
		const credentialCount = await this.db.query<{ count: string }>(
			`SELECT COUNT(*) as count FROM tenant_credentials
			 WHERE tenant_id = $1 AND key_version < $2`,
			[tenantId, currentVersion]
		);

		if (parseInt(credentialCount.rows[0]?.count ?? "0", 10) > 0) {
			return false;
		}

		return true;
	}

	/**
	 * Complete the key rotation
	 */
	async completeRotation(tenantId: string): Promise<KeyRotationStatus> {
		const result = await this.db.query<{
			id: string;
			old_version: number;
			new_version: number;
			records_updated: number;
			rotated_at: Date;
		}>(
			`UPDATE key_rotation_history
			 SET status = 'completed', completed_at = NOW()
			 WHERE tenant_id = $1 AND status = 'in_progress'
			 RETURNING id, old_version, new_version, records_updated, rotated_at`,
			[tenantId]
		);

		if (result.rows.length === 0) {
			throw new Error("No in-progress rotation found for tenant");
		}

		const record = result.rows[0]!;

		return {
			tenantId,
			oldVersion: record.old_version,
			newVersion: record.new_version,
			status: "completed",
			recordsUpdated: record.records_updated,
			startedAt: record.rotated_at,
			completedAt: new Date(),
		};
	}

	/**
	 * Mark rotation as failed
	 */
	async failRotation(tenantId: string, error: string): Promise<void> {
		await this.db.query(
			`UPDATE key_rotation_history
			 SET status = 'failed', completed_at = NOW()
			 WHERE tenant_id = $1 AND status = 'in_progress'`,
			[tenantId]
		);

		console.error(`Key rotation failed for tenant ${tenantId}:`, error);
	}

	/**
	 * Get rotation history for a tenant
	 */
	async getRotationHistory(tenantId: string): Promise<KeyRotationStatus[]> {
		const result = await this.db.query<{
			old_version: number;
			new_version: number;
			status: string;
			records_updated: number;
			rotated_at: Date;
			completed_at: Date | null;
		}>(
			`SELECT old_version, new_version, status, records_updated, rotated_at, completed_at
			 FROM key_rotation_history
			 WHERE tenant_id = $1
			 ORDER BY rotated_at DESC`,
			[tenantId]
		);

		return result.rows.map((row) => ({
			tenantId,
			oldVersion: row.old_version,
			newVersion: row.new_version,
			status: row.status as KeyRotationStatus["status"],
			recordsUpdated: row.records_updated,
			startedAt: row.rotated_at,
			completedAt: row.completed_at ?? undefined,
		}));
	}

	/**
	 * Perform a full key rotation with re-encryption
	 * This is a convenience method that handles the full rotation lifecycle
	 */
	async performFullRotation(
		tenantId: string,
		options?: { batchSize?: number; maxIterations?: number }
	): Promise<KeyRotationStatus> {
		const batchSize = options?.batchSize ?? 100;
		const maxIterations = options?.maxIterations ?? 1000;

		try {
			// Start rotation
			const status = await this.startRotation(tenantId);

			// Re-encrypt in batches until complete
			let iterations = 0;
			while (iterations < maxIterations) {
				const progress = await this.reEncryptData(tenantId, batchSize);

				// Check if we're done
				const totalRemaining =
					progress.messages.total -
					progress.messages.updated +
					progress.blobs.total -
					progress.blobs.updated +
					progress.config.total -
					progress.config.updated;

				if (totalRemaining === 0 && (await this.isReEncryptionComplete(tenantId))) {
					break;
				}

				iterations++;
			}

			// Complete rotation
			return await this.completeRotation(tenantId);
		} catch (error) {
			await this.failRotation(
				tenantId,
				error instanceof Error ? error.message : String(error)
			);
			throw error;
		}
	}
}

// Singleton instance
let keyRotationService: KeyRotationService | null = null;

export function getKeyRotationService(db: DbClient): KeyRotationService {
	if (!keyRotationService) {
		keyRotationService = new KeyRotationService(db);
	}
	return keyRotationService;
}
