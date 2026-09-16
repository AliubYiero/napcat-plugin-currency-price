/**
 * API 服务模块
 * 注册 WebUI API 路由
 *
 * 路由类型说明：
 * ┌─────────────────┬──────────────────────────────────────────────┬─────────────────┐
 * │ 类型            │ 路径前缀                                      │ 注册方法        │
 * ├─────────────────┼──────────────────────────────────────────────┼─────────────────┤
 * │ 需要鉴权 API    │ /api/Plugin/ext/<plugin-id>/                 │ router.get/post │
 * │ 无需鉴权 API    │ /plugin/<plugin-id>/api/                     │ router.getNoAuth│
 * │ 静态文件        │ /plugin/<plugin-id>/files/<urlPath>/         │ router.static   │
 * │ 内存文件        │ /plugin/<plugin-id>/mem/<urlPath>/           │ router.staticOnMem│
 * │ 页面            │ /plugin/<plugin-id>/page/<path>             │ router.page     │
 * └─────────────────┴──────────────────────────────────────────────┴─────────────────┘
 *
 * 一般插件自带的 WebUI 页面使用 NoAuth 路由，因为页面本身已在 NapCat WebUI 内嵌展示。
 */

import type {
    NapCatPluginContext,
} from 'napcat-types/napcat-onebot/network/plugin/types';
import { pluginState } from '../core/state';
import { getInstallState, runInstall } from './browser/chrome-installer';
import { detectBrowserFull, getBrowserStatus } from './browser/status';
import { DataStore } from '../store/data.store';

/**
 * API 层的依赖注入点。
 *
 * 检测与安装要起浏览器进程 / 下载几百 MB, 单测里不该真做。本项目其余测试一律跑真实实现,
 * 所以这里不用 mock 框架, 只把这两个重动作换成可替换引用。
 */
export const apiServiceDeps = {
    detectBrowserFull,
};

/**
 * 注册 API 路由
 */
export function registerApiRoutes(ctx: NapCatPluginContext): void {
    const router = ctx.router;

    // ==================== 插件信息（无鉴权）====================

    /** 获取插件状态（含各游戏最后抓取时间, 供仪表盘显示） */
    router.getNoAuth('/status', (_req, res) => {
        res.json({
            code: 0,
            data: {
                pluginName: ctx.pluginName,
                uptime: pluginState.getUptime(),
                uptimeFormatted: pluginState.getUptimeFormatted(),
                config: pluginState.config,
                stats: pluginState.stats,
                games: gameStatuses(),
            },
        });
    });

    // ==================== 浏览器（无鉴权）====================

    /**
     * 浏览器状态。**只读缓存, 零副作用**。
     *
     * ⚠️ 模板的 WebUI 每 5 秒轮询一次状态。如果这里每次都跑 `launch()`, 只要有人开着面板
     * 就会**每 5 秒拉起一次浏览器**——检测必须由 `POST /chrome/detect` 显式触发。
     */
    router.getNoAuth('/chrome/status', (_req, res) => {
        res.json({ code: 0, data: getBrowserStatus() });
    });

    /** 执行一次完整检测（轻量检查 → `launch()` 验证, 5000ms 超时）并刷新缓存 */
    router.postNoAuth('/chrome/detect', async (_req, res) => {
        try {
            res.json({ code: 0, data: await apiServiceDeps.detectBrowserFull() });
        } catch (error) {
            ctx.logger.error('浏览器检测失败:', error);
            res.status(500).json({ code: -1, message: String(error) });
        }
    });

    /**
     * 触发 Chrome 下载安装。
     *
     * **后台跑, 不 await**: 下载几百 MB 会让请求悬着。前端靠轮询进度端点拿进展。
     */
    router.postNoAuth('/chrome/install', (_req, res) => {
        if (getInstallState().running) {
            res.json({ code: 0, message: '安装已在进行中' });

            return;
        }

        void runInstall().catch((error) => ctx.logger.error('Chrome 安装失败:', error));

        res.json({ code: 0, message: 'ok' });
    });

    /** 安装进度 */
    router.getNoAuth('/chrome/install/progress', (_req, res) => {
        res.json({ code: 0, data: getInstallState() });
    });

    // ==================== 配置管理（无鉴权）====================

    /** 获取配置 */
    router.getNoAuth('/config', (_req, res) => {
        res.json({ code: 0, data: pluginState.config });
    });

    /** 保存配置 */
    router.postNoAuth('/config', async (req, res) => {
        try {
            const body = req.body as Record<string, unknown> | undefined;
            if (!body) {
                return res.status(400).json({ code: -1, message: '请求体为空' });
            }
            // ⚠️ 走 `replaceConfig` 而非 `updateConfig`: 后者只做浅合并、不清洗, 是给内部
            // 可信调用方的。这里的 body 来自 WebUI —— **一切外部输入的配置写回必须经过
            // `sanitizeConfig`** (见 docs/config-pattern.md 的核心约束 2)。
            // 漏了这一步, Schema 面板以文本送来的 `adminUsers` 会原样存成字符串,
            // `isSuperAdmin` 数组包含检查随即全部落空。
            pluginState.replaceConfig({
                ...pluginState.config,
                ...body,
            } as import('../types').PluginConfig);
            ctx.logger.info('配置已保存');
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('保存配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    // ==================== 群管理（无鉴权）====================

    /** 获取群列表（附带各群启用状态） */
    router.getNoAuth('/groups', async (_req, res) => {
        try {
            const groups = await ctx.actions.call(
                'get_group_list',
                {},
                ctx.adapterName,
                ctx.pluginManager.config
            ) as Array<{ group_id: number; group_name: string; member_count: number; max_member_count: number }>;

            const groupsWithConfig = (groups || []).map((group) => {
                const groupId = String(group.group_id);
                return {
                    group_id: group.group_id,
                    group_name: group.group_name,
                    member_count: group.member_count,
                    max_member_count: group.max_member_count,
                    enabled: pluginState.isGroupEnabled(groupId),
                };
            });

            res.json({ code: 0, data: groupsWithConfig });
        } catch (e) {
            ctx.logger.error('获取群列表失败:', e);
            res.status(500).json({ code: -1, message: String(e) });
        }
    });

    /** 更新单个群配置 */
    router.postNoAuth('/groups/:id/config', async (req, res) => {
        try {
            const groupId = req.params?.id;
            if (!groupId) {
                return res.status(400).json({ code: -1, message: '缺少群 ID' });
            }

            const body = req.body as Record<string, unknown> | undefined;
            const enabled = body?.enabled;
            pluginState.updateGroupConfig(groupId, { enabled: Boolean(enabled) });
            ctx.logger.info(`群 ${groupId} 配置已更新: enabled=${enabled}`);
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('更新群配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    /** 批量更新群配置 */
    router.postNoAuth('/groups/bulk-config', async (req, res) => {
        try {
            const body = req.body as Record<string, unknown> | undefined;
            const { enabled, groupIds } = body || {};

            if (typeof enabled !== 'boolean' || !Array.isArray(groupIds)) {
                return res.status(400).json({ code: -1, message: '参数错误' });
            }

            for (const groupId of groupIds) {
                pluginState.updateGroupConfig(String(groupId), { enabled });
            }

            ctx.logger.info(`批量更新群配置完成 | 数量: ${groupIds.length}, enabled=${enabled}`);
            res.json({ code: 0, message: 'ok' });
        } catch (err) {
            ctx.logger.error('批量更新群配置失败:', err);
            res.status(500).json({ code: -1, message: String(err) });
        }
    });

    // TODO: 在这里添加你的自定义 API 路由

    ctx.logger.debug('API 路由注册完成');
}

/**
 * 各游戏的数据状态。
 *
 * `readAt` 是**游戏级**的（见设计文档 §7.2）——仪表盘要显示的是"这个游戏的数据是什么时候的",
 * 不是"整次抓取是什么时候的"。
 */
function gameStatuses(): Array<{ name: string; readAt: string; lastError: string | null }> {
    return Object.entries(DataStore.getInstance().getGames()).map(([name, record]) => ({
        name,
        readAt: record.readAt,
        lastError: record.lastError,
    }));
}
