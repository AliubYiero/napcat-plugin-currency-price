/**
 * 逐条发送的节拍
 *
 * 「串行发 + 相邻两条之间间隔 `pushIntervalMs`」是**定时推送与手动展示共用**的规则
 * （设计文档 §10.3）: 频控边界在 QQ 服务端, 与这条消息是定时发的还是用户敲出来的无关。
 * 两处各写一遍 `if (sentAny && interval > 0) await sleep(interval)`, 迟早会漏改一处。
 */

/** 等待 `ms` 毫秒 */
export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
}

/**
 * 造一个节拍器: 在每次真正发送**之前** await 一次, **首条不等待**, 之后每条之间等
 * `intervalMs`（`intervalMs` 为 0 时完全不等待）。
 *
 * 「已经发过没有」的状态由返回的函数自己持有——调用方不必维护游标。
 * 定时推送的游标跨会话（一次推送里的所有消息共用一条时间线）, 手动展示的只在一次回复内,
 * 但两者要的规则是同一条, 所以共用本工厂。
 */
export function createSendPacer(intervalMs: number): () => Promise<void> {
    let sentAny = false;

    return async (): Promise<void> => {
        if (sentAny && intervalMs > 0) await sleep(intervalMs);
        sentAny = true;
    };
}
