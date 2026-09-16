/**
 * Chrome 下载安装器
 *
 * 见设计文档 §8.2 与片 06。**这不是"锦上添花"**: 第 0 步实测的部署机是 Linux 且一个
 * 浏览器都没有, Windows 那两类检测路径在它上面零命中, 安装器是唯一出路。
 *
 * 测试注入假的下载器与解压器: 真下几百 MB 显然不该出现在单测里, 但"多个源怎么回退"
 * "进度怎么报" "全失败了说什么" 这些**决策**必须钉死——它们恰恰是出错时唯一能帮上忙的东西。
 */

import { describe, expect, it } from 'vitest';
import {
    downloadSources,
    installChrome,
    type InstallDeps,
    type InstallProgress,
} from '../../../src/services/browser/chrome-installer';

const VERSION = '141.0.7390.54';

/** 记录尝试过的源、并在第 `failUntil` 个之前一律失败的假下载器 */
function fakeDownloader(failUntil: number, log: string[] = []) {
    return async (source: { name: string }): Promise<Buffer> => {
        log.push(source.name);
        if (log.length <= failUntil) throw new Error(`${source.name} 连接超时`);

        return Buffer.from('zip-bytes');
    };
}

function deps(overrides: Partial<InstallDeps> = {}): InstallDeps {
    return {
        platform: 'linux',
        env: { XDG_DATA_HOME: '/data/xdg' },
        homeDir: '/home/napcat',
        version: VERSION,
        extract: async () => {},
        ...overrides,
    };
}

describe('downloadSources — 多源列表', () => {
    it('**至少三个源**, 且 Google 官方源排在最前', () => {
        const sources = downloadSources(VERSION, 'linux');

        expect(sources.length).toBeGreaterThanOrEqual(3);
        expect(sources[0]?.name).toBe('Google');
    });

    /**
     * ⚠️ 两个名字**不一样**, 混用会 404:
     * URL 的路径段是**下载平台标识**（`linux64`）, 而包目录名（也是 zip 文件名）是
     * `chrome-linux64`。实测踩过: 三个源一起 404, 报错一模一样, 看不出是路径写错。
     */
    it('Linux 的下载 URL 是 `<平台段>/<包名>.zip`——`linux64/chrome-linux64.zip`', () => {
        expect(downloadSources(VERSION, 'linux')[0]?.url).toBe(
            `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/linux64/chrome-linux64.zip`,
        );
    });

    it('Windows 同理: `win64/chrome-win64.zip`', () => {
        expect(downloadSources(VERSION, 'win32')[0]?.url).toBe(
            `https://storage.googleapis.com/chrome-for-testing-public/${VERSION}/win64/chrome-win64.zip`,
        );
    });

    it('npmmirror 两个镜像的路径结构一致（同一份镜像的不同入口）', () => {
        const urls = downloadSources(VERSION, 'linux')
            .filter((source) => source.name.includes('npmmirror'))
            .map((source) => source.url);

        expect(urls).toHaveLength(2);
        for (const url of urls) {
            expect(url).toContain(`/${VERSION}/linux64/chrome-linux64.zip`);
        }
    });

    it('含 npmmirror 的镜像源——境内网络下官方源常常不通', () => {
        const names = downloadSources(VERSION, 'linux').map((source) => source.name);

        expect(names.some((name) => name.includes('npmmirror'))).toBe(true);
    });
});

describe('installChrome — 多源逐个回退', () => {
    it('第一个源失败时**自动换下一个**, 不把失败直接抛给调用方', async () => {
        const log: string[] = [];

        const result = await installChrome(
            deps({ download: fakeDownloader(1, log) }),
        );

        expect(log).toHaveLength(2);
        expect(result.source).toBe(log[1]);
    });

    it('前两个源都失败时还能落到第三个', async () => {
        const log: string[] = [];

        const result = await installChrome(deps({ download: fakeDownloader(2, log) }));

        expect(log).toHaveLength(3);
        expect(result.source).toBe(log[2]);
    });

    it('第一个源就成功时不试后面的——每次尝试都是几百 MB 的流量', async () => {
        const log: string[] = [];

        await installChrome(deps({ download: fakeDownloader(0, log) }));

        expect(log).toHaveLength(1);
    });

    it('**全部源都失败时抛错, 并逐个列出各自的原因**——只说"安装失败"等于没说', async () => {
        const log: string[] = [];

        await expect(
            installChrome(deps({ download: fakeDownloader(99, log) })),
        ).rejects.toThrow(/连接超时/);

        await expect(
            installChrome(deps({ download: fakeDownloader(99, []) })),
        ).rejects.toThrow(/npmmirror/);
    });

    it('解压失败也算该源失败, 继续换下一个源', async () => {
        const log: string[] = [];
        let extracts = 0;

        const result = await installChrome(
            deps({
                download: fakeDownloader(0, log),
                extract: async () => {
                    extracts++;
                    if (extracts === 1) throw new Error('归档损坏');
                },
            }),
        );

        expect(log).toHaveLength(2);
        expect(result.source).toBe(log[1]);
    });
});

describe('installChrome — 进度与落点', () => {
    it('**带进度回调**, 且进度里能看出当前在用哪个源', async () => {
        const seen: InstallProgress[] = [];

        await installChrome(
            deps({
                download: async (_source, onProgress) => {
                    onProgress(50, 100);
                    onProgress(100, 100);

                    return Buffer.from('zip');
                },
                onProgress: (progress) => seen.push({ ...progress }),
            }),
        );

        expect(seen.some((progress) => progress.percent === 0.5)).toBe(true);
        expect(seen.every((progress) => progress.source !== null)).toBe(true);
    });

    it('装到**共享安装路径**下——跨插件复用, 免得每个插件重下几百 MB', async () => {
        const result = await installChrome(deps({ download: fakeDownloader(0) }));

        expect(result.path).toBe('/data/xdg/napcat-chrome/chrome-linux64/chrome');
    });

    it('Windows 上装到 `LOCALAPPDATA` 下的共享路径', async () => {
        const result = await installChrome(
            deps({
                platform: 'win32',
                env: { LOCALAPPDATA: 'D:\\AppData\\Local' },
                homeDir: 'D:\\Users\\napcat',
                download: fakeDownloader(0),
            }),
        );

        expect(result.path).toBe(
            'D:\\AppData\\Local\\napcat-chrome\\chrome-win64\\chrome.exe',
        );
    });

    it('结果里带上版本号——检测阶段要拿它跟实际启动的浏览器对账', async () => {
        const result = await installChrome(deps({ download: fakeDownloader(0) }));

        expect(result.version).toBe(VERSION);
    });
});
