/**
 * 浏览器检测与启动
 *
 * 见设计文档 §8.2。本插件的抓取走浏览器自动化 (ADR-0001), 因此"机器上有没有浏览器"
 * 是插件能否工作的前提。
 *
 * ⚠️ **只做精简版**: 不做远程 `wsEndpoint` 连接、不做页面信号量、不做健康检查、
 * 不做指数退避重连——本插件串行、单页、用完即关 (设计文档 §2 非目标)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
// 只取类型: `import type` 会被编译期擦除, 不会把 playwright-core 拖进运行期依赖
import type { Browser } from 'playwright-core';

/** 浏览器是从哪一档找到的。用于 WebUI 上如实交代来源, 也用于排查"为什么选了这个" */
export type BrowserSource = 'config' | 'shared' | 'system';

export interface BrowserInfo {
    path: string;
    source: BrowserSource;
}

/** 检测的可注入边界。生产代码用缺省值, 测试注入假件以免碰真实文件系统 */
export interface DetectOptions {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    /** 该路径是否是一个存在的文件 */
    isFile?: (path: string) => boolean;
}

/** 缺省的文件检查: 只认**存在的文件**, 目录不算 */
function defaultIsFile(candidate: string): boolean {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/** 按平台选 `path` 实现: 测试要在任意平台上断言另一个平台的路径表 */
function pathFor(platform: NodeJS.Platform) {
    return platform === 'win32' ? path.win32 : path.posix;
}

function resolveOptions(options: DetectOptions) {
    return {
        platform: options.platform ?? process.platform,
        env: options.env ?? process.env,
        homeDir: options.homeDir ?? os.homedir(),
    };
}

// ==================== 共享安装路径 ====================

/**
 * 共享安装目录名
 *
 * **共享**是重点: 目录固定在用户级数据目录下、不含插件名, 因此本插件装的浏览器
 * 其它 NapCat 插件也能用, 反之亦然。每个插件各下一份几百 MB 的 Chrome 是不可接受的。
 */
export const SHARED_INSTALL_DIRNAME = 'napcat-chrome';

/** Chrome for Testing 解压后包了一层平台目录, 两种平台的目录名与可执行文件名都不同 */
const SHARED_PACKAGE_DIR: Partial<Record<NodeJS.Platform, string>> = {
    linux: 'chrome-linux64',
    win32: 'chrome-win64',
};

const SHARED_EXECUTABLE_NAME: Partial<Record<NodeJS.Platform, string>> = {
    linux: 'chrome',
    win32: 'chrome.exe',
};

/**
 * 共享安装根目录。
 *
 * ⚠️ **按平台分派**: Linux 上落 `XDG_DATA_HOME`（缺省 `~/.local/share`）, Windows 上落
 * `LOCALAPPDATA`。写死 `LOCALAPPDATA` 是本项目第 0 步实测踩到的坑——部署机是 Linux,
 * 那条路径**零命中**, 而表现只是"浏览器永远不可用", 看不出是路径表写错了。
 */
export function sharedInstallRoot(options: DetectOptions = {}): string {
    const { platform, env, homeDir } = resolveOptions(options);
    const platformPath = pathFor(platform);

    if (platform === 'win32') {
        const base = env.LOCALAPPDATA || platformPath.join(homeDir, 'AppData', 'Local');

        return platformPath.join(base, SHARED_INSTALL_DIRNAME);
    }

    const base = env.XDG_DATA_HOME || platformPath.join(homeDir, '.local', 'share');

    return platformPath.join(base, SHARED_INSTALL_DIRNAME);
}

/**
 * 共享安装路径下**应该**出现的可执行文件。
 *
 * 检测与安装共用这一个函数: 安装器往哪写、检测器去哪找, 必须是同一个答案。
 * 未知平台返回 `null`（本插件只声明支持 Windows 与 Linux）。
 */
export function sharedExecutablePath(options: DetectOptions = {}): string | null {
    const { platform } = resolveOptions(options);
    const packageDir = SHARED_PACKAGE_DIR[platform];
    const executableName = SHARED_EXECUTABLE_NAME[platform];
    if (!packageDir || !executableName) return null;

    return pathFor(platform).join(sharedInstallRoot(options), packageDir, executableName);
}

/** 共享安装路径下的候选可执行文件（未知平台为空） */
function sharedCandidates(options: DetectOptions): string[] {
    const candidate = sharedExecutablePath(options);

    return candidate ? [candidate] : [];
}

/** Chrome for Testing 解压后包的那层平台目录名; 未知平台为 `null` */
export function sharedPackageDir(platform: NodeJS.Platform): string | null {
    return SHARED_PACKAGE_DIR[platform] ?? null;
}

// ==================== 系统浏览器常见路径 ====================

/** Linux 发行版常见的浏览器位置, 按探测顺序 */
const LINUX_SYSTEM_PATHS = [
    '/usr/bin/google-chrome',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/snap/bin/chromium',
    '/opt/google/chrome/chrome',
];

/**
 * Windows 常见的浏览器位置, 按探测顺序。
 *
 * Edge 也在表内: 同为 Chromium 内核, 能用就不必让用户再装一个。
 */
function windowsSystemPaths(env: NodeJS.ProcessEnv, homeDir: string): string[] {
    const programFiles = env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = env.LOCALAPPDATA || path.win32.join(homeDir, 'AppData', 'Local');

    return [
        path.win32.join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.win32.join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.win32.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
        path.win32.join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
        path.win32.join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
}

/** 系统浏览器候选路径（未知平台为空——本插件只声明支持 Windows 与 Linux） */
function systemCandidates(options: DetectOptions): string[] {
    const { platform, env, homeDir } = resolveOptions(options);

    if (platform === 'win32') return windowsSystemPaths(env, homeDir);
    if (platform === 'linux') return LINUX_SYSTEM_PATHS;

    return [];
}

/**
 * 按检测顺序找一个可用的浏览器。
 *
 * 顺序是 `chromeExecutablePath` 配置 → 共享安装路径 → 系统浏览器常见路径。
 * 配置排最前是因为它是用户**显式指定**的: 用户手填了路径却被自动检测顶掉, 是最难排查的
 * 一类问题。
 *
 * @param configuredPath `chromeExecutablePath` 配置值, 空串表示没配
 * @returns 找到的浏览器; 都没有时 `null`（调用方据此报"服务不可用"）
 */
export function detectChrome(configuredPath: string, options: DetectOptions = {}): BrowserInfo | null {
    const { isFile = defaultIsFile } = options;

    if (configuredPath && isFile(configuredPath)) {
        return { path: configuredPath, source: 'config' };
    }

    for (const candidate of sharedCandidates(options)) {
        if (isFile(candidate)) return { path: candidate, source: 'shared' };
    }

    for (const candidate of systemCandidates(options)) {
        if (isFile(candidate)) return { path: candidate, source: 'system' };
    }

    return null;
}

export { defaultIsFile };

// ==================== UA 伪装 ====================

/**
 * 按真实内核版本生成 Chrome UA。
 *
 * ⚠️ **站点按 UA 拦截**: UA 里含 "HeadlessChrome" 时文档请求直接返回 405, 页面连 DOM
 * 都渲染不出来（不是慢, 是被拒）。因此无头模式必须伪造 UA。
 *
 * 按**真实内核版本**生成而不是写死一个版本号: 版本号与内核能力不符本身就是特征。
 * 只取主版本号, 后三段补 0——真实 Chrome 的 UA 也正是这个形态 (设计文档 §15)。
 */
export function buildUserAgent(browserVersion: string): string {
    const major = browserVersion.split('.')[0];

    return (
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
        `(KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`
    );
}

// ==================== 启动 ====================

/** 真正执行启动的边界。抽出来是为了让"参数到底传没传对"可单测, 而不必真起一个浏览器 */
export type BrowserLauncher = (options: {
    executablePath: string;
    headless: boolean;
}) => Promise<Browser>;

/**
 * 缺省启动器: 动态加载 `playwright-core`。
 *
 * 用**动态** import 而非顶层静态 import, 是为了让本模块的纯逻辑（检测表）能单独单测:
 * 顶层 import 会让每个引用到本模块的测试都付上加载这个重依赖的代价。
 * 打包侧无碍——`vite.config.ts` 设了 `inlineDynamicImports`, 动态 import 会内联进单入口。
 */
const playwrightLauncher: BrowserLauncher = async (options) => {
    const { chromium } = await import('playwright-core');

    return chromium.launch(options);
};

/**
 * 启动浏览器。
 *
 * ⚠️ **`executablePath` 一律显式传**。不给的话 playwright 会去找它自带的浏览器, 而
 * 1.63 的 headless 要的是 `chromium_headless_shell-<rev>`——它与 `chromium-<rev>` 是
 * **两个独立下载物**。本插件既不用自带浏览器（宿主不为插件装依赖）, 也不走 playwright
 * 自带的 registry 安装（内联打包后磁盘上没有 `node_modules/playwright-core/cli.js`）。
 * 凡遇到"明明装了浏览器却仍报找不到", 先核对这两个名字。
 */
export async function launchBrowser(
    executablePath: string,
    launcher: BrowserLauncher = playwrightLauncher,
): Promise<Browser> {
    return launcher({ executablePath, headless: true });
}

/**
 * 判断启动失败是不是「这台机器上没有浏览器」。
 *
 * 区分的意义在于**给用户的下一步动作不同**: 没装 → 去 WebUI 点「安装 Chrome」;
 * 其它失败 → 装一遍也没用, 得看日志。混为一谈会让用户反复重装浏览器而问题另有其因。
 *
 * `chromium_headless_shell` 是实测报错点名的那个（见 §8.2）: 它出现时往往意味着
 * 调用方**没传** `executablePath`, 而不是机器上真没有浏览器。
 */
export function isMissingBrowserError(error: unknown): boolean {
    const message = error instanceof Error ? error.message : String(error ?? '');

    return (
        /executable doesn't exist/i.test(message) ||
        /chromium(_headless_shell)?-\d+/i.test(message)
    );
}
