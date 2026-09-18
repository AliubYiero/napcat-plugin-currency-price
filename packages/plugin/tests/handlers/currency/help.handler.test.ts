import fs from 'fs';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { OB11Message } from 'napcat-types/napcat-onebot';
import { DEFAULT_CONFIG } from '../../../src/config';
import type { UserRole } from '../../../src/core/admin';
import { pluginState } from '../../../src/core/state';
import { HELP_TEXT_MAP } from '../../../src/handlers/currency/helpText.generated';
import { handleMessage } from '../../../src/handlers/message-handler';
import { getHelpVariant, type HelpVariant } from '../../../src/utils/helpMessage';
import { buildCurrencyPriceHelp } from '../../../scripts/generateHelp/cmds/napcat-plugin-currency-price';
import { createTestEnv, groupMessage, privateMessage, type TestEnv } from '../../helpers/test-env';

function role(
    roleName: UserRole['role'],
    sessionType: 'group' | 'private' = 'group',
): UserRole {
    return {
        userId: '10001',
        role: roleName,
        from: { id: sessionType === 'group' ? '555' : '10001', type: sessionType },
    };
}

describe('getHelpVariant — 帮助版本由「角色 + 会话类型」共同决定', () => {
    it('普通用户任意会话类型都是 user 版', () => {
        expect(getHelpVariant(role('user', 'group'))).toBe('user');
        expect(getHelpVariant(role('user', 'private'))).toBe('user');
    });

    it('群管理员是 admin 版', () => {
        expect(getHelpVariant(role('admin'))).toBe('admin');
    });

    it('好友私聊用户 (privateUser) 是 admin 版——它等同 admin 权限组', () => {
        expect(getHelpVariant(role('privateUser', 'private'))).toBe('admin');
    });

    it('**群聊里的超管是 admin 版**, 不是 superAdmin 版', () => {
        // SuperAdmin 版含仅私聊可用的指令, 在群里输出会误导用户
        expect(getHelpVariant(role('superAdmin', 'group'))).toBe('admin');
    });

    it('私聊里的超管才是 superAdmin 版', () => {
        expect(getHelpVariant(role('superAdmin', 'private'))).toBe('superAdmin');
    });
});

// ==================== 产物与权威源的一致性 ====================

/** 按范式的权限过滤规则取出某变体可见的指令原文 */
function authoritativeInstructions(variant: HelpVariant): string[] {
    const { cmd } = buildCurrencyPriceHelp(DEFAULT_CONFIG.commandPrefix);

    return cmd
        .filter((set) => {
            if (set.isSuperAdmin) return variant === 'superAdmin';
            if (set.isAdmin) return variant !== 'user';
            return true;
        })
        .flatMap((set) => set.instructions.map((instruction) => instruction.cmd));
}

describe('帮助产物 — 由权威源生成, 不手工维护', () => {
    it('前缀来自 `DEFAULT_CONFIG.commandPrefix`, 不是各处硬编码的字面量', () => {
        for (const text of Object.values(HELP_TEXT_MAP)) {
            expect(text).toContain(`${DEFAULT_CONFIG.commandPrefix} price`);
        }
    });

    it('**生成产物与权威源同步**: 权威源里的每条指令都出现在对应的文本映射里', () => {
        // 改了权威源却忘了重跑 help:generate, 在用户那里的表现是"指令能用但帮助里查不到",
        // 这条断言把它变成一次测试失败
        for (const variant of ['user', 'admin', 'superAdmin'] as HelpVariant[]) {
            for (const instruction of authoritativeInstructions(variant)) {
                expect(HELP_TEXT_MAP[variant]).toContain(instruction);
            }
        }
    });

    it('管理指令**不出现**在 user 版里', () => {
        const adminOnly = buildCurrencyPriceHelp(DEFAULT_CONFIG.commandPrefix).cmd
            .filter((set) => set.isAdmin === true)
            .flatMap((set) => set.instructions.map((instruction) => instruction.cmd));

        expect(adminOnly.length).toBeGreaterThan(0);
        for (const instruction of adminOnly) {
            expect(HELP_TEXT_MAP.user).not.toContain(instruction);
        }
    });

    it('SuperAdmin 版与 Admin 版内容相同——本插件没有超管专属指令', () => {
        expect(HELP_TEXT_MAP.superAdmin).toBe(HELP_TEXT_MAP.admin);
    });

    it('三张 PNG 都在仓库里, 且是真 PNG', () => {
        const assetsDir = path.resolve(__dirname, '../../../src/assets');
        const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

        for (const variant of ['User', 'Admin', 'SuperAdmin']) {
            const file = path.join(assetsDir, `napcat-plugin-currency-price-${variant}.png`);
            expect(fs.existsSync(file)).toBe(true);
            expect(fs.readFileSync(file).subarray(0, 4)).toEqual(signature);
        }
    });
});

// ==================== 运行时: 图片优先 / 文本回退 ====================

describe('帮助指令 — 图片优先, 文本回退', () => {
    let env: TestEnv;

    /** 把三个假 PNG 放进插件根目录的 `assets/` (运行时按 dataPath 的兄弟目录找图) */
    function putHelpImages(): void {
        const assetsDir = path.join(env.root, 'assets');
        fs.mkdirSync(assetsDir, { recursive: true });
        for (const variant of ['User', 'Admin', 'SuperAdmin']) {
            fs.writeFileSync(
                path.join(assetsDir, `napcat-plugin-currency-price-${variant}.png`),
                Buffer.from([0x89, 0x50, 0x4e, 0x47]),
            );
        }
    }

    async function helpMessage(event: OB11Message): Promise<string> {
        env.clearSent();
        await handleMessage(env.ctx, event);
        return env.sent.at(-1) ?? '';
    }

    beforeEach(() => {
        env = createTestEnv();
        env.init();
    });

    afterEach(() => {
        env.dispose();
    });

    it('`#currency` 与 `#currency help` 都返回帮助, 内容一致', async () => {
        const bare = await helpMessage(groupMessage('#currency'));
        const explicit = await helpMessage(groupMessage('#currency help'));

        expect(bare).toBe(explicit);
        expect(bare).toBe(HELP_TEXT_MAP.user);
    });

    it('有图片产物时发图片 (不是文本)', async () => {
        putHelpImages();

        const message = await helpMessage(groupMessage('#currency help'));

        expect(message).toContain('"type":"image"');
        expect(message).not.toContain('核心指令');
    });

    it('按「角色 + 会话类型」选对了图片文件', async () => {
        putHelpImages();

        const cases: { event: OB11Message; variant: string; why: string }[] = [
            {
                event: groupMessage('#currency help'),
                variant: 'User',
                why: '群聊普通成员',
            },
            {
                event: groupMessage('#currency help', { role: 'admin' }),
                variant: 'Admin',
                why: '群管理员',
            },
            {
                event: groupMessage('#currency help', { role: 'owner' }),
                variant: 'Admin',
                why: '群主',
            },
            {
                event: privateMessage('#currency help'),
                variant: 'Admin',
                why: '好友私聊 (privateUser 等同 admin)',
            },
            {
                event: privateMessage('#currency help', { subType: 'group' }),
                variant: 'User',
                why: '群临时会话',
            },
        ];

        for (const { event, variant, why } of cases) {
            // 超管档位不在表内: 它走 adminUsers 名单, 由下一条用例覆盖
            expect(`${why} → ${await helpMessage(event)}`).toContain(`-${variant}.png`);
        }
    });

    it('**群聊超管发 Admin 版图**, 私聊超管才发 SuperAdmin 版图', async () => {
        putHelpImages();
        pluginState.config = { ...pluginState.config, adminUsers: ['10001', '10002'] };

        const inGroup = await helpMessage(groupMessage('#currency help', { userId: '10001' }));
        expect(inGroup).toContain('-Admin.png');

        const inPrivate = await helpMessage(privateMessage('#currency help', { userId: '10002' }));
        expect(inPrivate).toContain('-SuperAdmin.png');
    });

    it('图片缺失时回退文本, 且文本与图片表达的内容一致 (同一份权威源)', async () => {
        const message = await helpMessage(groupMessage('#currency help', { role: 'admin' }));

        expect(message).toBe(HELP_TEXT_MAP.admin);
        // 图上有的每组指令, 回退文本里也在
        expect(message).toContain('#currency price');
        expect(message).toContain('#currency notify on|off');
    });

    it('图片存在但发送失败时同样回退文本', async () => {
        putHelpImages();
        vi.spyOn(env.ctx.actions, 'call').mockRejectedValueOnce(new Error('发送失败'));

        const message = await helpMessage(groupMessage('#currency help'));

        expect(message).toBe(HELP_TEXT_MAP.user);
    });

    it('user 版文本里没有管理指令', async () => {
        const message = await helpMessage(groupMessage('#currency help'));

        expect(message).toContain('#currency status');
        expect(message).not.toContain('notify');
        expect(message).not.toContain('game');
    });
});
