import { useState, useRef, useCallback } from "react";
import { useAuthStore } from "../stores/auth";

interface VoiceInputProps {
	onTranscription: (text: string) => void;
	onError?: (error: string) => void;
	disabled?: boolean;
}

type RecordingState = "idle" | "recording" | "processing";

export function VoiceInput({
	onTranscription,
	onError,
	disabled = false,
}: VoiceInputProps) {
	const [recordingState, setRecordingState] = useState<RecordingState>("idle");
	const [duration, setDuration] = useState(0);
	const mediaRecorderRef = useRef<MediaRecorder | null>(null);
	const chunksRef = useRef<Blob[]>([]);
	const timerRef = useRef<NodeJS.Timeout | null>(null);
	const { token } = useAuthStore();

	const startRecording = useCallback(async () => {
		try {
			const stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					echoCancellation: true,
					noiseSuppression: true,
					sampleRate: 16000,
				},
			});

			const mediaRecorder = new MediaRecorder(stream, {
				mimeType: "audio/webm;codecs=opus",
			});

			chunksRef.current = [];

			mediaRecorder.ondataavailable = (event) => {
				if (event.data.size > 0) {
					chunksRef.current.push(event.data);
				}
			};

			mediaRecorder.onstop = async () => {
				// Stop all tracks
				stream.getTracks().forEach((track) => track.stop());

				// Clear timer
				if (timerRef.current) {
					clearInterval(timerRef.current);
					timerRef.current = null;
				}

				// Process audio
				setRecordingState("processing");

				try {
					const audioBlob = new Blob(chunksRef.current, {
						type: "audio/webm",
					});

					// Send to transcription API
					const formData = new FormData();
					formData.append("file", audioBlob, "recording.webm");

					const response = await fetch("/api/media/transcribe", {
						method: "POST",
						headers: {
							Authorization: `Bearer ${token}`,
						},
						body: formData,
					});

					if (!response.ok) {
						const error = await response.json();
						throw new Error(error.error || "Transcription failed");
					}

					const result = await response.json();
					onTranscription(result.transcription.text);
				} catch (error) {
					onError?.(
						error instanceof Error ? error.message : "Transcription failed"
					);
				} finally {
					setRecordingState("idle");
					setDuration(0);
				}
			};

			mediaRecorderRef.current = mediaRecorder;
			mediaRecorder.start(100); // Collect data every 100ms

			setRecordingState("recording");
			setDuration(0);

			// Start duration timer
			timerRef.current = setInterval(() => {
				setDuration((d) => d + 1);
			}, 1000);
		} catch (error) {
			onError?.(
				error instanceof Error
					? error.message
					: "Failed to access microphone"
			);
		}
	}, [token, onTranscription, onError]);

	const stopRecording = useCallback(() => {
		if (mediaRecorderRef.current && recordingState === "recording") {
			mediaRecorderRef.current.stop();
		}
	}, [recordingState]);

	const formatDuration = (seconds: number): string => {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, "0")}`;
	};

	return (
		<div className="flex items-center gap-2">
			{recordingState === "idle" && (
				<button
					type="button"
					onClick={startRecording}
					disabled={disabled}
					className="p-2 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
					title="Start voice recording"
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="h-5 w-5 text-gray-600"
						viewBox="0 0 24 24"
						fill="currentColor"
					>
						<path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
						<path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
					</svg>
				</button>
			)}

			{recordingState === "recording" && (
				<div className="flex items-center gap-2">
					<div className="flex items-center gap-1">
						<span className="w-2 h-2 bg-red-500 rounded-full animate-pulse" />
						<span className="text-sm text-gray-600 font-mono">
							{formatDuration(duration)}
						</span>
					</div>
					<button
						type="button"
						onClick={stopRecording}
						className="p-2 rounded-full bg-red-100 hover:bg-red-200 transition-colors"
						title="Stop recording"
					>
						<svg
							xmlns="http://www.w3.org/2000/svg"
							className="h-5 w-5 text-red-600"
							viewBox="0 0 24 24"
							fill="currentColor"
						>
							<rect x="6" y="6" width="12" height="12" rx="2" />
						</svg>
					</button>
				</div>
			)}

			{recordingState === "processing" && (
				<div className="flex items-center gap-2 text-sm text-gray-600">
					<svg
						className="animate-spin h-4 w-4"
						xmlns="http://www.w3.org/2000/svg"
						fill="none"
						viewBox="0 0 24 24"
					>
						<circle
							className="opacity-25"
							cx="12"
							cy="12"
							r="10"
							stroke="currentColor"
							strokeWidth="4"
						/>
						<path
							className="opacity-75"
							fill="currentColor"
							d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
						/>
					</svg>
					<span>Transcribing...</span>
				</div>
			)}
		</div>
	);
}
