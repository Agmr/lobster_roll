import { Routes, Route, Navigate } from "react-router-dom";
import { useAuthStore } from "./stores/auth";
import { LoginPage } from "./pages/Login";
import { SignupPage } from "./pages/Signup";
import { ChatPage } from "./pages/Chat";
import { useEffect } from "react";

function ProtectedRoute({ children }: { children: React.ReactNode }) {
	const { isAuthenticated, isLoading } = useAuthStore();

	if (isLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
			</div>
		);
	}

	if (!isAuthenticated) {
		return <Navigate to="/login" replace />;
	}

	return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
	const { isAuthenticated, isLoading } = useAuthStore();

	if (isLoading) {
		return (
			<div className="min-h-screen flex items-center justify-center">
				<div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-600" />
			</div>
		);
	}

	if (isAuthenticated) {
		return <Navigate to="/chat" replace />;
	}

	return <>{children}</>;
}

export function App() {
	const setLoading = useAuthStore((state) => state.setLoading);

	// Check auth state on mount
	useEffect(() => {
		// Give hydration a moment to complete
		const timer = setTimeout(() => {
			setLoading(false);
		}, 100);

		return () => clearTimeout(timer);
	}, [setLoading]);

	return (
		<Routes>
			<Route
				path="/login"
				element={
					<PublicRoute>
						<LoginPage />
					</PublicRoute>
				}
			/>
			<Route
				path="/signup"
				element={
					<PublicRoute>
						<SignupPage />
					</PublicRoute>
				}
			/>
			<Route
				path="/chat"
				element={
					<ProtectedRoute>
						<ChatPage />
					</ProtectedRoute>
				}
			/>
			<Route path="/" element={<Navigate to="/chat" replace />} />
			<Route path="*" element={<Navigate to="/chat" replace />} />
		</Routes>
	);
}
