import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { authApi } from "../lib/api";

export function SignupPage() {
	const navigate = useNavigate();

	const [email, setEmail] = useState("");
	const [password, setPassword] = useState("");
	const [confirmPassword, setConfirmPassword] = useState("");
	const [displayName, setDisplayName] = useState("");
	const [error, setError] = useState("");
	const [loading, setLoading] = useState(false);
	const [success, setSuccess] = useState(false);

	const handleSubmit = async (e: React.FormEvent) => {
		e.preventDefault();
		setError("");

		if (password !== confirmPassword) {
			setError("Passwords do not match");
			return;
		}

		if (password.length < 8) {
			setError("Password must be at least 8 characters");
			return;
		}

		setLoading(true);

		try {
			await authApi.signup({
				email,
				password,
				displayName: displayName || undefined,
			});

			setSuccess(true);

			// Redirect to login after 2 seconds
			setTimeout(() => {
				navigate("/login");
			}, 2000);
		} catch (err) {
			setError(err instanceof Error ? err.message : "Signup failed");
		} finally {
			setLoading(false);
		}
	};

	if (success) {
		return (
			<div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4">
				<div className="max-w-md w-full text-center">
					<div className="rounded-md bg-green-50 p-6">
						<h2 className="text-lg font-medium text-green-800">
							Account created successfully!
						</h2>
						<p className="mt-2 text-sm text-green-700">
							Please check your email to verify your account.
							Redirecting to login...
						</p>
					</div>
				</div>
			</div>
		);
	}

	return (
		<div className="min-h-screen flex items-center justify-center bg-gray-50 py-12 px-4 sm:px-6 lg:px-8">
			<div className="max-w-md w-full space-y-8">
				<div>
					<h1 className="text-center text-3xl font-bold text-gray-900">
						Moltbot
					</h1>
					<h2 className="mt-6 text-center text-2xl font-semibold text-gray-900">
						Create your account
					</h2>
					<p className="mt-2 text-center text-sm text-gray-600">
						Already have an account?{" "}
						<Link
							to="/login"
							className="font-medium text-primary-600 hover:text-primary-500"
						>
							Sign in
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
								htmlFor="displayName"
								className="block text-sm font-medium text-gray-700"
							>
								Display name (optional)
							</label>
							<input
								id="displayName"
								name="displayName"
								type="text"
								autoComplete="name"
								value={displayName}
								onChange={(e) => setDisplayName(e.target.value)}
								className="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500"
								placeholder="Your name"
							/>
						</div>

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
								autoComplete="new-password"
								required
								value={password}
								onChange={(e) => setPassword(e.target.value)}
								className="mt-1 appearance-none block w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm placeholder-gray-400 focus:outline-none focus:ring-primary-500 focus:border-primary-500"
								placeholder="••••••••"
							/>
							<p className="mt-1 text-xs text-gray-500">
								At least 8 characters with uppercase, lowercase, and numbers
							</p>
						</div>

						<div>
							<label
								htmlFor="confirmPassword"
								className="block text-sm font-medium text-gray-700"
							>
								Confirm password
							</label>
							<input
								id="confirmPassword"
								name="confirmPassword"
								type="password"
								autoComplete="new-password"
								required
								value={confirmPassword}
								onChange={(e) => setConfirmPassword(e.target.value)}
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
							{loading ? "Creating account..." : "Create account"}
						</button>
					</div>

					<p className="text-xs text-center text-gray-500">
						By signing up, you agree to our Terms of Service and Privacy Policy
					</p>
				</form>
			</div>
		</div>
	);
}
