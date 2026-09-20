/**
 * `scraper/parse.ts` 纯函数
 *
 * 见设计文档 §8.3 与 §18。这些函数是抓取层静默错值防线的**唯一可单测部分**——
 * 页面点击、等待渲染、UA 伪装都只能在真机上验，但"读到的数字到底对不对"可以在这里钉死。
 *
 * ⚠️ 改造后**方向本身也成了可单测的东西**：`price` 是**比率方向（个/元）**，
 * 而两行的 DOM 形态一模一样——读错行不会报错，只会静默换个方向。所以这里的用例
 * 不只是"值对不对"，还有"方向对不对"。
 */

import { describe, expect, it } from 'vitest';
import {
    hasRenderedExpected,
    parseCurrencyRow,
    parsePriceText,
    parseZoneSpecIds,
    type RawCurrencyRow,
} from '../../../src/services/scraper/parse';

/**
 * 造一条采集到的原始行（浏览器侧产出的形态）。
 *
 * 默认值是**真实站点的形态**：第二行 `1 元 = 7.893 个`（比率价），第一行
 * `1 个 = 0.1267 元`（元价），计数的通货单位是 `个`。
 */
function row(
    ratioText: string | null,
    rmbText = '0.1267',
    countUnit = '个',
): RawCurrencyRow {
    return {
        name: '神圣石',
        ratioText,
        rmbText: ratioText === null ? null : rmbText,
        countUnit: ratioText === null ? null : countUnit,
    };
}

/** 造一个级联节点。只有叶子带 `dataValue`（区服标识）, 中间层级是空串 */
function node(
    label: string,
    dataValue = '',
    children: unknown[] = [],
) {
    return { dataValueLabel: label, dataValue, children };
}

describe('parsePriceText — 千分位与格式', () => {
    it('千分位不静默错值：`1,234.5` 解析为 1234.5（parseFloat 会返回 1）', () => {
        expect(parsePriceText('1,234.5')).toBe(1234.5);
    });

    it('科学计数法不是页面价格：记 null, 不静默换算成 1200', () => {
        expect(parsePriceText('1.2e3')).toBe(null);
    });

    it('不符合千分位分组的逗号不做无差别剥离：`1,23` 记 null', () => {
        expect(parsePriceText('1,23')).toBe(null);
    });

    it('**容忍尾随零**：`1.2300` 与 `1.23` 是同一个价格, 不因比对不通过而误判为 null', () => {
        expect(parsePriceText('1.2300')).toBe(1.23);
    });

    it('整数千分位：`1,234` 解析为 1234', () => {
        expect(parsePriceText('1,234')).toBe(1234);
    });

    it('超长数字会被 Number 静默截断, 此时记 null 而不是返回一个看似合理的错值', () => {
        // 2^53 + 1, Number 表示不了, 会退化成 ...992
        expect(parsePriceText('9007199254740993')).toBe(null);
    });

    it('页面无报价时的两种形态（空串 / `--`）都记 null', () => {
        expect(parsePriceText('')).toBe(null);
        expect(parsePriceText('--')).toBe(null);
        expect(parsePriceText('   ')).toBe(null);
    });

    it('**`0` 是合法价格, 不是解析失败**——它必须与 null 区分得开', () => {
        expect(parsePriceText('0')).toBe(0);
        expect(parsePriceText('0.0000')).toBe(0);
    });
});

describe('parseCurrencyRow — 原始行解析成价格记录', () => {
    it('**主方向是比率价**（第二行 `1 元 = 7.893 个`），单位拼成 `个/元`', () => {
        expect(parseCurrencyRow(row('7.893'))).toEqual({
            name: '神圣石',
            price: 7.893,
            unit: '个/元',
            rmbPrice: 0.1267,
            rmbUnit: '元/个',
        });
    });

    it('元方向取自第一行, **不是 `1 / price` 算出来的**（两个方向不是精确倒数）', () => {
        // 真实数据里 `1 元 = 314.3911 个` 与 `1 个 = 0.003 元` 并存, 而 1/0.003 = 333.333
        const parsed = parseCurrencyRow(row('314.3911', '0.003'));

        expect(parsed.rmbPrice).toBe(0.003);
        expect(parsed.rmbPrice).not.toBeCloseTo(1 / 314.3911, 6);
    });

    it('千分位在这条链路上被正确剥离——这里是**唯一的解析点**', () => {
        expect(parseCurrencyRow(row('1,234.5')).price).toBe(1234.5);
    });

    it('**无报价记 null, 不写 0 占位**', () => {
        expect(parseCurrencyRow(row(null))).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('**读到 `0` 也记 null**：站点上没有"确实报 0"这个形态，0 就是无报价', () => {
        // 接口的 ratioPrice 为 0 时页面显示的本来就是占位符, 两者是同一件事（ADR-0006 结论 4）。
        // 保留一个永不出现的 0, 只会让下游继续写 `price ?? 0` 这类把两者混起来的代码
        expect(parseCurrencyRow(row('0'))).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('解析不通过时整条记 null, 且**不带单位、不产出元方向**——半个价格比没有更糟', () => {
        expect(parseCurrencyRow(row('1.2e3'))).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('读不出计数单位时价格为数字而单位为 null, 元方向**两个键一起不出现**', () => {
        expect(parseCurrencyRow(row('7.893', '0.1267', ''))).toEqual({
            name: '神圣石',
            price: 7.893,
            unit: null,
        });
    });

    it('元方向读不出来时**不产出这两个键**（而不是产出半个价格）', () => {
        const parsed = parseCurrencyRow(row('7.893', '不是数字'));

        expect(parsed.price).toBe(7.893);
        expect(parsed).not.toHaveProperty('rmbPrice');
        expect(parsed).not.toHaveProperty('rmbUnit');
    });
});

/**
 * ⚠️ 这条判据**不再是价格的正确性防线**（价格由接口定, 见 ADR-0006 结论 1）。
 * 它现在唯一的职责是「DOM 刷新了没有」——切换区服时列表会先清空再重绘, 响应刚回来时读到的
 * 可能是空列表或上一个区服的旧值。**只在需要走 DOM 兜底时才调用**, 判错也不再让整轮作废。
 */
describe('hasRenderedExpected — DOM 是否已刷新出接口返回的价格（刷新判据）', () => {
    /** 造一行指定名称的原始行 */
    function named(
        name: string,
        ratioText: string | null,
    ): RawCurrencyRow {
        return {
            name,
            ratioText,
            rmbText: ratioText === null ? null : '0.1267',
            countUnit: ratioText === null ? null : '个',
        };
    }

    it('接口给了正价、DOM 读到同一个数 → 已渲染', () => {
        expect(
            hasRenderedExpected(
                [named('神圣石', '0.0845')],
                new Map([['神圣石', 0.0845]]),
                ['神圣石'],
            ),
        ).toBe(true);
    });

    it('**接口判为无报价 (0) 而页面显示占位符 → 已渲染**（曾把这种形态判为未渲染, 整个游戏本轮作废）', () => {
        // 实测: 流放之路1 的「国服 / 赛季 / 专家」接口对所有通货都给 0, 页面如实显示占位符
        expect(
            hasRenderedExpected(
                [named('神圣石', null)],
                new Map([['神圣石', 0]]),
                ['神圣石'],
            ),
        ).toBe(true);
    });

    it('接口判为无报价、页面却还是**上一个区服的旧正价** → 未渲染（旧值必须被识破）', () => {
        expect(
            hasRenderedExpected(
                [named('神圣石', '0.0845')],
                new Map([['神圣石', 0]]),
                ['神圣石'],
            ),
        ).toBe(false);
    });

    it('接口给了正价而页面是占位符 → 未渲染（这条防线不放宽）', () => {
        expect(
            hasRenderedExpected(
                [named('神圣石', null)],
                new Map([['神圣石', 0.0845]]),
                ['神圣石'],
            ),
        ).toBe(false);
    });

    it('行本身还没出现 → 未渲染', () => {
        expect(
            hasRenderedExpected([], new Map([['神圣石', 0.0845]]), [
                '神圣石',
            ]),
        ).toBe(false);
    });

    it('千分位价格走与产出数据同一套解析：`1,234.5` 与 1234.5 相等（parseFloat 会截断成 1）', () => {
        expect(
            hasRenderedExpected(
                [named('卡兰德的魔镜', '1,234.5')],
                new Map([['卡兰德的魔镜', 1234.5]]),
                ['卡兰德的魔镜'],
            ),
        ).toBe(true);
    });

    it('浮点格式化差异（尾随零）不算"未渲染"：`0.1480` 与 `0.148` 是同一个价格', () => {
        expect(
            hasRenderedExpected(
                [named('神圣石', '0.1480')],
                new Map([['神圣石', 0.148]]),
                ['神圣石'],
            ),
        ).toBe(true);
    });

    it('接口**没给价**的通货不参与比对——配置里写错的名字只会进 `missing`, 不该卡住整轮抓取', () => {
        const expected = new Map([['神圣石', 0.0845]]);

        expect(
            hasRenderedExpected(
                [named('神圣石', '0.0845')],
                expected,
                ['神圣石', '不存在的通货'],
            ),
        ).toBe(true);
        // 接口一个都没给: 无从比对, 不因此判未渲染（由游戏级 `missing` 兜底）
        expect(hasRenderedExpected([], new Map(), ['神圣石'])).toBe(
            true,
        );
    });
});

describe('parseZoneSpecIds — 从选项树解析区服标识', () => {
    /** 三级树：区域 / 赛季 / 难度 */
    const THREE_LEVEL = [
        node('国服', '', [
            node('赛季', '', [
                node('普通', '3794868'),
                node('专家', '3794869'),
            ]),
        ]),
        node('国际服', '', [
            node('赛季', '', [
                node('普通', '3794870'),
                node('专家', '3794871'),
            ]),
        ]),
    ];

    it('把叶子节点的路径拼成键, 值为站点内部的区服标识', () => {
        const map = parseZoneSpecIds(THREE_LEVEL);

        expect(map.get('国服/赛季/普通')).toBe('3794868');
        expect(map.get('国际服/赛季/专家')).toBe('3794871');
    });

    it('**层数随游戏而变**: 两级树上同样按路径拼键（不得假设固定三级）', () => {
        // 火炬之光只有两级, 且「非赛季」下没有「专家」
        const twoLevel = [
            node('赛季', '', [
                node('普通', '1560001'),
                node('专家', '1560002'),
            ]),
        ];

        const map = parseZoneSpecIds(twoLevel);

        expect(map.get('赛季/普通')).toBe('1560001');
        expect([...map.keys()]).toHaveLength(2);
    });

    it('中间层级没有标识, 不进映射——只有叶子才带 `dataValue`', () => {
        const map = parseZoneSpecIds(THREE_LEVEL);

        expect(map.has('国服')).toBe(false);
        expect(map.has('国服/赛季')).toBe(false);
        expect([...map.values()]).not.toContain('');
    });

    it('空响应 / 缺失 children 不抛错, 返回空映射', () => {
        expect(parseZoneSpecIds([]).size).toBe(0);
        expect(parseZoneSpecIds(undefined as never).size).toBe(0);
        expect(
            parseZoneSpecIds([{ dataValueLabel: '国服' }] as never)
                .size,
        ).toBe(0);
    });
});
