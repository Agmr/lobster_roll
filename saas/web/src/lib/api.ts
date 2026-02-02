import { useAuthStore } from "../stores/auth";

const API_BASE = "/api";

interface ApiError {
	error: string;
	message?: string;
}

class ApiClient {
	private getHeaders(): HeadersInit {
		const headers: HeadersInit = {
			"Content-Type": "application/json",
		};

		const token = useAuthStore.getState().accessToken;
		if (token) {
			headers["Authorization"] = `Bearer ${token}`;
		}

		return headers;
	}

	private async handleResponse<T>(response: Response): Promise<T> {
		if (response.status === 401) {
			// Try to refresh token
			const refreshed = await this.refreshToken();
			if (!refreshed) {
				useAuthStore.getState().logout();
				throw new Error("Session expired");
			}
			throw new Error("RETRY");
		}

		if (!response.ok) {
			const error: ApiError = await response.json();
			throw new Error(error.error || "Request failed");
		}

		return response.json();
	}

	private async refreshToken(): Promise<boolean> {
		const refreshToken = useAuthStore.getState().refreshToken;
		if (!refreshToken) return false;

		try {
			const response = await fetch(`${API_BASE}/auth/refresh`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ refreshToken }),
			});

			if (!response.ok) return false;

			const data = await response.json();
			useAuthStore.getState().setTokens({
				accessToken: data.tokens.accessToken,
				refreshToken: data.tokens.refreshToken,
			});

			return true;
		} catch {
			return false;
		}
	}

	async get<T>(path: string): Promise<T> {
		const response = await fetch(`${API_BASE}${path}`, {
			method: "GET",
			headers: this.getHeaders(),
		});

		try {
			return await this.handleResponse<T>(response);
		} catch (error) {
			if (error instanceof Error && error.message === "RETRY") {
				// Retry with new token
				const retryResponse = await fetch(`${API_BASE}${path}`, {
					method: "GET",
					headers: this.getHeaders(),
				});
				return this.handleResponse<T>(retryResponse);
			}
			throw error;
		}
	}

	async post<T>(path: string, body?: unknown): Promise<T> {
		const response = await fetch(`${API_BASE}${path}`, {
			method: "POST",
			headers: this.getHeaders(),
			body: body ? JSON.stringify(body) : undefined,
		});

		try {
			return await this.handleResponse<T>(response);
		} catch (error) {
			if (error instanceof Error && error.message === "RETRY") {
				const retryResponse = await fetch(`${API_BASE}${path}`, {
					method: "POST",
					headers: this.getHeaders(),
					body: body ? JSON.stringify(body) : undefined,
				});
				return this.handleResponse<T>(retryResponse);
			}
			throw error;
		}
	}

	async delete<T>(path: string): Promise<T> {
		const response = await fetch(`${API_BASE}${path}`, {
			method: "DELETE",
			headers: this.getHeaders(),
		});

		try {
			return await this.handleResponse<T>(response);
		} catch (error) {
			if (error instanceof Error && error.message === "RETRY") {
				const retryResponse = await fetch(`${API_BASE}${path}`, {
					method: "DELETE",
					headers: this.getHeaders(),
				});
				return this.handleResponse<T>(retryResponse);
			}
			throw error;
		}
	}
}

export const api = new ApiClient();

// Auth API
export const authApi = {
	signup: (data: { email: string; password: string; displayName?: string }) =>
		api.post<{ user: { id: string; email: string } }>("/auth/signup", data),

	login: (data: { email: string; password: string }) =>
		api.post<{
			user: {
				id: string;
				email: string;
				displayName: string | null;
				emailVerified: boolean;
				tier: "free" | "starter" | "pro" | "enterprise";
			};
			tokens: {
				accessToken: string;
				refreshToken: string;
				expiresIn: number;
			};
		}>("/auth/login", data),

	logout: () => api.post<{ message: string }>("/auth/logout"),

	me: () =>
		api.get<{
			id: string;
			email: string;
			displayName: string | null;
			emailVerified: boolean;
		}>("/auth/me"),
};

// Agent API
export const agentApi = {
	status: () =>
		api.get<{
			status: string;
			ready?: boolean;
			namespace?: string;
			message?: string;
		}>("/agent/status"),

	provision: () =>
		api.post<{
			message: string;
			tenantId: string;
			namespace: string;
		}>("/agent/provision"),

	wake: () => api.post<{ message: string }>("/agent/wake"),

	restart: () => api.post<{ message: string }>("/agent/restart"),

	terminate: () => api.delete<{ message: string }>("/agent"),

	logs: (lines?: number) =>
		api.get<{ logs: string }>(`/agent/logs${lines ? `?lines=${lines}` : ""}`),
};
