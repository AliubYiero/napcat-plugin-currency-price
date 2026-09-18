/**
 * 新鲜度判定（片 05, §9.2）
 *
 * 边界恰好 5 分钟算**新鲜**（严格大于才算过期）; 从未抓取判过期。
 */

import { describe, expect, it } from 'vitest';
import {
    STALENESS_THRESHOLD_MS,
    getStaleGames,
    isStaleGame,
} from '../../src/services/staleness';
import type { GameRecord } from '../../src/store/data.store';

const NOW = 1_789_000_000_000;

function record(minuteAge: number): GameRecord {
    return {
        readAt: new Date(NOW - minuteAge * 60_000).toISOString(),
        zones: [],
        missing: [],
        lastError: null,
    };
}

describe('isStaleGame', () => {
    it('超过 5 分钟 → 过期', () => {
        expect(isStaleGame(record(6).readAt, { now: () => NOW })).toBe(true);
    });

    it('**边界恰好 5 分钟 → 新鲜**（判定条件是严格大于）', () => {
        expect(isStaleGame(record(5).readAt, { now: () => NOW })).toBe(false);
    });

    it('5 分钟以内 → 新鲜', () => {
        expect(isStaleGame(record(2).readAt, { now: () => NOW })).toBe(false);
    });

    it('**从未抓到过（readAt 不存在）→ 过期**', () => {
        expect(isStaleGame(null, { now: () => NOW })).toBe(true);
        expect(isStaleGame(undefined, { now: () => NOW })).toBe(true);
        expect(isStaleGame('', { now: () => NOW })).toBe(true);
    });

    it('readAt 无法解析 → 过期（宁可多抓, 不可当新的用）', () => {
        expect(isStaleGame('not-a-date', { now: () => NOW })).toBe(true);
    });

    it('阈值常量是 5 分钟, 且**不是配置项**', () => {
        expect(STALENESS_THRESHOLD_MS).toBe(5 * 60 * 1000);
    });
});

describe('getStaleGames', () => {
    const records: Record<string, GameRecord | null> = {
        freshGame: record(2),
        staleGame: record(15),
        neverGame: null,
    };
    const deps = { now: () => NOW, getGame: (name: string) => records[name] ?? null };

    it('只筛出过期的; 全部新鲜时返回空（→ 完全不启动浏览器）', () => {
        expect(getStaleGames(['freshGame'], deps)).toEqual([]);
    });

    it('部分过期 → 只返回过期的那些', () => {
        expect(getStaleGames(['freshGame', 'staleGame'], deps)).toEqual(['staleGame']);
    });

    it('从未抓到的游戏判过期', () => {
        expect(getStaleGames(['neverGame'], deps)).toEqual(['neverGame']);
    });

    it('保持传入顺序输出——抓取顺序是展示顺序的依据', () => {
        expect(getStaleGames(['neverGame', 'staleGame'], deps)).toEqual([
            'neverGame',
            'staleGame',
        ]);
    });
});
