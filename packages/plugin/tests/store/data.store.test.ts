/**
 * `data.json` —— 最新价格 + 抓取状态
 *
 * 见设计文档 §7.2。本片落定结构、原子写、损坏恢复与两条覆盖规则（成功覆盖 / 失败只记
 * `lastError`）。**新鲜度判定**（读游戏级 `readAt`）在片 05, 但它依据的字段在这里落盘。
 */

import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DataStore, type GameOk } from '../../src/store/data.store';
import { createTestEnv, type TestEnv } from '../helpers/test-env';

let env: TestEnv;
let store: DataStore;

/** 一个成功的游戏抓取结果 */
function okResult(): GameOk {
    return {
        readAt: '2026-09-16T08:00:05.123Z',
        missing: [],
        zones: [
            {
                zone: ['国服', '赛季', '普通'],
                readAt: '2026-09-16T08:00:05.123Z',
                prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
            },
        ],
    };
}

beforeEach(() => {
    env = createTestEnv();
    env.init();
    store = DataStore.getInstance();
});

afterEach(() => {
    env.dispose();
});

describe('DataStore — 落盘与读回', () => {
    it('成功结果落盘, 结构与设计文档 §7.2 一致（`lastError` 补 `null`）', () => {
        store.saveGameResult('流放之路2', okResult());

        expect(JSON.parse(env.readDataFile('data.json') ?? '{}')).toEqual({
            version: 1,
            games: {
                '流放之路2': {
                    readAt: '2026-09-16T08:00:05.123Z',
                    lastError: null,
                    missing: [],
                    zones: [
                        {
                            zone: ['国服', '赛季', '普通'],
                            readAt: '2026-09-16T08:00:05.123Z',
                            prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
                        },
                    ],
                },
            },
        });
    });
});

describe('DataStore — 失败不覆盖（§7.2 规则 2）', () => {
    const ERROR = '切换到 国服 / 赛季 / 普通 失败：Timeout 20000ms exceeded';

    it('本轮失败时 `zones` / `readAt` 保持上一次成功的内容, **只更新 `lastError`**', () => {
        store.saveGameResult('流放之路2', okResult());
        store.saveGameResult('流放之路2', { error: ERROR });

        const game = store.getGame('流放之路2');

        expect(game?.readAt).toBe('2026-09-16T08:00:05.123Z');
        expect(game?.zones).toHaveLength(1);
        expect(game?.lastError).toBe(ERROR);
    });

    it('失败后又成功一次, `lastError` 清回 `null`', () => {
        store.saveGameResult('流放之路2', okResult());
        store.saveGameResult('流放之路2', { error: ERROR });
        store.saveGameResult('流放之路2', okResult());

        expect(store.getGame('流放之路2')?.lastError).toBe(null);
    });

    it('**从未成功抓到过的游戏**失败后不产生条目——没有数据就是没有, 不写半截记录充数', () => {
        // 先落一个别的游戏, 让文件存在——否则"失败的游戏不在文件里"是文件压根不存在造出来的假象
        store.saveGameResult('流放之路2', okResult());
        store.saveGameResult('火炬之光', { error: '页面未能加载出内容（可能被拦截）' });

        expect(store.getGame('火炬之光')).toBe(null);
        expect(Object.keys(store.getGames())).toEqual(['流放之路2']);
    });
});

describe('DataStore — `null` 与 `0` 可区分（§7.2 规则 3）', () => {
    it('落盘后两者仍是不同的值, 不会被归一成同一个', () => {
        store.saveGameResult('流放之路2', {
            readAt: '2026-09-16T08:00:05.123Z',
            missing: ['崇高石'],
            zones: [
                {
                    zone: ['国服', '赛季', '普通'],
                    readAt: '2026-09-16T08:00:05.123Z',
                    prices: [
                        { name: '神圣石', price: 0, unit: '元/个' },
                        { name: '崇高石', price: null, unit: null },
                    ],
                },
            ],
        });

        const prices = store.getGame('流放之路2')?.zones[0]?.prices;

        expect(prices?.[0]).toEqual({ name: '神圣石', price: 0, unit: '元/个' });
        expect(prices?.[1]).toEqual({ name: '崇高石', price: null, unit: null });
    });

    it('**文件里也是分开的**——JSON 天然区分, 清洗层不得把 `null` 归一成 `0`', () => {
        store.saveGameResult('流放之路2', {
            readAt: '2026-09-16T08:00:05.123Z',
            missing: [],
            zones: [
                {
                    zone: ['国服'],
                    readAt: '2026-09-16T08:00:05.123Z',
                    prices: [
                        { name: '神圣石', price: 0, unit: null },
                        { name: '崇高石', price: null, unit: null },
                    ],
                },
            ],
        });

        const raw = env.readDataFile('data.json') ?? '';

        expect(raw).toContain('"price": 0');
        expect(raw).toContain('"price": null');
    });
});

describe('DataStore — 损坏恢复', () => {
    it('文件损坏时备份为 `*.bak` 并初始化为空, **不阻塞启动**', () => {
        const filePath = path.join(env.dataPath, 'data.json');
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(filePath, '{ 这不是 JSON', 'utf-8');

        expect(store.getGames()).toEqual({});
        expect(fs.readFileSync(`${filePath}.bak`, 'utf-8')).toBe('{ 这不是 JSON');
    });

    it('备份之后所有游戏判为过期——文件被重写成空结构, 而不是留一个读不动的坏文件', () => {
        const filePath = path.join(env.dataPath, 'data.json');
        fs.mkdirSync(env.dataPath, { recursive: true });
        fs.writeFileSync(filePath, '{ 坏文件', 'utf-8');

        store.getGames();

        expect(JSON.parse(env.readDataFile('data.json') ?? '{}')).toEqual({ version: 1, games: {} });
    });
});
