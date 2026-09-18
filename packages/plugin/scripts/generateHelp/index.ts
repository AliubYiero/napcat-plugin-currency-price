/**
 * `pnpm help:generate` 入口
 *
 * 全链路见 docs/help-output-pattern.md:
 *   权威源 (scripts/generateHelp/cmds/) → 上游渲染服务 → 落盘 → 运行时选变体与回退
 *
 * 落盘两处产物 (**禁止手改**, 改内容只改权威源后重跑本脚本):
 * - 图片: `src/assets/{cmdId}-{Role}.png` (覆盖写入, 由 vite 复制进 dist/assets)
 * - 文本: `src/handlers/currency/helpText.generated.ts` (图片缺失时的回退文案)
 *
 * 上游 `napcat-help-generate` 是**独立项目** (与本仓库同级, 见 issue 11 的外部依赖),
 * 未运行时本脚本会在其目录执行 `pnpm start` 并轮询就绪。
 *
 * 运行方式: `node scripts/generateHelp/index.ts` (Node 22.18+ 原生支持 TS 类型剥离,
 * 无需 tsx; 这也是权威源里只允许"可擦除语法"的原因)。
 */

import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DEFAULT_CONFIG } from '../../src/config.ts';
import type { Cmd, Role } from './cmd.ts';
import { buildCurrencyPriceHelp } from './cmds/napcat-plugin-currency-price.ts';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** 插件包根目录 (packages/plugin) */
const PROJECT_ROOT = resolve(__dirname, '..', '..');
/** 上游渲染服务目录: 约定与本仓库同级 */
const GENERATOR_ROOT = resolve(PROJECT_ROOT, '..', '..', 'napcat-help-generate');

/** 图片产物的落盘目录 */
const ASSETS_DIR = join(PROJECT_ROOT, 'src', 'assets');

/**
 * 权威源 → 落盘目标
 *
 * 新增一个帮助面板时在这里加一行 (cmd 配置 + 文本映射的落盘目录)。
 */
const CMD_TARGETS: { cmd: Cmd; handlerDir: string }[] = [
    {
        cmd: buildCurrencyPriceHelp(DEFAULT_CONFIG.commandPrefix),
        handlerDir: join(PROJECT_ROOT, 'src', 'handlers', 'currency'),
    },
];

/** 权限组: 上游 API 键 (PascalCase) → 运行时变体键 (camelCase) */
const ROLE_MAP: { role: Role; variant: string }[] = [
    { role: 'User', variant: 'user' },
    { role: 'Admin', variant: 'admin' },
    { role: 'SuperAdmin', variant: 'superAdmin' },
];

/** 探活/请求超时与启动等待 */
const POLL_INTERVAL_MS = 500;
const START_TIMEOUT_MS = 30_000;
const REQUEST_TIMEOUT_MS = 30_000;

// ---------- 上游服务 ----------

async function isServerUp(port: number): Promise<boolean> {
    try {
        const res = await fetch(`http://localhost:${port}/api/cmds`, {
            signal: AbortSignal.timeout(2000),
        });
        return res.ok;
    } catch {
        return false;
    }
}

/** 读取上游 `.env` 的 PORT (缺省 3366), 读不到按缺省处理 */
function readGeneratorPort(): number {
    try {
        const env = readFileSync(join(GENERATOR_ROOT, '.env'), 'utf-8');
        const match = env.match(/^PORT=(\d+)\s*$/m);
        if (match) {
            return Number(match[1]);
        }
    } catch {
        // .env 不存在或不可读, 用缺省端口
    }
    return 3366;
}

function sleep(ms: number): Promise<void> {
    return new Promise((r) => setTimeout(r, ms));
}

/** 上游未运行时自动拉起并轮询就绪 */
async function ensureServer(port: number): Promise<void> {
    if (await isServerUp(port)) {
        console.log(`[help:generate] 检测到上游服务已运行 (port ${port})`);
        return;
    }

    console.log(`[help:generate] 上游服务未运行, 在 ${GENERATOR_ROOT} 启动 pnpm start ...`);
    const bin = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm';
    const child = spawn(bin, ['start'], {
        cwd: GENERATOR_ROOT,
        stdio: 'ignore',
        detached: false,
        // Windows 下 Node 对 .cmd 的 spawn 强制要求 shell
        shell: process.platform === 'win32',
    });
    child.on('error', (err) => {
        console.error(
            `[help:generate] 启动上游服务失败: ${err.message}\n` +
                '请手动进入 napcat-help-generate 目录执行 pnpm start 后重试',
        );
        process.exit(1);
    });

    const startedAt = Date.now();
    while (Date.now() - startedAt < START_TIMEOUT_MS) {
        if (await isServerUp(port)) {
            console.log('[help:generate] 上游服务已就绪');
            return;
        }
        await sleep(POLL_INTERVAL_MS);
    }
    console.error(
        `[help:generate] 等待上游服务就绪超时 (${START_TIMEOUT_MS / 1000}s)\n` +
            '首次运行需在上游目录执行 npx playwright install chromium; 也可手动 pnpm start 后重试',
    );
    process.exit(1);
}

// ---------- API 请求 ----------

function assertOk(res: Response, body: string): void {
    if (res.status === 400 || res.status === 500) {
        // 上游错误响应为 {"error": "..."}
        try {
            const { error, detail } = JSON.parse(body);
            throw new Error(`上游返回 ${res.status}: ${error}${detail ? ` (${detail})` : ''}`);
        } catch (e) {
            if (e instanceof SyntaxError) {
                throw new Error(`上游返回 ${res.status}: ${body}`);
            }
            throw e;
        }
    }
    if (!res.ok) {
        throw new Error(`上游返回 ${res.status}: ${body}`);
    }
}

async function fetchText(port: number, cmd: Cmd): Promise<Record<Role, string>> {
    const res = await fetch(`http://localhost:${port}/api/text`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: [cmd], role: ROLE_MAP.map((r) => r.role) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    const body = await res.text();
    assertOk(res, body);
    return JSON.parse(body);
}

async function fetchImages(port: number, cmd: Cmd): Promise<Map<Role, Buffer>> {
    const res = await fetch(`http://localhost:${port}/api/images`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cmd: [cmd], role: ROLE_MAP.map((r) => r.role) }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    // body 只读一次: 错误响应用 UTF-8 文本判定, 成功响应按二进制解析
    const buffer = Buffer.from(await res.arrayBuffer());
    const contentType = res.headers.get('content-type') ?? '';
    if (!contentType.includes('multipart/form-data')) {
        assertOk(res, buffer.toString('utf-8'));
        throw new Error(`响应不是 multipart: ${contentType}`);
    }

    // 手写解析 multipart (上游 boundary 固定前缀 napcat-help-generate-)
    // 二进制安全: 以 latin1 解码 buffer, 保证字节 1:1 (PNG 不可走 UTF-8 text())
    const boundaryMatch = contentType.match(/boundary=(.+)$/);
    if (!boundaryMatch) {
        throw new Error(`响应缺少 boundary: ${contentType}`);
    }
    const bodyBin = buffer.toString('latin1');
    const imageMap = new Map<Role, Buffer>();
    for (const part of bodyBin.split(`--${boundaryMatch[1]}`)) {
        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) {
            continue;
        }
        const nameMatch = part.match(/name="(User|Admin|SuperAdmin)"/);
        if (!nameMatch) {
            continue;
        }
        const raw = part.slice(headerEnd + 4).replace(/\r\n$/, '');
        imageMap.set(nameMatch[1] as Role, Buffer.from(raw, 'latin1'));
    }

    const missing = ROLE_MAP.map((r) => r.role).filter((r) => !imageMap.has(r));
    if (missing.length > 0) {
        throw new Error(`multipart 响应缺少 role part: ${missing.join(', ')}`);
    }
    return imageMap;
}

// ---------- 落盘 ----------

function writeImages(cmdId: string, images: Map<Role, Buffer>): void {
    // 首次生成时目录还不存在; 不建目录的表现是渲染完才 ENOENT, 白白浪费一次截图
    mkdirSync(ASSETS_DIR, { recursive: true });
    for (const [role, buffer] of images) {
        const file = join(ASSETS_DIR, `${cmdId}-${role}.png`);
        writeFileSync(file, buffer);
        console.log(`[help:generate] 写入 ${file} (${buffer.length} bytes)`);
    }
}

function writeHelpText(
    cmdId: string,
    handlerDir: string,
    texts: Record<Role, string>,
): void {
    const lines: string[] = [
        '/**',
        ' * 由 pnpm run help:generate 生成, 禁止手改',
        ` * cmd 权威源: scripts/generateHelp/cmds/${cmdId}.ts`,
        ' */',
        '',
        "import type { HelpVariant } from '../../utils/helpMessage';",
        '',
        '/** 按帮助版本的文本帮助 (图片降级用), Admin 版同时用于私聊用户与群聊超管 */',
        'export const HELP_TEXT_MAP: Record<HelpVariant, string> = {',
    ];
    for (const { role, variant } of ROLE_MAP) {
        lines.push(`    ${variant}: ${JSON.stringify(texts[role])},`);
    }
    lines.push('};', '');

    const file = join(handlerDir, 'helpText.generated.ts');
    writeFileSync(file, lines.join('\n'));
    console.log(`[help:generate] 写入 ${file}`);
}

// ---------- 主流程 ----------

async function main(): Promise<void> {
    const port = readGeneratorPort();
    await ensureServer(port);

    for (const { cmd, handlerDir } of CMD_TARGETS) {
        console.log(`[help:generate] 生成 ${cmd.id} ...`);
        const texts = await fetchText(port, cmd);
        const images = await fetchImages(port, cmd);
        writeImages(cmd.id, images);
        writeHelpText(cmd.id, handlerDir, texts);
    }
    console.log('[help:generate] 全部完成');
}

main().catch((err) => {
    console.error('[help:generate] 失败:', err);
    process.exit(1);
});
