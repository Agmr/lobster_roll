import { TenantKeyManager, getTenantKeyManager } from "./tenant-keys.js";
import type { DbClient } from "../db/client.js";

export interface Credential {
	id: string;
	provider: string;
	name: string;
	data: Record<string, unknown>;
	expiresAt?: Date;
	createdAt: Date;
	updatedAt: Date;
}

interface CredentialRow {
	id: string;
	provider: string;
	name: string;
	encrypted_data: string;
	key_version: number;
	expires_at: Date | null;
	created_at: Date;
	updated_at: Date;
}

// Supported credential providers
export type CredentialProvider =
	| "anthropic"
	| "openai"
	| "google"
	| "azure"
	| "telegram"
	| "discord"
	| "slack"
	| "whatsapp"
	| "custom";

/**
 * Encrypted credential storage for tenant API keys and tokens
 */
export class EncryptedCredentialStore {
	private keyManager: TenantKeyManager;

	constructor(
		private db: DbClient,
		keyManager?: TenantKeyManager
	) {
		this.keyManager = keyManager ?? getTenantKeyManager(db);
	}

	/**
	 * Store a credential
	 */
	async setCredential(
		tenantId: string,
		provider: CredentialProvider,
		name: string,
		data: Record<string, unknown>,
		expiresAt?: Date
	): Promise<Credential> {
		const encrypted = await this.keyManager.encryptForTenant(
			tenantId,
			JSON.stringify(data)
		);

		const result = await this.db.query<CredentialRow>(
			`INSERT INTO tenant_credentials (tenant_id, provider, name, encrypted_data, key_version, expires_at)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 ON CONFLICT (tenant_id, provider, name) DO UPDATE SET
			   encrypted_data = $4,
			   key_version = $5,
			   expires_at = $6,
			   updated_at = NOW()
			 RETURNING *`,
			[tenantId, provider, name, encrypted.ciphertext, encrypted.keyVersion, expiresAt]
		);

		const row = result.rows[0]!;

		return {
			id: row.id,
			provider: row.provider,
			name: row.name,
			data,
			expiresAt: row.expires_at ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	/**
	 * Get a credential
	 */
	async getCredential(
		tenantId: string,
		provider: CredentialProvider,
		name: string
	): Promise<Credential | null> {
		const result = await this.db.query<CredentialRow>(
			`SELECT * FROM tenant_credentials
			 WHERE tenant_id = $1 AND provider = $2 AND name = $3`,
			[tenantId, provider, name]
		);

		if (result.rows.length === 0) {
			return null;
		}

		const row = result.rows[0]!;

		// Check expiration
		if (row.expires_at && row.expires_at < new Date()) {
			return null;
		}

		const decrypted = await this.keyManager.decryptForTenant(tenantId, {
			ciphertext: row.encrypted_data,
			keyVersion: row.key_version,
			algorithm: "aes-256-gcm",
		});

		return {
			id: row.id,
			provider: row.provider,
			name: row.name,
			data: JSON.parse(decrypted),
			expiresAt: row.expires_at ?? undefined,
			createdAt: row.created_at,
			updatedAt: row.updated_at,
		};
	}

	/**
	 * Get all credentials for a provider
	 */
	async getCredentialsForProvider(
		tenantId: string,
		provider: CredentialProvider
	): Promise<Credential[]> {
		const result = await this.db.query<CredentialRow>(
			`SELECT * FROM tenant_credentials
			 WHERE tenant_id = $1 AND provider = $2
			   AND (expires_at IS NULL OR expires_at > NOW())
			 ORDER BY created_at`,
			[tenantId, provider]
		);

		return Promise.all(
			result.rows.map(async (row) => {
				const decrypted = await this.keyManager.decryptForTenant(tenantId, {
					ciphertext: row.encrypted_data,
					keyVersion: row.key_version,
					algorithm: "aes-256-gcm",
				});

				return {
					id: row.id,
					provider: row.provider,
					name: row.name,
					data: JSON.parse(decrypted),
					expiresAt: row.expires_at ?? undefined,
					createdAt: row.created_at,
					updatedAt: row.updated_at,
				};
			})
		);
	}

	/**
	 * List all credentials (without decrypting data)
	 */
	async listCredentials(
		tenantId: string
	): Promise<Array<{
		id: string;
		provider: string;
		name: string;
		expiresAt?: Date;
		createdAt: Date;
	}>> {
		const result = await this.db.query<CredentialRow>(
			`SELECT id, provider, name, expires_at, created_at FROM tenant_credentials
			 WHERE tenant_id = $1
			   AND (expires_at IS NULL OR expires_at > NOW())
			 ORDER BY provider, name`,
			[tenantId]
		);

		return result.rows.map((row) => ({
			id: row.id,
			provider: row.provider,
			name: row.name,
			expiresAt: row.expires_at ?? undefined,
			createdAt: row.created_at,
		}));
	}

	/**
	 * Delete a credential
	 */
	async deleteCredential(
		tenantId: string,
		provider: CredentialProvider,
		name: string
	): Promise<boolean> {
		const result = await this.db.query(
			`DELETE FROM tenant_credentials
			 WHERE tenant_id = $1 AND provider = $2 AND name = $3`,
			[tenantId, provider, name]
		);

		return (result.rowCount ?? 0) > 0;
	}

	/**
	 * Delete all credentials for a provider
	 */
	async deleteProviderCredentials(
		tenantId: string,
		provider: CredentialProvider
	): Promise<number> {
		const result = await this.db.query(
			`DELETE FROM tenant_credentials WHERE tenant_id = $1 AND provider = $2`,
			[tenantId, provider]
		);

		return result.rowCount ?? 0;
	}

	/**
	 * Clean up expired credentials
	 */
	async cleanupExpired(tenantId: string): Promise<number> {
		const result = await this.db.query(
			`DELETE FROM tenant_credentials
			 WHERE tenant_id = $1 AND expires_at IS NOT NULL AND expires_at < NOW()`,
			[tenantId]
		);

		return result.rowCount ?? 0;
	}

	/**
	 * Re-encrypt credentials after key rotation
	 */
	async reEncryptCredentials(tenantId: string): Promise<number> {
		const currentVersion = await this.keyManager.getKeyVersion(tenantId);

		const result = await this.db.query<CredentialRow>(
			`SELECT * FROM tenant_credentials
			 WHERE tenant_id = $1 AND key_version < $2`,
			[tenantId, currentVersion]
		);

		let updated = 0;

		for (const row of result.rows) {
			// Decrypt with old key
			const decrypted = await this.keyManager.decryptForTenant(tenantId, {
				ciphertext: row.encrypted_data,
				keyVersion: row.key_version,
				algorithm: "aes-256-gcm",
			});

			// Re-encrypt with current key
			const newEncrypted = await this.keyManager.encryptForTenant(tenantId, decrypted);

			// Update record
			await this.db.query(
				`UPDATE tenant_credentials
				 SET encrypted_data = $1, key_version = $2, updated_at = NOW()
				 WHERE id = $3`,
				[newEncrypted.ciphertext, newEncrypted.keyVersion, row.id]
			);

			updated++;
		}

		return updated;
	}
}

// Helper functions for common credential types

export interface AnthropicCredential {
	apiKey: string;
}

export interface OpenAICredential {
	apiKey: string;
	organizationId?: string;
}

export interface OAuthCredential {
	accessToken: string;
	refreshToken?: string;
	tokenType: string;
	scope?: string;
	expiresAt?: number;
}

/**
 * Get Anthropic API key for a tenant
 */
export async function getAnthropicKey(
	store: EncryptedCredentialStore,
	tenantId: string
): Promise<string | null> {
	const cred = await store.getCredential(tenantId, "anthropic", "default");
	if (!cred) return null;

	const data = cred.data as AnthropicCredential;
	return data.apiKey;
}

/**
 * Get OpenAI API key for a tenant
 */
export async function getOpenAIKey(
	store: EncryptedCredentialStore,
	tenantId: string
): Promise<{ apiKey: string; orgId?: string } | null> {
	const cred = await store.getCredential(tenantId, "openai", "default");
	if (!cred) return null;

	const data = cred.data as OpenAICredential;
	return { apiKey: data.apiKey, orgId: data.organizationId };
}
