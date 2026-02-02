import { useState, useRef, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAuthStore } from "../stores/auth";
import { useChatStore } from "../stores/chat";
import { useWebSocket } from "../hooks/useWebSocket";
import { MessageList } from "../components/MessageList";
import { ChatInput } from "../components/ChatInput";
import { Sidebar } from "../components/Sidebar";
import { agentApi } from "../lib/api";

export function ChatPage() {
	const navigate = useNavigate();
	const { user, isAuthenticated, logout } = useAuthStore();
	const { isConnected, error } = useChatStore();
	const { sendMessage } = useWebSocket();

	const [agentStatus, setAgentStatus] = useState<string>("checking");
	const [provisioning, setProvisioning] = useState(false);

	// Check authentication
	useEffect(() => {
		if (!isAuthenticated) {
			navigate("/login");
		}
	}, [isAuthenticated, navigate]);

	// Check agent status
	useEffect(() => {
		const checkStatus = async () => {
			try {
				const status = await agentApi.status();
				setAgentStatus(status.status);

				if (status.status === "not_provisioned") {
					// Auto-provision for new users
					setProvisioning(true);
					await agentApi.provision();
					setAgentStatus("provisioning");

					// Poll for ready status
					const poll = setInterval(async () => {
						const newStatus = await agentApi.status();
						if (newStatus.status === "active" && newStatus.ready) {
							clearInterval(poll);
							setAgentStatus("active");
							setProvisioning(false);
						}
					}, 2000);
				} else if (status.status === "scaled_down") {
					// Wake up the agent
					await agentApi.wake();
					setAgentStatus("waking");
				}
			} catch (err) {
				console.error("Failed to check agent status:", err);
				setAgentStatus("error");
			}
		};

		checkStatus();
	}, []);

	const handleSend = (content: string) => {
		if (content.trim() && isConnected) {
			sendMessage(content);
		}
	};

	const handleLogout = async () => {
		logout();
		navigate("/login");
	};

	if (agentStatus !== "active") {
		return (
			<div className="min-h-screen flex items-center justify-center bg-gray-100">
				<div className="bg-white p-8 rounded-lg shadow-md max-w-md w-full text-center">
					{agentStatus === "checking" && (
						<>
							<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto" />
							<p className="mt-4 text-gray-600">Checking agent status...</p>
						</>
					)}

					{(agentStatus === "provisioning" || provisioning) && (
						<>
							<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto" />
							<h2 className="mt-4 text-lg font-semibold">Setting up your agent</h2>
							<p className="mt-2 text-gray-600">
								This may take a minute...
							</p>
						</>
					)}

					{agentStatus === "waking" && (
						<>
							<div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600 mx-auto" />
							<h2 className="mt-4 text-lg font-semibold">Waking up your agent</h2>
							<p className="mt-2 text-gray-600">
								Your agent was sleeping to save resources...
							</p>
						</>
					)}

					{agentStatus === "error" && (
						<>
							<div className="text-red-500 text-4xl mb-4">⚠️</div>
							<h2 className="text-lg font-semibold text-red-600">
								Something went wrong
							</h2>
							<p className="mt-2 text-gray-600">
								Failed to start your agent. Please try again.
							</p>
							<button
								onClick={() => window.location.reload()}
								className="mt-4 px-4 py-2 bg-primary-600 text-white rounded-md hover:bg-primary-700"
							>
								Retry
							</button>
						</>
					)}
				</div>
			</div>
		);
	}

	return (
		<div className="flex h-screen bg-gray-100">
			{/* Sidebar */}
			<Sidebar user={user} onLogout={handleLogout} />

			{/* Main chat area */}
			<div className="flex-1 flex flex-col">
				{/* Header */}
				<header className="bg-white border-b border-gray-200 px-6 py-4 flex items-center justify-between">
					<div>
						<h1 className="text-xl font-semibold text-gray-900">Chat</h1>
						<p className="text-sm text-gray-500">
							{isConnected ? (
								<span className="text-green-600">● Connected</span>
							) : (
								<span className="text-yellow-600">● Connecting...</span>
							)}
						</p>
					</div>
				</header>

				{/* Error banner */}
				{error && (
					<div className="bg-red-50 border-b border-red-200 px-6 py-3">
						<p className="text-sm text-red-700">{error}</p>
					</div>
				)}

				{/* Messages */}
				<MessageList />

				{/* Input */}
				<ChatInput onSend={handleSend} disabled={!isConnected} />
			</div>
		</div>
	);
}
