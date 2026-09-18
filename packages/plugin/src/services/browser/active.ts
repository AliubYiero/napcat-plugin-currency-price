/**
 * 活动浏览器的登记口
 *
 * 见设计文档 §14: **插件卸载时抓取可能正在进行**, `plugin_cleanup` 必须把浏览器
 * **强制关闭且不等待**——等待一次最坏 3 分钟的失败路径, 卸载就卡死了。
 *
 * 抓取层每次起浏览器时把句柄登记到这里, 卸载时从这里取走并 `close()`。
 * 互斥锁（§9.3）保证同一时刻至多一个浏览器在跑, 登记口因此只留一个槽位。
 */

/** 只需要 `close()`: 这里的职责是关掉, 不是操作页面 */
interface CloseableBrowser {
    close(): Promise<void>;
}

let activeBrowser: CloseableBrowser | null = null;

/** 抓取层起浏览器后登记。同一时刻只会有一个（互斥锁保证）, 后者覆盖前者 */
export function setActiveBrowser(browser: CloseableBrowser): void {
    activeBrowser = browser;
}

/**
 * 取消登记。抓取正常结束时由抓取层调用, 免得卸载时去关一个已经关掉的浏览器
 * （关了也无害, 但日志里会多一条吓人的错误）
 */
export function clearActiveBrowser(): void {
    activeBrowser = null;
}

/**
 * 强制关闭当前活动的浏览器, **不等待**。
 *
 * `plugin_cleanup` 专用: 火灾演练不排队。`close()` 的结果无人接——进程退出本身
 * 会回收一切, 这里只负责"让抓取立刻失败"。
 */
export function closeActiveBrowser(): void {
    const browser = activeBrowser;
    activeBrowser = null;

    if (!browser) return;

    void browser.close().catch(() => {
        /* 关不掉也不等了: 卸载路径上没有"等待"这个选项 */
    });
}
