import { TenantKeyManager, getTenantKeyManager } from "./tenant-keys.js";
import type { DbClient } from "../db/client.js";

interface StoredData<T> {
	version: number;
	keyVersion: number;
	algorithm: string;
	ciphertext: string;
	metadata?: {
		createdAt: string;
		updatedAt: string;
	};
}

const STORAGE_VERSION = 1;

/**
 * Encrypted storage service for tenant data
 * Provides a simple API for storing and retrieving encrypted JSON data
 */
export class EncryptedStorage {
	private keyManager: TenantKeyManager;

	constructor(db: DbClient, keyManager?: TenantKeyManager) {
		this.keyManager = keyManager ?? getTenantKeyManager(db);
	}

	/**
	 * Encrypt and serialize data for storage
	 */
	async encrypt<T>(tenantId: string, data: T): Promise<string> {
		const plaintext = JSON.stringify(data);
		const encrypted = await this.keyManager.encryptForTenant(tenantId, plaintext);

		const storedData: StoredData<T> = {
			version: STORAGE_VERSION,
			keyVersion: encrypted.keyVersion,
			algorithm: encrypted.algorithm,
			ciphertext: encrypted.ciphertext,
			metadata: {
				createdAt: new Date().toISOString(),
				updatedAt: new Date().toISOString(),
			},
		};

		return JSON.stringify(storedData);
	}

	/**
	 * Decrypt and deserialize stored data
	 */
	async decrypt<T>(tenantId: string, encryptedString: string): Promise<T> {
		const storedData: StoredData<T> = JSON.parse(encryptedString);

		if (storedData.version !== STORAGE_VERSION) {
			throw new Error(`Unsupported storage version: ${storedData.version}`);
		}

		const plaintext = await this.keyManager.decryptForTenant(tenantId, {
			ciphertext: storedData.ciphertext,
			keyVersion: storedData.keyVersion,
			algorithm: storedData.algorithm,
		});

		return JSON.parse(plaintext) as T;
	}

	/**
	 * Check if stored data needs re-encryption
	 */
	async needsReEncryption(tenantId: string, encryptedString: string): Promise<boolean> {
		const storedData: StoredData<unknown> = JSON.parse(encryptedString);
		return this.keyManager.needsReEncryption(tenantId, storedData.keyVersion);
	}

	/**
	 * Re-encrypt data with current key
	 */
	async reEncrypt<T>(tenantId: string, encryptedString: string): Promise<string> {
		const data = await this.decrypt<T>(tenantId, encryptedString);
		return this.encrypt(tenantId, data);
	}
}

/**
 * Encrypted key-value store for tenant configuration
 */
export class EncryptedConfigStore {
	private storage: EncryptedStorage;

	constructor(
		private db: DbClient,
		storage?: EncryptedStorage
	) {
		this.storage = storage ?? new EncryptedStorage(db);
	}

	/**
	 * Get a config value
	 */
	async get<T>(tenantId: string, key: string): Promise<T | null> {
		const result = await this.db.query<{ value: string }>(
			`SELECT value FROM tenant_config WHERE tenant_id = $1 AND key = $2`,
			[tenantId, key]
		);

		if (result.rows.length === 0) {
			return null;
		}

		return this.storage.decrypt<T>(tenantId, result.rows[0]!.value);
	}

	/**
	 * Set a config value
	 */
	async set<T>(tenantId: string, key: string, value: T): Promise<void> {
		const encrypted = await this.storage.encrypt(tenantId, value);

		await this.db.query(
			`INSERT INTO tenant_config (tenant_id, key, value)
			 VALUES ($1, $2, $3)
			 ON CONFLICT (tenant_id, key) DO UPDATE SET
			   value = $3,
			   updated_at = NOW()`,
			[tenantId, key, encrypted]
		);
	}

	/**
	 * Delete a config value
	 */
	async delete(tenantId: string, key: string): Promise<void> {
		await this.db.query(
			`DELETE FROM tenant_config WHERE tenant_id = $1 AND key = $2`,
			[tenantId, key]
		);
	}

	/**
	 * List all config keys for a tenant
	 */
	async list(tenantId: string): Promise<string[]> {
		const result = await this.db.query<{ key: string }>(
			`SELECT key FROM tenant_config WHERE tenant_id = $1`,
			[tenantId]
		);

		return result.rows.map((r) => r.key);
	}

	/**
	 * Re-encrypt all config values after key rotation
	 */
	async reEncryptAll(tenantId: string): Promise<number> {
		const result = await this.db.query<{ key: string; value: string }>(
			`SELECT key, value FROM tenant_config WHERE tenant_id = $1`,
			[tenantId]
		);

		let count = 0;

		for (const row of result.rows) {
			if (await this.storage.needsReEncryption(tenantId, row.value)) {
				const reEncrypted = await this.storage.reEncrypt(tenantId, row.value);
				await this.db.query(
					`UPDATE tenant_config SET value = $1, updated_at = NOW()
					 WHERE tenant_id = $2 AND key = $3`,
					[reEncrypted, tenantId, row.key]
				);
				count++;
			}
		}

		return count;
	}
}

/**
 * Encrypted blob storage for larger tenant data (files, backups, etc.)
 */
export class EncryptedBlobStore {
	private storage: EncryptedStorage;

	constructor(
		private db: DbClient,
		storage?: EncryptedStorage
	) {
		this.storage = storage ?? new EncryptedStorage(db);
	}

	/**
	 * Store a blob
	 */
	async put(
		tenantId: string,
		name: string,
		data: Buffer,
		contentType?: string
	): Promise<string> {
		const blobData = {
			contentType: contentType ?? "application/octet-stream",
			data: data.toString("base64"),
			size: data.length,
		};

		const encrypted = await this.storage.encrypt(tenantId, blobData);
		const blobId = crypto.randomUUID();

		await this.db.query(
			`INSERT INTO tenant_blobs (id, tenant_id, name, encrypted_data, size, content_type)
			 VALUES ($1, $2, $3, $4, $5, $6)`,
			[blobId, tenantId, name, encrypted, data.length, contentType]
		);

		return blobId;
	}

	/**
	 * Get a blob by ID
	 */
	async get(
		tenantId: string,
		blobId: string
	): Promise<{ data: Buffer; contentType: string; name: string } | null> {
		const result = await this.db.query<{
			name: string;
			encrypted_data: string;
			content_type: string;
		}>(
			`SELECT name, encrypted_data, content_type FROM tenant_blobs
			 WHERE id = $1 AND tenant_id = $2`,
			[blobId, tenantId]
		);

		if (result.rows.length === 0) {
			return null;
		}

		const row = result.rows[0]!;
		const decrypted = await this.storage.decrypt<{
			data: string;
			contentType: string;
		}>(tenantId, row.encrypted_data);

		return {
			data: Buffer.from(decrypted.data, "base64"),
			contentType: row.content_type,
			name: row.name,
		};
	}

	/**
	 * Delete a blob
	 */
	async delete(tenantId: string, blobId: string): Promise<void> {
		await this.db.query(
			`DELETE FROM tenant_blobs WHERE id = $1 AND tenant_id = $2`,
			[blobId, tenantId]
		);
	}

	/**
	 * List blobs for a tenant
	 */
	async list(
		tenantId: string
	): Promise<Array<{ id: string; name: string; size: number; createdAt: Date }>> {
		const result = await this.db.query<{
			id: string;
			name: string;
			size: number;
			created_at: Date;
		}>(
			`SELECT id, name, size, created_at FROM tenant_blobs
			 WHERE tenant_id = $1 ORDER BY created_at DESC`,
			[tenantId]
		);

		return result.rows.map((r) => ({
			id: r.id,
			name: r.name,
			size: r.size,
			createdAt: r.created_at,
		}));
	}
}
