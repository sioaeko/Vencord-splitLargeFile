import { definePlugin } from "@vendetta/plugins";
import { findByPropsLazy } from "@webpack";
import { Clipboard, Button, Text, useCallback, useState } from "@webpack/common";

const CHUNK_SIZE = 7.9 * 1024 * 1024; // 7.9MB to stay safely under Discord's 8MB limit

interface FileChunk {
    index: number;
    total: number;
    data: string;
    originalName: string;
    originalSize: number;
}

const FileUploadStore = findByPropsLazy("instantBatchUpload", "upload");
const MessageActions = findByPropsLazy("sendMessage");

const SplitFileComponent = () => {
    const [status, setStatus] = useState("");

    const handleFileSplit = useCallback(async (file: File) => {
        const chunks: FileChunk[] = [];
        const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
        
        for (let i = 0; i < totalChunks; i++) {
            const start = i * CHUNK_SIZE;
            const end = Math.min(start + CHUNK_SIZE, file.size);
            const chunk = file.slice(start, end);
            
            const reader = new FileReader();
            const base64Data = await new Promise<string>((resolve) => {
                reader.onload = () => resolve(reader.result as string);
                reader.readAsDataURL(chunk);
            });

            chunks.push({
                index: i,
                total: totalChunks,
                data: base64Data,
                originalName: file.name,
                originalSize: file.size
            });
        }

        // Upload chunks
        for (const chunk of chunks) {
            const chunkBlob = await fetch(chunk.data).then(r => r.blob());
            const chunkFile = new File(
                [chunkBlob], 
                `${file.name}.part${chunk.index + 1}of${chunk.total}`,
                { type: 'application/octet-stream' }
            );
            
            await FileUploadStore.upload({
                file: chunkFile,
                message: JSON.stringify(chunk)
            });
            
            setStatus(`Uploaded part ${chunk.index + 1} of ${chunk.total}`);
        }
    }, []);

    const handleFileSelect = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
        const file = e.target.files?.[0];
        if (file && file.size > CHUNK_SIZE) {
            handleFileSplit(file);
        } else if (file) {
            setStatus("File is small enough to send directly");
        }
    }, [handleFileSplit]);

    const handleFileMerge = useCallback(async (chunks: FileChunk[]) => {
        chunks.sort((a, b) => a.index - b.index);
        
        const blobParts: Blob[] = [];
        for (const chunk of chunks) {
            const response = await fetch(chunk.data);
            const blob = await response.blob();
            blobParts.push(blob);
        }
        
        const finalBlob = new Blob(blobParts);
        const finalFile = new File([finalBlob], chunks[0].originalName);
        
        // Create download link
        const url = URL.createObjectURL(finalFile);
        const a = document.createElement('a');
        a.href = url;
        a.download = finalFile.name;
        a.click();
        URL.revokeObjectURL(url);
    }, []);

    return (
        <div className="split-file-container">
            <input 
                type="file" 
                onChange={handleFileSelect}
                style={{ display: 'none' }}
                id="file-input"
            />
            <Button
                onClick={() => document.getElementById('file-input')?.click()}
            >
                Select Large File
            </Button>
            {status && <Text>{status}</Text>}
        </div>
    );
};

export default definePlugin({
    name: "FileSplitter",
    description: "Split large files to bypass Discord's 8MB limit",
    authors: [{ name: "Your Name", id: BigInt(1234567890) }],
    
    patches: [
        {
            find: ".uploadFiles,",
            replacement: {
                match: /(.{1,}\.uploadFiles,)/,
                replace: `$1,
                    FileSplitter: ${SplitFileComponent},`
            }
        }
    ],

    start() {
        // Add message listener for chunk detection
        const originalSendMessage = MessageActions.sendMessage;
        MessageActions.sendMessage = async (...args) => {
            try {
                const content = args[1]?.content;
                if (content && content.startsWith("{") && content.includes("index")) {
                    const chunkData = JSON.parse(content);
                    if (chunkData.index !== undefined) {
                        // Store chunk data for later merging
                        // You might want to implement a better storage solution
                        window._fileChunks = window._fileChunks || {};
                        window._fileChunks[chunkData.originalName] = window._fileChunks[chunkData.originalName] || [];
                        window._fileChunks[chunkData.originalName].push(chunkData);
                        
                        if (window._fileChunks[chunkData.originalName].length === chunkData.total) {
                            // All chunks received, merge them
                            this.handleFileMerge(window._fileChunks[chunkData.originalName]);
                            delete window._fileChunks[chunkData.originalName];
                        }
                    }
                }
            } catch (e) {
                // Not a chunk message, proceed normally
            }
            return originalSendMessage.apply(this, args);
        };
    },

    stop() {
        // Clean up message listener
        MessageActions.sendMessage = MessageActions.sendMessage.__original || MessageActions.sendMessage;
    }
});
