import { definePlugin, webpack, Patcher } from "@utils/webpack";
import { Button, Text, Forms } from "@webpack/common";
import { useCallback, useState, useEffect } from "@webpack/common";
import { NsUI } from "@utils/types"; // Vencord standard type import

// Optimized chunk size. Set to 24.5MB, just under Discord's 25MB default limit for non-Nitro users.
// The legacy 8MB limit is obsolete.
const CHUNK_SIZE = 24.5 * 1024 * 1024; 
const CHUNK_TIMEOUT = 5 * 60 * 1000; // 5-minute cache expiration for incomplete files.

/**
 * Metadata structure for a file chunk.
 * This object is JSON-stringified and sent as the message content,
 * excluding the binary payload which is sent as an attachment.
 */
interface FileChunkMetadata {
    type: "FileSplitterChunk"; // A unique identifier to distinguish chunk messages.
    index: number;
    total: number;
    originalName: string;
    originalSize: number;
    timestamp: number;
}

/**
 * Represents a chunk stored in the local ChunkManager.
 * Correlates the metadata with the attachment's resolvable CDN URL.
 */
interface StoredFileChunk extends FileChunkMetadata {
    url: string; // The Discord CDN URL for the attached file part.
}

// Interface for the local chunk storage.
interface ChunkStorage {
    [key: string]: { // Keyed by originalName
        chunks: StoredFileChunk[];
        lastUpdated: number;
    };
}

// --- Webpack Module Resolution ---
// Locating necessary Discord internal modules.

const FileUploadStore = webpack.getModule(m => m?.upload && m?.instantBatchUpload);
const MessageActions = webpack.getModule(m => m?.sendMessage);
const Dispatcher = webpack.getModule(m => m?.dispatch && m?.subscribe);
const ChannelStore = webpack.getModule(m => m?.getChannelId);
// Module required for injecting the custom UI component.
const ChannelTextArea = webpack.getModule(m => m.type?.displayName === "ChannelTextArea");

/**
 * Manages the assembly of file chunks received from messages.
 * This is a static class acting as a singleton storage manager.
 */
class ChunkManager {
    private static storage: ChunkStorage = {};

    /**
     * Adds a received chunk to the storage.
     * @param chunk The stored chunk object containing metadata and URL.
     */
    static addChunk(chunk: StoredFileChunk): void {
        const key = chunk.originalName;
        if (!this.storage[key]) {
            this.storage[key] = {
                chunks: [],
                lastUpdated: Date.now()
            };
        }
        
        // Idempotency check: prevent processing or storing the same chunk index multiple times.
        if (!this.storage[key].chunks.some(c => c.index === chunk.index)) {
            this.storage[key].chunks.push(chunk);
            this.storage[key].lastUpdated = Date.now();
        }
    }

    /**
     * Retrieves all stored chunks for a given file name.
     * @param fileName The original name of the file.
     * @returns An array of stored chunks or null if none found.
     */
    static getChunks(fileName: string): StoredFileChunk[] | null {
        return this.storage[fileName]?.chunks || null;
    }

    /**
     * Garbage collection: Removes chunk data that hasn't been updated
     * within the CHUNK_TIMEOUT window.
     */
    static cleanOldChunks(): void {
        const now = Date.now();
        Object.keys(this.storage).forEach(key => {
            if (now - this.storage[key].lastUpdated > CHUNK_TIMEOUT) {
                delete this.storage[key];
                console.log(`[FileSplitter] Garbage collected stale chunks for: ${key}`);
            }
        });
    }
}

// --- Core Utilities ---

/**
 * Type guard to validate if a parsed message object is a valid FileChunk.
 * @param chunk The object to validate (parsed from JSON).
 * @returns True if the object adheres to the FileChunkMetadata protocol.
 */
const isValidChunk = (chunk: any): chunk is FileChunkMetadata => {
    return (
        typeof chunk === 'object' &&
        chunk.type === "FileSplitterChunk" && // Verify the unique identifier.
        typeof chunk.index === 'number' &&
        typeof chunk.total === 'number' &&
        typeof chunk.originalName === 'string' &&
        typeof chunk.originalSize === 'number' &&
        typeof chunk.timestamp === 'number'
    );
};

/**
 * Asynchronously merges all file chunks into a single file and triggers a download.
 * @param chunks An array of StoredFileChunk objects.
 */
const handleFileMerge = async (chunks: StoredFileChunk[]) => {
    try {
        // Ensure chunks are in the correct order.
        chunks.sort((a, b) => a.index - b.index);
        
        const blobParts: Blob[] = [];
        for (const chunk of chunks) {
            // Asynchronously fetches the binary content from the chunk's CDN URL.
            const response = await fetch(chunk.url);
            if (!response.ok) {
                throw new Error(`Failed to fetch chunk ${chunk.index + 1} from ${chunk.url}`);
            }
            const blob = await response.blob();
            blobParts.push(blob);
        }
        
        // Assemble the final file.
        const finalBlob = new Blob(blobParts);
        const finalFile = new File([finalBlob], chunks[0].originalName);
        
        // Generates a client-side download by creating a virtual link.
        const url = URL.createObjectURL(finalFile);
        const a = document.createElement('a');
        a.href = url;
        a.download = finalFile.name;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
        
        console.log(`[FileSplitter] File merged and downloaded successfully: ${finalFile.name}`);

    } catch (error) {
        console.error('[FileSplitter] Error during file merge process:', error);
    }
};

// --- React Component: UI ---

/**
 * The React component that provides the UI for selecting and uploading large files.
 */
const SplitFileComponent = () => {
    const [status, setStatus] = useState("");
    const [isUploading, setIsUploading] = useState(false);
    const [progress, setProgress] = useState(0);

    /**
     * Handles the core logic of splitting a file and uploading it in chunks.
     * @param file The file selected by the user.
     */
    const handleFileSplit = useCallback(async (file: File) => {
        try {
            setIsUploading(true);
            const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
            
            for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, file.size);
                
                // Step 1: Efficiently slice the file. Bypasses Base64 conversion, using the native Blob.
                const chunkBlob = file.slice(start, end);
                
                // Step 2: Construct the metadata payload. This JSON will be the message content.
                const metadata: FileChunkMetadata = {
                    type: "FileSplitterChunk",
                    index: i,
                    total: totalChunks,
                    originalName: file.name,
                    originalSize: file.size,
                    timestamp: Date.now()
                };

                // Step 3: Re-wrap the Blob as a File object for the upload API.
                const chunkFile = new File(
                    [chunkBlob], 
                    `${file.name}.part${String(i + 1).padStart(3, '0')}`, // Padded for lexical sorting.
                    { type: 'application/octet-stream' }
                );
                
                // Step 4: Dispatch the upload action, pairing the file part with its metadata message.
                await FileUploadStore.upload({
                    file: chunkFile,
                    message: JSON.stringify(metadata), // Send metadata as the message.
                    channelId: ChannelStore.getChannelId()
                });

                setProgress(Math.round(((i + 1) / totalChunks) * 100));
            }

            setStatus(`Successfully uploaded ${totalChunks} parts for ${file.name}`);
        } catch (error) {
            setStatus(`Error: ${error.message}`);
        } finally {
            setIsUploading(false);
            setProgress(0);
        }
    }, []);

    /**
     * Handler for the file input change event.
     * @param e The React change event from the file input.
     */
    const handleFileSelect = useCallback(async (e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (!file) return;

        // Pre-flight check: Enforce Discord's absolute 500MB (Nitro) file size limit.
        if (file.size > 500 * 1024 * 1024) {
             setStatus("File exceeds 500MB. This is not supported.");
             return;
        }

        // Only split if the file is larger than our defined CHUNK_SIZE.
        if (file.size > CHUNK_SIZE) {
            setStatus(`Splitting ${file.name} into ~${Math.ceil(file.size / CHUNK_SIZE)} chunks...`);
            await handleFileSplit(file);
        } else {
            setStatus("File is small enough to be sent directly.");
        }
        
        // Reset the file input to allow re-selection of the same file.
        e.target.value = "";
    }, [handleFileSplit]);

    // UI Note: Using a standard <div> for more flexible layout injection.
    return (
        <div style={{ padding: '8px', borderTop: '1px solid var(--background-modifier-accent)' }}>
            <input 
                type="file" 
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                id="file-splitter-input"
            />
            <Button
                onClick={() => document.getElementById('file-splitter-input')?.click()}
                disabled={isUploading}
            >
                {isUploading ? `Uploading... (${progress}%)` : 'Upload Large File'}
            </Button>
            {status && <Text variant="text-sm/normal" style={{ marginLeft: '8px', verticalAlign: 'middle' }}>{status}</Text>}
        </div>
    );
};

// --- Vencord Plugin Definition ---

export default definePlugin({
    name: "FileSplitter",
    description: "Splits large files into 25MB chunks to bypass Discord's default limit.",
    authors: [
        {
            id: 1234567890n,
            name: "Your Name",
        },
    ],

    // This property is used to store the interval ID for cleanup.
    chunkCleanupInterval: null as NodeJS.Timeout | null,

    /**
     * Handler for the 'MESSAGE_CREATE' dispatch event.
     * Intercepts incoming messages to find and assemble chunks.
     * @param { message: NsUI.Message } The message payload from Discord.
     */
    onMessageCreate({ message }: { message: NsUI.Message }) {
        try {
            // Optimization: If there's no content or no attachment, it can't be a chunk.
            if (!message.content || !message.attachments?.length) return;

            const chunkData = JSON.parse(message.content);
            
            // Validate if this message is one of our file chunks.
            if (isValidChunk(chunkData)) {
                const attachment = message.attachments[0];
                if (!attachment?.url) return; // Should not happen, but safeguard.

                const storedChunk: StoredFileChunk = {
                    ...chunkData,
                    url: attachment.url
                };
                
                ChunkManager.addChunk(storedChunk);
                
                // Check if all chunks have been received.
                const chunks = ChunkManager.getChunks(chunkData.originalName);
                if (chunks && chunks.length === chunkData.total) {
                    console.log(`[FileSplitter] All ${chunkData.total} chunks received for ${chunkData.originalName}. Initiating merge...`);
                    
                    // Optimization TODO: Implement a user-facing prompt (e.g., a modal or toast) 
                    // to confirm file merge, rather than automatic download.
                    
                    // Current: Initiates automatic merge and download upon receiving the final chunk.
                    handleFileMerge(chunks);
                }
            }
        } catch (e) {
            // Gracefully handle non-chunk messages; JSON.parse will fail, which is expected.
        }
    },

    start() {
        // Initiate periodic garbage collection for expired chunk data.
        this.chunkCleanupInterval = setInterval(() => {
            ChunkManager.cleanOldChunks();
        }, 60000); // Run every 60 seconds.

        // 1. Subscribe to the 'MESSAGE_CREATE' event to intercept incoming messages.
        Dispatcher.subscribe("MESSAGE_CREATE", this.onMessageCreate);

        // 2. Inject the React component into the UI using Patcher.
        // We patch ChannelTextArea as it's a stable component rendered at the bottom of the chat.
        if (ChannelTextArea) {
            Patcher.after("FileSplitter", ChannelTextArea, "type", (thisObj, [props], res) => {
                // 'res' is the rendered ChannelTextArea element.
                // We append our component to its children.
                if (res?.props?.children && Array.isArray(res.props.children)) {
                    res.props.children.push(<SplitFileComponent />);
                }
            });
        } else {
             console.error("[FileSplitter] Failed to find ChannelTextArea component for patching UI.");
        }
    },

    stop() {
        // Perform complete cleanup: remove all patches and event subscriptions.
        Patcher.unpatchAll("FileSplitter");
        Dispatcher.unsubscribe("MESSAGE_CREATE", this.onMessageCreate);
        if (this.chunkCleanupInterval) {
            clearInterval(this.chunkCleanupInterval);
        }
    }
});
