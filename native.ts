import { IpcMainInvokeEvent, net } from "electron";

export async function fetchChunk(_: IpcMainInvokeEvent, url: string): Promise<{ status: number; data: string | null; }> {
    try {
        // Use Electron's net module which shares Discord's session/cookies
        const res = await net.fetch(url);
        if (!res.ok) {
            return { status: res.status, data: null };
        }
        const buffer = await res.arrayBuffer();
        return { status: res.status, data: Buffer.from(buffer).toString("base64") };
    } catch (e) {
        return { status: -1, data: String(e) };
    }
}
