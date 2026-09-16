import { describe, expect, it, vi } from 'vitest';
import type { UserRole } from '../../src/core/admin';
import {
    renderFailure,
    resolveInstruction,
    type DispatchOutcome,
    type InstructionDefinition,
    type InstructionRegistry,
} from '../../src/handlers/instruction';

// ==================== 夹具 ====================

const handler: InstructionDefinition['handler'] = vi.fn();

/**
 * 测试专用的注册表。
 *
 * 真实注册表在片 01 只装了 `help` / `status`, 而这两条都不带权限与作用域门槛;
 * 门槛分支因此用**注入注册表**覆盖——测的是分发层本身, 不是某条具体指令。
 */
function makeRegistry(): InstructionRegistry {
    return {
        // 二级命名空间: 模块 → 子指令
        namespaces: {
            game: {
                add: {
                    handler,
                    requiredRole: 'admin',
                    // 合法取值取决于运行期配置 (catalogs), 表达不进声明式门槛
                    validateArgs: (args) => (args[0] === '流放之路2' ? null : args[0] ?? ''),
                },
                list: { handler },
            },
        },
        // 一级: 指令名 → 定义
        root: {
            help: { handler },
            game: { handler },
            status: { handler, scope: 'group' },
            secret: { handler, scope: 'private' },
        },
    };
}

/** 群里的普通成员 */
const anonymous: UserRole = {
    userId: '10001',
    role: 'user',
    from: { id: '555', type: 'group' },
};

/** 群管理员 */
const groupAdmin: UserRole = { ...anonymous, role: 'admin' };

/** 好友私聊用户 (等同 admin 权限组) */
const friend: UserRole = {
    userId: '10002',
    role: 'privateUser',
    from: { id: '10002', type: 'private' },
};

/** 超管, 且身处别人的群里 */
const superAdmin: UserRole = {
    userId: '958341409',
    role: 'superAdmin',
    from: { id: '999', type: 'group' },
};

/** 断言结果是 execute, 并取出定义 */
function executedDefinition(outcome: DispatchOutcome): InstructionDefinition {
    if (outcome.kind !== 'execute') {
        throw new Error(`期望 execute, 实际是 ${outcome.kind}`);
    }
    return outcome.definition;
}

/** 断言结果是 execute, 并取出剩余参数 */
function executedArgs(outcome: DispatchOutcome): string[] {
    if (outcome.kind !== 'execute') {
        throw new Error(`期望 execute, 实际是 ${outcome.kind}`);
    }
    return outcome.args;
}

// ==================== 命中与路由 ====================

describe('resolveInstruction — 命中与路由', () => {
    it('一级指令命中, 剩余参数交给 handler', () => {
        const registry = makeRegistry();

        const outcome = resolveInstruction(anonymous, ['help'], registry);

        expect(executedDefinition(outcome)).toBe(registry.root.help);
        expect(executedArgs(outcome)).toEqual([]);
    });

    it('只有前缀、没有参数时路由到 help', () => {
        // 接收层切词后是 ['']——空串也是"一个参数"
        const registry = makeRegistry();

        expect(executedDefinition(resolveInstruction(anonymous, [''], registry))).toBe(
            registry.root.help,
        );
    });

    it('二级命名空间命中时, 模块名与子指令名都从参数里摘掉', () => {
        const registry = makeRegistry();

        const outcome = resolveInstruction(groupAdmin, ['game', 'add', '流放之路2'], registry);

        expect(executedDefinition(outcome)).toBe(registry.namespaces.game.add);
        expect(executedArgs(outcome)).toEqual(['流放之路2']);
    });

    it('**先查二级, 未命中再查一级**: `game` 既是命名空间又是指令名', () => {
        const registry = makeRegistry();

        const twoLevel = resolveInstruction(groupAdmin, ['game', 'add', '流放之路2'], registry);
        const oneLevel = resolveInstruction(groupAdmin, ['game'], registry);

        expect(executedDefinition(twoLevel)).toBe(registry.namespaces.game.add);
        expect(executedDefinition(oneLevel)).toBe(registry.root.game);
    });

    it('二级未命中时回落一级, 子指令名变回一级指令的普通参数', () => {
        // `game bogus` —— `game` 是命名空间但没有 `bogus` 子指令, 于是回落查一级的 `game`
        const registry = makeRegistry();

        const outcome = resolveInstruction(groupAdmin, ['game', 'bogus'], registry);

        expect(executedDefinition(outcome)).toBe(registry.root.game);
        expect(executedArgs(outcome)).toEqual(['bogus']);
    });

    it('真实形态: `game` 只作为命名空间存在时, `game bogus` 是未知指令', () => {
        const registry = makeRegistry();
        delete registry.root.game;

        expect(resolveInstruction(groupAdmin, ['game', 'bogus'], registry).kind).toBe(
            'unknown-command',
        );
    });

    it('指令名不区分大小写', () => {
        expect(resolveInstruction(anonymous, ['HELP'], makeRegistry()).kind).toBe('execute');
        expect(
            resolveInstruction(groupAdmin, ['Game', 'ADD', '流放之路2'], makeRegistry()).kind,
        ).toBe('execute');
    });

    it('未命中任何指令时是 unknown-command', () => {
        expect(resolveInstruction(anonymous, ['typo'], makeRegistry()).kind).toBe(
            'unknown-command',
        );
    });

    it('缺省 requiredRole 是 user——所有人都能用', () => {
        expect(resolveInstruction(anonymous, ['help'], makeRegistry()).kind).toBe('execute');
    });
});

// ==================== 作用域校验 ====================

describe('resolveInstruction — 作用域', () => {
    it('作用域不符时是 scope-mismatch, 并带上要求的会话类型', () => {
        // `status` 声明 scope: 'group', 而好友私聊的 from.type 是 'private'
        expect(resolveInstruction(friend, ['status'], makeRegistry())).toEqual({
            kind: 'scope-mismatch',
            required: 'group',
        });
    });

    it('作用域相符则通过', () => {
        expect(resolveInstruction(anonymous, ['status'], makeRegistry()).kind).toBe('execute');
        expect(resolveInstruction(friend, ['secret'], makeRegistry()).kind).toBe('execute');
    });

    it('未声明 scope 的指令不限会话类型', () => {
        expect(resolveInstruction(friend, ['help'], makeRegistry()).kind).toBe('execute');
        expect(resolveInstruction(anonymous, ['help'], makeRegistry()).kind).toBe('execute');
    });
});

// ==================== 权限校验 ====================

describe('resolveInstruction — 权限', () => {
    it('权限不足时是 permission-denied, 并带上整个参数串', () => {
        const outcome = resolveInstruction(anonymous, ['game', 'add', '流放之路2'], makeRegistry());

        expect(outcome).toEqual({
            kind: 'permission-denied',
            raw: 'game add 流放之路2',
        });
    });

    it('群管理员够 admin 级', () => {
        expect(resolveInstruction(groupAdmin, ['game', 'add', '流放之路2'], makeRegistry()).kind).toBe(
            'execute',
        );
    });

    it('好友私聊(privateUser)够 admin 级——它是 admin 权限组之上的档位', () => {
        expect(resolveInstruction(friend, ['game', 'add', '流放之路2'], makeRegistry()).kind).toBe(
            'execute',
        );
    });

    it('超管在**别人的群里**也够 admin 级', () => {
        expect(
            resolveInstruction(superAdmin, ['game', 'add', '流放之路2'], makeRegistry()).kind,
        ).toBe('execute');
    });
});

// ==================== 参数取值校验 ====================

describe('resolveInstruction — 参数取值', () => {
    it('validateArgs 返回出错的参数时是 invalid-args', () => {
        expect(resolveInstruction(groupAdmin, ['game', 'add', '原神'], makeRegistry())).toEqual({
            kind: 'invalid-args',
            arg: '原神',
        });
    });

    it('validateArgs 通过则执行', () => {
        const registry = makeRegistry();

        const outcome = resolveInstruction(groupAdmin, ['game', 'add', '流放之路2'], registry);

        expect(executedDefinition(outcome)).toBe(registry.namespaces.game.add);
        expect(executedArgs(outcome)).toEqual(['流放之路2']);
    });

    it('**权限先于取值**: 无权者传非法取值时回的是权限不足, 不泄露合法取值', () => {
        expect(resolveInstruction(anonymous, ['game', 'add', '原神'], makeRegistry())).toEqual({
            kind: 'permission-denied',
            raw: 'game add 原神',
        });
    });
});

// ==================== 失败文案 ====================

describe('renderFailure — 三类失败文案 (ADR-0002)', () => {
    const PREFIX = '#currency';
    const FOOTER = `输入 '${PREFIX} help' 获取帮助信息`;

    it('参数不合法: 报出**出错的参数**', () => {
        expect(renderFailure({ kind: 'invalid-args', arg: '原神' }, PREFIX)).toBe(
            `${PREFIX}: 非法参数 原神\n${FOOTER}`,
        );
    });

    it('未知指令: 报出**整个参数串**', () => {
        expect(renderFailure({ kind: 'unknown-command', raw: 'typo a b' }, PREFIX)).toBe(
            `${PREFIX}: 未知指令 typo a b\n${FOOTER}`,
        );
    });

    it('权限不足: 报出**整个参数串**; 与"非法参数"文案如实区分', () => {
        const text = renderFailure({ kind: 'permission-denied', raw: 'game add 流放之路2' }, PREFIX);

        expect(text).toBe(`${PREFIX}: 权限不足 game add 流放之路2\n${FOOTER}`);
        expect(text).not.toContain('非法参数');
    });

    it('作用域不符按范式回固定提示, 不带前缀也不带尾行', () => {
        expect(renderFailure({ kind: 'scope-mismatch', required: 'group' }, PREFIX)).toBe(
            '该指令仅限群聊使用',
        );
        expect(renderFailure({ kind: 'scope-mismatch', required: 'private' }, PREFIX)).toBe(
            '该指令仅限私聊使用',
        );
    });

    it('前缀取自配置, **不硬编码**: 换个前缀文案整体跟着换', () => {
        const custom = '/price';

        const text = renderFailure({ kind: 'unknown-command', raw: 'x' }, custom);

        expect(text).toBe(`/price: 未知指令 x\n输入 '/price help' 获取帮助信息`);
        expect(text).not.toContain('#currency');
    });

    it('成功执行不产生任何文案', () => {
        const outcome = resolveInstruction(anonymous, ['help'], makeRegistry());

        expect(renderFailure(outcome, PREFIX)).toBeNull();
    });
});
