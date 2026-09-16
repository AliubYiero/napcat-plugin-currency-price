/**
 * `scraper/parse.ts` 纯函数
 *
 * 见设计文档 §8.3 与 §18。这些函数是抓取层两道静默错值防线的**唯一可单测部分**——
 * 页面点击、等待渲染、UA 伪装都只能在真机上验，但"读到的数字到底对不对"可以在这里钉死。
 */

import { describe, expect, it } from 'vitest';
import {
    parseCurrencyRow,
    parsePriceText,
    parseZoneSpecIds,
    type RawCurrencyRow,
} from '../../../src/services/scraper/parse';

/** 造一条采集到的原始行（浏览器侧产出的形态） */
function row(priceText: string | null, baseUnit = '个', quoteUnit = '元'): RawCurrencyRow {
    return { name: '神圣石', priceText, baseUnit, quoteUnit };
}

/** 造一个级联节点。只有叶子带 `dataValue`（区服标识）, 中间层级是空串 */
function node(label: string, dataValue = '', children: unknown[] = []) {
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
    it('价格走 parsePriceText, 单位由「计价单位/基准单位」拼成', () => {
        expect(parseCurrencyRow(row('0.2444'))).toEqual({
            name: '神圣石',
            price: 0.2444,
            unit: '元/个',
        });
    });

    it('千分位在这条链路上被正确剥离——这里是**唯一的解析点**', () => {
        expect(parseCurrencyRow(row('1,234.5')).price).toBe(1234.5);
    });

    it('**无报价记 null, 不写 0 占位**', () => {
        expect(parseCurrencyRow({ ...row(null), baseUnit: null, quoteUnit: null })).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('页面**确实报 `0`** 时记 0 并带上单位——它与"未取到"不是一回事', () => {
        expect(parseCurrencyRow(row('0'))).toEqual({
            name: '神圣石',
            price: 0,
            unit: '元/个',
        });
    });

    it('解析不通过时整条记 null, 且**不带单位**——半条数据比没有更糟', () => {
        expect(parseCurrencyRow(row('1.2e3'))).toEqual({
            name: '神圣石',
            price: null,
            unit: null,
        });
    });

    it('页面没给单位时, 价格为数字而单位为 null', () => {
        expect(parseCurrencyRow(row('0.2444', '', ''))).toEqual({
            name: '神圣石',
            price: 0.2444,
            unit: null,
        });
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
        const twoLevel = [node('赛季', '', [node('普通', '1560001'), node('专家', '1560002')])];

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
        expect(parseZoneSpecIds([{ dataValueLabel: '国服' }] as never).size).toBe(0);
    });
});
