import { VaultClient, getVaultClient, tenantVaultPath } from "./vault.js";
import {
	encrypt,
	decrypt,
	deriveTenantKey,
	generateSecureRandomString,
	sha256,
} from "./encryption.js";
import type { DbClient, TenantRow } from "../db/client.js";
import { env } from "../config/env.js";

interface TenantKeyInfo {
	tenantId: string;
	keyVersion: number;
	createdAt: string;
	rotatedAt?: string;
}

interface EncryptedData {
	ciphertext: string;
	keyVersion: number;
	algorithm: string;
}

/**
 * Per-tenant key management service
 * Handles encryption key lifecycle for tenant data
 */
export class TenantKeyManager {
	private vault: VaultClient;
	private keyCache: Map<string, { key: string; version: number; expiresAt: number }> = new Map();
	private readonly CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

	constructor(
		private db: DbClient,
		vaultClient?: VaultClient
	) {
		this.vault = vaultClient ?? getVaultClient();
	}

	/**
	 * Initialize encryption key for a new tenant
	 */
	async initializeTenantKey(tenantId: string): Promise<void> {
		const keyName = this.getTransitKeyName(tenantId);

		// Create transit key in Vault
		if (await this.isVaultAvailable()) {
			await this.vault.createTransitKey(keyName);

			// Store key metadata
			await this.vault.kvPut(tenantVaultPath(tenantId, "key-info"), {
				tenantId,
				keyVersion: 1,
				createdAt: new Date().toISOString(),
			});
		}

		// Update tenant record with key reference
		await this.db.query(
			`UPDATE tenants SET vault_key_id = $1 WHERE id = $2`,
			[keyName, tenantId]
		);
	}

	/**
	 * Get the encryption key for a tenant
	 * Uses Vault transit if available, otherwise derives from master key
	 */
	async getTenantKey(tenantId: string): Promise<string> {
		// Check cache
		const cached = this.keyCache.get(tenantId);
		if (cached && cached.expiresAt > Date.now()) {
			return cached.key;
		}

		let key: string;

		if (await this.isVaultAvailable()) {
			// Use Vault-derived key
			key = await this.deriveKeyFromVault(tenantId);
		} else {
			// Fallback to local derivation
			key = deriveTenantKey(tenantId);
		}

		// Cache the key
		this.keyCache.set(tenantId, {
			key,
			version: 1,
			expiresAt: Date.now() + this.CACHE_TTL_MS,
		});

		return key;
	}

	/**
	 * Encrypt data for a tenant
	 */
	async encryptForTenant(tenantId: string, plaintext: string): Promise<EncryptedData> {
		if (await this.isVaultAvailable()) {
			// Use Vault transit encryption (recommended for production)
			const keyName = this.getTransitKeyName(tenantId);
			const ciphertext = await this.vault.transitEncrypt(keyName, plaintext);

			return {
				ciphertext,
				keyVersion: await this.getKeyVersion(tenantId),
				algorithm: "vault-transit-aes256-gcm96",
			};
		}

		// Fallback to local encryption
		const key = await this.getTenantKey(tenantId);
		const encryptedBuffer = encrypt(plaintext, key);

		return {
			ciphertext: encryptedBuffer.toString("base64"),
			keyVersion: 1,
			algorithm: "aes-256-gcm",
		};
	}

	/**
	 * Decrypt data for a tenant
	 */
	async decryptForTenant(tenantId: string, encryptedData: EncryptedData): Promise<string> {
		if (encryptedData.algorithm === "vault-transit-aes256-gcm96") {
			const keyName = this.getTransitKeyName(tenantId);
			return this.vault.transitDecrypt(keyName, encryptedData.ciphertext);
		}

		// Local decryption
		const key = await this.getTenantKey(tenantId);
		const encryptedBuffer = Buffer.from(encryptedData.ciphertext, "base64");
		return decrypt(encryptedBuffer, key);
	}

	/**
	 * Rotate encryption key for a tenant
	 */
	async rotateTenantKey(tenantId: string): Promise<void> {
		if (await this.isVaultAvailable()) {
			const keyName = this.getTransitKeyName(tenantId);

			// Rotate the transit key
			await this.vault.rotateTransitKey(keyName);

			// Update key metadata
			const keyInfo = await this.vault.kvGet(
				tenantVaultPath(tenantId, "key-info")
			) as TenantKeyInfo | null;

			await this.vault.kvPut(tenantVaultPath(tenantId, "key-info"), {
				...keyInfo,
				keyVersion: (keyInfo?.keyVersion ?? 0) + 1,
				rotatedAt: new Date().toISOString(),
			});

			// Log rotation event
			await this.db.query(
				`INSERT INTO audit_logs (tenant_id, event_type, event_category, description)
				 VALUES ($1, 'key_rotation', 'security', 'Tenant encryption key rotated')`,
				[tenantId]
			);
		}

		// Clear cache
		this.keyCache.delete(tenantId);
	}

	/**
	 * Delete all encryption keys for a tenant
	 */
	async deleteTenantKeys(tenantId: string): Promise<void> {
		if (await this.isVaultAvailable()) {
			// Note: Transit keys can't be easily deleted, but we can delete the KV metadata
			await this.vault.kvDelete(tenantVaultPath(tenantId, "key-info"));
		}

		this.keyCache.delete(tenantId);
	}

	/**
	 * Get current key version for a tenant
	 */
	async getKeyVersion(tenantId: string): Promise<number> {
		if (await this.isVaultAvailable()) {
			const keyInfo = await this.vault.kvGet(
				tenantVaultPath(tenantId, "key-info")
			) as TenantKeyInfo | null;

			return keyInfo?.keyVersion ?? 1;
		}

		return 1;
	}

	/**
	 * Check if a tenant's data needs re-encryption after key rotation
	 */
	async needsReEncryption(
		tenantId: string,
		dataKeyVersion: number
	): Promise<boolean> {
		const currentVersion = await this.getKeyVersion(tenantId);
		return dataKeyVersion < currentVersion;
	}

	// Private helpers

	private getTransitKeyName(tenantId: string): string {
		return `tenant-${tenantId}`;
	}

	private async isVaultAvailable(): Promise<boolean> {
		if (!env.VAULT_ADDR || !env.VAULT_TOKEN) {
			return false;
		}

		try {
			return await this.vault.isHealthy();
		} catch {
			return false;
		}
	}

	private async deriveKeyFromVault(tenantId: string): Promise<string> {
		// Use Vault to encrypt a known value, deriving a unique key
		const keyName = this.getTransitKeyName(tenantId);
		const seed = `key-derivation-seed-${tenantId}`;

		const encrypted = await this.vault.transitEncrypt(keyName, seed);

		// Use hash of ciphertext as the derived key
		return sha256(encrypted);
	}
}

// Singleton instance
let keyManager: TenantKeyManager | null = null;

export function getTenantKeyManager(db: DbClient): TenantKeyManager {
	if (!keyManager) {
		keyManager = new TenantKeyManager(db);
	}
	return keyManager;
}
