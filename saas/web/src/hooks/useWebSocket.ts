import { useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "../stores/auth";
import { useChatStore } from "../stores/chat";

const WS_URL = `${window.location.protocol === "https:" ? "wss:" : "ws:"}//${window.location.host}/ws`;

interface GatewayMessage {
	type: string;
	payload?: unknown;
	id?: string;
}

export function useWebSocket() {
	const wsRef = useRef<WebSocket | null>(null);
	const reconnectTimeoutRef = useRef<NodeJS.Timeout | null>(null);
	const reconnectAttempts = useRef(0);

	const accessToken = useAuthStore((state) => state.accessToken);
	const { addMessage, updateMessage, setConnected, setTyping, setError } =
		useChatStore();

	const connect = useCallback(() => {
		if (!accessToken) return;

		// Close existing connection
		if (wsRef.current) {
			wsRef.current.close();
		}

		const ws = new WebSocket(`${WS_URL}?token=${accessToken}`);

		ws.onopen = () => {
			console.log("WebSocket connected");
			setConnected(true);
			setError(null);
			reconnectAttempts.current = 0;
		};

		ws.onclose = (event) => {
			console.log("WebSocket closed:", event.code, event.reason);
			setConnected(false);

			// Attempt to reconnect with exponential backoff
			if (reconnectAttempts.current < 5) {
				const delay = Math.min(1000 * Math.pow(2, reconnectAttempts.current), 30000);
				reconnectTimeoutRef.current = setTimeout(() => {
					reconnectAttempts.current++;
					connect();
				}, delay);
			} else {
				setError("Connection lost. Please refresh the page.");
			}
		};

		ws.onerror = (error) => {
			console.error("WebSocket error:", error);
			setError("Connection error");
		};

		ws.onmessage = (event) => {
			try {
				const message: GatewayMessage = JSON.parse(event.data);
				handleMessage(message);
			} catch (error) {
				console.error("Failed to parse WebSocket message:", error);
			}
		};

		wsRef.current = ws;
	}, [accessToken, setConnected, setError]);

	const handleMessage = useCallback(
		(message: GatewayMessage) => {
			switch (message.type) {
				case "message":
					addMessage({
						id: message.id || crypto.randomUUID(),
						role: "assistant",
						content: (message.payload as { content: string }).content,
						timestamp: new Date(),
						status: "sent",
					});
					setTyping(false);
					break;

				case "typing":
					setTyping(true);
					break;

				case "typing_end":
					setTyping(false);
					break;

				case "error":
					setError((message.payload as { message: string }).message);
					break;

				case "message_sent":
					if (message.id) {
						updateMessage(message.id, { status: "sent" });
					}
					break;

				default:
					console.log("Unknown message type:", message.type);
			}
		},
		[addMessage, updateMessage, setTyping, setError]
	);

	const sendMessage = useCallback((content: string) => {
		if (!wsRef.current || wsRef.current.readyState !== WebSocket.OPEN) {
			setError("Not connected");
			return null;
		}

		const id = crypto.randomUUID();

		// Add message to store immediately
		addMessage({
			id,
			role: "user",
			content,
			timestamp: new Date(),
			status: "sending",
		});

		// Send via WebSocket
		wsRef.current.send(
			JSON.stringify({
				type: "message",
				id,
				payload: { content },
			})
		);

		return id;
	}, [addMessage, setError]);

	const disconnect = useCallback(() => {
		if (reconnectTimeoutRef.current) {
			clearTimeout(reconnectTimeoutRef.current);
		}
		if (wsRef.current) {
			wsRef.current.close();
			wsRef.current = null;
		}
		setConnected(false);
	}, [setConnected]);

	// Connect when token is available
	useEffect(() => {
		if (accessToken) {
			connect();
		}

		return () => {
			disconnect();
		};
	}, [accessToken, connect, disconnect]);

	return {
		sendMessage,
		disconnect,
		reconnect: connect,
	};
}
