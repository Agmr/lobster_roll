import { useState, useRef, useCallback } from "react";
import { useAuthStore } from "../stores/auth";

interface FileUploadProps {
	onUploadComplete: (file: UploadedFile) => void;
	onError?: (error: string) => void;
	accept?: string;
	maxSizeMB?: number;
	disabled?: boolean;
}

export interface UploadedFile {
	id: string;
	originalName: string;
	mimeType: string;
	mediaType: string;
	size: number;
}

export function FileUpload({
	onUploadComplete,
	onError,
	accept = "image/*,audio/*,video/*,.pdf,.txt,.json",
	maxSizeMB = 50,
	disabled = false,
}: FileUploadProps) {
	const [uploading, setUploading] = useState(false);
	const [progress, setProgress] = useState(0);
	const [dragOver, setDragOver] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const { token } = useAuthStore();

	const uploadFile = useCallback(
		async (file: File) => {
			// Validate file size
			const maxBytes = maxSizeMB * 1024 * 1024;
			if (file.size > maxBytes) {
				onError?.(`File too large. Maximum size is ${maxSizeMB}MB`);
				return;
			}

			setUploading(true);
			setProgress(0);

			try {
				const formData = new FormData();
				formData.append("file", file);

				// Use XMLHttpRequest for progress tracking
				const xhr = new XMLHttpRequest();

				const uploadPromise = new Promise<UploadedFile>((resolve, reject) => {
					xhr.upload.onprogress = (event) => {
						if (event.lengthComputable) {
							const percent = Math.round((event.loaded / event.total) * 100);
							setProgress(percent);
						}
					};

					xhr.onload = () => {
						if (xhr.status >= 200 && xhr.status < 300) {
							const response = JSON.parse(xhr.responseText);
							if (response.success) {
								resolve(response.file);
							} else {
								reject(new Error(response.error || "Upload failed"));
							}
						} else {
							try {
								const error = JSON.parse(xhr.responseText);
								reject(new Error(error.error || "Upload failed"));
							} catch {
								reject(new Error("Upload failed"));
							}
						}
					};

					xhr.onerror = () => reject(new Error("Network error"));
					xhr.onabort = () => reject(new Error("Upload cancelled"));
				});

				xhr.open("POST", "/api/media/upload");
				xhr.setRequestHeader("Authorization", `Bearer ${token}`);
				xhr.send(formData);

				const result = await uploadPromise;
				onUploadComplete(result);
			} catch (error) {
				onError?.(error instanceof Error ? error.message : "Upload failed");
			} finally {
				setUploading(false);
				setProgress(0);
			}
		},
		[token, maxSizeMB, onUploadComplete, onError]
	);

	const handleFileSelect = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			if (file) {
				uploadFile(file);
			}
			// Reset input
			event.target.value = "";
		},
		[uploadFile]
	);

	const handleDrop = useCallback(
		(event: React.DragEvent) => {
			event.preventDefault();
			setDragOver(false);

			const file = event.dataTransfer.files?.[0];
			if (file) {
				uploadFile(file);
			}
		},
		[uploadFile]
	);

	const handleDragOver = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		setDragOver(true);
	}, []);

	const handleDragLeave = useCallback((event: React.DragEvent) => {
		event.preventDefault();
		setDragOver(false);
	}, []);

	return (
		<div className="relative">
			<input
				ref={inputRef}
				type="file"
				accept={accept}
				onChange={handleFileSelect}
				disabled={disabled || uploading}
				className="hidden"
			/>

			{uploading ? (
				<div className="flex items-center gap-2">
					<div className="flex-1 h-2 bg-gray-200 rounded-full overflow-hidden">
						<div
							className="h-full bg-blue-500 transition-all duration-300"
							style={{ width: `${progress}%` }}
						/>
					</div>
					<span className="text-sm text-gray-600">{progress}%</span>
				</div>
			) : (
				<div
					onDrop={handleDrop}
					onDragOver={handleDragOver}
					onDragLeave={handleDragLeave}
					onClick={() => inputRef.current?.click()}
					className={`
						flex items-center justify-center gap-2 p-2 rounded-lg border-2 border-dashed
						cursor-pointer transition-colors
						${dragOver
							? "border-blue-400 bg-blue-50"
							: "border-gray-300 hover:border-gray-400 hover:bg-gray-50"
						}
						${disabled ? "opacity-50 cursor-not-allowed" : ""}
					`}
				>
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="h-5 w-5 text-gray-500"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4" />
						<polyline points="17 8 12 3 7 8" />
						<line x1="12" y1="3" x2="12" y2="15" />
					</svg>
					<span className="text-sm text-gray-600">
						{dragOver ? "Drop file here" : "Upload file"}
					</span>
				</div>
			)}
		</div>
	);
}

/**
 * Compact button variant for inline use
 */
export function FileUploadButton({
	onUploadComplete,
	onError,
	accept,
	maxSizeMB,
	disabled,
}: FileUploadProps) {
	const [uploading, setUploading] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const { token } = useAuthStore();

	const uploadFile = useCallback(
		async (file: File) => {
			const maxBytes = (maxSizeMB ?? 50) * 1024 * 1024;
			if (file.size > maxBytes) {
				onError?.(`File too large. Maximum size is ${maxSizeMB}MB`);
				return;
			}

			setUploading(true);

			try {
				const formData = new FormData();
				formData.append("file", file);

				const response = await fetch("/api/media/upload", {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
					},
					body: formData,
				});

				if (!response.ok) {
					const error = await response.json();
					throw new Error(error.error || "Upload failed");
				}

				const result = await response.json();
				onUploadComplete(result.file);
			} catch (error) {
				onError?.(error instanceof Error ? error.message : "Upload failed");
			} finally {
				setUploading(false);
			}
		},
		[token, maxSizeMB, onUploadComplete, onError]
	);

	const handleFileSelect = useCallback(
		(event: React.ChangeEvent<HTMLInputElement>) => {
			const file = event.target.files?.[0];
			if (file) {
				uploadFile(file);
			}
			event.target.value = "";
		},
		[uploadFile]
	);

	return (
		<>
			<input
				ref={inputRef}
				type="file"
				accept={accept ?? "image/*,audio/*,video/*,.pdf,.txt,.json"}
				onChange={handleFileSelect}
				disabled={disabled || uploading}
				className="hidden"
			/>
			<button
				type="button"
				onClick={() => inputRef.current?.click()}
				disabled={disabled || uploading}
				className="p-2 rounded-full bg-gray-100 hover:bg-gray-200 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
				title="Upload file"
			>
				{uploading ? (
					<svg
						className="animate-spin h-5 w-5 text-gray-600"
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
				) : (
					<svg
						xmlns="http://www.w3.org/2000/svg"
						className="h-5 w-5 text-gray-600"
						viewBox="0 0 24 24"
						fill="none"
						stroke="currentColor"
						strokeWidth="2"
					>
						<path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48" />
					</svg>
				)}
			</button>
		</>
	);
}
