/**
 * 历史留档存储 —— `archive/YYYY-MM-DD.json[.gz]`
 *
 * 见设计文档 §7.3 §7.4 §12.4。归档是 "`data.json` 的历史切片": `runs[].games` 与
 * `data.json` 的 `games` **同构**, 渲染与校验各只有一份代码。
 *
 * 生命周期（§7.4）: 当天实时追加（run 级） → 次日 gzip（流式）并删除原文件 → 30 天后删除。
 * 维护任务**不挂在调度器上**（并集为空或小时集合为空时调度器根本不启动, 归档会永远不被
 * 压缩清理）, 改挂在 `plugin_init` 完成后 + 每次成功抓取后——维护的存在不取决于
 * "有没有人订阅"。
 */

import fs from 'fs';
import path from 'path';
import { createGzip } from 'zlib';
import { pluginState } from '../core/state';
import type { GameOk, GameResult } from './data.store';
import { writeJsonAtomic } from './atomic-json';

/** 一次抓取运行的落档记录（不含归档文件自身的包装结构） */
export interface RunRecord {
    /** 由调度层记的开始时刻（ISO 8601 UTC）——抓取层不管这些（§8.1） */
    startedAt: string;
    finishedAt: string;
    /** `"schedule"` 或 `"manual:{会话键}"` */
    trigger: string;
    /** 与 `scrapeGames` 返回值同构: 成功 `GameOk`, 失败 `{ error }` */
    games: Record<string, GameResult>;
}

/** 归档文件结构 */
interface ArchiveFile {
    date: string;
    runs: RunRecord[];
}

/** 本地日期 → `YYYY-MM-DD`。归档按**用户的钟点**分天, 与展示层同一基准 */
function localDateKey(date: Date): string {
    const pad = (value: number): string => String(value).padStart(2, '0');

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/**
 * 归档存储 (单例)。延迟实例化, 与 `DataStore` 同理: 模块加载期零 IO
 */
export class ArchiveStore {
    private static instance: ArchiveStore | null = null;

    private constructor() {}

    /** 单例入口。**不要**在模块加载期调用 */
    static getInstance(): ArchiveStore {
        if (!ArchiveStore.instance) {
            ArchiveStore.instance = new ArchiveStore();
        }

        return ArchiveStore.instance;
    }

    /**
     * 追加一条抓取运行到当天的归档文件。
     *
     * **全部游戏失败（或一个游戏都没有）时不写归档**（§7.3）——归档记录的是"值多少",
     * 一条全是 `error` 的 run 对渲染与回溯都没有价值。
     *
     * @param run 本次运行的元数据与结果
     * @param now 当前时刻, 归档文件名由它的本地日期决定。默认取系统时间
     */
    recordRun(run: RunRecord, now: Date = new Date()): void {
        if (!Object.values(run.games).some((game) => !('error' in game))) return;

        const date = localDateKey(now);
        const filePath = path.join(pluginState.getDataFilePath('archive'), `${date}.json`);

        const state = this.readArchive(filePath);
        state.runs.push(run);

        try {
            writeJsonAtomic(filePath, state, 2);
        } catch (error) {
            // 磁盘写入失败只记日志, 不影响主流程（§14）
            pluginState.logger.error('写入归档失败:', error);
        }
    }

    /**
     * 归档维护: 把今天之前的 `.json` 压成 `.json.gz` 并删除原文件, 再清理超过 30 天的
     * `.json.gz`（§12.4）。
     *
     * 日期以**文件名**为准而不是 mtime——mtime 会被复制 / 同步 / 手改污染, 文件名才是
     * 归档身份的一部分。失败（如 gzip 中途出错）时保留未压缩文件, 下次维护再试（§14）。
     *
     * @param now 当前时刻, 决定"哪些算昨天之前、哪些算超过 30 天"。默认取系统时间
     */
    async runMaintenance(now: Date = new Date()): Promise<void> {
        const dir = pluginState.getDataFilePath('archive');
        if (!fs.existsSync(dir)) return;

        const today = localDateKey(now);

        for (const filename of fs.readdirSync(dir)) {
            if (!filename.endsWith('.json')) continue;

            const date = filename.slice(0, -'.json'.length);
            if (date >= today) continue; // 今天及未来的不压缩（含非日期命名的杂项文件）

            await this.gzipArchive(path.join(dir, filename));
        }

        this.pruneExpiredGz(dir, now);
    }

    /**
     * 流式 gzip 一个归档文件, 成功后删除原文件。
     *
     * 压缩产物同样走临时文件 + rename（§7.5）: 中断不会留下半截 `.json.gz` 被当成品。
     * 任何一步失败都**保留**未压缩的 `.json`, 由下次维护重试。
     */
    private async gzipArchive(filePath: string): Promise<void> {
        const gzPath = `${filePath}.gz`;
        const tmpPath = `${gzPath}.tmp`;

        try {
            await new Promise<void>((resolve, reject) => {
                const source = fs.createReadStream(filePath);
                const gzip = createGzip();
                const target = fs.createWriteStream(tmpPath);

                source.on('error', reject);
                gzip.on('error', reject);
                target.on('error', reject);
                target.on('finish', () => resolve());
                source.pipe(gzip).pipe(target);
            });
            fs.renameSync(tmpPath, gzPath);
            fs.rmSync(filePath, { force: true });
        } catch (error) {
            try {
                fs.rmSync(tmpPath, { force: true });
            } catch {
                /* 清理失败不影响主流程: 原 `.json` 仍在, 下次重试 */
            }
            pluginState.logger.warn(`归档压缩失败, 保留原文件待下次重试: ${filePath}`, error);
        }
    }

    /** 删除超过 30 天的 `.json.gz`。删除失败只记日志, 不阻塞其余清理 */
    private pruneExpiredGz(dir: string, now: Date): void {
        const cutoff = new Date(now);
        cutoff.setDate(cutoff.getDate() - 30);
        const cutoffKey = localDateKey(cutoff);

        for (const filename of fs.readdirSync(dir)) {
            if (!filename.endsWith('.json.gz')) continue;

            const date = filename.slice(0, -'.json.gz'.length);
            if (date >= cutoffKey) continue; // 未满 30 天

            try {
                fs.rmSync(path.join(dir, filename), { force: true });
            } catch (error) {
                pluginState.logger.warn(`清理过期归档失败: ${filename}`, error);
            }
        }
    }

    /** 现读归档文件。文件不存在或损坏都从空结构开始——追加不该被一个坏文件挡住 */
    private readArchive(filePath: string): ArchiveFile {
        try {
            const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as ArchiveFile;
            if (raw && typeof raw === 'object' && Array.isArray(raw.runs)) return raw;
        } catch {
            /* 文件不存在 / 损坏 → 空结构 */
        }

        return { date: path.basename(filePath, '.json'), runs: [] };
    }
}
