/**
 * 浏览器检测 —— 按平台分派的路径表与检测顺序
 *
 * 见设计文档 §8.2 与片 06。检测顺序是 `chromeExecutablePath` 配置 → 共享安装路径
 * → 系统浏览器常见路径 (片 06 验收项)。
 *
 * ⚠️ **不能只写 Windows**。第 0 步实测的部署机是 Linux 且一个浏览器都没有,
 * Windows 那两类路径在它上面**零命中**——检测表漏了 Linux, 表现是"配置明明没错却永远
 * 说浏览器不可用"。
 *
 * 测试注入「这个路径是不是一个存在的文件」的回答, 因此不碰真实文件系统,
 * 也能在任意平台上断言另一个平台的路径表。
 */

import { describe, expect, it } from 'vitest';
import {
    buildUserAgent,
    detectChrome,
    isMissingBrowserError,
    launchBrowser,
    type BrowserLauncher,
    type DetectOptions,
} from '../../../src/services/browser/launcher';

/** 造一个只认给定路径的假文件系统 */
function filesOf(...paths: string[]): (path: string) => boolean {
    const set = new Set(paths);

    return (path) => set.has(path);
}

/** 检测选项: 缺省是一片空白的 Linux 部署机 */
function opts(overrides: Partial<DetectOptions> = {}): DetectOptions {
    return {
        platform: 'linux',
        env: {},
        homeDir: '/home/napcat',
        isFile: () => false,
        ...overrides,
    };
}

describe('detectChrome — 检测顺序', () => {
    it('配置的 chromeExecutablePath 存在时直接用它, 不继续往下探测', () => {
        const configured = '/opt/my-chrome/chrome';

        const found = detectChrome(configured, opts({ isFile: filesOf(configured) }));

        expect(found).toEqual({ path: configured, source: 'config' });
    });

    it('配置的路径**不存在**时继续往下探测, 而不是就此判定浏览器不可用', () => {
        const found = detectChrome('/gone/chrome', opts({ isFile: () => false }));

        expect(found).toBe(null);
    });
});

describe('detectChrome — 共享安装路径', () => {
    /** Chrome for Testing 解压后的布局: 包一层平台目录 */
    const LINUX_SHARED = '/data/xdg/napcat-chrome/chrome-linux64/chrome';
    const WIN_SHARED = 'D:\\AppData\\Local\\napcat-chrome\\chrome-win64\\chrome.exe';

    it('Linux: 落在 `XDG_DATA_HOME` 下, **不是** `LOCALAPPDATA`', () => {
        const found = detectChrome(
            '',
            opts({
                env: { XDG_DATA_HOME: '/data/xdg' },
                isFile: filesOf(LINUX_SHARED),
            }),
        );

        expect(found).toEqual({ path: LINUX_SHARED, source: 'shared' });
    });

    it('Linux: 没设 `XDG_DATA_HOME` 时回退到 `~/.local/share`', () => {
        const fallback = '/home/napcat/.local/share/napcat-chrome/chrome-linux64/chrome';

        const found = detectChrome('', opts({ env: {}, isFile: filesOf(fallback) }));

        expect(found).toEqual({ path: fallback, source: 'shared' });
    });

    it('Windows: 落在 `LOCALAPPDATA` 下', () => {
        const found = detectChrome(
            '',
            opts({
                platform: 'win32',
                env: { LOCALAPPDATA: 'D:\\AppData\\Local' },
                homeDir: 'D:\\Users\\napcat',
                isFile: filesOf(WIN_SHARED),
            }),
        );

        expect(found).toEqual({ path: WIN_SHARED, source: 'shared' });
    });

    it('共享安装路径**优先于**系统浏览器——插件装的那份是自己管得住的', () => {
        const found = detectChrome(
            '',
            opts({
                env: { XDG_DATA_HOME: '/data/xdg' },
                isFile: filesOf(LINUX_SHARED, '/usr/bin/google-chrome'),
            }),
        );

        expect(found).toEqual({ path: LINUX_SHARED, source: 'shared' });
    });
});

describe('detectChrome — 系统浏览器常见路径', () => {
    it('Linux: 认出发行版常见的 chrome / chromium 位置', () => {
        const found = detectChrome('', opts({ isFile: filesOf('/usr/bin/chromium-browser') }));

        expect(found).toEqual({ path: '/usr/bin/chromium-browser', source: 'system' });
    });

    it('Linux: `/snap/bin/chromium` 这类非 `/usr/bin` 的位置也在表内', () => {
        const found = detectChrome('', opts({ isFile: filesOf('/snap/bin/chromium') }));

        expect(found).toEqual({ path: '/snap/bin/chromium', source: 'system' });
    });

    it('Windows: 认出发行版常见的 Chrome 位置', () => {
        const chrome = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

        const found = detectChrome(
            '',
            opts({
                platform: 'win32',
                env: { ProgramFiles: 'C:\\Program Files' },
                homeDir: 'C:\\Users\\napcat',
                isFile: filesOf(chrome),
            }),
        );

        expect(found).toEqual({ path: chrome, source: 'system' });
    });

    it('Windows: 装了 Edge 也能用（同为 Chromium 内核）', () => {
        const edge = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';

        const found = detectChrome(
            '',
            opts({
                platform: 'win32',
                env: { 'ProgramFiles(x86)': 'C:\\Program Files (x86)' },
                homeDir: 'C:\\Users\\napcat',
                isFile: filesOf(edge),
            }),
        );

        expect(found).toEqual({ path: edge, source: 'system' });
    });

    it('**一个浏览器都没有的部署机**返回 null——这正是第 0 步实测的处境', () => {
        expect(detectChrome('', opts({ isFile: () => false }))).toBe(null);
    });
});

describe('launchBrowser — 启动', () => {
    /** 记下启动参数的假启动器 */
    function recordingLauncher(): { calls: Array<Record<string, unknown>>; launcher: BrowserLauncher } {
        const calls: Array<Record<string, unknown>> = [];

        return {
            calls,
            launcher: async (launchOptions) => {
                calls.push(launchOptions);

                return {} as never;
            },
        };
    }

    it('**一律显式传 `executablePath`**——不传 playwright 会去找它自带的浏览器', async () => {
        const { calls, launcher } = recordingLauncher();

        await launchBrowser('/usr/bin/chromium', launcher);

        expect(calls).toEqual([{ executablePath: '/usr/bin/chromium', headless: true }]);
    });
});

describe('isMissingBrowserError — 「浏览器未装」的识别', () => {
    it('playwright 点名 `chromium_headless_shell-<rev>` 时, 这是"没装"而不是"配置错了"', () => {
        const error = new Error(
            "browserType.launch: Executable doesn't exist at " +
                '/root/.cache/ms-playwright/chromium_headless_shell-1187/chrome-linux/headless_shell',
        );

        expect(isMissingBrowserError(error)).toBe(true);
    });

    it('`Executable doesn\'t exist` 的其它浏览器名同样算没装', () => {
        const error = new Error(
            "browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1187/chrome-linux/chrome",
        );

        expect(isMissingBrowserError(error)).toBe(true);
    });

    it('普通的启动失败**不算**没装——混为一谈会让用户去重装浏览器而问题另有其因', () => {
        expect(isMissingBrowserError(new Error('Target page, context or browser has been closed'))).toBe(
            false,
        );
        expect(isMissingBrowserError(new Error('spawn EACCES'))).toBe(false);
    });

    it('非 Error 的抛出物也能判定, 不抛二次异常', () => {
        expect(isMissingBrowserError('chromium_headless_shell-1187')).toBe(true);
        expect(isMissingBrowserError(undefined)).toBe(false);
    });
});

describe('buildUserAgent — UA 伪装（§15）', () => {
    it('**不含 `HeadlessChrome`**——站点按 UA 拦截, 含它的文档请求直接 405', () => {
        expect(buildUserAgent('141.0.7390.54')).not.toContain('HeadlessChrome');
    });

    it('按真实内核主版本号生成, 后三段补 0（写死版本号本身就是特征）', () => {
        expect(buildUserAgent('141.0.7390.54')).toBe(
            'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
                '(KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36',
        );
    });

    it('版本号字符串形态就是 `主版本.次.构建.补丁`, 取主版本号即可', () => {
        expect(buildUserAgent('118.0.5993.70')).toContain('Chrome/118.0.0.0');
    });
});
