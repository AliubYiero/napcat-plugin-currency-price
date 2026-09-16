/**
 * Chrome for Testing 多源下载安装器
 *
 * 见设计文档 §8.2。⚠️ **这不是"锦上添花"**: 第 0 步实测的部署机是 Linux、一个浏览器都没有,
 * Windows 那两类检测路径在它上面零命中——安装器是让插件能工作的**唯一出路**。
 *
 * 不采用 Playwright 自带的 registry 安装: 内联打包后磁盘上没有
 * `node_modules/playwright-core/cli.js`, 自带的安装入口根本不存在。
 *
 * 装到**共享安装路径**（`sharedInstallRoot`）, 跨插件复用——每个插件各下一份几百 MB 的
 * Chrome 是不可接受的。
 */

import { spawn } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
    sharedExecutablePath,
    sharedInstallRoot,
    sharedPackageDir,
    type DetectOptions,
} from './launcher';

/**
 * Chrome for Testing 的版本（实测存在的稳定版）。
 *
 * 用稳定版而不是内置一个具体内核: 站点只按 UA 主版本号判断, 而 UA 是从**实际启动的浏览器**
 * 读来的（`buildUserAgent(browser.version())`）, 因此版本本身不影响伪装效果。
 *
 * 旧版本在官方源上**不会被删**, 所以这个常量不会自己失效; 想换新版本时改这里即可。
 * 可用的版本清单见 <https://googlechromelabs.github.io/chrome-for-testing/>。
 */
export const DEFAULT_CHROME_VERSION = '153.0.8010.47';

/**
 * **下载平台标识** —— 下载 URL 路径里的那一段。
 *
 * ⚠️ 它与**包目录名**（`sharedPackageDir`, 形如 `chrome-linux64`）不是一回事:
 * 完整路径是 `<版本>/linux64/chrome-linux64.zip`。两处混用会让三个源**一起 404**,
 * 而三条报错长得一模一样, 完全看不出是路径写错了（实测踩过）。
 */
const DOWNLOAD_PLATFORM: Partial<Record<NodeJS.Platform, string>> = {
    linux: 'linux64',
    win32: 'win64',
};

/** 一个下载源 */
export interface InstallSource {
    name: string;
    url: string;
}

/**
 * 下载源列表, 按**尝试顺序**。
 *
 * 官方源排最前（版本最可信）; 后两个是 npmmirror 的镜像——境内网络下官方源常常不通,
 * 而"装不上浏览器"对本插件是致命的。
 */
export function downloadSources(version: string, platform: NodeJS.Platform): InstallSource[] {
    const downloadPlatform = DOWNLOAD_PLATFORM[platform];
    const packageDir = sharedPackageDir(platform);
    if (!downloadPlatform || !packageDir) return [];

    // 例: `153.0.8010.47/linux64/chrome-linux64.zip`
    const tail = `${version}/${downloadPlatform}/${packageDir}.zip`;

    return [
        {
            name: 'Google',
            url: `https://storage.googleapis.com/chrome-for-testing-public/${tail}`,
        },
        {
            name: 'npmmirror CDN',
            url: `https://cdn.npmmirror.com/binaries/chrome-for-testing/${tail}`,
        },
        {
            name: 'npmmirror Registry',
            url: `https://registry.npmmirror.com/-/binary/chrome-for-testing/${tail}`,
        },
    ];
}

export interface InstallProgress {
    phase: 'downloading' | 'extracting' | 'done';
    /** `0`~`1`。总量未知时为 `0`（调用方不该把进度条卡在某个假值上） */
    percent: number;
    /** 当前正在使用的源名; **每个进度都必须带上它**——卡住时用户要知道卡在哪个源 */
    source: string | null;
    message: string;
}

export interface InstallResult {
    /** 装好的可执行文件路径 */
    path: string;
    /** 最终成功的源名 */
    source: string;
    version: string;
}

export interface InstallDeps extends DetectOptions {
    version?: string;
    /** 下载一个源的产物。抛错表示该源不可用, 换下一个 */
    download?: (source: InstallSource, onProgress: (received: number, total: number) => void) => Promise<Buffer>;
    /** 解压归档到目标目录 */
    extract?: (archive: Buffer, targetDir: string) => Promise<void>;
    onProgress?: (progress: InstallProgress) => void;
}

/**
 * 下载并安装 Chrome。**多源逐个回退**: 只有一个源可用就算成功。
 *
 * @throws 所有源都失败时抛出, 错误信息里**逐个列出每个源各自的原因**——
 *         只说一句"安装失败"等于没说, 用户下一步不知道该去查网络、查磁盘还是查权限。
 */
export async function installChrome(deps: InstallDeps = {}): Promise<InstallResult> {
    const platform = deps.platform ?? process.platform;
    const version = deps.version ?? DEFAULT_CHROME_VERSION;

    const executablePath = sharedExecutablePath(deps);
    if (!executablePath) throw new Error(`不支持的平台：${platform}`);

    const targetDir = sharedInstallRoot(deps);
    const download = deps.download ?? defaultDownload;
    const extract = deps.extract ?? defaultExtract;
    const failures: string[] = [];

    for (const source of downloadSources(version, platform)) {
        try {
            deps.onProgress?.({
                phase: 'downloading',
                percent: 0,
                source: source.name,
                message: `正在从 ${source.name} 下载…`,
            });

            const archive = await download(source, (received, total) => {
                deps.onProgress?.({
                    phase: 'downloading',
                    percent: total > 0 ? received / total : 0,
                    source: source.name,
                    message: `正在从 ${source.name} 下载…`,
                });
            });

            deps.onProgress?.({
                phase: 'extracting',
                percent: 1,
                source: source.name,
                message: '正在解压…',
            });

            await extract(archive, targetDir);

            deps.onProgress?.({
                phase: 'done',
                percent: 1,
                source: source.name,
                message: '安装完成',
            });

            return { path: executablePath, source: source.name, version };
        } catch (error) {
            failures.push(`${source.name}：${messageOf(error)}`);
        }
    }

    throw new Error(
        `Chrome 安装失败，所有下载源都不可用：\n${failures.map((line) => `- ${line}`).join('\n')}`,
    );
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

// ==================== 安装状态 ====================

export interface InstallState {
    running: boolean;
    /** 最近一次进度; 从未安装过时为 `null` */
    progress: InstallProgress | null;
    /** 失败原因。**多源逐个回退后的总结**, 见 `installChrome` */
    error: string | null;
    /** 装好后的可执行文件路径 */
    path: string | null;
}

let state: InstallState = idleState();

function idleState(): InstallState {
    return { running: false, progress: null, error: null, path: null };
}

/**
 * 安装能力的注入点。
 *
 * ⚠️ 注入的是**真正下载安装**这一动作, 不是 `runInstall` 本身——状态管理、进度记录、
 * 失败归类都是真实跑的逻辑, 只把"下几百 MB 并解压"换掉。
 */
export const installerDeps = {
    install: installChrome as (deps?: InstallDeps) => Promise<InstallResult>,
};

/** 读安装状态。WebUI 的进度条读它 */
export function getInstallState(): InstallState {
    return state;
}

/** 清空安装状态 */
export function resetInstallState(): void {
    state = idleState();
}

/**
 * 跑一次安装, 把进度与结果记进状态。
 *
 * **调用方不必 `await`**: 下载几百 MB 会让 HTTP 请求悬着, WebUI 是后台跑 + 轮询进度的。
 */
export async function runInstall(deps: InstallDeps = {}): Promise<InstallResult> {
    state = { running: true, progress: null, error: null, path: null };

    try {
        const result = await installerDeps.install({
            ...deps,
            onProgress: (progress) => {
                state = { ...state, progress };
                deps.onProgress?.(progress);
            },
        });

        state = { running: false, progress: state.progress, error: null, path: result.path };

        return result;
    } catch (error) {
        state = { running: false, progress: state.progress, error: messageOf(error), path: null };

        throw error;
    }
}

/** 缺省下载器: 流式读取以便回报进度 */
async function defaultDownload(
    source: InstallSource,
    onProgress: (received: number, total: number) => void,
): Promise<Buffer> {
    const response = await fetch(source.url);
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    if (!response.body) throw new Error('响应没有内容');

    const total = Number(response.headers.get('content-length') ?? 0);
    const chunks: Uint8Array[] = [];
    let received = 0;

    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        chunks.push(chunk);
        received += chunk.length;
        onProgress(received, total);
    }

    return Buffer.concat(chunks);
}

/**
 * 缺省解压器。
 *
 * ⚠️ 用**系统命令**而不是引入 zip 解析库: 发布包只含 `index.mjs`, 多一个依赖就多一份
 * 内联打包的负担。Windows 10 起自带的 `tar`（bsdtar）与 Linux 的 `unzip` 都能处理 zip。
 */
async function defaultExtract(archive: Buffer, targetDir: string): Promise<void> {
    const archivePath = path.join(os.tmpdir(), `napcat-chrome-${process.pid}.zip`);
    fs.mkdirSync(targetDir, { recursive: true });
    fs.writeFileSync(archivePath, archive);

    try {
        await extractWithSystemTool(archivePath, targetDir);
    } finally {
        fs.rmSync(archivePath, { force: true });
    }
}

async function extractWithSystemTool(archivePath: string, targetDir: string): Promise<void> {
    const attempts: Array<[string, string[]]> =
        process.platform === 'win32'
            ? [['tar', ['-xf', archivePath, '-C', targetDir]]]
            : [
                  ['unzip', ['-o', '-q', archivePath, '-d', targetDir]],
                  ['tar', ['-xf', archivePath, '-C', targetDir]],
              ];

    const errors: string[] = [];

    for (const [command, args] of attempts) {
        try {
            await run(command, args);

            return;
        } catch (error) {
            errors.push(`${command}：${messageOf(error)}`);
        }
    }

    throw new Error(`解压失败：${errors.join('；')}`);
}

function run(command: string, args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
        const child = spawn(command, args, { stdio: 'ignore' });
        child.on('error', reject);
        child.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error(`${command} 退出码 ${code}`)),
        );
    });
}
