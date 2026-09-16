/**
 * WebUI API 端点
 *
 * ⚠️ 本片的**头号验收项**在 `/chrome/status`: 模板的 WebUI 每 5 秒轮询一次状态,
 * 如果状态查询每次都跑 `launch()`, 只要有人开着面板就会每 5 秒拉起一次浏览器。
 * **检测与查询必须分离**。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEFAULT_CONFIG } from '../../src/config';
import { pluginState } from '../../src/core/state';
import { registerApiRoutes, apiServiceDeps } from '../../src/services/api-service';
import {
    detectBrowserLightweight,
    detectBrowserFull,
    invalidateBrowserStatus,
} from '../../src/services/browser/status';
import { installerDeps, resetInstallState } from '../../src/services/browser/chrome-installer';
import type { DetectOptions } from '../../src/services/browser/launcher';
import { DataStore } from '../../src/store/data.store';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;

const CHROMIUM = '/usr/bin/chromium';

const WITH_CHROME: DetectOptions = {
    platform: 'linux',
    env: {},
    homeDir: '/home/napcat',
    isFile: (path) => path === CHROMIUM,
};

const WITHOUT_CHROME: DetectOptions = { ...WITH_CHROME, isFile: () => false };

/** 假浏览器。`version()` 是判定"真的 launch 过"的唯一途径 */
function fakeBrowser(version = '141.0.7390.54') {
    return { version: () => version, close: async (): Promise<void> => {} };
}

beforeEach(() => {
    env = createTestEnv();
    env.init();
    invalidateBrowserStatus();
    resetInstallState();
    pluginState.config = { ...DEFAULT_CONFIG };
    registerApiRoutes(env.ctx);
});

afterEach(() => {
    env.dispose();
});

describe('/chrome/status — 只读缓存（本片头号验收项）', () => {
    it('**连续轮询多次, `launch()` 次数不变**——开着面板不该每 5 秒拉起一次浏览器', async () => {
        let launched = 0;
        await detectBrowserFull({
            ...WITH_CHROME,
            launch: async () => {
                launched++;

                return fakeBrowser();
            },
        });
        expect(launched).toBe(1);

        for (let i = 0; i < 10; i++) await env.callRoute('GET /chrome/status');

        expect(launched).toBe(1);
    });

    it('轮询同样**不做文件检测**——缓存有了就只读缓存', async () => {
        let fileChecks = 0;
        detectBrowserLightweight({
            ...WITH_CHROME,
            isFile: (path) => {
                fileChecks++;

                return path === CHROMIUM;
            },
        });

        const afterDetect = fileChecks;
        for (let i = 0; i < 5; i++) await env.callRoute('GET /chrome/status');

        expect(fileChecks).toBe(afterDetect);
    });

    it('返回可用性、路径与版本', async () => {
        await detectBrowserFull({ ...WITH_CHROME, launch: async () => fakeBrowser('141.0.7390.54') });

        const { body } = await env.callRoute('GET /chrome/status');

        expect(body).toMatchObject({
            code: 0,
            data: { available: true, path: CHROMIUM, version: '141.0.7390.54' },
        });
    });

    it('浏览器不可用时如实返回, 并带上原因', async () => {
        detectBrowserLightweight(WITHOUT_CHROME);

        const { body } = await env.callRoute('GET /chrome/status');

        expect(body).toMatchObject({ code: 0, data: { available: false } });
        expect((body as { data: { error: string } }).data.error).toBeTruthy();
    });
});

describe('/chrome/detect — 执行检测并刷新缓存', () => {
    const realDetect = apiServiceDeps.detectBrowserFull;

    afterEach(() => {
        apiServiceDeps.detectBrowserFull = realDetect;
    });

    it('执行检测并返回路径与版本', async () => {
        apiServiceDeps.detectBrowserFull = () => detectBrowserFull({
            ...WITH_CHROME,
            launch: async () => fakeBrowser('141.0.7390.54'),
        });

        const { body } = await env.callRoute('POST /chrome/detect');

        expect(body).toMatchObject({
            code: 0,
            data: { available: true, path: CHROMIUM, version: '141.0.7390.54' },
        });
    });

    it('检测结果进缓存——之后 `/chrome/status` 能读到', async () => {
        apiServiceDeps.detectBrowserFull = () => detectBrowserFull({
            ...WITH_CHROME,
            launch: async () => fakeBrowser('141.0.7390.54'),
        });

        await env.callRoute('POST /chrome/detect');
        const { body } = await env.callRoute('GET /chrome/status');

        expect(body).toMatchObject({ data: { available: true, version: '141.0.7390.54' } });
    });
});

describe('/chrome/install 与进度', () => {
    const realInstall = installerDeps.install;

    afterEach(() => {
        installerDeps.install = realInstall;
    });

    it('没装过时进度是「未在安装」, 不是空响应', async () => {
        const { body } = await env.callRoute('GET /chrome/install/progress');

        expect(body).toMatchObject({ code: 0, data: { running: false, error: null } });
    });

    it('**触发安装**后能读到进度`, 且进度带当前源名', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        installerDeps.install = async (deps) => {
            deps?.onProgress?.({
                phase: 'downloading',
                percent: 0.4,
                source: 'npmmirror CDN',
                message: '正在下载…',
            });
            await gate;

            return { path: CHROMIUM, source: 'npmmirror CDN', version: '141' };
        };

        await env.callRoute('POST /chrome/install');

        const { body } = await env.callRoute('GET /chrome/install/progress');
        expect(body).toMatchObject({
            data: { running: true, progress: { percent: 0.4, source: 'npmmirror CDN' } },
        });

        release();
    });

    it('安装失败时进度里留下**可读的失败原因**（多源逐个回退后的总结）', async () => {
        installerDeps.install = async () => {
            throw new Error('Chrome 安装失败，所有下载源都不可用：\n- Google：连接超时');
        };

        await env.callRoute('POST /chrome/install');
        // 安装是后台跑的, 让出一次事件循环等它落定
        await new Promise((resolve) => setTimeout(resolve, 0));

        const { body } = await env.callRoute('GET /chrome/install/progress');
        expect((body as { data: { error: string; running: boolean } }).data.error).toContain(
            '所有下载源都不可用',
        );
        expect((body as { data: { running: boolean } }).data.running).toBe(false);
    });
});

describe('/status — 各游戏最后抓取时间', () => {
    it('带上每个游戏自己的 `readAt`——仪表盘要显示"这个游戏的数据是什么时候的"', async () => {
        DataStore.getInstance().saveGameResult('流放之路2', {
            readAt: '2026-09-16T08:00:05.123Z',
            missing: [],
            zones: [],
        });

        const { body } = await env.callRoute('GET /status');

        expect(body).toMatchObject({
            data: { games: [{ name: '流放之路2', readAt: '2026-09-16T08:00:05.123Z' }] },
        });
    });
});
