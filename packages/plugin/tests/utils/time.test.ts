/**
 * `nextSelectedHour` —— 下一个选中整点的计算
 *
 * 见设计文档 §9.1 与 §18 测试重点。重点覆盖验收点名的情形:
 * 跨零点 / 恰好整点 / 空集合 / 单元素集合 / 乱序与重复的 `pushHours`。
 */

import { describe, expect, it } from 'vitest';
import { nextSelectedHour } from '../../src/utils/time';

/** 本地 `2026-09-18 HH:mm:ss` 的时间戳。测试只跟本地钟点打交道 */
function local(h: number, m = 0, s = 0): number {
    const date = new Date();
    date.setHours(h, m, s, 0);

    return date.getTime();
}

/** 断言结果等于本地 `day(h)`; `dayOffset` 为 1 表示"明天" */
function expectLocal(result: number | null, h: number, dayOffset = 0): void {
    expect(result).not.toBeNull();
    const date = new Date(result!);
    expect(date.getHours()).toBe(h);
    expect(date.getMinutes()).toBe(0);
    expect(date.getSeconds()).toBe(0);
    expect(date.getDate()).toBe(new Date(local(h)).getDate() + dayOffset);
}

describe('nextSelectedHour', () => {
    it('当天还有选中小时 → 今天的下一个选中整点', () => {
        // 现在 08:30, 选中 [9, 21] → 9 点
        expectLocal(nextSelectedHour(local(8, 30), [9, 21]), 9);
    });

    it('当天剩余选中小时用完 → **顺延到明天第一个**（跨零点）', () => {
        // 现在 22:00, 选中 [9, 21] → 明天 9 点
        expectLocal(nextSelectedHour(local(22), [9, 21]), 9, 1);
    });

    it('选中集合跨零点边界: 23 点选中、现在 23:30 → 明天第一个选中小时', () => {
        expectLocal(nextSelectedHour(local(23, 30), [23, 0]), 0, 1);
    });

    it('**恰好整点触发时不能退化成立刻再触发**——严格大于, 返回下一个选中整点', () => {
        // 现在 21:00 整, 选中 [9, 21] → 明天 9 点, 而不是 setTimeout(0) 立即触发
        expectLocal(nextSelectedHour(local(21), [9, 21]), 9, 1);
    });

    it('恰好整点且当天还有更晚的选中小时 → 当天下一个', () => {
        expectLocal(nextSelectedHour(local(9), [9, 21]), 21);
    });

    it('空集合 → `null`（空数组是合法语义, 不是回退默认全选）', () => {
        expect(nextSelectedHour(local(8), [])).toBeNull();
    });

    it('单元素集合 → 每天同一时刻', () => {
        expectLocal(nextSelectedHour(local(8, 15), [10]), 10);
        expectLocal(nextSelectedHour(local(10, 1), [10]), 10, 1);
    });

    it('乱序与重复的集合 → 与排序去重后等价', () => {
        const now = local(8, 30);

        expect(nextSelectedHour(now, [21, 9])).toBe(nextSelectedHour(now, [9, 21]));
        expect(nextSelectedHour(now, [9, 9, 21])).toBe(nextSelectedHour(now, [9, 21]));
    });

    it('非法小时（越界 / 非整数）被过滤, 过滤后为空 → `null`', () => {
        expect(nextSelectedHour(local(8), [24, -1, 9.5])).toBeNull();
    });
});
