import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage, Server } from "node:http";
import { verifyAccessToken } from "../auth/jwt.js";

/**
 * WebRTC signaling message types
 */
export type SignalingMessageType =
	| "offer"
	| "answer"
	| "ice-candidate"
	| "join"
	| "leave"
	| "error";

export interface SignalingMessage {
	type: SignalingMessageType;
	roomId: string;
	senderId: string;
	targetId?: string;
	payload?: unknown;
}

export interface RoomParticipant {
	id: string;
	socket: WebSocket;
	userId: string;
	tenantId: string;
	joinedAt: Date;
}

export interface Room {
	id: string;
	tenantId: string;
	participants: Map<string, RoomParticipant>;
	createdAt: Date;
	maxParticipants: number;
}

/**
 * WebRTC Signaling Server
 * Handles peer-to-peer connection negotiation for voice/video calls
 */
export class WebRTCSignalingServer {
	private wss: WebSocketServer;
	private rooms: Map<string, Room> = new Map();
	private participantToRoom: Map<string, string> = new Map();

	constructor(
		server: Server,
		private path: string = "/rtc"
	) {
		this.wss = new WebSocketServer({ server, path });
		this.setupEventHandlers();
	}

	private setupEventHandlers(): void {
		this.wss.on("connection", async (socket, request) => {
			try {
				const participant = await this.authenticateConnection(socket, request);
				if (!participant) {
					socket.close(4001, "Unauthorized");
					return;
				}

				this.handleParticipantConnection(participant);
			} catch (error) {
				console.error("WebRTC connection error:", error);
				socket.close(4000, "Connection error");
			}
		});
	}

	private async authenticateConnection(
		socket: WebSocket,
		request: IncomingMessage
	): Promise<Omit<RoomParticipant, "socket"> | null> {
		const url = new URL(request.url ?? "", `http://${request.headers.host}`);
		const token = url.searchParams.get("token");

		if (!token) {
			return null;
		}

		try {
			const payload = await verifyAccessToken(token);

			return {
				id: crypto.randomUUID(),
				userId: payload.sub,
				tenantId: payload.tenantId ?? payload.sub,
				joinedAt: new Date(),
			};
		} catch {
			return null;
		}
	}

	private handleParticipantConnection(
		participantInfo: Omit<RoomParticipant, "socket">
	): void {
		// Find the socket from the last connection
		const sockets = Array.from(this.wss.clients);
		const socket = sockets[sockets.length - 1] as WebSocket;

		const participant: RoomParticipant = {
			...participantInfo,
			socket,
		};

		socket.on("message", (data) => {
			try {
				const message = JSON.parse(data.toString()) as SignalingMessage;
				this.handleMessage(participant, message);
			} catch (error) {
				this.sendError(socket, "Invalid message format");
			}
		});

		socket.on("close", () => {
			this.handleParticipantDisconnect(participant);
		});

		socket.on("error", (error) => {
			console.error(`WebRTC socket error for ${participant.id}:`, error);
		});
	}

	private handleMessage(
		participant: RoomParticipant,
		message: SignalingMessage
	): void {
		switch (message.type) {
			case "join":
				this.handleJoin(participant, message.roomId);
				break;
			case "leave":
				this.handleLeave(participant);
				break;
			case "offer":
			case "answer":
			case "ice-candidate":
				this.relayMessage(participant, message);
				break;
			default:
				this.sendError(participant.socket, `Unknown message type: ${message.type}`);
		}
	}

	private handleJoin(participant: RoomParticipant, roomId: string): void {
		// Check if already in a room
		const currentRoomId = this.participantToRoom.get(participant.id);
		if (currentRoomId) {
			this.handleLeave(participant);
		}

		// Get or create room
		let room = this.rooms.get(roomId);
		if (!room) {
			room = {
				id: roomId,
				tenantId: participant.tenantId,
				participants: new Map(),
				createdAt: new Date(),
				maxParticipants: 10,
			};
			this.rooms.set(roomId, room);
		}

		// Verify tenant isolation
		if (room.tenantId !== participant.tenantId) {
			this.sendError(participant.socket, "Access denied to this room");
			return;
		}

		// Check room capacity
		if (room.participants.size >= room.maxParticipants) {
			this.sendError(participant.socket, "Room is full");
			return;
		}

		// Notify existing participants
		for (const [, existingParticipant] of room.participants) {
			this.sendMessage(existingParticipant.socket, {
				type: "join",
				roomId,
				senderId: participant.id,
				payload: {
					userId: participant.userId,
					participantCount: room.participants.size + 1,
				},
			});
		}

		// Add to room
		room.participants.set(participant.id, participant);
		this.participantToRoom.set(participant.id, roomId);

		// Send room info to new participant
		this.sendMessage(participant.socket, {
			type: "join",
			roomId,
			senderId: "server",
			payload: {
				participantId: participant.id,
				participants: Array.from(room.participants.keys()).filter(
					(id) => id !== participant.id
				),
				participantCount: room.participants.size,
			},
		});
	}

	private handleLeave(participant: RoomParticipant): void {
		const roomId = this.participantToRoom.get(participant.id);
		if (!roomId) return;

		const room = this.rooms.get(roomId);
		if (!room) return;

		room.participants.delete(participant.id);
		this.participantToRoom.delete(participant.id);

		// Notify remaining participants
		for (const [, remainingParticipant] of room.participants) {
			this.sendMessage(remainingParticipant.socket, {
				type: "leave",
				roomId,
				senderId: participant.id,
				payload: {
					participantCount: room.participants.size,
				},
			});
		}

		// Clean up empty rooms
		if (room.participants.size === 0) {
			this.rooms.delete(roomId);
		}
	}

	private handleParticipantDisconnect(participant: RoomParticipant): void {
		this.handleLeave(participant);
	}

	private relayMessage(
		sender: RoomParticipant,
		message: SignalingMessage
	): void {
		const roomId = this.participantToRoom.get(sender.id);
		if (!roomId || roomId !== message.roomId) {
			this.sendError(sender.socket, "Not in the specified room");
			return;
		}

		const room = this.rooms.get(roomId);
		if (!room) return;

		// If targetId specified, send only to that participant
		if (message.targetId) {
			const target = room.participants.get(message.targetId);
			if (target) {
				this.sendMessage(target.socket, {
					...message,
					senderId: sender.id,
				});
			}
		} else {
			// Broadcast to all other participants
			for (const [id, participant] of room.participants) {
				if (id !== sender.id) {
					this.sendMessage(participant.socket, {
						...message,
						senderId: sender.id,
					});
				}
			}
		}
	}

	private sendMessage(socket: WebSocket, message: SignalingMessage): void {
		if (socket.readyState === WebSocket.OPEN) {
			socket.send(JSON.stringify(message));
		}
	}

	private sendError(socket: WebSocket, error: string): void {
		this.sendMessage(socket, {
			type: "error",
			roomId: "",
			senderId: "server",
			payload: { error },
		});
	}

	/**
	 * Get room statistics
	 */
	getStats(): {
		totalRooms: number;
		totalParticipants: number;
		roomStats: Array<{ roomId: string; participants: number }>;
	} {
		const roomStats = Array.from(this.rooms.entries()).map(([id, room]) => ({
			roomId: id,
			participants: room.participants.size,
		}));

		return {
			totalRooms: this.rooms.size,
			totalParticipants: this.participantToRoom.size,
			roomStats,
		};
	}

	/**
	 * Close all connections and cleanup
	 */
	close(): void {
		for (const client of this.wss.clients) {
			client.close(1001, "Server shutting down");
		}
		this.wss.close();
		this.rooms.clear();
		this.participantToRoom.clear();
	}
}

/**
 * Create a WebRTC signaling server
 */
export function createWebRTCSignalingServer(
	server: Server,
	path?: string
): WebRTCSignalingServer {
	return new WebRTCSignalingServer(server, path);
}
