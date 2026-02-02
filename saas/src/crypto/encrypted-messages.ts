import { TenantKeyManager, getTenantKeyManager } from "./tenant-keys.js";
import type { DbClient } from "../db/client.js";

export interface ChatMessage {
	id: string;
	sessionId: string;
	role: "user" | "assistant" | "system";
	content: string;
	metadata?: Record<string, unknown>;
	createdAt: Date;
}

interface MessageRow {
	id: string;
	session_id: string;
	role: string;
	encrypted_content: string;
	key_version: number;
	metadata: Record<string, unknown> | null;
	created_at: Date;
}

/**
 * Encrypted message storage for tenant chat history
 */
export class EncryptedMessageStore {
	private keyManager: TenantKeyManager;

	constructor(
		private db: DbClient,
		keyManager?: TenantKeyManager
	) {
		this.keyManager = keyManager ?? getTenantKeyManager(db);
	}

	/**
	 * Store a new message
	 */
	async addMessage(
		tenantId: string,
		message: Omit<ChatMessage, "id" | "createdAt">
	): Promise<ChatMessage> {
		const encrypted = await this.keyManager.encryptForTenant(
			tenantId,
			message.content
		);

		const result = await this.db.query<{ id: string; created_at: Date }>(
			`INSERT INTO tenant_messages (tenant_id, session_id, role, encrypted_content, key_version, metadata)
			 VALUES ($1, $2, $3, $4, $5, $6)
			 RETURNING id, created_at`,
			[
				tenantId,
				message.sessionId,
				message.role,
				encrypted.ciphertext,
				encrypted.keyVersion,
				message.metadata ? JSON.stringify(message.metadata) : null,
			]
		);

		const row = result.rows[0]!;

		return {
			id: row.id,
			sessionId: message.sessionId,
			role: message.role,
			content: message.content,
			metadata: message.metadata,
			createdAt: row.created_at,
		};
	}

	/**
	 * Get messages for a session
	 */
	async getMessages(
		tenantId: string,
		sessionId: string,
		options?: { limit?: number; before?: Date }
	): Promise<ChatMessage[]> {
		let query = `
			SELECT id, session_id, role, encrypted_content, key_version, metadata, created_at
			FROM tenant_messages
			WHERE tenant_id = $1 AND session_id = $2
		`;
		const params: unknown[] = [tenantId, sessionId];

		if (options?.before) {
			query += ` AND created_at < $${params.length + 1}`;
			params.push(options.before);
		}

		query += ` ORDER BY created_at DESC`;

		if (options?.limit) {
			query += ` LIMIT $${params.length + 1}`;
			params.push(options.limit);
		}

		const result = await this.db.query<MessageRow>(query, params);

		// Decrypt all messages
		const messages = await Promise.all(
			result.rows.map(async (row) => {
				const content = await this.keyManager.decryptForTenant(tenantId, {
					ciphertext: row.encrypted_content,
					keyVersion: row.key_version,
					algorithm: "aes-256-gcm", // Default for stored messages
				});

				return {
					id: row.id,
					sessionId: row.session_id,
					role: row.role as ChatMessage["role"],
					content,
					metadata: row.metadata ?? undefined,
					createdAt: row.created_at,
				};
			})
		);

		// Return in chronological order
		return messages.reverse();
	}

	/**
	 * Get all sessions for a tenant
	 */
	async getSessions(
		tenantId: string
	): Promise<Array<{ sessionId: string; lastMessage: Date; messageCount: number }>> {
		const result = await this.db.query<{
			session_id: string;
			last_message: Date;
			message_count: string;
		}>(
			`SELECT session_id, MAX(created_at) as last_message, COUNT(*) as message_count
			 FROM tenant_messages
			 WHERE tenant_id = $1
			 GROUP BY session_id
			 ORDER BY last_message DESC`,
			[tenantId]
		);

		return result.rows.map((r) => ({
			sessionId: r.session_id,
			lastMessage: r.last_message,
			messageCount: parseInt(r.message_count, 10),
		}));
	}

	/**
	 * Delete a session and all its messages
	 */
	async deleteSession(tenantId: string, sessionId: string): Promise<number> {
		const result = await this.db.query(
			`DELETE FROM tenant_messages WHERE tenant_id = $1 AND session_id = $2`,
			[tenantId, sessionId]
		);

		return result.rowCount ?? 0;
	}

	/**
	 * Delete old messages (for data retention)
	 */
	async deleteOldMessages(tenantId: string, olderThan: Date): Promise<number> {
		const result = await this.db.query(
			`DELETE FROM tenant_messages WHERE tenant_id = $1 AND created_at < $2`,
			[tenantId, olderThan]
		);

		return result.rowCount ?? 0;
	}

	/**
	 * Re-encrypt messages after key rotation
	 */
	async reEncryptMessages(
		tenantId: string,
		batchSize: number = 100
	): Promise<{ updated: number; total: number }> {
		// Get current key version
		const currentVersion = await this.keyManager.getKeyVersion(tenantId);

		// Find messages with old key versions
		const result = await this.db.query<MessageRow>(
			`SELECT id, session_id, role, encrypted_content, key_version, metadata, created_at
			 FROM tenant_messages
			 WHERE tenant_id = $1 AND key_version < $2
			 LIMIT $3`,
			[tenantId, currentVersion, batchSize]
		);

		let updated = 0;

		for (const row of result.rows) {
			// Decrypt with old key
			const content = await this.keyManager.decryptForTenant(tenantId, {
				ciphertext: row.encrypted_content,
				keyVersion: row.key_version,
				algorithm: "aes-256-gcm",
			});

			// Re-encrypt with current key
			const newEncrypted = await this.keyManager.encryptForTenant(tenantId, content);

			// Update record
			await this.db.query(
				`UPDATE tenant_messages
				 SET encrypted_content = $1, key_version = $2
				 WHERE id = $3`,
				[newEncrypted.ciphertext, newEncrypted.keyVersion, row.id]
			);

			updated++;
		}

		// Get total remaining
		const countResult = await this.db.query<{ count: string }>(
			`SELECT COUNT(*) as count FROM tenant_messages
			 WHERE tenant_id = $1 AND key_version < $2`,
			[tenantId, currentVersion]
		);

		const remaining = parseInt(countResult.rows[0]?.count ?? "0", 10);

		return {
			updated,
			total: remaining + updated,
		};
	}

	/**
	 * Export all messages (for user data export)
	 */
	async exportAllMessages(tenantId: string): Promise<ChatMessage[]> {
		const result = await this.db.query<MessageRow>(
			`SELECT id, session_id, role, encrypted_content, key_version, metadata, created_at
			 FROM tenant_messages
			 WHERE tenant_id = $1
			 ORDER BY created_at ASC`,
			[tenantId]
		);

		return Promise.all(
			result.rows.map(async (row) => {
				const content = await this.keyManager.decryptForTenant(tenantId, {
					ciphertext: row.encrypted_content,
					keyVersion: row.key_version,
					algorithm: "aes-256-gcm",
				});

				return {
					id: row.id,
					sessionId: row.session_id,
					role: row.role as ChatMessage["role"],
					content,
					metadata: row.metadata ?? undefined,
					createdAt: row.created_at,
				};
			})
		);
	}
}
