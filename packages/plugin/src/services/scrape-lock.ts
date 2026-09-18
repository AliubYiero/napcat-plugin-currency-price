/**
 * 全局抓取互斥锁
 *
 * 见设计文档 §9.3。**全局一把锁**, 后到者排队——不是"复用前者结果": 在游戏级粒度下,
 * 前者可能根本没抓你要的游戏。
 *
 * 后到者**轮到自己时重新计算**需要抓的游戏（前者可能已经抓过了, 此时直接复用）。
 * 「重算」不在本模块做——本模块只保证"同一时刻只有一段抓取在跑", 重算是调用方
 * 拿到锁之后的第一个动作。
 *
 * ⚠️ **不做游戏级并发**（§9.3）: 多个游戏共用同一个 page 串行, UA 挂在 context 上、
 * 页面状态在组合间累积, 并发就得开多个 browser/page。「两个会话同一分钟都发 price」
 * 是低频事件, 排队等一两分钟是可接受的代价。
 */

/** 锁尾: 前面所有持锁任务的串行化终点。永远不 reject（错误由各自的调用方接收） */
let tail: Promise<unknown> = Promise.resolve();

/** 已入队（含正在跑）的任务数 */
let pending = 0;

/**
 * 抢全局锁执行一段抓取。锁被占用时**排队等待**, 轮到后执行 `job`。
 *
 * 返回 `job` 本身的 Promise——失败只属于调用方, 不传染给排在后面的任务
 * （`tail` 单独吞掉错误）。
 */
export function runWithScrapeLock<T>(job: () => Promise<T>): Promise<T> {
    pending++;

    // 计数递减与 job 结束**同步**（finally）, 而不是晚一个微任务——
    // 否则 "await 完一个任务" 与 "锁空闲" 之间会出现可观察的错位
    const wrapped = async (): Promise<T> => {
        try {
            return await job();
        } finally {
            pending--;
        }
    };

    const result = tail.then(wrapped, wrapped);

    tail = result.catch(() => {});

    return result;
}

/** 锁当前是否被占用（正在跑或有任务在排队）。测试与诊断用 */
export function isScrapeLocked(): boolean {
    return pending > 0;
}
