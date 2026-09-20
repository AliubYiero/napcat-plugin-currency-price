/**
 * 插件类型定义
 *
 * 注意：OneBot 相关类型（OB11Message, OB11PostSendMsg 等）
 * 以及插件框架类型（NapCatPluginContext, PluginModule 等）
 * 均来自 napcat-types 包，无需在此重复定义。
 *
 * 与 WebUI 共用的类型（PluginConfig, GroupConfig, ApiResponse）
 * 统一定义在 @napcat-plugin-template/shared，此处仅重导出。
 *
 * ⚠️ 本文件只做类型重导出, **不得引入任何运行期依赖**——它被 WebUI 与插件后端共用,
 * 且 `config.ts` 的默认配置对象在模块加载期就会求值。
 */
export type {
    PluginConfig,
    GroupConfig,
    CatalogConfig,
    CurrencyConfig,
    ApiResponse,
} from '@napcat-plugin-template/shared';
