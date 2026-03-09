const fs = require("fs");
const os = require("os");
const path = require("path");
const { execFileSync, spawn } = require("child_process");

const PLUGIN_MARKER = 'name:"FileSplitter"';
const VENCORD_PATCH_START = "/* FILESPLITTER_VENCORD_PATCH_START */";
const VENCORD_PATCH_END = "/* FILESPLITTER_VENCORD_PATCH_END */";
const ROOT_DIR = __dirname;
const PLATFORM = process.platform;

function isWindows() {
    return PLATFORM === "win32";
}

function isMac() {
    return PLATFORM === "darwin";
}

function getBinaryLabel() {
    return isWindows() ? "FileSplitterPatcher.exe" : "FileSplitterPatcher";
}

function getDefaultEquicordRoot() {
    if (isMac()) {
        return path.join(os.homedir(), "Library", "Application Support", "Equicord");
    }
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Equicord");
}

function getDefaultVencordRoot() {
    if (isMac()) {
        return path.join(os.homedir(), "Library", "Application Support", "Vencord");
    }
    return path.join(process.env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Vencord");
}

function getAssetPath(name) {
    return path.join(ROOT_DIR, name);
}

function getPaths(options = {}) {
    const inputPath = options.equicordRoot ?? options.appData ?? getDefaultEquicordRoot();
    if (!inputPath) {
        throw new Error("Equicord data path is not set.");
    }

    const resolved = path.resolve(inputPath);
    const equicordRoot = path.basename(resolved).toLowerCase() === "equicord"
        ? resolved
        : path.join(resolved, "Equicord");
    const appDataRoot = path.dirname(equicordRoot);

    return {
        appDataRoot,
        equicordRoot,
        equicordFolder: path.join(equicordRoot, "equicord"),
        asarPath: path.join(equicordRoot, "equicord.asar"),
        asarBak: path.join(equicordRoot, "equicord.asar.bak"),
        rendererPath: path.join(equicordRoot, "equicord", "renderer.js")
    };
}

function ensureBackup(paths) {
    if (fs.existsSync(paths.asarBak)) return false;
    if (!fs.existsSync(paths.asarPath)) {
        throw new Error(`Missing file: ${paths.asarPath}`);
    }

    fs.copyFileSync(paths.asarPath, paths.asarBak);
    return true;
}

function ensureRendererBackup(paths) {
    if (fs.existsSync(paths.rendererBak)) return false;
    if (!fs.existsSync(paths.rendererPath)) {
        throw new Error(`Missing file: ${paths.rendererPath}`);
    }

    fs.copyFileSync(paths.rendererPath, paths.rendererBak);
    return true;
}

function alignTo4(size) {
    return size + ((4 - (size % 4)) % 4);
}

function createPickleReader(buffer) {
    const payloadSize = buffer.readUInt32LE(0);
    const headerSize = buffer.length - payloadSize;
    let readIndex = 0;

    function readBytes(length, method) {
        const start = headerSize + readIndex;
        const value = method
            ? method.call(buffer, start)
            : buffer.slice(start, start + length);
        readIndex += alignTo4(length);
        return value;
    }

    return {
        readUInt32() {
            return readBytes(4, Buffer.prototype.readUInt32LE);
        },
        readInt32() {
            return readBytes(4, Buffer.prototype.readInt32LE);
        },
        readString() {
            const length = this.readInt32();
            return readBytes(length).toString("utf8");
        }
    };
}

function readArchiveHeaderSync(archivePath) {
    const fd = fs.openSync(archivePath, "r");
    try {
        const sizeBuf = Buffer.alloc(8);
        if (fs.readSync(fd, sizeBuf, 0, 8, 0) !== 8) {
            throw new Error("Unable to read ASAR header size.");
        }

        const sizeReader = createPickleReader(sizeBuf);
        const headerSize = sizeReader.readUInt32();
        const headerBuf = Buffer.alloc(headerSize);
        if (fs.readSync(fd, headerBuf, 0, headerSize, 8) !== headerSize) {
            throw new Error("Unable to read ASAR header.");
        }

        const headerReader = createPickleReader(headerBuf);
        const headerString = headerReader.readString();
        return {
            headerSize,
            header: JSON.parse(headerString)
        };
    } finally {
        fs.closeSync(fd);
    }
}

function walkAsarFiles(node, basePath = "", files = []) {
    const entries = Object.entries(node?.files ?? {});
    for (const [name, child] of entries) {
        const relPath = basePath ? path.join(basePath, name) : name;
        if (child?.files) {
            files.push({ type: "dir", relPath, node: child });
            walkAsarFiles(child, relPath, files);
        } else if (child?.link) {
            files.push({ type: "link", relPath, node: child });
        } else {
            files.push({ type: "file", relPath, node: child });
        }
    }
    return files;
}

function extractArchiveSync(archivePath, destination) {
    const { header, headerSize } = readArchiveHeaderSync(archivePath);
    const unpackedRoot = `${archivePath}.unpacked`;

    if (fs.existsSync(destination)) {
        fs.rmSync(destination, { recursive: true, force: true });
    }
    fs.mkdirSync(destination, { recursive: true });

    const entries = walkAsarFiles(header);
    const fd = fs.openSync(archivePath, "r");
    try {
        for (const entry of entries) {
            const targetPath = path.join(destination, entry.relPath);
            if (entry.type === "dir") {
                fs.mkdirSync(targetPath, { recursive: true });
                continue;
            }

            if (entry.type === "link") {
                const linkTarget = path.join(path.dirname(targetPath), entry.node.link);
                try {
                    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
                    fs.symlinkSync(linkTarget, targetPath);
                } catch { }
                continue;
            }

            fs.mkdirSync(path.dirname(targetPath), { recursive: true });
            if (entry.node.unpacked) {
                const unpackedPath = path.join(unpackedRoot, entry.relPath);
                fs.copyFileSync(unpackedPath, targetPath);
            } else {
                const size = Number(entry.node.size ?? 0);
                const offset = 8 + headerSize + Number(entry.node.offset ?? 0);
                const buffer = Buffer.alloc(size);
                if (size > 0) {
                    fs.readSync(fd, buffer, 0, size, offset);
                }
                fs.writeFileSync(targetPath, buffer);
            }

            if (entry.node.executable && !isWindows()) {
                try {
                    fs.chmodSync(targetPath, 0o755);
                } catch { }
            }
        }
    } finally {
        fs.closeSync(fd);
    }
}

function resetExtractedFolder(paths) {
    extractArchiveSync(paths.asarBak, paths.equicordFolder);
}

function readRenderer(paths) {
    if (!fs.existsSync(paths.rendererPath)) {
        throw new Error(`Renderer not found: ${paths.rendererPath}`);
    }
    return fs.readFileSync(paths.rendererPath, "utf8");
}

function getVencordPaths(options = {}) {
    const rootInput = options.vencordRoot ?? options.appData ?? getDefaultVencordRoot();
    if (!rootInput) {
        throw new Error("Vencord data path is not set.");
    }

    const vencordRoot = path.resolve(rootInput);
    const distFolder = path.join(vencordRoot, "dist");
    return {
        appDataRoot: path.dirname(vencordRoot),
        vencordRoot,
        distFolder,
        rendererPath: path.join(distFolder, "renderer.js"),
        rendererBak: path.join(distFolder, "renderer.js.filesplitter.bak")
    };
}

function readAssetText(name) {
    return fs.readFileSync(getAssetPath(name), "utf8");
}

function analyzeRenderer(code) {
    const dpMatch = code.match(/(\w+)\(\{name:"BadgeAPI"/);
    const rtMatch = code.match(/(\w+)=\{(\[\w+\.name\]:\w+,){3,}/);
    const piMatch = code.match(/\},(\w+)=\{\[\w+\.name\]:\{folderName:/);
    const cbbMatch = code.match(/(\w+)=\((\w+),(\w+),(\w+)\)=>(\w+)\.set\(\2,\{render:\3,icon:\4\}\)/);

    if (!dpMatch || !rtMatch || !piMatch || !cbbMatch) {
        throw new Error("Failed to analyze renderer.js. Equicord build layout may have changed.");
    }

    const addCBB = cbbMatch[1];
    const cbbMap = cbbMatch[5];
    const cbbAreaMatch = code.match(new RegExp(`${addCBB}=.*?,(\\w+)=\\w+=>${cbbMap}\\.delete\\(\\w+\\),(\\w+)=\\w+\\.wrap`));

    if (!cbbAreaMatch) {
        throw new Error("Failed to find ChatBarButton helpers.");
    }

    const fdMatch = code.match(/(\w+)\.subscribe\("MESSAGE_CREATE"/);
    const veMatch = code.match(/(\w+)\.getChannelId\(\)/);
    const smMatch = code.match(/(\w+)\.sendMessage\((\w+),(\w+),(\w+),(\w+)\)/);
    const reactMatch = code.match(/(\w+)\.useState\b/);

    return {
        dpFn: dpMatch[1],
        rtVar: rtMatch[1],
        rtIdx: rtMatch.index,
        piVar: piMatch[1],
        addCBB,
        rmCBB: cbbAreaMatch[1],
        chatBarBtn: cbbAreaMatch[2],
        channelStore: veMatch?.[1] ?? "Ve",
        msgActions: smMatch?.[1] ?? "o",
        reactVar: reactMatch?.[1] ?? "Z",
        fluxDisp: fdMatch?.[1] ?? "J"
    };
}

function buildPluginDef(meta) {
    return readAssetText("injected-plugin.template.js")
        .replace(/__DP_FN__/g, meta.dpFn)
        .replace(/__CHAT_BAR_BUTTON__/g, meta.chatBarBtn)
        .replace(/__ADD_CBB__/g, meta.addCBB)
        .replace(/__REMOVE_CBB__/g, meta.rmCBB);
}

function injectPlugin(paths) {
    const code = readRenderer(paths);
    const meta = analyzeRenderer(code);
    const pluginDef = buildPluginDef(meta);

    const beforeRt = code.substring(0, meta.rtIdx);
    const afterRt = code.substring(meta.rtIdx);
    let updated = beforeRt + pluginDef + afterRt;

    const newRtStart = updated.indexOf(meta.rtVar + "={", meta.rtIdx);
    const insertPos = newRtStart + meta.rtVar.length + 2;
    updated = updated.substring(0, insertPos) + `[_FS_.name]:_FS_,` + updated.substring(insertPos);

    const piSearch = meta.piVar + "={";
    const newPiStart = updated.indexOf(piSearch, meta.rtIdx);
    const piInsertPos = newPiStart + piSearch.length;
    updated = updated.substring(0, piInsertPos) + `[_FS_.name]:{folderName:"src/userplugins/fileSplitter",userPlugin:true},` + updated.substring(piInsertPos);

    fs.writeFileSync(paths.rendererPath, updated);
}

function removeExistingPlugin(code) {
    return code
        .replace(/var _FS_=\w+\(\{name:"FileSplitter"[\s\S]*?\}\);\s*/m, "")
        .replace(/\[_FS_\.name\]:_FS_,/g, "")
        .replace(/\[_FS_\.name\]:\{folderName:"src\/userplugins\/fileSplitter",userPlugin:true\},/g, "");
}

function removeInstalledVencordPatch(code) {
    const start = code.indexOf(VENCORD_PATCH_START);
    if (start === -1) return code;

    const end = code.indexOf(VENCORD_PATCH_END, start);
    if (end === -1) return code.slice(0, start).trimEnd() + "\n";

    return (code.slice(0, start) + code.slice(end + VENCORD_PATCH_END.length))
        .replace(/\n{3,}/g, "\n\n")
        .trimEnd() + "\n";
}

function buildInstalledVencordPluginDef() {
    const transformed = readAssetText("injected-plugin.template.js")
        .replace(/^var _FS_=__DP_FN__\(\{/m, "var _FS_={")
        .replace(/__CHAT_BAR_BUTTON__/g, "Vencord.Api.ChatButtons.ChatBarButton")
        .replace(/__ADD_CBB__/g, "Vencord.Api.ChatButtons.addChatBarButton")
        .replace(/__REMOVE_CBB__/g, "Vencord.Api.ChatButtons.removeChatBarButton")
        .replace(/\}\);\s*$/, "};");

    if (/__\w+__/.test(transformed)) {
        throw new Error("Failed to build installed Vencord plugin template.");
    }

    return transformed;
}

function buildInstalledVencordBootstrap() {
    const pluginDef = buildInstalledVencordPluginDef();
    return [
        "",
        VENCORD_PATCH_START,
        "(function(){",
        pluginDef,
        "try{",
        "if(typeof Vencord==='undefined'||!Vencord||!Vencord.Plugins||!Vencord.Plugins.plugins||!Vencord.Api||!Vencord.Api.PluginManager){",
        "console.warn('[FileSplitter] Installed Vencord bootstrap: Vencord runtime not available.');",
        "return;",
        "}",
        "var plugins=Vencord.Plugins.plugins;",
        "var manager=Vencord.Api.PluginManager;",
        "var existing=plugins.FileSplitter;",
        "if(existing&&existing!==_FS_&&existing.started&&typeof manager.stopPlugin==='function'){",
        "try{manager.stopPlugin(existing);}catch(error){console.warn('[FileSplitter] Failed to stop previous Vencord FileSplitter plugin:',error);}",
        "}",
        "plugins.FileSplitter=_FS_;",
        "if(_FS_.started&&typeof manager.stopPlugin==='function'){",
        "try{manager.stopPlugin(_FS_);}catch(error){console.warn('[FileSplitter] Failed to reset FileSplitter plugin before start:',error);}",
        "}",
        "if(typeof manager.startPlugin==='function'){",
        "manager.startPlugin(_FS_);",
        "}else if(typeof _FS_.start==='function'){",
        "_FS_.start();",
        "_FS_.started=true;",
        "}",
        "}catch(error){",
        "console.error('[FileSplitter] Installed Vencord bootstrap failed:',error);",
        "}",
        "})();",
        VENCORD_PATCH_END,
        ""
    ].join("\n");
}

async function install(options = {}) {
    const paths = getPaths(options);
    const backupCreated = ensureBackup(paths);

    if (fs.existsSync(paths.rendererPath)) {
        const existing = readRenderer(paths);
        if (existing.includes(PLUGIN_MARKER)) {
            fs.writeFileSync(paths.rendererPath, removeExistingPlugin(existing));
            injectPlugin(paths);
            return { paths, backupCreated, mode: "updated-existing-renderer" };
        }
    }

    if (!fs.existsSync(paths.rendererPath)) {
        resetExtractedFolder(paths);
    }

    injectPlugin(paths);
    return { paths, backupCreated, mode: "patched-renderer" };
}

function installInstalledVencord(options = {}) {
    const paths = getVencordPaths(options);
    const backupCreated = ensureRendererBackup(paths);
    const existing = readRenderer(paths);
    const sanitized = removeInstalledVencordPatch(removeExistingPlugin(existing)).trimEnd();
    const bootstrap = buildInstalledVencordBootstrap();
    fs.writeFileSync(paths.rendererPath, `${sanitized}\n${bootstrap}`);
    return { paths, backupCreated, mode: "patched-vencord-renderer" };
}

function ensureRepoRoot(repoRoot) {
    const resolved = path.resolve(repoRoot);
    const srcDir = path.join(resolved, "src");
    if (!fs.existsSync(srcDir)) {
        throw new Error(`Not a Vencord/Equicord source repo: ${resolved}`);
    }
    return resolved;
}

function installSourceRepo(options = {}) {
    const repoRoot = ensureRepoRoot(options.repo);
    const pluginDir = path.join(repoRoot, "src", "userplugins", "fileSplitter");
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.copyFileSync(getAssetPath("FileSplitter.tsx"), path.join(pluginDir, "index.tsx"));
    fs.copyFileSync(getAssetPath("native.ts"), path.join(pluginDir, "native.ts"));
    return { repoRoot, pluginDir };
}

function statusSourceRepo(options = {}) {
    const repoRoot = ensureRepoRoot(options.repo);
    const pluginDir = path.join(repoRoot, "src", "userplugins", "fileSplitter");
    return {
        repoRoot,
        pluginDir,
        indexExists: fs.existsSync(path.join(pluginDir, "index.tsx")),
        nativeExists: fs.existsSync(path.join(pluginDir, "native.ts"))
    };
}

function restore(options = {}) {
    const paths = getPaths(options);
    if (!fs.existsSync(paths.asarBak)) {
        throw new Error(`Backup not found: ${paths.asarBak}`);
    }

    if (fs.existsSync(paths.equicordFolder)) {
        fs.rmSync(paths.equicordFolder, { recursive: true, force: true });
    }
    fs.copyFileSync(paths.asarBak, paths.asarPath);
    return { paths };
}

function restoreInstalledVencord(options = {}) {
    const paths = getVencordPaths(options);
    if (!fs.existsSync(paths.rendererBak)) {
        throw new Error(`Backup not found: ${paths.rendererBak}`);
    }

    fs.copyFileSync(paths.rendererBak, paths.rendererPath);
    return { paths };
}

function status(options = {}) {
    const paths = getPaths(options);
    const rendererExists = fs.existsSync(paths.rendererPath);
    const rendererContainsPlugin = rendererExists && readRenderer(paths).includes(PLUGIN_MARKER);
    return {
        paths,
        backupExists: fs.existsSync(paths.asarBak),
        asarExists: fs.existsSync(paths.asarPath),
        extractedExists: fs.existsSync(paths.equicordFolder),
        rendererExists,
        rendererContainsPlugin
    };
}

function statusInstalledVencord(options = {}) {
    const paths = getVencordPaths(options);
    const rendererExists = fs.existsSync(paths.rendererPath);
    const rendererCode = rendererExists ? readRenderer(paths) : "";
    const rendererContainsPlugin = rendererExists && rendererCode.includes(VENCORD_PATCH_START);
    return {
        paths,
        backupExists: fs.existsSync(paths.rendererBak),
        distExists: fs.existsSync(paths.distFolder),
        rendererExists,
        rendererContainsPlugin
    };
}

function printStatus(state) {
    console.log("FileSplitter patcher status");
    console.log(`- data root: ${state.paths.appDataRoot}`);
    console.log(`- equicord.asar: ${state.asarExists ? "present" : "missing"}`);
    console.log(`- equicord.asar.bak: ${state.backupExists ? "present" : "missing"}`);
    console.log(`- extracted folder: ${state.extractedExists ? "present" : "missing"}`);
    console.log(`- renderer.js: ${state.rendererExists ? "present" : "missing"}`);
    console.log(`- plugin marker: ${state.rendererContainsPlugin ? "present" : "missing"}`);
}

function printSourceStatus(state) {
    console.log("FileSplitter source plugin status");
    console.log(`- repo: ${state.repoRoot}`);
    console.log(`- plugin dir: ${state.pluginDir}`);
    console.log(`- index.tsx: ${state.indexExists ? "present" : "missing"}`);
    console.log(`- native.ts: ${state.nativeExists ? "present" : "missing"}`);
}

function printInstalledVencordStatus(state) {
    console.log("FileSplitter installed Vencord status");
    console.log(`- data root: ${state.paths.vencordRoot}`);
    console.log(`- dist folder: ${state.distExists ? "present" : "missing"}`);
    console.log(`- renderer.js: ${state.rendererExists ? "present" : "missing"}`);
    console.log(`- renderer backup: ${state.backupExists ? "present" : "missing"}`);
    console.log(`- patch marker: ${state.rendererContainsPlugin ? "present" : "missing"}`);
}

function getLocalAppDataRoot(options = {}) {
    if (isMac()) {
        return path.resolve(options.localAppData ?? path.join(os.homedir(), "Applications"));
    }
    return path.resolve(options.localAppData ?? process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"));
}

function getLatestAppExe(baseDir, exeName) {
    if (!fs.existsSync(baseDir)) return null;
    const candidates = fs.readdirSync(baseDir, { withFileTypes: true })
        .filter(entry => entry.isDirectory() && /^app-\d+\.\d+\.\d+/.test(entry.name))
        .map(entry => path.join(baseDir, entry.name, exeName))
        .filter(candidate => fs.existsSync(candidate));

    if (!candidates.length) return null;
    candidates.sort((left, right) => {
        const leftTime = fs.statSync(left).mtimeMs;
        const rightTime = fs.statSync(right).mtimeMs;
        return rightTime - leftTime;
    });
    return candidates[0];
}

function resolveClientExecutable(options = {}) {
    const explicit = options.clientExe && path.resolve(options.clientExe);
    if (explicit && fs.existsSync(explicit)) {
        return explicit;
    }

    if (isMac()) {
        const appNames = ["Discord", "Equicord", "Equilotl"];
        const bundleCandidates = [];
        for (const appName of appNames) {
            const appByScript = runOptionalCommand("osascript", [
                "-e",
                `POSIX path of (path to application "${appName}")`
            ]);
            if (appByScript.ok) {
                const bundlePath = appByScript.stdout.trim();
                if (bundlePath && fs.existsSync(bundlePath)) return bundlePath;
            }

            bundleCandidates.push(
                path.join("/Applications", `${appName}.app`),
                path.join(os.homedir(), "Applications", `${appName}.app`)
            );
        }

        return bundleCandidates.find(candidate => fs.existsSync(candidate)) ?? null;
    }

    const localAppData = getLocalAppDataRoot(options);
    const processCandidates = [
        ["Discord", "Discord.exe"],
        ["Equicord", "Equicord.exe"],
        ["Equilotl", "Equilotl.exe"]
    ];

    for (const [processName, exeName] of processCandidates) {
        try {
            const output = execFileSync("powershell.exe", [
                "-NoProfile",
                "-Command",
                `(Get-Process -Name '${processName}' -ErrorAction SilentlyContinue | Where-Object { $_.Path } | Select-Object -First 1 -ExpandProperty Path)`
            ], { encoding: "utf8" }).trim();
            if (output && fs.existsSync(output)) return output;
        } catch { }

        const localCandidate = getLatestAppExe(path.join(localAppData, processName), exeName);
        if (localCandidate) return localCandidate;
    }

    return null;
}

function runOptionalCommand(command, args, options = {}) {
    try {
        const stdout = execFileSync(command, args, {
            encoding: "utf8",
            stdio: ["ignore", "pipe", "pipe"],
            ...options
        });
        return { ok: true, stdout };
    } catch (error) {
        const stderr = error?.stderr?.toString?.() ?? "";
        return {
            ok: false,
            code: error?.status ?? error?.code ?? "unknown",
            stderr: stderr.trim() || error?.message || String(error)
        };
    }
}

function stopClientProcesses() {
    const names = ["Discord", "Equicord", "Equilotl"];
    const stopped = [];
    const errors = [];

    if (isMac()) {
        for (const name of names) {
            runOptionalCommand("osascript", ["-e", `tell application "${name}" to quit`]);
            sleep(500);

            const pkill = runOptionalCommand("pkill", ["-x", name]);
            const stillRunning = listRunningClientProcesses().includes(name);
            if (!stillRunning) {
                if (runOptionalCommand("pgrep", ["-x", name]).ok || pkill.ok) {
                    stopped.push(name);
                }
                continue;
            }

            errors.push(`${name}: process did not exit cleanly`);
        }

        return { stopped, errors };
    }

    for (const name of names) {
        const taskkill = runOptionalCommand("taskkill.exe", ["/IM", `${name}.exe`, "/T", "/F"]);
        if (taskkill.ok) {
            stopped.push(name);
            continue;
        }

        const ps = runOptionalCommand("powershell.exe", [
            "-NoProfile",
            "-Command",
            `Stop-Process -Name '${name}' -Force -ErrorAction Stop`
        ]);
        if (ps.ok) {
            stopped.push(name);
            continue;
        }

        errors.push(`${name}: ${taskkill.stderr || ps.stderr || "stop failed"}`);
    }

    return { stopped, errors };
}

function sleep(ms) {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function listRunningClientProcesses() {
    if (isMac()) {
        try {
            const output = execFileSync("ps", ["-A", "-o", "comm="], { encoding: "utf8" });
            return output.split(/\r?\n/)
                .map(line => path.basename(line.trim()))
                .filter(Boolean)
                .map(name => name.replace(/\.app$/i, ""))
                .filter(name => ["Discord", "Equicord", "Equilotl"].includes(name));
        } catch {
            return [];
        }
    }

    try {
        const output = execFileSync("tasklist.exe", ["/FO", "CSV", "/NH"], { encoding: "utf8" });
        return output.split(/\r?\n/)
            .map(line => line.trim())
            .filter(Boolean)
            .map(line => line.replace(/^"|"$/g, "").split('","')[0])
            .filter(name => ["Discord.exe", "Equicord.exe", "Equilotl.exe"].includes(name));
    } catch {
        return [];
    }
}

function waitForClientsToExit(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        if (!listRunningClientProcesses().length) return true;
        sleep(250);
    }
    return !listRunningClientProcesses().length;
}

function resolveLaunchTarget(executablePath) {
    if (isMac()) {
        return {
            command: "open",
            args: ["-a", executablePath]
        };
    }

    const baseDir = path.dirname(path.dirname(executablePath));
    const updateExe = path.join(baseDir, "Update.exe");
    if (fs.existsSync(updateExe)) {
        return {
            command: updateExe,
            args: ["--processStart", path.basename(executablePath)]
        };
    }

    return {
        command: executablePath,
        args: []
    };
}

function launchClient(executablePath) {
    const target = resolveLaunchTarget(executablePath);
    const child = spawn(target.command, target.args, {
        detached: true,
        stdio: "ignore"
    });
    child.unref();
    return target;
}

function restartClient(options = {}) {
    const executablePath = resolveClientExecutable(options);
    if (!executablePath) {
        return { restarted: false, reason: "Client executable not found." };
    }

    const stopResult = stopClientProcesses();
    const fullyStopped = waitForClientsToExit();
    if (!fullyStopped) {
        return {
            restarted: false,
            reason: "Client processes did not exit cleanly.",
            stopped: stopResult.stopped,
            stopErrors: stopResult.errors,
            executablePath
        };
    }

    sleep(750);
    const launchTarget = launchClient(executablePath);
    return {
        restarted: true,
        executablePath,
        launchTarget,
        stopped: stopResult.stopped,
        stopErrors: stopResult.errors
    };
}

function getPowerShellPath() {
    const candidates = [
        process.env.SystemRoot && path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        process.env.WINDIR && path.join(process.env.WINDIR, "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
        "powershell.exe"
    ].filter(Boolean);

    for (const candidate of candidates) {
        try {
            if (candidate.endsWith(".exe")) {
                if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) continue;
                return candidate;
            }
        } catch { }
    }

    return "powershell.exe";
}

function runAppleScript(scriptText, args = []) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "filesplitter-patcher-"));
    const scriptPath = path.join(tempDir, "script.applescript");

    try {
        fs.writeFileSync(scriptPath, scriptText, "utf8");
        return execFileSync("osascript", [scriptPath, ...args], {
            encoding: "utf8"
        });
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch { }
    }
}

function runPowerShellScript(scriptText) {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "filesplitter-patcher-"));
    const scriptPath = path.join(tempDir, "script.ps1");

    try {
        fs.writeFileSync(scriptPath, scriptText, "utf8");
        return execFileSync(getPowerShellPath(), [
            "-NoProfile",
            "-ExecutionPolicy", "Bypass",
            "-STA",
            "-File", scriptPath
        ], {
            encoding: "utf8"
        });
    } finally {
        try {
            fs.rmSync(tempDir, { recursive: true, force: true });
        } catch { }
    }
}

function showGui() {
    const output = (isMac()
        ? runAppleScript(readAssetText("patcher-gui.applescript"))
        : runPowerShellScript(readAssetText("patcher-gui.ps1"))).trim();
    if (!output) return null;
    return JSON.parse(output);
}

function showMessage(title, message, icon = "Information") {
    if (isMac()) {
        const macIcon = icon === "Error" ? "stop" : icon === "Warning" ? "caution" : "note";
        runAppleScript(`
on run argv
    set dialogTitle to item 1 of argv
    set dialogMessage to item 2 of argv
    display dialog dialogMessage with title dialogTitle buttons {"OK"} default button "OK" with icon ${macIcon}
end run
`, [title, message]);
        return;
    }

    const safeTitle = title.replace(/'/g, "''");
    const safeMessage = message.replace(/'/g, "''");
    const script = `
Add-Type -AssemblyName System.Windows.Forms
[System.Windows.Forms.MessageBox]::Show('${safeMessage}','${safeTitle}',
    [System.Windows.Forms.MessageBoxButtons]::OK,
    [System.Windows.Forms.MessageBoxIcon]::${icon}) | Out-Null
`;
    runPowerShellScript(script);
}

function formatRestartLines(restart) {
    if (!restart) return [];
    if (restart.restarted) {
        const lines = [
            `Restarted client:\n${restart.executablePath}`
        ];
        if (restart.launchTarget) {
            lines.push(`Launch command:\n${restart.launchTarget.command} ${restart.launchTarget.args.join(" ")}`.trim());
        }
        if (restart.stopped?.length) {
            lines.push(`Stopped processes:\n${restart.stopped.join(", ")}`);
        }
        if (restart.stopErrors?.length) {
            lines.push(`Stop warnings:\n${restart.stopErrors.join("\n")}`);
        }
        return lines;
    }

    const lines = [`Restart skipped:\n${restart.reason ?? "Unknown error"}`];
    if (restart.executablePath) {
        lines.push(`Client executable:\n${restart.executablePath}`);
    }
    if (restart.stopped?.length) {
        lines.push(`Stopped processes:\n${restart.stopped.join(", ")}`);
    }
    if (restart.stopErrors?.length) {
        lines.push(`Stop errors:\n${restart.stopErrors.join("\n")}`);
    }
    return lines;
}

function formatInstalledSuccessMessage(result, restart) {
    const lines = [
        result.backupCreated ? "Success: Backup created." : "Success: Using existing backup.",
        `Renderer updated:\n${result.paths.rendererPath}`
    ];

    if (restart) {
        if (restart.restarted) {
            lines.push(`Discord restarted:\n${path.basename(restart.executablePath)}`);
        } else {
            lines.push(`Discord restart skipped:\n${restart.reason ?? "Unknown error"}`);
        }
    }

    const warnings = restart?.stopErrors?.filter(Boolean) ?? [];
    if (warnings.length) {
        lines.push(`Warnings:\n${warnings.join("\n")}`);
    }

    return lines.join("\n\n");
}

function formatInstalledVencordSuccessMessage(result, restart) {
    const lines = [
        result.backupCreated ? "Success: Vencord backup created." : "Success: Using existing Vencord backup.",
        `Renderer updated:\n${result.paths.rendererPath}`
    ];

    if (restart) {
        if (restart.restarted) {
            lines.push(`Discord restarted:\n${path.basename(restart.executablePath)}`);
        } else {
            lines.push(`Discord restart skipped:\n${restart.reason ?? "Unknown error"}`);
        }
    }

    const warnings = restart?.stopErrors?.filter(Boolean) ?? [];
    if (warnings.length) {
        lines.push(`Warnings:\n${warnings.join("\n")}`);
    }

    return lines.join("\n\n");
}

function formatInstalledVencordRestoreMessage(result, restart) {
    const lines = [
        "Success: Restored Vencord renderer from backup.",
        `Backup used:\n${result.paths.rendererBak}`
    ];

    if (restart) {
        if (restart.restarted) {
            lines.push(`Discord restarted:\n${path.basename(restart.executablePath)}`);
        } else {
            lines.push(`Discord restart skipped:\n${restart.reason ?? "Unknown error"}`);
        }
    }

    const warnings = restart?.stopErrors?.filter(Boolean) ?? [];
    if (warnings.length) {
        lines.push(`Warnings:\n${warnings.join("\n")}`);
    }

    return lines.join("\n\n");
}

function formatRestoreSuccessMessage(result, restart) {
    const lines = [
        "Success: Restored from backup.",
        `Backup used:\n${result.paths.asarBak}`
    ];

    if (restart) {
        if (restart.restarted) {
            lines.push(`Discord restarted:\n${path.basename(restart.executablePath)}`);
        } else {
            lines.push(`Discord restart skipped:\n${restart.reason ?? "Unknown error"}`);
        }
    }

    const warnings = restart?.stopErrors?.filter(Boolean) ?? [];
    if (warnings.length) {
        lines.push(`Warnings:\n${warnings.join("\n")}`);
    }

    return lines.join("\n\n");
}

function getSourceFlavorLabel(sourceFlavor) {
    return sourceFlavor === "vencord" ? "Vencord" : "Equicord";
}

function parseArgs(argv) {
    const args = Array.isArray(argv) ? [...argv] : [];
    const options = {
        command: "gui",
        appData: undefined,
        equicordRoot: undefined,
        vencordRoot: undefined,
        repo: undefined,
        restartClient: false,
        clientExe: undefined
    };

    while (args.length) {
        const arg = args.shift();
        if (arg === "--install") options.command = "install";
        else if (arg === "--restore") options.command = "restore";
        else if (arg === "--status") options.command = "status";
        else if (arg === "--install-vencord") options.command = "install-vencord";
        else if (arg === "--restore-vencord") options.command = "restore-vencord";
        else if (arg === "--status-vencord") options.command = "status-vencord";
        else if (arg === "--install-source") options.command = "install-source";
        else if (arg === "--status-source") options.command = "status-source";
        else if (arg === "--gui") options.command = "gui";
        else if (arg === "--appdata") options.appData = args.shift();
        else if (arg === "--equicord-root") options.equicordRoot = args.shift();
        else if (arg === "--vencord-root") options.vencordRoot = args.shift();
        else if (arg === "--repo") options.repo = args.shift();
        else if (arg === "--restart-client") options.restartClient = true;
        else if (arg === "--client-exe") options.clientExe = args.shift();
        else if (arg === "--help" || arg === "-h" || arg === "/?") options.command = "help";
        else throw new Error(`Unknown argument: ${arg}`);
    }

    return options;
}

function printHelp() {
    console.log("FileSplitterPatcher");
    console.log("");
    console.log("Usage:");
    console.log(`  ${getBinaryLabel()}`);
    console.log(`  ${getBinaryLabel()} --gui`);
    console.log(`  ${getBinaryLabel()} --install`);
    console.log(`  ${getBinaryLabel()} --restore`);
    console.log(`  ${getBinaryLabel()} --status`);
    console.log(`  ${getBinaryLabel()} --install-vencord`);
    console.log(`  ${getBinaryLabel()} --restore-vencord`);
    console.log(`  ${getBinaryLabel()} --status-vencord`);
    console.log(`  ${getBinaryLabel()} --install --restart-client`);
    console.log(`  ${getBinaryLabel()} --restore --restart-client`);
    console.log(`  ${getBinaryLabel()} --install-vencord --restart-client`);
    console.log(`  ${getBinaryLabel()} --restore-vencord --restart-client`);
    console.log(`  ${getBinaryLabel()} --install-source --repo <path>`);
    console.log(`  ${getBinaryLabel()} --status-source --repo <path>`);
    console.log("");
    console.log("Options:");
    console.log("  --appdata <path>         Override Equicord data root");
    console.log("  --equicord-root <path>   Override Equicord roaming root");
    console.log("  --vencord-root <path>    Override Vencord roaming root");
    console.log("  --repo <path>            Vencord/Equicord source repo root");
    console.log("  --restart-client         Restart Discord/Equicord after install or restore");
    console.log("  --client-exe <path>      Override client executable path for restart");
}

async function runCli(argv = process.argv.slice(2)) {
    try {
        const options = parseArgs(argv);

        if (options.command === "help") {
            printHelp();
            return;
        }

        if (options.command === "gui") {
            const selection = showGui();
            if (!selection) return;

            if (selection.mode === "installed") {
                const installedOptions = { equicordRoot: selection.path };
                if (selection.action === "status") {
                    const state = status(installedOptions);
                    printStatus(state);
                    showMessage("FileSplitterPatcher", [
                        "Installed Equicord status",
                        `equicord.asar: ${state.asarExists ? "present" : "missing"}`,
                        `backup: ${state.backupExists ? "present" : "missing"}`,
                        `plugin marker: ${state.rendererContainsPlugin ? "present" : "missing"}`
                    ].join("\n"));
                    return;
                }

                if (selection.action === "restore") {
                    const restored = restore(installedOptions);
                    const restart = selection.restartClient ? restartClient(installedOptions) : null;
                    showMessage("FileSplitterPatcher", formatRestoreSuccessMessage(restored, restart));
                    return;
                }

                const installed = await install(installedOptions);
                const restart = selection.restartClient ? restartClient(installedOptions) : null;
                showMessage("FileSplitterPatcher", formatInstalledSuccessMessage(installed, restart));
                return;
            }

            if (selection.mode === "installed-vencord") {
                const installedOptions = { vencordRoot: selection.path };
                if (selection.action === "status") {
                    const state = statusInstalledVencord(installedOptions);
                    printInstalledVencordStatus(state);
                    showMessage("FileSplitterPatcher", [
                        "Installed Vencord status",
                        `renderer.js: ${state.rendererExists ? "present" : "missing"}`,
                        `backup: ${state.backupExists ? "present" : "missing"}`,
                        `patch marker: ${state.rendererContainsPlugin ? "present" : "missing"}`
                    ].join("\n"));
                    return;
                }

                if (selection.action === "restore") {
                    const restored = restoreInstalledVencord(installedOptions);
                    const restart = selection.restartClient ? restartClient(installedOptions) : null;
                    showMessage("FileSplitterPatcher", formatInstalledVencordRestoreMessage(restored, restart));
                    return;
                }

                const installed = installInstalledVencord(installedOptions);
                const restart = selection.restartClient ? restartClient(installedOptions) : null;
                showMessage("FileSplitterPatcher", formatInstalledVencordSuccessMessage(installed, restart));
                return;
            }

            const sourceOptions = { repo: selection.path };
            const sourceFlavorLabel = getSourceFlavorLabel(selection.sourceFlavor);
            if (selection.action === "status") {
                const sourceState = statusSourceRepo(sourceOptions);
                printSourceStatus(sourceState);
                showMessage("FileSplitterPatcher", [
                    `${sourceFlavorLabel} source plugin status`,
                    `index.tsx: ${sourceState.indexExists ? "present" : "missing"}`,
                    `native.ts: ${sourceState.nativeExists ? "present" : "missing"}`
                ].join("\n"));
                return;
            }

            const sourceInstall = installSourceRepo(sourceOptions);
            showMessage("FileSplitterPatcher", `Installed FileSplitter ${sourceFlavorLabel} source plugin into:\n${sourceInstall.pluginDir}`);
            return;
        }

        if (options.command === "status") {
            printStatus(status(options));
            return;
        }

        if (options.command === "status-vencord") {
            printInstalledVencordStatus(statusInstalledVencord(options));
            return;
        }

        if (options.command === "status-source") {
            printSourceStatus(statusSourceRepo(options));
            return;
        }

        if (options.command === "restore") {
            const result = restore(options);
            const restart = options.restartClient ? restartClient(options) : null;
            console.log(`Restored Equicord from backup at ${result.paths.asarBak}`);
            if (options.restartClient) formatRestartLines(restart).forEach(line => console.log(line.replace(/\n/g, " ")));
            return;
        }

        if (options.command === "restore-vencord") {
            const result = restoreInstalledVencord(options);
            const restart = options.restartClient ? restartClient(options) : null;
            console.log(`Restored Vencord renderer from backup at ${result.paths.rendererBak}`);
            if (options.restartClient) formatRestartLines(restart).forEach(line => console.log(line.replace(/\n/g, " ")));
            return;
        }

        if (options.command === "install-source") {
            const result = installSourceRepo(options);
            console.log(`Installed FileSplitter source plugin into ${result.pluginDir}`);
            return;
        }

        if (options.command === "install-vencord") {
            const result = installInstalledVencord(options);
            console.log(result.backupCreated
                ? `Created backup: ${result.paths.rendererBak}`
                : `Using existing backup: ${result.paths.rendererBak}`);
            console.log(`Patched renderer: ${result.paths.rendererPath}`);
            const restart = options.restartClient ? restartClient(options) : null;
            if (options.restartClient) formatRestartLines(restart).forEach(line => console.log(line.replace(/\n/g, " ")));
            console.log("FileSplitter was injected into installed Vencord successfully.");
            return;
        }

        const result = await install(options);
        console.log(result.backupCreated
            ? `Created backup: ${result.paths.asarBak}`
            : `Using existing backup: ${result.paths.asarBak}`);
        console.log(`Patched renderer: ${result.paths.rendererPath}`);
        const restart = options.restartClient ? restartClient(options) : null;
        if (options.restartClient) formatRestartLines(restart).forEach(line => console.log(line.replace(/\n/g, " ")));
        console.log("FileSplitter was injected successfully.");
    } catch (error) {
        const message = error?.stack || error?.message || String(error);
        if ((argv || process.argv.slice(2)).includes("--gui") || !process.argv.slice(2).length) {
            try {
                showMessage("FileSplitterPatcher Error", message, "Error");
            } catch { }
        }
        console.error(message);
        process.exitCode = 1;
    }
}

if (require.main === module) {
    void runCli();
}

module.exports = {
    runCli,
    install,
    installInstalledVencord,
    restore,
    restoreInstalledVencord,
    status
};
