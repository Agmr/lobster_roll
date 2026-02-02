import { create } from "zustand";
import { persist } from "zustand/middleware";

export interface User {
	id: string;
	email: string;
	displayName: string | null;
	emailVerified: boolean;
	tier: "free" | "starter" | "pro" | "enterprise";
}

interface AuthState {
	user: User | null;
	accessToken: string | null;
	refreshToken: string | null;
	isAuthenticated: boolean;
	isLoading: boolean;

	// Actions
	setAuth: (user: User, tokens: { accessToken: string; refreshToken: string }) => void;
	setTokens: (tokens: { accessToken: string; refreshToken: string }) => void;
	logout: () => void;
	setLoading: (loading: boolean) => void;
}

export const useAuthStore = create<AuthState>()(
	persist(
		(set) => ({
			user: null,
			accessToken: null,
			refreshToken: null,
			isAuthenticated: false,
			isLoading: true,

			setAuth: (user, tokens) =>
				set({
					user,
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
					isAuthenticated: true,
					isLoading: false,
				}),

			setTokens: (tokens) =>
				set({
					accessToken: tokens.accessToken,
					refreshToken: tokens.refreshToken,
				}),

			logout: () =>
				set({
					user: null,
					accessToken: null,
					refreshToken: null,
					isAuthenticated: false,
					isLoading: false,
				}),

			setLoading: (loading) => set({ isLoading: loading }),
		}),
		{
			name: "moltbot-auth",
			partialize: (state) => ({
				user: state.user,
				accessToken: state.accessToken,
				refreshToken: state.refreshToken,
				isAuthenticated: state.isAuthenticated,
			}),
		}
	)
);
