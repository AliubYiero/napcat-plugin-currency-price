/**
 * 权限模块
 *
 * 只回答"发送者是谁", 不回答"这条指令需要谁"——后者是 InstructionDefinition 里的门槛声明,
 * 校验时机与失败反馈收敛在分发层 (见 handlers/instruction.ts)。
 *
 * 角色**推导而非配置**: 除 superAdmin 需 `adminUsers` 名单外, 全部从消息事件推导,
 * 不维护"用户 → 权限"的数据面。见 docs/permission-pattern.md。
 */

import type { OB11Message } from 'napcat-types/napcat-onebot';
import { pluginState } from './state';

/** 角色推导的返回结构, 一次推导、处处使用 */
export interface UserRole {
    /** 用户 QQ 号 */
    userId: string;
    role: 'user' | 'admin' | 'privateUser' | 'superAdmin';
    from: {
        /** 群号或用户 QQ 号 */
        id: string;
        type: 'private' | 'group';
    };
}

/**
 * 档位等级表。**与 `UserRole['role']` 同处一模块**, 新增档位时两处同步修改。
 */
const ROLE_LEVEL: Record<UserRole['role'], number> = {
    user: 0,
    admin: 1,
    privateUser: 2,
    superAdmin: 3,
};

/**
 * 判断角色是否达到所需档位
 *
 * 一律是"至少 X 级"的线性比较, 不写矩阵式权限表。
 */
export function hasRole(userRole: UserRole, required: UserRole['role']): boolean {
    return ROLE_LEVEL[userRole.role] >= ROLE_LEVEL[required];
}

/**
 * 是否为超级管理员
 *
 * 本模块中**唯一**触碰全局状态的函数, 因此整个模块只在运行期可用——
 * 不要在模块加载期求值任何角色。
 */
export function isSuperAdmin(qq: string): boolean {
    return pluginState.config.adminUsers.includes(qq);
}

/**
 * 群管理员身份检查
 *
 * 只读消息事件里平台给出的判定结果 (`admin` = 群管理员, `owner` = 群主),
 * **不自行调用群成员查询 API**——消息事件已带该字段。
 *
 * ⚠️ 非群聊场景返回 `false` 而非 `true`: 返回 `true` 会让任何误在私聊路径上的
 * 调用静默通过权限判定。
 */
export function isGroupAdmin(event: OB11Message): boolean {
    if (event.message_type !== 'group') return false;
    const role = (event.sender as Record<string, unknown> | undefined)?.role;
    return role === 'admin' || role === 'owner';
}

/**
 * 入口推导: 由消息事件一次性推导出发送者角色
 *
 * 推导顺序 superAdmin → privateUser → admin → user, **短路命中, 一票定档**, 不做档位叠加。
 */
export function getUserRole(event: OB11Message): UserRole {
    const userId = String(event.user_id);
    const isGroup = event.message_type === 'group';

    let role: UserRole['role'] = 'user';
    if (isSuperAdmin(userId)) {
        role = 'superAdmin';
    } else if (!isGroup) {
        // 仅机器人**好友**的私聊等同 admin 权限组。
        // sub_type: friend = 好友, group = 群临时会话, other = 陌生人。
        // "好友私聊即提权"是领域决策: 与机器人互为好友者经平台关系链约束, 视为可信。
        if (event.sub_type === 'friend') {
            role = 'privateUser';
        }
    } else if (isGroupAdmin(event)) {
        role = 'admin';
    }

    return {
        userId,
        role,
        from: {
            id: isGroup ? String(event.group_id) : String(event.user_id),
            type: isGroup ? 'group' : 'private',
        },
    };
}
