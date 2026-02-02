import { create } from "zustand";

export interface Message {
	id: string;
	role: "user" | "assistant" | "system";
	content: string;
	timestamp: Date;
	status?: "sending" | "sent" | "error";
}

interface ChatState {
	messages: Message[];
	isConnected: boolean;
	isTyping: boolean;
	error: string | null;

	// Actions
	addMessage: (message: Message) => void;
	updateMessage: (id: string, updates: Partial<Message>) => void;
	setConnected: (connected: boolean) => void;
	setTyping: (typing: boolean) => void;
	setError: (error: string | null) => void;
	clearMessages: () => void;
}

export const useChatStore = create<ChatState>((set) => ({
	messages: [],
	isConnected: false,
	isTyping: false,
	error: null,

	addMessage: (message) =>
		set((state) => ({
			messages: [...state.messages, message],
		})),

	updateMessage: (id, updates) =>
		set((state) => ({
			messages: state.messages.map((msg) =>
				msg.id === id ? { ...msg, ...updates } : msg
			),
		})),

	setConnected: (connected) => set({ isConnected: connected }),

	setTyping: (typing) => set({ isTyping: typing }),

	setError: (error) => set({ error }),

	clearMessages: () => set({ messages: [] }),
}));
