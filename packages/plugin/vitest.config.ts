import { defineConfig } from 'vitest/config';

/**
 * 单测配置**刻意与 `vite.config.ts` 分离**。
 *
 * `vite.config.ts` 是发布产物的打包配置（内联 playwright-core、注入 CJS shim、桩模块、
 * napcatHmrPlugin 等）。那些处置是为「产物在 QQ/Electron 的 Node 运行时里加载」服务的，
 * 对单测不但无用, 还会让 vitest 去解析 playwright-core 的一大堆可选依赖。
 *
 * 单测只跑纯函数与纯逻辑模块, 走 Node 原生 ESM 解析即可。
 */
export default defineConfig({
    test: {
        // 测试**集中放在 `tests/`, 层级镜像 `src/`**——不与被测源码混放,
        // 打包时也不必再为 `*.test.ts` 配 exclude。
        include: ['tests/**/*.test.ts'],
        environment: 'node',
    },
});
