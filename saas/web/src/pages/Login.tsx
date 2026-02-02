import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authApi } from "../lib/api";
import { useAuthStore } from "../stores/auth";

export function LoginPage() {
	const navigate = useNavigate();
	const setAuth = useAuthStore((state) => state.setAuth);

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");
		setLoading(true);

		try {
			const response = await authApi.login({ email, password });

			setAuth(
				{
					id: response.user.id,
					email: response.user.email,
					displayName: response.user.displayName,
					emailVerified: response.user.emailVerified,
					tier: response.user.tier,
				},
				{
					accessToken: response.tokens.accessToken,
					refreshToken: response.tokens.refreshToken,
				}
			);

			navigate("/chat");
		} catch (err) {
			setError(err instanceof Error ? err.message : "Login failed");
		} finally {
			setLoading(false);
		}
	};

	return (
		<div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
			<div className="max-w-md w-full space-y-8">
				<div>
					<h1 className="text-center text-3xl font-bold text-gray-900">
						Moltbot
					</h1>
					<h2 className="mt-6 text-center text-2xl font-semibold text-gray-900">
						Sign in to your account
					</h2>
					<p className="mt-2 text-center text-sm text-gray-600">
						Or{" "}
						<Link
							to="/signup"
							className="font-medium text-primary-600 hover:text-primary-500"
						>
							create a new account
						</Link>
					</p>
				</div>

				<form className="mt-8 space-y-6" onSubmit={handleSubmit}>
					{error && (
						<div className="rounded-md bg-red-50 p-4">
							<p className="text-sm text-red-700">{error}</p>
						</div>
					)}

					<div className="space-y-4">
						<div>
							<label
								htmlFor="email"
								className="block text-sm font-medium text-gray-700"
							>
								Email address
							</label>
							<input
								id="email"
								name="email"
								type="email"
								autoComplete="email"
								required
								value={email}
								onChange={(e) => setEmail(e.target.value)}
								className="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500"
								placeholder="you@example.com"
							/>
						</div>

						<div>
							<label
								htmlFor="password"
								className="block text-sm font-medium text-gray-700"
							>
								Password
							</label>
							<input
								id="password"
								name="password"
								type="password"
								autoComplete="current-password"
								required
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500"
								placeholder="••••••••"
							/>
						</div>
					</div>

					<div>
						<button
							type="submit"
							disabled={loading}
							className="w-full flex justify-center py-2 px-4 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50 disabled:cursor-not-allowed"
						>
							{loading ? "Signing in..." : "Sign in"}
						</button>
					</div>
				</form>
			</div>
		</div>
	);
}
