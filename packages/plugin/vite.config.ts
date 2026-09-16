import { resolve, dirname } from 'path';
import { defineConfig, loadEnv, type Plugin } from 'vite';
import nodeResolve from '@rollup/plugin-node-resolve';
import { builtinModules } from 'module';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import fs from 'fs';
// @ts-ignore
import { napcatHmrPlugin } from 'napcat-plugin-debug-cli/vite';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, '../..');

const nodeModules = [
    ...builtinModules,
    ...builtinModules.map((m) => `node:${m}`),
].flat();

/**
 * 依赖排除：playwright-core 的**可选原生模块**。发布包里没有它们，且都包在 `try/catch` 里
 * （@rollup/plugin-commonjs 的 `ignoreTryCatch` 默认会把这类 require 原样留在产物中），
 * 运行期 `require` 未定义抛 ReferenceError 被 catch 掉，从而**正确地回退到纯 JS 实现**。
 *
 * ⚠️ 这三个**必须**保持 external，不要改成空桩模块：桩模块会让 `require()` 成功返回 `{}`，
 * 于是 ws 的 try/catch 不再触发、选中 `bufferUtil.mask()` 这条"可用"分支，等到发大帧时才
 * 炸在调用处——把一个启动期的确定性回退变成运行期的随机崩溃。
 *
 *   - bufferutil / utf-8-validate : ws 的可选原生加速模块
 *   - kerberos                    : Negotiate 代理认证，动态 `import()` 且在 try/catch 内
 */
const external: string[] = [ 'bufferutil', 'utf-8-validate', 'kerberos' ];

/**
 * `inspector` 内建模块的惰性桩。
 *
 * playwright-core 只在两处**惰性**路径碰它：`page.pause()` 的调试器探测（`inspector.url()`）
 * 与 `--profile` 性能采样（`new inspector.Session()`），上游都是 lazy init。但打包后
 * rollup 会把 CJS 的 `require("inspector")` 提升成产物**顶层的静态 import** → 变成加载期求值。
 * QQ / Electron 的 Node 运行时未编译 inspector，`import 'inspector'` 直接抛
 * `ERR_INSPECTOR_NOT_AVAILABLE`（表现为 "Inspector is not available"），**插件加载即失败**
 * ——而这条路径本插件根本不会走。
 *
 * 因此改为惰性解析：真正用到时才去 require。这里刻意用裸 `require` —— 它由产物顶部的
 * {@link bundleShim} 提供；桩模块自身不引入任何顶层绑定，避免与 shim 的别名撞名。
 */
const INSPECTOR_STUB = `
const loadInspector = () => require('inspector');
export default {
    url: ( ...args ) => loadInspector().url( ...args ),
    open: ( ...args ) => loadInspector().open( ...args ),
    close: ( ...args ) => loadInspector().close( ...args ),
    Session: class Session {
        constructor( ...args ) { return new ( loadInspector().Session )( ...args ); }
    },
};
`;

/**
 * 需要替换成桩模块的裸模块 → 桩源码。
 *
 * 共同点：**不能**放 `external`。rollup 会把 CJS 的 `require` 提升成 `index.mjs` **顶层的静态
 * import**，于是即便代码路径永远走不到，插件加载期就炸（`ERR_MODULE_NOT_FOUND` /
 * `ERR_INSPECTOR_NOT_AVAILABLE`）。解析成桩并进产物后，加载安全，只有真的走到才报错。
 *
 *   - chromium-bidi/* : BiDi 协议 mapper（既非 playwright-core 的 dependencies，也不在发布包里）。
 *                       Chromium 默认走 CDP，本插件不碰 BiDi
 *   - electron/*      : Electron 启动器，非 Electron 环境不会进入
 *   - inspector       : 见 {@link INSPECTOR_STUB}
 */
const STUB_MODULES: Record<string, string> = {
    'chromium-bidi/lib/cjs/bidiMapper/BidiMapper': 'export default {};',
    'chromium-bidi/lib/cjs/cdp/CdpConnection': 'export default {};',
    'electron': 'export default {};',
    'electron/index.js': 'export default {};',
    'inspector': INSPECTOR_STUB,
};

/**
 * 产物前置的运行时 shim。
 *
 * playwright-core 是 CJS 包，**在模块加载期**（不是调用期）就要解析出自己的"包根目录"：
 *   `packageRoot = path.join(__dirname, '..')`
 *   `packageJSON  = require(path.join(packageRoot, 'package.json'))`
 *   `registry     = new Registry(require(path.join(packageRoot, 'browsers.json')))`
 * 内联进 ESM 产物后 `__dirname` / `require` 都不存在 → 插件**加载即崩**。
 *
 * 这里补回三者，并把 `__dirname` 伪造成「插件根目录 /lib」——于是 `packageRoot` 正好落在
 * 插件根目录，也就是随包发布的 `package.json`（copyAssetsPlugin 生成）与 `browsers.json`
 * （见下方 copy 步骤）所在处。
 *
 * ⚠️ `libPath()` 会随之指向不存在的 `<插件根>/lib/*`。它只服务于 oopBrowserDownload /
 * appIcon / electron loader / trace viewer 等路径，本插件（headless + 系统 Chrome + goto）
 * 一条都不走；将来若启用截图 webp、trace 或 headed 启动，需要重新处理。
 */
const bundleShim = [
    `import { createRequire as __ncpCreateRequire } from 'node:module';`,
    `import { fileURLToPath as __ncpFileURLToPath } from 'node:url';`,
    `import { dirname as __ncpDirname, join as __ncpJoin } from 'node:path';`,
    `const __filename = __ncpFileURLToPath(import.meta.url);`,
    `const require = __ncpCreateRequire(import.meta.url);`,
    `const __dirname = __ncpJoin(__ncpDirname(__filename), 'lib');`,
].join('\n');

/** 把 {@link STUB_MODULES} 中的模块解析为桩源码的 Vite 插件 */
function stubOptionalDeps(): Plugin {
    const STUB_PREFIX = '\0napcat-plugin:stub:';
    return {
        name: 'stub-optional-deps',
        enforce: 'pre',
        // ⚠️ 命中前提：这些 id **不能**出现在 rollupOptions.external 里——rollup 对 external 数组
        // 命中的 id 直接外部化，根本不会走到 resolveId 钩子（见下方 external 的过滤）。
        resolveId( source ) {
            return source in STUB_MODULES ? STUB_PREFIX + source : null;
        },
        load( id ) {
            return id.startsWith( STUB_PREFIX )
                ? STUB_MODULES[ id.slice( STUB_PREFIX.length ) ] ?? null
                : null;
        },
    };
}

/**
 * 递归复制目录
 */
function copyDirRecursive(src: string, dest: string) {
    if (!fs.existsSync(dest)) {
        fs.mkdirSync(dest, { recursive: true });
    }
    const entries = fs.readdirSync(src, { withFileTypes: true });
    for (const entry of entries) {
        const srcPath = resolve(src, entry.name);
        const destPath = resolve(dest, entry.name);
        if (entry.isDirectory()) {
            copyDirRecursive(srcPath, destPath);
        } else {
            fs.copyFileSync(srcPath, destPath);
        }
    }
}

/**
 * 构建后自动复制资源的 Vite 插件
 * - 复制 webui 构建产物（需先运行 webui 构建）到 dist/webui
 * - 生成精简的 package.json（只保留运行时必要字段）
 * - 复制 templates 目录（如果存在）
 */
function copyAssetsPlugin() {
    return {
        name: 'copy-assets',
        writeBundle() {
            try {
                const distDir = resolve(__dirname, 'dist');

                // 1. 复制 webui 构建产物（由根脚本 pnpm build 先行构建）
                const webuiDist = resolve(repoRoot, 'packages/webui/dist');
                const webuiDest = resolve(distDir, 'webui');
                if (fs.existsSync(webuiDist)) {
                    copyDirRecursive(webuiDist, webuiDest);
                    console.log('[copy-assets] (o\'v\'o) 已复制 webui 构建产物');
                } else {
                    console.error('[copy-assets] (;_;) webui 构建产物不存在，请先运行 pnpm run build（根目录）');
                }

                // 2. 生成精简的 package.json（只保留运行时必要字段）
                const pkgPath = resolve(__dirname, 'package.json');
                if (fs.existsSync(pkgPath)) {
                    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
                    const distPkg: Record<string, unknown> = {
                        name: pkg.name,
                        plugin: pkg.plugin,
                        version: pkg.version,
                        type: pkg.type,
                        main: pkg.main,
                        description: pkg.description,
                        author: pkg.author,
                        dependencies: pkg.dependencies,
                    };
                    if (pkg.napcat) {
                        distPkg.napcat = pkg.napcat;
                    }
                    fs.writeFileSync(
                        resolve(distDir, 'package.json'),
                        JSON.stringify(distPkg, null, 2)
                    );
                    console.log('[copy-assets] (o\'v\'o) 已生成精简 package.json');
                }

                // 3. 复制 playwright-core 的 browsers.json
                //    内联后 playwright 仍在加载期按 packageRoot 读取它（见 bundleShim 注释），
                //    缺了会在 import 阶段直接抛 MODULE_NOT_FOUND。
                try {
                    const pwCoreDir = dirname(createRequire(import.meta.url).resolve('playwright-core'));
                    const browsersJson = resolve(pwCoreDir, 'browsers.json');
                    if (fs.existsSync(browsersJson)) {
                        fs.copyFileSync(browsersJson, resolve(distDir, 'browsers.json'));
                        console.log('[copy-assets] (o\'v\'o) 已复制 playwright-core browsers.json');
                    } else {
                        console.error(`[copy-assets] (;_;) 未找到 ${browsersJson}`);
                    }
                } catch (error) {
                    console.error('[copy-assets] (;_;) 复制 browsers.json 失败:', error);
                }

                // 4. 复制 templates 目录（如果存在）
                const templatesSrc = resolve(__dirname, 'templates');
                if (fs.existsSync(templatesSrc)) {
                    copyDirRecursive(templatesSrc, resolve(distDir, 'templates'));
                    console.log('[copy-assets] (o\'v\'o) 已复制 templates 目录');
                }

                console.log('[copy-assets] (*\'v\'*) 资源复制完成！');
            } catch (error) {
                console.error('[copy-assets] (;_;) 资源复制失败:', error);
            }
        },
    };
}

export default defineConfig( ( { mode } ) => {
    const env = loadEnv( mode, repoRoot, '' );
    return {
        resolve: {
            conditions: [ 'node', 'default' ],
        },
        build: {
            sourcemap: false,
            target: 'esnext',
            minify: false,
            // playwright-core 是 CJS 包（index.mjs → index.js → lib/coreBundle.js），
            // 必须让 commonjs 插件覆盖 node_modules 才能内联（见 docs/design.md §8.2）。
            commonjsOptions: {
                include: [ /node_modules/ ],
                transformMixedEsModules: true,
                defaultIsModuleExports: true,
                // playwright-core 用 `require(path.join(packageRoot, 'xxx.json'))` 这种**动态** require
                // 读取自己的 package.json / browsers.json。默认会被替换成抛错的 commonjsRequire；
                // 打开此项后原样保留 `require(...)`，由产物顶部的 shim（见 bundleShim）接管。
                ignoreDynamicRequires: true,
            },
            lib: {
                entry: resolve( __dirname, 'src/index.ts' ),
                formats: [ 'es' ],
                fileName: () => 'index.mjs',
            },
            rollupOptions: {
                // 需要打桩的内建模块（如 inspector）必须从 external 中摘掉，否则会被直接外部化、
                // 绕过 stubOptionalDeps 的 resolveId，重新变成产物顶层的静态 import。
                external: [
                    ...nodeModules.filter( ( m ) => !( m in STUB_MODULES ) && !( m.startsWith( 'node:' ) && m.slice( 5 ) in STUB_MODULES ) ),
                    ...external,
                ],
                output: {
                    inlineDynamicImports: true,
                    banner: bundleShim,
                },
            },
            outDir: 'dist',
        },
        plugins: [ stubOptionalDeps(), nodeResolve(), copyAssetsPlugin(), napcatHmrPlugin( {
            webui: {
                distDir: '../../packages/webui/dist',
                targetDir: 'webui',
            },
            wsUrl: env.WS_URL,
            token: env.TOKEN,
        } ) ],
    };
} );
