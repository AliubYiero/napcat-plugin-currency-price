/**
 * 浏览器状态缓存
 *
 * ⚠️ **检测与查询必须分离**（设计文档 §13）。模板的 WebUI 每 5 秒轮询一次状态; 如果状态
 * 查询每次都跑 `launch()`, 只要有人开着面板就会**每 5 秒拉起一次浏览器**。因此:
 *
 * - `getBrowserStatus()` —— **只读缓存, 零副作用**。WebUI 轮询、指令判断走这里。
 * - `detectBrowserLightweight()` —— 只查文件是否存在。同步, 不起进程。
 * - `detectBrowserFull()` —— 轻量检查 + `launch()` 完整验证。**只由 `/chrome/detect` 触发**。
 */

import { pluginState } from '../../core/state';
import {
    detectChrome,
    launchBrowser,
    type BrowserSource,
    type DetectOptions,
} from './launcher';

/** `launch()` 完整验证的超时。起一个浏览器进程不该让请求悬着 */
const VERIFY_TIMEOUT_MS = 5000;

export interface BrowserStatus {
    available: boolean;
    /** 可执行文件路径; 未找到时为 `null` */
    path: string | null;
    /** 从哪一档找到的（配置 / 共享安装 / 系统） */
    source: BrowserSource | null;
    /** 浏览器版本。**只有完整检测（launch 过）才有**, 轻量检测时为 `null` */
    version: string | null;
    /** 最近一次检测时刻 (ISO 8601 UTC); **从未检测过时为 `null`** */
    checkedAt: string | null;
    /** 不可用的原因, 供仪表盘如实交代 */
    error: string | null;
}

/** 尚未检测过的状态。**不是**"不可用"——两者在仪表盘上要能分开说 */
const UNKNOWN_STATUS: BrowserStatus = {
    available: false,
    path: null,
    source: null,
    version: null,
    checkedAt: null,
    error: null,
};

let cache: BrowserStatus | null = null;

/**
 * 读浏览器状态。
 *
 * ⚠️ **只读缓存, 不做任何检测**。这是每 5 秒被轮询的那个入口。
 */
export function getBrowserStatus(): BrowserStatus {
    return cache ?? UNKNOWN_STATUS;
}

/**
 * 读状态, 缓存为空时补一次**轻量检测**。
 *
 * 补这一次是必要的: 否则插件刚启动时指令会一直说"服务不可用", 直到有人去 WebUI 点一次
 * 检测。轻量检测只查文件存在, 不起浏览器进程。
 */
export function ensureBrowserStatus(deps: DetectOptions = {}): BrowserStatus {
    return cache ?? detectBrowserLightweight(deps);
}

/** 清空缓存。配置变更（换了 `chromeExecutablePath`）后要调 */
export function invalidateBrowserStatus(): void {
    cache = null;
}

/** 轻量检测: 按检测顺序找一个存在的浏览器文件。同步、不起进程 */
export function detectBrowserLightweight(deps: DetectOptions = {}): BrowserStatus {
    const found = detectChrome(pluginState.config.chromeExecutablePath ?? '', deps);

    cache = found
        ? {
              available: true,
              path: found.path,
              source: found.source,
              version: null,
              checkedAt: new Date().toISOString(),
              error: null,
          }
        : {
              available: false,
              path: null,
              source: null,
              version: null,
              checkedAt: new Date().toISOString(),
              error: '未找到可用的浏览器',
          };

    return cache;
}

/** 一个刚起好的浏览器, 只要够取版本号并关掉 */
interface LaunchedBrowser {
    version(): string;
    close(): Promise<void>;
}

export interface VerifyDeps extends DetectOptions {
    /** `launch()` 完整验证。缺省走真实启动; 测试注入假件 */
    launch?: (executablePath: string) => Promise<LaunchedBrowser>;
}

/**
 * 完整检测: 轻量检查 **→** `launch()` 验证, 然后刷新缓存。
 *
 * ⚠️ **轻量检查通过才跑 `launch()`**——为一次注定失败的验证起一个进程没有意义。
 * `launch()` 有 `VERIFY_TIMEOUT_MS` 超时, 免得请求一直悬着。
 */
export async function detectBrowserFull(deps: VerifyDeps = {}): Promise<BrowserStatus> {
    const lightweight = detectBrowserLightweight(deps);
    if (!lightweight.available || !lightweight.path) return lightweight;

    const launch = deps.launch ?? ((executablePath: string) => launchBrowser(executablePath));

    try {
        const browser = await withTimeout(
            launch(lightweight.path),
            VERIFY_TIMEOUT_MS,
            `启动验证超时（${VERIFY_TIMEOUT_MS}ms）`,
        );

        const version = browser.version();
        await browser.close().catch(() => {});

        cache = { ...lightweight, version, checkedAt: new Date().toISOString(), error: null };
    } catch (error) {
        // 路径找到了但起不来: 版本不匹配、依赖缺失、权限不足……对用户而言都归为"不可用",
        // 但**原因要留下来**——装一遍浏览器解决不了权限问题
        cache = {
            available: false,
            path: lightweight.path,
            source: lightweight.source,
            version: null,
            checkedAt: new Date().toISOString(),
            error: error instanceof Error ? error.message : String(error),
        };
    }

    return cache;
}

function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;

    const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(message)), ms);
    });

    return Promise.race([promise, timeout]).finally(() => {
        if (timer) clearTimeout(timer);
    });
}
