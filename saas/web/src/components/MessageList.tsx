import { useEffect, useRef } from "react";
import { useChatStore, type Message } from "../stores/chat";

function MessageBubble({ message }: { message: Message }) {
	const isUser = message.role === "user";

	return (
		<div
			className={`flex ${isUser ? "justify-end" : "justify-start"} message-enter`}
		>
			<div
				className={`max-w-[70%] rounded-lg px-4 py-2 ${
					isUser
						? "bg-primary-600 text-white"
						: "bg-white text-gray-900 border border-gray-200"
				}`}
			>
				<p className="whitespace-pre-wrap break-words">{message.content}</p>
				<div
					className={`text-xs mt-1 ${
						isUser ? "text-primary-200" : "text-gray-400"
					}`}
				>
					{message.timestamp.toLocaleTimeString([], {
						hour: "2-digit",
						minute: "2-digit",
					})}
					{message.status === "sending" && " · Sending..."}
					{message.status === "error" && " · Failed"}
				</div>
			</div>
		</div>
	);
}

function TypingIndicator() {
	return (
		<div className="flex justify-start">
			<div className="bg-white text-gray-900 border border-gray-200 rounded-lg px-4 py-3">
				<div className="flex space-x-1">
					<div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
					<div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
					<div className="w-2 h-2 bg-gray-400 rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
				</div>
			</div>
		</div>
	);
}

export function MessageList() {
	const { messages, isTyping } = useChatStore();
	const bottomRef = useRef<HTMLDivElement>(null);

	// Auto-scroll to bottom on new messages
	useEffect(() => {
		bottomRef.current?.scrollIntoView({ behavior: "smooth" });
	}, [messages, isTyping]);

	if (messages.length === 0 && !isTyping) {
		return (
			<div className="flex-1 flex items-center justify-center bg-gray-50">
				<div className="text-center">
					<h2 className="text-xl font-semibold text-gray-700">
						Welcome to Moltbot
					</h2>
					<p className="mt-2 text-gray-500">
						Start a conversation by typing a message below
					</p>
				</div>
			</div>
		);
	}

	return (
		<div className="flex-1 overflow-y-auto bg-gray-50 px-6 py-4">
			<div className="space-y-4 max-w-4xl mx-auto">
				{messages.map((message) => (
					<MessageBubble key={message.id} message={message} />
				))}
				{isTyping && <TypingIndicator />}
				<div ref={bottomRef} />
			</div>
		</div>
	);
}
