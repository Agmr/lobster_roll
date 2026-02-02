import { useState, useRef, useEffect } from "react";

interface ChatInputProps {
	onSend: (content: string) => void;
	disabled?: boolean;
}

export function ChatInput({ onSend, disabled }: ChatInputProps) {
	const [message, setMessage] = useState("");
	const textareaRef = useRef<HTMLTextAreaElement>(null);

	// Auto-resize textarea
	useEffect(() => {
		const textarea = textareaRef.current;
		if (textarea) {
			textarea.style.height = "auto";
			textarea.style.height = `${Math.min(textarea.scrollHeight, 200)}px`;
		}
	}, [message]);

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		if (message.trim() && !disabled) {
			onSend(message.trim());
			setMessage("");
		}
	};

	const handleKeyDown = (e: React.KeyboardEvent) => {
		if (e.key === "Enter" && !e.shiftKey) {
			e.preventDefault();
			handleSubmit(e);
		}
	};

	return (
		<div className="bg-white border-t border-gray-200 px-6 py-4">
			<form
				onSubmit={handleSubmit}
				className="max-w-4xl mx-auto flex items-end gap-4"
			>
				<div className="flex-1 relative">
					<textarea
						ref={textareaRef}
						value={message}
						onChange={(e) => setMessage(e.target.value)}
						onKeyDown={handleKeyDown}
						placeholder={disabled ? "Connecting..." : "Type a message..."}
						disabled={disabled}
						rows={1}
						className="w-full resize-none rounded-lg border border-gray-300 px-4 py-3 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:border-transparent disabled:bg-gray-100 disabled:cursor-not-allowed"
					/>
				</div>

				<button
					type="submit"
					disabled={disabled || !message.trim()}
					className="px-6 py-3 bg-primary-600 text-white rounded-lg hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-primary-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						viewBox="0 0 24 24"
						fill="currentColor"
						className="w-5 h-5"
					>
						<path d="M3.478 2.404a.75.75 0 0 0-.926.941l2.432 7.905H13.5a.75.75 0 0 1 0 1.5H4.984l-2.432 7.905a.75.75 0 0 0 .926.94 60.519 60.519 0 0 0 18.445-8.986.75.75 0 0 0 0-1.218A60.517 60.517 0 0 0 3.478 2.404Z" />
					</svg>
				</button>
			</form>

			<p className="text-xs text-gray-400 text-center mt-2">
				Press Enter to send, Shift+Enter for new line
			</p>
		</div>
	);
}
