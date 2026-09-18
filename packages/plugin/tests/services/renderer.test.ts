/**
 * 消息渲染器（片 09, §10.2）
 *
 * 纯函数: 给数据、出文本。`price` 展示与定时推送**共用本模块**, 因此模板规则在这里
 * 逐条钉死——两个场景长得不一样, 只应该是数据不一样。
 */

import { describe, expect, it } from 'vitest';
import { renderGame } from '../../src/services/renderer';
import { formatLocalTime } from '../../src/utils/time';
import type { GameRecord } from '../../src/store/data.store';

/** 造一份游戏记录。默认是"一次成功抓取", 各区服与游戏级 readAt 刻意不同 */
function record(overrides: Partial<GameRecord> = {}): GameRecord {
    return {
        readAt: '2026-09-16T08:00:05.123Z',
        lastError: null,
        missing: [],
        zones: [
            {
                zone: ['国服', '赛季', '普通'],
                readAt: '2026-09-16T08:00:01.000Z',
                prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
            },
        ],
        ...overrides,
    };
}

describe('renderGame — 头部', () => {
    it('抓取失败、回退旧数据时头部加「（数据未更新）」', () => {
        const header = renderGame('流放之路2', record(), { notUpdated: true }).split('\n')[0];

        expect(header).toMatch(/实时千岛通货价格（数据未更新）$/);
    });

    it('头部时间是**游戏级** `readAt`——区服级的留在数据文件里, 显示出来是噪音', () => {
        const gameReadAt = '2026-09-16T08:00:05.123Z';
        const zoneReadAt = '2026-09-16T07:59:30.000Z';

        const header = renderGame(
            '流放之路2',
            record({
                readAt: gameReadAt,
                zones: [
                    {
                        zone: ['国服'],
                        readAt: zoneReadAt,
                        prices: [{ name: '神圣石', price: 1, unit: '元/个' }],
                    },
                ],
            }),
        ).split('\n')[0];

        expect(header).toContain(formatLocalTime(gameReadAt));
        expect(header).not.toContain(formatLocalTime(zoneReadAt));
    });
});

describe('renderGame — 区服组合块', () => {
    it('**层数随配置自适应**: 火炬之光两级、流放之路三级都一样渲染', () => {
        const text = renderGame(
            '流放之路2',
            record({
                zones: [
                    { zone: ['国服', '赛季'], readAt: '2026-09-16T08:00:00.000Z', prices: [] },
                    {
                        zone: ['国服', '赛季', '普通'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [],
                    },
                ],
            }),
        );

        expect(text).toContain('【国服 / 赛季】');
        expect(text).toContain('【国服 / 赛季 / 普通】');
    });

    it('**整块都没取到时仍显示标题**——否则用户会以为这个区服没在抓', () => {
        const text = renderGame(
            '流放之路2',
            record({
                zones: [
                    {
                        zone: ['国服', '赛季', '普通'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [{ name: '神圣石', price: null, unit: null }],
                    },
                ],
            }),
        );

        expect(text).toContain('【国服 / 赛季 / 普通】');
        expect(text).toContain('（1 项未取到价格）');
    });

    it('**`price` 为 `0` 与 `null` 的行都被过滤**, `（N 项未取到价格）` 计数正确', () => {
        const text = renderGame(
            '流放之路2',
            record({
                zones: [
                    {
                        zone: ['国服'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [
                            { name: '神圣石', price: 0.2444, unit: '元/个' },
                            { name: '崇高石', price: null, unit: null },
                            { name: '卡兰德的魔镜', price: 0, unit: '元/个' },
                        ],
                    },
                ],
            }),
        );

        expect(text).toContain('1. 神圣石 0.2444 元/个');
        expect(text).not.toContain('崇高石');
        expect(text).not.toContain('卡兰德的魔镜');
        expect(text).toContain('（2 项未取到价格）');
    });

    it('价格**原样显示**, 不做固定小数位', () => {
        const text = renderGame(
            '流放之路2',
            record({
                zones: [
                    {
                        zone: ['国服'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [
                            { name: '初火源质', price: 0.0012, unit: '元/火' },
                            { name: '神圣石', price: 1.5, unit: '元/个' },
                        ],
                    },
                ],
            }),
        );

        expect(text).toContain('初火源质 0.0012 元/火');
        expect(text).toContain('神圣石 1.5 元/个');
    });

    it('**`missing` 单独成行**并交代数量——配置写错时用户唯一的可见信号', () => {
        const text = renderGame(
            '流放之路2',
            record({
                missing: ['不存在的通货甲', '不存在的通货乙'],
                zones: [
                    {
                        zone: ['国服'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [{ name: '神圣石', price: 0.2444, unit: '元/个' }],
                    },
                ],
            }),
        );

        expect(text).toContain('（另有 2 项配置的通货名在站点上不存在）');
        // 单独成行: 不与任何区服块挤在一起
        expect(text.split('\n')).toContain('（另有 2 项配置的通货名在站点上不存在）');
    });

    it('没有 `missing` 时不出现那一行', () => {
        expect(renderGame('流放之路2', record())).not.toContain('不存在');
    });
});
