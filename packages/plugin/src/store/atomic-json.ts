/**
 * JSON 文件的原子写与容错读
 *
 * 见设计文档 §7.5 与 §14: `state.json` / `data.json` / 归档一律**临时文件 + rename**;
 * 损坏时备份为 `*.bak` 并初始化为空结构, **不阻塞启动**。
 *
 * 本模块是这两种处置的唯一实现——`data.json`(片 03)、归档(片 07) 复用同一份,
 * 免得"原子写"在每个 store 里各写一遍、各漏一处。
 */

import fs from 'fs';
import path from 'path';

/** 读取结果。`corrupted` 为真表示原文件读不动、已被备份走了 */
export interface ReadResult<T> {
    data: T;
    corrupted: boolean;
}

/**
 * 损坏文件的备份路径: `xxx.json` → `xxx.json.bak`
 *
 * 后缀追加而非替换扩展名: `state.json.bak` 一眼看得出备份的是哪个文件。
 */
export function backupPathOf(filePath: string): string {
    return `${filePath}.bak`;
}

/**
 * 原子写 JSON
 *
 * 先写同目录下的临时文件, 再 rename 覆盖目标——rename 在同一文件系统内是原子的,
 * 因此**读到的永远是完整文件**: 要么是旧内容, 要么是新内容, 不会是半截。
 *
 * @throws 写入或 rename 失败时抛出 (调用方决定记日志还是中断), 但临时文件会被清理
 */
export function writeJsonAtomic(filePath: string, data: unknown, space: number = 0): void {
    const tmpPath = `${filePath}.tmp`;
    const dir = path.dirname(filePath);

    try {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
        fs.writeFileSync(tmpPath, JSON.stringify(data, null, space), 'utf-8');
        fs.renameSync(tmpPath, filePath);
    } catch (error) {
        // 清理未完成落盘的临时文件——留着它下次会被当成垃圾, 且容易误读成"写入成功过"
        try {
            fs.rmSync(tmpPath, { force: true });
        } catch {
            /* 清理失败不影响主流程: 目标文件仍是完整可用的 */
        }
        throw error;
    }
}

/**
 * 容错读 JSON: 任何情况下都返回可用数据, **绝不抛错**
 *
 * 文件不存在 → 兜底值; 文件损坏 (JSON 解析失败) → 把损坏文件**原样备份**为 `*.bak`,
 * 再返回兜底值。备份而非删除: 用户的订阅关系可能是手工改坏的, 留一份才好排查。
 */
export function readJsonSafe<T>(filePath: string, fallback: T): ReadResult<T> {
    if (!fs.existsSync(filePath)) {
        return { data: fallback, corrupted: false };
    }

    try {
        return { data: JSON.parse(fs.readFileSync(filePath, 'utf-8')) as T, corrupted: false };
    } catch {
        try {
            fs.renameSync(filePath, backupPathOf(filePath));
        } catch {
            /* 备份失败 (如权限不足) 也要继续: 启动不能被一个坏文件挡住 */
        }
        return { data: fallback, corrupted: true };
    }
}
