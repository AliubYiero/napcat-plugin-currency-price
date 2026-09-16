/**
 * 指令注册表与分发
 *
 * 本模块只做两件事: (a) 声明式装配指令表; (b) 在调用 handler 前完成**全部**校验。
 * 业务 handler 收到的参数已保证满足角色与作用域要求, 内部**不再重复校验**。
 *
 * 分发是**纯函数**: `resolveInstruction` 只回答"这条消息该执行什么 / 该回什么失败文案",
 * 不发送消息、不碰全局状态。发送与日志留接收层 (handlers/message-handler.ts)。
 *
 * ⚠️ 失败反馈策略被 [ADR-0002](../../../docs/adr/0002-explicit-failure-feedback-over-silence.md)
 * **覆盖**: 范式的默认策略是"权限不足与未知指令静默", 本插件改为三类失败一律显式回复。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import type { NapCatPluginContext } from 'napcat-types/napcat-onebot/network/plugin/types';
import { hasRole, type UserRole } from '../core/admin';
import { helpHandler } from './currency/help.handler';
import { statusHandler } from './currency/status.handler';

/** 指令执行函数。校验已由分发层完成, 内部不做权限/作用域判断。 */
export type InstructionHandler = (
    ctx: NapCatPluginContext,
    event: OB11Message,
    commands: string[],
    userRole: UserRole,
) => void | Promise<void>;

/** 一条指令的声明: 执行函数 + 可选的门槛声明 */
export interface InstructionDefinition {
    handler: InstructionHandler;
    /** 执行所需**最低**角色, 缺省 `user` (所有人可用) */
    requiredRole?: UserRole['role'];
    /** 允许的会话类型, 缺省不限 */
    scope?: 'group' | 'private';
    /**
     * 参数取值校验 (业务级)。
     *
     * 分发层在调用 handler 前执行; 返回**出错的参数**(用于文案)表示不合法, `null` 表示通过。
     * 适用于"合法取值取决于运行期配置"的场景 (如 `game add <游戏名>` 要对 `catalogs` 精确匹配),
     * 这类校验放不进声明式的 `requiredRole` / `scope`。
     */
    validateArgs?: (args: string[]) => string | null;
}

/** 指令表: 二级命名空间 + 一级指令 */
export interface InstructionRegistry {
    /** 二级命名空间: 模块 → 子指令 → 定义 */
    namespaces: Record<string, Record<string, InstructionDefinition>>;
    /** 一级: 指令名 → 定义 */
    root: Record<string, InstructionDefinition>;
}

/**
 * 本插件的指令注册表（**纯装配, 不含业务**）
 *
 * 新增指令 = 这里加一行 + 在 `handlers/currency/` 写 handler。
 *
 * 本片只装已实现的 `help` / `status`。`price` / `notify` / `game` 见设计文档 §11.1 的
 * 完整指令表, 由后续片逐条加入——**不预告未实现的指令**, 装了就要能用。
 */
export const registry: InstructionRegistry = {
    // 二级命名空间: 模块 → 子指令
    namespaces: {},
    // 一级: 指令名 → 定义
    root: {
        help: { handler: helpHandler },
        status: { handler: statusHandler },
    },
};

/** 分发结果。`execute` 之外的每一种都对应一条要回复的失败文案。 */
export type DispatchOutcome =
    | { kind: 'execute'; definition: InstructionDefinition; args: string[] }
    | { kind: 'invalid-args'; arg: string }
    | { kind: 'unknown-command'; raw: string }
    | { kind: 'permission-denied'; raw: string }
    | { kind: 'scope-mismatch'; required: 'group' | 'private' };

/**
 * 解析一条指令消息, 完成命中、作用域、权限、参数四步校验。
 *
 * 校验顺序固定为 **作用域 → 权限 → 参数取值**: 权限先于取值, 免得把"合法取值有哪些"
 * 泄露给一个本来就无权执行的人。
 *
 * @param userRole 入口处**一次性推导**的角色 (见 core/admin.ts), 不在此重复推导
 * @param args 接收层切词后的参数数组 (已去掉前缀); 只有前缀时是 `['']`
 * @param registry 指令表; 缺省用本插件的真实注册表
 */
export function resolveInstruction(
    userRole: UserRole,
    args: string[],
    registry: InstructionRegistry,
): DispatchOutcome {
    const { definition, rest } = lookup(args, registry);

    if (!definition) {
        // 未知指令: 带上整个参数串, 供文案渲染
        return { kind: 'unknown-command', raw: args.join(' ') };
    }

    if (definition.scope && definition.scope !== userRole.from.type) {
        return { kind: 'scope-mismatch', required: definition.scope };
    }

    if (definition.requiredRole && !hasRole(userRole, definition.requiredRole)) {
        return { kind: 'permission-denied', raw: args.join(' ') };
    }

    const invalidArg = definition.validateArgs?.(rest);
    if (invalidArg !== null && invalidArg !== undefined) {
        return { kind: 'invalid-args', arg: invalidArg };
    }

    return { kind: 'execute', definition, args: rest };
}

/** 作用域不符的固定提示 (范式规定, 非本插件自拟) */
const SCOPE_HINT: Record<'group' | 'private', string> = {
    group: '该指令仅限群聊使用',
    private: '该指令仅限私聊使用',
};

/**
 * 把分发结果渲染成要回复的文案。
 *
 * ⚠️ **覆盖范式的默认静默策略** (见 [ADR-0002](../../../docs/adr/0002-explicit-failure-feedback-over-silence.md)):
 * 范式默认"权限不足与未知指令静默", 本插件改为三类失败一律显式回复, 且**文案如实区分**——
 * 统一成一句话就只剩纯损失: 没权限的用户看到"非法参数"会去检查拼写, 而不是意识到自己没权限。
 *
 * 前缀一律取自配置 `commandPrefix`, **不硬编码**——前缀是可配置的, 硬编码会在用户改过之后误导人。
 *
 * @returns 要回复的文案; `execute` 时返回 `null` (无需回复)
 */
export function renderFailure(outcome: DispatchOutcome, commandPrefix: string): string | null {
    const footer = `输入 '${commandPrefix} help' 获取帮助信息`;

    switch (outcome.kind) {
        case 'invalid-args':
            return `${commandPrefix}: 非法参数 ${outcome.arg}\n${footer}`;
        case 'unknown-command':
            return `${commandPrefix}: 未知指令 ${outcome.raw}\n${footer}`;
        case 'permission-denied':
            return `${commandPrefix}: 权限不足 ${outcome.raw}\n${footer}`;
        case 'scope-mismatch':
            return SCOPE_HINT[outcome.required];
        case 'execute':
            return null;
    }
}

/**
 * 查表: 先查二级命名空间 (`arg1` 为模块名、`arg2` 为子指令名), 未命中再查一级。
 *
 * 另有一条兜底: **只有前缀、没有参数时路由到 `help`**。"敲个前缀看看有什么"是最自然的
 * 用户行为, 用静默回应它是纯粹的可用性损失。该兜底只在**一级命名空间存在 `help`** 时生效。
 */
function lookup(
    args: string[],
    registry: InstructionRegistry,
): { definition: InstructionDefinition | null; rest: string[] } {
    // 兜底: 只有前缀、没有参数 (切词后是 [''])
    if (args.length === 1 && args[0] === '') {
        const help = registry.root.help;
        return { definition: help ?? null, rest: [] };
    }

    const first = args[0]?.toLocaleLowerCase() ?? '';
    const second = args[1]?.toLocaleLowerCase() ?? '';

    // 先查二级
    const subCommand = registry.namespaces[first]?.[second];
    if (subCommand) {
        return { definition: subCommand, rest: args.slice(2) };
    }

    // 未命中再查一级
    const rootCommand = registry.root[first];
    if (rootCommand) {
        return { definition: rootCommand, rest: args.slice(1) };
    }

    return { definition: null, rest: [] };
}
