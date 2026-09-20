/**
 * 消息渲染器（片 09, §10.2）
 *
 * 纯函数: 给数据、出文本。`price` 展示与定时推送**共用本模块**, 因此模板规则在这里
 * 逐条钉死——两个场景长得不一样, 只应该是数据不一样。
 *
 * ⚠️ 改造后这里多了三类必须钉死的东西（ADR-0005 / ADR-0007）:
 * - **方向**: 主方向（`个/元`）在前、元方向在括号里, 且**任何地方都不做换算**
 * - **挂单块**: 标题写实际条数（不是上限）、总价两位小数、编号不承诺任何含义
 * - **两种"没价"分开计数**: 「未取到」与「挂单过少失真」并成一句会让用户无从应对
 */

import { describe, expect, it } from 'vitest';
import { renderGame } from '../../src/services/renderer';
import { formatLocalTime } from '../../src/utils/time';
import type { GameRecord } from '../../src/store/data.store';

/** 一条有价的记录（主方向 + 元方向） */
const PRICED = {
    name: '神圣石',
    price: 7.893,
    unit: '个/元',
    rmbPrice: 0.1267,
    rmbUnit: '元/个',
};

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
                prices: [PRICED],
            },
        ],
        ...overrides,
    };
}

/** 造一个只含单个区服的游戏记录 */
function oneZone(
    prices: GameRecord['zones'][number]['prices'],
    zone = ['国服'],
): GameRecord {
    return record({
        zones: [{ zone, readAt: '2026-09-16T08:00:00.000Z', prices }],
    });
}

describe('renderGame — 头部', () => {
    it('抓取失败、回退旧数据时头部加「（数据未更新）」', () => {
        const header = renderGame('流放之路2', record(), {
            notUpdated: true,
        }).split('\n')[0];

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
                        prices: [PRICED],
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
                    {
                        zone: ['国服', '赛季'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [],
                    },
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
            oneZone([{ name: '神圣石', price: null, unit: null }]),
        );

        expect(text).toContain('【国服】');
        expect(text).toContain('（1 项未取到价格）');
    });

    it('**`price` 为 `null` 的行被过滤**, 过滤掉的行名不出现在消息里', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                PRICED,
                { name: '崇高石', price: null, unit: null },
            ]),
        );

        expect(text).toContain(
            ' · 神圣石 7.893 个/元 (0.1267 元/个)',
        );
        expect(text).not.toContain('崇高石');
        expect(text).toContain('（1 项未取到价格）');
    });

    it('**一个区服只有一条数据时不编号**, 用 ` · ` 打头；多条才是数字序号', () => {
        const text = renderGame(
            '流放之路2',
            record({
                zones: [
                    {
                        zone: ['国服'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [PRICED],
                    },
                    {
                        zone: ['国际服'],
                        readAt: '2026-09-16T08:00:00.000Z',
                        prices: [
                            {
                                name: '神圣石',
                                price: 11.644,
                                unit: '个/元',
                            },
                            {
                                name: '崇高石',
                                price: 3553.187,
                                unit: '个/元',
                            },
                        ],
                    },
                ],
            }),
        );

        const lines = text.split('\n');

        expect(lines).toContain(
            ' · 神圣石 7.893 个/元 (0.1267 元/个)',
        );
        expect(lines).toContain('1. 神圣石 11.644 个/元');
        expect(lines).toContain('2. 崇高石 3553.187 个/元');
        // 编号是**逐区服**判定的, 不是整个游戏一个开关
        expect(lines).not.toContain(
            '1. 神圣石 7.893 个/元 (0.1267 元/个)',
        );
    });

    it('价格**四舍五入到 4 位小数, 不补零**', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                { name: '初火源质', price: 801.92456, unit: '火/元' },
                { name: '神圣石', price: 91, unit: '个/元' },
            ]),
        );

        expect(text).toContain('1. 初火源质 801.9246 火/元');
        expect(text).toContain('2. 神圣石 91 个/元');
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
                        prices: [PRICED],
                    },
                ],
            }),
        );

        expect(text).toContain(
            '（另有 2 项配置的通货名在站点上不存在）',
        );
        // 单独成行: 不与任何区服块挤在一起
        expect(text.split('\n')).toContain(
            '（另有 2 项配置的通货名在站点上不存在）',
        );
    });

    it('没有 `missing` 时不出现那一行', () => {
        expect(renderGame('流放之路2', record())).not.toContain(
            '不存在',
        );
    });
});

describe('renderGame — 两个方向（ADR-0005 结论 2）', () => {
    it('**主方向在前、元方向在括号里**, 且两个数原样显示', () => {
        const text = renderGame('流放之路2', oneZone([PRICED]));

        expect(text).toContain('神圣石 7.893 个/元 (0.1267 元/个)');
    });

    it('元方向缺失时**整个括号省略**——不补位、不拿主方向取倒数', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                { name: '神圣石', price: 7.893, unit: '个/元' },
            ]),
        );

        expect(text).toContain('神圣石 7.893 个/元');
        expect(text).not.toContain('(');
    });
});

describe('renderGame — 详情块（ADR-0005）', () => {
    /** 一条挂了详情的价格项 */
    function withDetail(
        listings: {
            stock: number;
            pricePerYuan: number;
            ratioUnit: string;
        }[],
        volume = '518.3w',
    ) {
        return {
            ...PRICED,
            detail: {
                volume,
                volumeValue: volume ? 5183000 : null,
                listings,
            },
        };
    }

    it('成交量原文跟在价格行末尾', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([withDetail([])]),
        );

        expect(text).toContain(
            ' · 神圣石 7.893 个/元 (0.1267 元/个) · 成交量 518.3w',
        );
    });

    it('**成交量原文为空串时那一截整个省略**（详情取到了但这个字段没读到）', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([withDetail([], '')]),
        );

        expect(text).toContain(
            ' · 神圣石 7.893 个/元 (0.1267 元/个)',
        );
        expect(text).not.toContain('成交量');
    });

    it('**标题写实际条数而不是上限**——写死"前5个"再列 3 行会让用户以为抓漏了', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                withDetail([
                    {
                        stock: 600,
                        pricePerYuan: 8.3333,
                        ratioUnit: '个',
                    },
                    {
                        stock: 500,
                        pricePerYuan: 8.3333,
                        ratioUnit: '个',
                    },
                    {
                        stock: 62,
                        pricePerYuan: 8.3264,
                        ratioUnit: '个',
                    },
                ]),
            ]),
        );

        expect(text).toContain('前3个挂单：');
        expect(text).not.toContain('前5个挂单：');
    });

    it('挂单算式: `库存 ÷ 比率价 = 总价`, 总价两位小数', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                withDetail([
                    {
                        stock: 600,
                        pricePerYuan: 8.3333,
                        ratioUnit: '个',
                    },
                    {
                        stock: 62,
                        pricePerYuan: 8.3264,
                        ratioUnit: '个',
                    },
                ]),
            ]),
        );

        const lines = text.split('\n');

        // 600 ÷ 8.3333 = 72.00；62 ÷ 8.3264 = 7.45 —— 拿屏幕上那两个数就能验算
        expect(lines).toContain(
            '    (1) 600 个 ÷ 8.3333 个/元 = 72.00 元',
        );
        expect(lines).toContain(
            '    (2) 62 个 ÷ 8.3264 个/元 = 7.45 元',
        );
    });

    it('**0 条挂单时不显示挂单块**, 成交量照常（那是一个有详情、没挂单的正常形态）', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([withDetail([])]),
        );

        expect(text).not.toContain('个挂单：');
        expect(text).toContain('成交量 518.3w');
    });

    it('没开详情的通货**完全不出现详情相关的内容**', () => {
        const text = renderGame('流放之路2', oneZone([PRICED]));

        expect(text).not.toContain('成交量');
        expect(text).not.toContain('个挂单：');
    });
});

describe('renderGame — 两种"没价"分开计数（ADR-0007 结论 6）', () => {
    it('**失真不并进「未取到价格」**——前者是"挂单太少, 价不算数", 后者是"没有报价"', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                PRICED,
                { name: '崇高石', price: null, unit: null },
                {
                    name: '混沌石',
                    price: null,
                    unit: null,
                    thinMarket: true,
                    detail: {
                        volume: '',
                        volumeValue: null,
                        listings: [
                            {
                                stock: 10,
                                pricePerYuan: 52.6,
                                ratioUnit: '个',
                            },
                        ],
                    },
                },
            ]),
        );

        expect(text).toContain('（1 项未取到价格）');
        expect(text).toContain('（1 项挂单过少，价格失真）');
    });

    it('**失真的通货不展开挂单块**——价格行都不在了, 一个孤零零的挂单块只会让人困惑', () => {
        const text = renderGame(
            '流放之路2',
            oneZone([
                {
                    name: '混沌石',
                    price: null,
                    unit: null,
                    thinMarket: true,
                    detail: {
                        volume: '5.5w',
                        volumeValue: 55000,
                        listings: [
                            {
                                stock: 10,
                                pricePerYuan: 52.6,
                                ratioUnit: '个',
                            },
                        ],
                    },
                },
            ]),
        );

        expect(text).not.toContain('个挂单：');
        expect(text).toContain('（1 项挂单过少，价格失真）');
    });

    it('没有失真项时不出现那一行', () => {
        const text = renderGame('流放之路2', oneZone([PRICED]));

        expect(text).not.toContain('失真');
    });
});
