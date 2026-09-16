/**
 * 浏览器状态缓存
 *
 * ⚠️ 本片的头号验收项: **轮询 `/chrome/status` 不会触发 `launch()`**。
 * 模板的 WebUI 每 5 秒轮询一次状态; 如果状态查询每次都跑 `launch()`, 只要有人开着面板
 * 就会每 5 秒拉起一次浏览器。**检测与查询必须分离**——这是本模块存在的全部理由。
 *
 * 测试注入「这个路径是不是一个存在的文件」, 因此不碰真实文件系统、也不受"开发机上恰好
 * 装了 Chrome"影响。
 */

import { beforeEach, describe, expect, it } from 'vitest';
import {
    detectBrowserFull,
    detectBrowserLightweight,
    ensureBrowserStatus,
    getBrowserStatus,
    invalidateBrowserStatus,
} from '../../../src/services/browser/status';
import type { DetectOptions } from '../../../src/services/browser/launcher';

const CHROMIUM = '/usr/bin/chromium';

/** 一台"有浏览器"的假机器 */
function withChrome(): DetectOptions {
    return {
        platform: 'linux',
        env: {},
        homeDir: '/home/napcat',
        isFile: (path) => path === CHROMIUM,
    };
}

/** 一台"一个浏览器都没有"的假机器——第 0 步实测的部署机 */
function withoutChrome(): DetectOptions {
    return {
        platform: 'linux',
        env: {},
        homeDir: '/home/napcat',
        isFile: () => false,
    };
}

/** 一个只回答版本号的假浏览器 */
function fakeBrowser(version: string) {
    return { version: () => version, close: async (): Promise<void> => {} };
}

beforeEach(() => {
    invalidateBrowserStatus();
});

describe('浏览器状态缓存 — 查询无副作用', () => {
    it('**`getBrowserStatus` 只读缓存**: 缓存没变时反复查, 结果一模一样', () => {
        detectBrowserLightweight(withoutChrome());

        const first = getBrowserStatus();
        const second = getBrowserStatus();
        const third = getBrowserStatus();

        expect(second).toEqual(first);
        expect(third).toEqual(first);
    });

    it('**反复查询不触发任何检测动作**——这正是每 5 秒轮询时不能做的事', () => {
        let fileChecks = 0;
        detectBrowserLightweight({
            ...withChrome(),
            isFile: (path) => {
                fileChecks++;

                return path === CHROMIUM;
            },
        });

        const checksAfterDetect = fileChecks;
        for (let i = 0; i < 20; i++) getBrowserStatus();

        expect(fileChecks).toBe(checksAfterDetect);
    });

    it('缓存为空时是「尚未检测」, 不是伪造的「不可用」', () => {
        const status = getBrowserStatus();

        expect(status.checkedAt).toBe(null);
        expect(status.available).toBe(false);
    });
});

describe('轻量检测 — 只查文件存在', () => {
    it('找到浏览器时记下路径与来源', () => {
        const status = detectBrowserLightweight(withChrome());

        expect(status).toMatchObject({ available: true, path: CHROMIUM, source: 'system' });
        expect(status.checkedAt).not.toBe(null);
    });

    it('**不 launch, 因此拿不到版本号**——版本要起进程问了才知道', () => {
        expect(detectBrowserLightweight(withChrome()).version).toBe(null);
    });

    it('没有浏览器时记下可读的原因, 供仪表盘如实交代', () => {
        const status = detectBrowserLightweight(withoutChrome());

        expect(status.available).toBe(false);
        expect(status.path).toBe(null);
        expect(status.error).toBeTruthy();
    });
});

describe('完整检测 — 轻量检查通过才跑 launch 验证', () => {
    it('**轻量检查通过时才跑 `launch()`**, 并取回版本号', async () => {
        let launched = 0;

        const status = await detectBrowserFull({
            ...withChrome(),
            launch: async () => {
                launched++;

                return fakeBrowser('141.0.7390.54');
            },
        });

        expect(launched).toBe(1);
        expect(status).toMatchObject({
            available: true,
            path: CHROMIUM,
            version: '141.0.7390.54',
        });
    });

    it('**轻量检查不通过时不跑 `launch()`**——没必要为一次注定失败的验证起一个进程', async () => {
        let launched = 0;

        const status = await detectBrowserFull({
            ...withoutChrome(),
            launch: async () => {
                launched++;

                return fakeBrowser('141.0.7390.54');
            },
        });

        expect(launched).toBe(0);
        expect(status.available).toBe(false);
    });

    it('`launch()` 失败时判为不可用, 并把原因写进状态', async () => {
        const status = await detectBrowserFull({
            ...withChrome(),
            launch: async () => {
                throw new Error("Executable doesn't exist at /usr/bin/chromium");
            },
        });

        expect(status.available).toBe(false);
        expect(status.error).toContain("Executable doesn't exist");
    });

    it('完整检测的结果同样进缓存', async () => {
        await detectBrowserFull({ ...withChrome(), launch: async () => fakeBrowser('141.0.7390.54') });

        expect(getBrowserStatus().version).toBe('141.0.7390.54');
    });
});

describe('ensureBrowserStatus — 缓存为空时补一次轻量检测', () => {
    it('缓存为空时做轻量检测并填充, 使插件刚启动时指令就能拿到状态', () => {
        // 不预填缓存, 直接问
        const status = ensureBrowserStatus({ isFile: () => false });

        expect(status.checkedAt).not.toBe(null);
        expect(getBrowserStatus().checkedAt).not.toBe(null);
    });

    it('缓存已有值时直接用缓存, 不重新检测', () => {
        detectBrowserLightweight(withChrome());

        // 换一个"没有浏览器"的环境来问——只要结果仍是"可用", 就说明没有重新检测
        const status = ensureBrowserStatus(withoutChrome());

        expect(status.available).toBe(true);
        expect(status.path).toBe(CHROMIUM);
    });
});
