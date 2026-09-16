/**
 * `CatalogPage` 的真实实现 —— 与站点页面打交道的那一层
 *
 * ⚠️ **本模块只能在真机上验证**。这里每一步的时序（等接口响应、等列表渲染、等选择器回读）
 * 都是照着**实测行为**写的, 单测的 DOM 环境复现不了它们。改动本模块后必须跑一次真机抓取。
 *
 * 改造自抓取源项目的一次性脚本, 三条静默错值防线原样保留、一条不得简化:
 * 1. 页面级加载校验（`open` 里等关键元素, 被拦截时显式抛错）
 * 2. 切换区服后回读选择器确认（`waitForZoneSelected`）
 * 3. DOM 与价格接口交叉比对（`waitForListRendered`）
 *
 * 另外按位置而非颜色类定位价格行（见 `parse.ts` 的 `CURRENCY_SELECTORS`）。
 */

import type { Page, Response } from 'playwright-core';
import type { CatalogPage, ZoneExpectation } from './index';
import {
    CURRENCY_SELECTORS,
    parseZoneSpecIds,
    readCurrencyList,
    type CascadeNode,
} from './parse';

/**
 * 价格接口路径。切换区服后页面会重新请求它, 返回左侧列表的全部通货价格。
 * 用它作为「新数据是否到位」的锚点, 替代固定时长的硬等待。
 */
const PRICE_API_PATH = '/c2c-web/v1/common/currency-spu-price-list';

/**
 * 级联属性接口路径。首屏返回「区域/赛季/难度」的完整选项树, 叶子节点带区服标识。
 *
 * ⚠️ 选项树是**按游戏各自返回**的, 换游戏后必须重新解析一次。
 */
const CASCADE_API_PATH = '/c2c-web/v1/common/get-cascade-attribute';

/** 单次网络等待的上限 */
const NETWORK_TIMEOUT_MS = 20_000;

/** 失败重试次数（不含首次尝试） */
const RETRY_TIMES = 2;

/** 重试间隔 */
const RETRY_DELAY_MS = 1000;

/** 等待列表渲染出接口数据: 最多采样 25 次、每次间隔 200ms, 上限 5 秒 */
const RENDER_SAMPLES = 25;
const RENDER_INTERVAL_MS = 200;

/** 页面加载后等待关键元素出现的上限 */
const PAGE_READY_TIMEOUT_MS = 30_000;

/** 点击后等待级联选择器回读为目标区服的上限 */
const SELECTION_TIMEOUT_MS = 10_000;

/** 级联选择器（「区域 / 赛季 / 难度」） */
const CASCADER = '.n-base-selection';
const CASCADER_SUBMENU = '.n-cascader-submenu';
const CASCADER_OPTION_LABEL = '.n-cascader-option__label';

/** 把 playwright 的 page 包成一个 `CatalogPage` */
export function createCatalogPage(page: Page): CatalogPage {
    /** 区服路径 → 区服标识。`open` 时解析, `selectZone` 要用 */
    let zoneSpecIds = new Map<string, string>();

    /**
     * 区服标识 → 「通货名 → 价格」。来自价格接口的响应。
     *
     * 前端对每个区服**只请求一次**: 再次切回本页已加载过的区服会命中缓存、不发请求
     * （实测表现: 切换成功、DOM 也渲染正确, 但等不到任何响应）。因此"等响应"只能作为
     * 获取期望值的手段之一, 拿到过的就复用, 不能当成唯一判据。
     */
    const expectedByZone = new Map<string, ZoneExpectation>();

    return {
        async open(pageUrl: string): Promise<void> {
            // 两个监听都必须在 goto **之前**挂上, 否则会漏掉首屏响应。
            // 统一 catch 掉失败: 拦截场景下由后面的显式校验负责报错
            const cascadeResponse = page
                .waitForResponse(
                    (res) => res.url().includes(CASCADE_API_PATH) && res.status() === 200,
                    { timeout: NETWORK_TIMEOUT_MS },
                )
                .catch(() => null);

            const firstPriceResponse = page
                .waitForResponse(
                    (res) => res.url().includes(PRICE_API_PATH) && res.status() === 200,
                    { timeout: NETWORK_TIMEOUT_MS },
                )
                .catch(() => null);

            await page.goto(pageUrl, { waitUntil: 'domcontentloaded' });

            // ⚠️ **页面级加载校验**（§8.3 硬约束 3）: 站点按 UA 拦截时页面是个空壳,
            // 连 DOM 都渲染不出来。这里必须显式失败, 否则会把整份结果静默写成空值。
            await assertPageReady(page);

            const cascade = await cascadeResponse;
            if (!cascade) {
                throw new Error(
                    `未能获取级联属性接口响应（${CASCADE_API_PATH}），无法确认区服标识，已中止以避免取到旧数据`,
                );
            }

            const cascadeBody = (await cascade.json()) as { data?: CascadeNode[] };
            zoneSpecIds = parseZoneSpecIds(cascadeBody.data);

            // 首屏那次请求返回的就是**默认区服**的价格, 必须收下——否则当默认区服恰好也出现
            // 在 zoneConfigs 里时（火炬之光就是这种情况）, 那个组合必然等到超时。
            const first = await firstPriceResponse;
            if (first) await recordZoneExpected(first, expectedByZone);
        },

        async readZoneSpecIds(): Promise<Map<string, string>> {
            return zoneSpecIds;
        },

        async selectZone(zonePath: string[]): Promise<ZoneExpectation> {
            const specId = zoneSpecIds.get(zonePath.join('/'));
            if (!specId) throw new Error(`页面上没有区服「${zonePath.join(' / ')}」`);

            await withRetry(
                async (attempt) => {
                    // 重试时先收起残留的面板, 保证从干净状态重新选择
                    if (attempt > 0) await resetCascader(page);

                    // 已经拿到过该区服的期望值就不必再等响应（命中缓存的切换不发请求）;
                    // 没拿到过则**先挂监听再触发切换**, 否则会漏掉本次响应。
                    const pending = expectedByZone.has(specId) ? null : waitForZonePrice(page, specId);
                    pending?.catch(() => {});

                    await clickThroughCascader(page, zonePath);
                    // 独立于网络确认选择真的切过去了: 点击未生效时, 下面会读到上一个区服的旧值
                    await waitForZoneSelected(page, zonePath);

                    if (pending) await recordZoneExpected(await pending, expectedByZone);
                },
                `切换到 ${zonePath.join(' / ')}`,
            );

            const expected = expectedByZone.get(specId);
            if (!expected) {
                throw new Error(
                    `未能确认「${zonePath.join(' / ')}」的价格数据（既没捕获到响应, 也没有可复用的期望值）`,
                );
            }

            return expected;
        },

        async readCurrencyRows() {
            return page.evaluate(readCurrencyList, CURRENCY_SELECTORS);
        },

        async waitForListRendered(expected, currencyList) {
            // 只比对**接口真的给了价**的那些通货: 接口没给的不参与, 否则永远对不上
            const comparable = currencyList.filter((name) => expected.has(name));

            for (let i = 0; i < RENDER_SAMPLES; i++) {
                const rows = await page.evaluate(readCurrencyList, CURRENCY_SELECTORS);

                const matched = comparable.every((name) => {
                    const hit = rows.find((item) => item.name === name);
                    if (!hit || hit.priceText === null) return false;

                    const price = Number.parseFloat(hit.priceText.replace(/,/g, ''));

                    return Number.isFinite(price) && isPriceEqual(price, expected.get(name) ?? Number.NaN);
                });

                if (matched) return true;

                await delay(RENDER_INTERVAL_MS);
            }

            return false;
        },
    };
}

/** 关键元素出现才算页面真的加载出来了 */
async function assertPageReady(page: Page): Promise<void> {
    try {
        await page.waitForSelector(CASCADER, { state: 'visible', timeout: PAGE_READY_TIMEOUT_MS });
        await page.waitForSelector(CURRENCY_SELECTORS.itemName, {
            state: 'visible',
            timeout: PAGE_READY_TIMEOUT_MS,
        });
    } catch {
        const text = await page
            .evaluate(() => document.body.innerText.trim().slice(0, 200))
            .catch(() => '');
        const ua = await page.evaluate(() => navigator.userAgent).catch(() => '(读取失败)');

        throw new Error(
            `页面未能加载出内容（可能被拦截）。UA=${ua}\n页面文本片段：${text || '(空)'}`,
        );
    }
}

/**
 * 打开级联选择器, 按顺序逐级点击选中。
 *
 * 每一级的可选项依赖上一级的选择, 因此必须一级一级点击。
 */
async function clickThroughCascader(page: Page, zonePath: string[]): Promise<void> {
    await page.click(CASCADER);
    await page.waitForSelector(CASCADER_SUBMENU, { state: 'visible' });

    for (let level = 0; level < zonePath.length; level++) {
        const value = zonePath[level] as string;

        // 等第 level 列渲染出目标选项本身, 而不是等固定时长——
        // 目标文本就位才说明该列已换成上一级选中后的内容
        await page.waitForFunction(
            ({ level, value }) => {
                const columns = document.querySelectorAll('.n-cascader-submenu');
                if (columns.length <= level) return false;

                return [...(columns[level]?.querySelectorAll('.n-cascader-option__label') ?? [])].some(
                    (el) => (el as HTMLElement).innerText.trim() === value,
                );
            },
            { level, value },
        );

        const option = page
            .locator(CASCADER_SUBMENU)
            .nth(level)
            .locator(`${CASCADER_OPTION_LABEL}:text-is("${value}")`);

        await option.waitFor({ state: 'visible' });
        await option.click();

        // 最后一级点击完成后菜单关闭
        if (level === zonePath.length - 1) {
            await page.waitForSelector(CASCADER_SUBMENU, { state: 'hidden' }).catch(() => {});
        }
    }
}

/**
 * 等待级联选择器**回读**为目标区服。
 *
 * 这一步独立于网络, 有两个作用:
 * 1. 点击被吞掉（选项未渲染完、面板状态残留）时立刻失败, 而不是继续往下读
 * 2. 配合"复用已知期望值": 不走网络等待的路径上, 这是唯一的切换判据
 */
async function waitForZoneSelected(page: Page, zonePath: string[]): Promise<void> {
    const expected = zonePath.join('/');

    try {
        await page.waitForFunction(
            ({ expected }) => {
                const el = document.querySelector('.n-base-selection');
                // 回读文本形如 `国服 / 赛季 / 普通`, 去掉分隔符两侧空白后与路径比较
                return !!el && (el as HTMLElement).innerText.replace(/\s+/g, '') === expected;
            },
            { expected },
            { timeout: SELECTION_TIMEOUT_MS },
        );
    } catch {
        const actual = await page
            .evaluate(
                () => (document.querySelector('.n-base-selection') as HTMLElement | null)?.innerText ?? '(找不到选择器)',
            )
            .catch(() => '(读取失败)');

        throw new Error(
            `切换后选择器显示为「${actual.trim()}」，与目标「${expected}」不符，点击可能未生效`,
        );
    }
}

/**
 * 等待价格接口返回**目标区服**的数据。
 *
 * 区服标识在**请求体**的 `specIds` 里（响应本身不带区服字段）, 据此确认这次响应属于本次
 * 切换, 而不是站点变慢时残留的上一次结果——后者正是固定硬等待最危险的失败模式:
 * 取到旧值且不报错。
 *
 * ⚠️ 必须在触发切换**之前**调用并持有返回的 Promise, 否则会漏掉响应。
 */
function waitForZonePrice(page: Page, specId: string): Promise<Response> {
    return page.waitForResponse(
        (response) => {
            if (response.status() !== 200 || !response.url().includes(PRICE_API_PATH)) return false;

            try {
                const body = JSON.parse(response.request().postData() ?? '');

                return (body.specIds ?? []).includes(specId);
            } catch {
                return false;
            }
        },
        { timeout: NETWORK_TIMEOUT_MS },
    );
}

/**
 * 从价格接口响应中读出「通货名 → 价格」, 按**请求体**里的 `specIds` 记为哪个区服的期望值。
 *
 * 区服标识在请求体里、不在响应里, 所以必须读 `postData()` 才能知道这份数据属于谁。
 */
async function recordZoneExpected(
    response: Response,
    cache: Map<string, ZoneExpectation>,
): Promise<void> {
    let specIds: unknown;
    try {
        specIds = JSON.parse(response.request().postData() ?? '{}').specIds;
    } catch {
        return;
    }

    if (!Array.isArray(specIds) || specIds.length === 0) return;

    const items = (await response.json())?.data?.items ?? [];
    const expected: ZoneExpectation = new Map(
        items.map((item: { spuName: string; rmbPrice: number }) => [item.spuName, item.rmbPrice]),
    );

    for (const specId of specIds) cache.set(String(specId), expected);
}

/** 比较两个价格是否一致。容忍前端可能的浮点格式化差异, 但不容忍数量级偏差 */
function isPriceEqual(a: number, b: number): boolean {
    return Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-6);
}

/** 收起可能处于展开状态的级联面板, 让重试从干净状态重新开始选择 */
async function resetCascader(page: Page): Promise<void> {
    await page.keyboard.press('Escape').catch(() => {});
    await page.waitForSelector(CASCADER_SUBMENU, { state: 'hidden', timeout: 5000 }).catch(() => {});
}

/**
 * 通用重试。用于网络抖动、临时反爬这类「重试即可恢复」的失败,
 * 避免单次偶发失败让整轮抓取作废。
 */
async function withRetry(fn: (attempt: number) => Promise<void>, label: string): Promise<void> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= RETRY_TIMES; attempt++) {
        try {
            return await fn(attempt);
        } catch (error) {
            lastError = error;
            if (attempt === RETRY_TIMES) break;

            // 这是重试前的退避, 不是在等页面, 因此用 setTimeout 而非 page.waitForTimeout
            await delay(RETRY_DELAY_MS);
        }
    }

    throw new Error(`${label} 失败：${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
