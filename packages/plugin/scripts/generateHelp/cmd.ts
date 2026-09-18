/**
 * 帮助权威源的类型定义
 *
 * 与上游渲染服务 `napcat-help-generate` 的 `src/types/cmd.ts` **逐字段对齐**——
 * 权威源是 TS 模块, 经 `/api/text` 与 `/api/images` 以 JSON 提交, 类型不一致会在上游
 * 被 zod 挡下 (400)。改这里的字段时, 同步改上游。
 *
 * 见 docs/help-output-pattern.md 的"配置权威源"节。
 */

/** 权限组: 上游 API 的 role 取值 (PascalCase), 落盘文件名与文本映射的键由生成脚本映射为变体名 */
export type Role = 'User' | 'Admin' | 'SuperAdmin';

/** 一条指令 */
export interface Instruction {
    /** 指令原文, **含前缀** */
    cmd: string;
    desc: string;
    /** 仅私聊可用。与 `onlyGroup` 互斥, 均缺省表示不限 */
    onlyPrivate?: boolean;
    /** 仅群聊可用 */
    onlyGroup?: boolean;
}

/** 一个指令集 (按职责分组的一段指令列表) */
export interface InstructionSet {
    groupName: string;
    instructions: Instruction[];
    /** 仅管理员可见 (超管也可见)。与 `isSuperAdmin` 互斥 */
    isAdmin?: boolean;
    /** 仅超管可见 */
    isSuperAdmin?: boolean;
}

export interface ContentHelpMethod {
    /** 方法名, 空字符串表示跳过标题 */
    name: string;
    /** 支持 html 标签 */
    steps: (string | string[])[];
}

/** 图文帮助 (分步骤说明)。本插件未用, 保留以对齐上游契约 */
export interface ContentHelp {
    groupName: string;
    methods: ContentHelpMethod[];
    isAdmin?: boolean;
    isSuperAdmin?: boolean;
}

/** 一个帮助面板 */
export interface Cmd {
    /** 脚注, 同时用作导出文件名 (`{id}-{Role}.png`) */
    id: string;
    title: string;
    cmd: (InstructionSet | ContentHelp)[];
}
