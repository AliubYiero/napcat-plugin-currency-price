/**
 * 全局抓取互斥锁（片 05, §9.3）
 */

import { describe, expect, it } from 'vitest';
import { isScrapeLocked, runWithScrapeLock } from '../../src/services/scrape-lock';

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('runWithScrapeLock', () => {
    it('**全局一把锁, 后到者排队**——前一个没跑完时后者不开始', async () => {
        const events: string[] = [];

        const first = runWithScrapeLock(async () => {
            events.push('first:start');
            await delay(20);
            events.push('first:end');
        });
        const second = runWithScrapeLock(async () => {
            events.push('second:start');
        });

        await Promise.all([first, second]);

        expect(events).toEqual(['first:start', 'first:end', 'second:start']);
    });

    it('排队期间**轮到后重新计算**的能力由"锁释放后才执行 job"保证——job 拿到的世界是新的', async () => {
        let sharedState = '旧值';
        let computedInside: string | null = null;

        const first = runWithScrapeLock(async () => {
            await delay(20);
            // 前一个持锁者改了世界
            sharedState = '已被前者抓过';
        });
        const second = runWithScrapeLock(async () => {
            // 后到者轮到自己时读到的是**改过之后**的世界 → 据此可以决定不重复抓
            computedInside = sharedState;
        });

        await Promise.all([first, second]);

        expect(computedInside).toBe('已被前者抓过');
    });

    it('前一个任务的失败**不传染**给排队的任务', async () => {
        const order: string[] = [];

        const first = runWithScrapeLock(async () => {
            throw new Error('第一个炸了');
        });
        const second = runWithScrapeLock(async () => {
            order.push('second');
        });

        await expect(first).rejects.toThrow('第一个炸了');
        await second;

        expect(order).toEqual(['second']);
        expect(isScrapeLocked()).toBe(false);
    });

    it('全部跑完后锁回到空闲', async () => {
        await runWithScrapeLock(async () => {});

        expect(isScrapeLocked()).toBe(false);
    });

    it('占用期间 `isScrapeLocked()` 为 true', async () => {
        let release: () => void = () => {};
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });

        const running = runWithScrapeLock(() => gate);
        expect(isScrapeLocked()).toBe(true);

        release();
        await running;

        expect(isScrapeLocked()).toBe(false);
    });
});
