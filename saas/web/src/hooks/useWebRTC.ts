import { useState, useEffect, useRef, useCallback } from "react";
import { useAuthStore } from "../stores/auth";

interface Participant {
	id: string;
	stream?: MediaStream;
}

interface UseWebRTCOptions {
	roomId: string;
	onParticipantJoined?: (participantId: string) => void;
	onParticipantLeft?: (participantId: string) => void;
	onError?: (error: string) => void;
}

interface UseWebRTCReturn {
	isConnected: boolean;
	isConnecting: boolean;
	localStream: MediaStream | null;
	participants: Map<string, Participant>;
	join: () => Promise<void>;
	leave: () => void;
	toggleAudio: () => void;
	toggleVideo: () => void;
	isAudioEnabled: boolean;
	isVideoEnabled: boolean;
}

const ICE_SERVERS: RTCConfiguration = {
	iceServers: [
		{ urls: "stun:stun.l.google.com:19302" },
		{ urls: "stun:stun1.l.google.com:19302" },
	],
};

export function useWebRTC({
	roomId,
	onParticipantJoined,
	onParticipantLeft,
	onError,
}: UseWebRTCOptions): UseWebRTCReturn {
	const { token } = useAuthStore();
	const [isConnected, setIsConnected] = useState(false);
	const [isConnecting, setIsConnecting] = useState(false);
	const [localStream, setLocalStream] = useState<MediaStream | null>(null);
	const [participants, setParticipants] = useState<Map<string, Participant>>(
		new Map()
	);
	const [isAudioEnabled, setIsAudioEnabled] = useState(true);
	const [isVideoEnabled, setIsVideoEnabled] = useState(false);

	const wsRef = useRef<WebSocket | null>(null);
	const peerConnectionsRef = useRef<Map<string, RTCPeerConnection>>(new Map());
	const localStreamRef = useRef<MediaStream | null>(null);

	// Send signaling message
	const sendMessage = useCallback(
		(message: Record<string, unknown>) => {
			if (wsRef.current?.readyState === WebSocket.OPEN) {
				wsRef.current.send(JSON.stringify({ ...message, roomId }));
			}
		},
		[roomId]
	);

	// Create peer connection for a participant
	const createPeerConnection = useCallback(
		(participantId: string): RTCPeerConnection => {
			const pc = new RTCPeerConnection(ICE_SERVERS);

			// Add local tracks
			if (localStreamRef.current) {
				localStreamRef.current.getTracks().forEach((track) => {
					pc.addTrack(track, localStreamRef.current!);
				});
			}

			// Handle ICE candidates
			pc.onicecandidate = (event) => {
				if (event.candidate) {
					sendMessage({
						type: "ice-candidate",
						targetId: participantId,
						payload: event.candidate,
					});
				}
			};

			// Handle remote tracks
			pc.ontrack = (event) => {
				setParticipants((prev) => {
					const updated = new Map(prev);
					const participant = updated.get(participantId) ?? { id: participantId };
					participant.stream = event.streams[0];
					updated.set(participantId, participant);
					return updated;
				});
			};

			// Handle connection state changes
			pc.onconnectionstatechange = () => {
				if (pc.connectionState === "failed") {
					onError?.(`Connection to ${participantId} failed`);
				}
			};

			peerConnectionsRef.current.set(participantId, pc);
			return pc;
		},
		[sendMessage, onError]
	);

	// Handle incoming signaling messages
	const handleSignalingMessage = useCallback(
		async (message: {
			type: string;
			senderId: string;
			payload?: unknown;
		}) => {
			const { type, senderId, payload } = message;

			switch (type) {
				case "join": {
					// New participant joined
					if (senderId !== "server") {
						onParticipantJoined?.(senderId);

						// Create offer for new participant
						const pc = createPeerConnection(senderId);
						const offer = await pc.createOffer();
						await pc.setLocalDescription(offer);

						sendMessage({
							type: "offer",
							targetId: senderId,
							payload: offer,
						});
					} else {
						// Server response with room info
						const info = payload as {
							participantId: string;
							participants: string[];
						};
						// Create peer connections for existing participants
						for (const participantId of info.participants) {
							createPeerConnection(participantId);
						}
					}
					break;
				}

				case "leave": {
					// Participant left
					const pc = peerConnectionsRef.current.get(senderId);
					if (pc) {
						pc.close();
						peerConnectionsRef.current.delete(senderId);
					}

					setParticipants((prev) => {
						const updated = new Map(prev);
						updated.delete(senderId);
						return updated;
					});

					onParticipantLeft?.(senderId);
					break;
				}

				case "offer": {
					// Received offer from another participant
					let pc = peerConnectionsRef.current.get(senderId);
					if (!pc) {
						pc = createPeerConnection(senderId);
					}

					await pc.setRemoteDescription(
						new RTCSessionDescription(payload as RTCSessionDescriptionInit)
					);
					const answer = await pc.createAnswer();
					await pc.setLocalDescription(answer);

					sendMessage({
						type: "answer",
						targetId: senderId,
						payload: answer,
					});
					break;
				}

				case "answer": {
					// Received answer from another participant
					const pc = peerConnectionsRef.current.get(senderId);
					if (pc) {
						await pc.setRemoteDescription(
							new RTCSessionDescription(payload as RTCSessionDescriptionInit)
						);
					}
					break;
				}

				case "ice-candidate": {
					// Received ICE candidate
					const pc = peerConnectionsRef.current.get(senderId);
					if (pc && payload) {
						await pc.addIceCandidate(
							new RTCIceCandidate(payload as RTCIceCandidateInit)
						);
					}
					break;
				}

				case "error": {
					const errorPayload = payload as { error: string };
					onError?.(errorPayload.error);
					break;
				}
			}
		},
		[createPeerConnection, sendMessage, onParticipantJoined, onParticipantLeft, onError]
	);

	// Join the room
	const join = useCallback(async () => {
		if (isConnected || isConnecting) return;

		setIsConnecting(true);

		try {
			// Get local media stream
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: true,
				video: isVideoEnabled,
			});

			localStreamRef.current = stream;
			setLocalStream(stream);

			// Connect to signaling server
			const wsProtocol = window.location.protocol === "https:" ? "wss:" : "ws:";
			const wsUrl = `${wsProtocol}//${window.location.host}/rtc?token=${token}`;

			const ws = new WebSocket(wsUrl);
			wsRef.current = ws;

			ws.onopen = () => {
				setIsConnected(true);
				setIsConnecting(false);

				// Join the room
				sendMessage({ type: "join" });
			};

			ws.onmessage = (event) => {
				try {
					const message = JSON.parse(event.data);
					handleSignalingMessage(message);
				} catch (error) {
					console.error("Failed to parse signaling message:", error);
				}
			};

			ws.onerror = () => {
				onError?.("WebSocket connection error");
			};

			ws.onclose = () => {
				setIsConnected(false);
				setIsConnecting(false);
			};
		} catch (error) {
			setIsConnecting(false);
			onError?.(
				error instanceof Error
					? error.message
					: "Failed to access media devices"
			);
		}
	}, [isConnected, isConnecting, isVideoEnabled, token, sendMessage, handleSignalingMessage, onError]);

	// Leave the room
	const leave = useCallback(() => {
		// Send leave message
		sendMessage({ type: "leave" });

		// Close WebSocket
		if (wsRef.current) {
			wsRef.current.close();
			wsRef.current = null;
		}

		// Close all peer connections
		for (const pc of peerConnectionsRef.current.values()) {
			pc.close();
		}
		peerConnectionsRef.current.clear();

		// Stop local stream
		if (localStreamRef.current) {
			localStreamRef.current.getTracks().forEach((track) => track.stop());
			localStreamRef.current = null;
		}

		setLocalStream(null);
		setParticipants(new Map());
		setIsConnected(false);
	}, [sendMessage]);

	// Toggle audio
	const toggleAudio = useCallback(() => {
		if (localStreamRef.current) {
			const audioTracks = localStreamRef.current.getAudioTracks();
			audioTracks.forEach((track) => {
				track.enabled = !track.enabled;
			});
			setIsAudioEnabled((prev) => !prev);
		}
	}, []);

	// Toggle video
	const toggleVideo = useCallback(async () => {
		if (localStreamRef.current) {
			const videoTracks = localStreamRef.current.getVideoTracks();

			if (videoTracks.length > 0) {
				// Disable existing video
				videoTracks.forEach((track) => {
					track.stop();
					localStreamRef.current?.removeTrack(track);
				});
				setIsVideoEnabled(false);
			} else {
				// Enable video
				try {
					const videoStream = await navigator.mediaDevices.getUserMedia({
						video: true,
					});
					const videoTrack = videoStream.getVideoTracks()[0];
					if (videoTrack) {
						localStreamRef.current.addTrack(videoTrack);

						// Add track to all peer connections
						for (const pc of peerConnectionsRef.current.values()) {
							pc.addTrack(videoTrack, localStreamRef.current);
						}

						setIsVideoEnabled(true);
					}
				} catch (error) {
					onError?.("Failed to access camera");
				}
			}
		}
	}, [onError]);

	// Cleanup on unmount
	useEffect(() => {
		return () => {
			leave();
		};
	}, [leave]);

	return {
		isConnected,
		isConnecting,
		localStream,
		participants,
		join,
		leave,
		toggleAudio,
		toggleVideo,
		isAudioEnabled,
		isVideoEnabled,
	};
}
