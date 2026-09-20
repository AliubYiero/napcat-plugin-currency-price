import { useState, useEffect, useCallback } from 'react';
import { noAuthFetch } from '../utils/api';
import { showToast } from '../hooks/useToast';
import type { CatalogConfig, CurrencyConfig } from '../types';
import {
    IconTerminal,
    IconSave,
    IconRefresh,
    IconX,
} from '../components/icons';

/** 区服组合在输入框里的分隔符。一行 = 一个区服组合，层数由分隔出的段数决定 */
const ZONE_SEPARATOR = '/';

const zoneRowToText = (row: string[]) =>
    row.join(` ${ZONE_SEPARATOR} `);
const textToZoneRow = (text: string) =>
    text
        .split(ZONE_SEPARATOR)
        .map((part) => part.trim())
        .filter((part) => part.length > 0);

/**
 * 分区配置页 —— `catalogs` 的唯一编辑入口。
 *
 * `catalogs` 在 NapCat 的配置 Schema 里**没有控件**（Schema 只有 boolean/text/number/
 * select/multiSelect/html/combine，没有数组或表格，而 `zoneConfigs` 是 `string[][]`），
 * 所以它必须走自定义页面，见 docs/design.md §5.2 §13。
 *
 * 保存即生效：后端把清单写回内存配置，`price` 与调度器下一轮读到的就是新值，无需重启。
 */
export default function CatalogPage() {
    const [catalogs, setCatalogs] = useState<CatalogConfig[] | null>(
        null,
    );
    /** 已保存内容的快照，用来判断"有没有未保存的改动" */
    const [savedJson, setSavedJson] = useState('');
    const [saving, setSaving] = useState(false);

    const fetchCatalogs = useCallback(async () => {
        try {
            const res =
                await noAuthFetch<CatalogConfig[]>('/catalogs');
            const data = res.code === 0 && res.data ? res.data : [];
            setCatalogs(data);
            setSavedJson(JSON.stringify(data));
        } catch {
            showToast('获取分区配置失败', 'error');
            setCatalogs([]);
        }
    }, []);

    useEffect(() => {
        fetchCatalogs();
    }, [fetchCatalogs]);

    const update = (index: number, patch: Partial<CatalogConfig>) => {
        setCatalogs(
            (prev) =>
                prev?.map((item, i) =>
                    i === index ? { ...item, ...patch } : item,
                ) ?? null,
        );
    };

    const addGame = () => {
        setCatalogs((prev) => [
            ...(prev ?? []),
            {
                name: '',
                pageUrl: '',
                zoneConfigs: [['']],
                currencyList: [],
            },
        ]);
    };

    const removeGame = (index: number) => {
        const target = catalogs?.[index];
        if (
            !window.confirm(
                `删除「${target?.name || '未命名游戏'}」的整份配置？`,
            )
        )
            return;

        setCatalogs(
            (prev) => prev?.filter((_, i) => i !== index) ?? null,
        );
    };

    const save = async () => {
        if (!catalogs) return;

        // 前端校验只是体验优化——真正的防线在 `POST /catalogs` 的清洗（见 config-pattern）
        const incomplete = catalogs.filter(
            (c) => !c.name.trim() || !c.pageUrl.trim(),
        );
        if (incomplete.length > 0) {
            showToast(
                `有 ${incomplete.length} 个游戏没填游戏名或页面 URL`,
                'warning',
            );
            return;
        }

        setSaving(true);
        try {
            await noAuthFetch('/catalogs', {
                method: 'POST',
                body: JSON.stringify({ catalogs }),
            });
            showToast('分区配置已保存，下一次抓取即生效', 'success');
            // 拉回后端清洗后的真实结果：让页面显示的是**实际生效的**配置，不是我们提交的
            await fetchCatalogs();
        } catch {
            showToast('保存失败', 'error');
        } finally {
            setSaving(false);
        }
    };

    if (!catalogs) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">
                        加载分区配置中...
                    </div>
                </div>
            </div>
        );
    }

    const dirty = JSON.stringify(catalogs) !== savedJson;

    return (
        <div className="space-y-4">
            {/* 工具栏 */}
            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 animate-fade-in-down">
                <p className="text-xs text-gray-400">
                    一个游戏 = 一份抓取目标。保存后
                    <strong className="text-gray-500 dark:text-gray-300">
                        下一次抓取即生效
                    </strong>
                    ，无需重启。
                </p>
                <div className="flex items-center gap-2">
                    <button
                        className="btn btn-ghost text-xs"
                        onClick={fetchCatalogs}
                    >
                        <IconRefresh size={13} />
                        重新加载
                    </button>
                    <button
                        className="btn btn-ghost text-xs"
                        onClick={addGame}
                    >
                        <IconTerminal size={13} />
                        新增游戏
                    </button>
                    <button
                        className="btn btn-primary text-xs"
                        onClick={save}
                        disabled={saving || !dirty}
                    >
                        <IconSave size={13} />
                        {saving
                            ? '保存中...'
                            : dirty
                              ? '保存'
                              : '已保存'}
                    </button>
                </div>
            </div>

            {catalogs.length === 0 && (
                <div className="card py-12 text-center empty-state">
                    <p className="text-gray-400 text-sm">
                        还没有配置任何游戏
                    </p>
                    <p className="text-gray-400 text-xs mt-2">
                        点「新增游戏」，填入站点页面 URL 即可开始抓取
                    </p>
                </div>
            )}

            {catalogs.map((catalog, index) => (
                <GameCard
                    key={index}
                    catalog={catalog}
                    onChange={(patch) => update(index, patch)}
                    onRemove={() => removeGame(index)}
                />
            ))}
        </div>
    );
}

/* ---- 子组件 ---- */

interface GameCardProps {
    catalog: CatalogConfig;
    onChange: (patch: Partial<CatalogConfig>) => void;
    onRemove: () => void;
}

function GameCard({ catalog, onChange, onRemove }: GameCardProps) {
    const setZoneRow = (rowIndex: number, row: string[]) => {
        onChange({
            zoneConfigs: catalog.zoneConfigs.map((r, i) =>
                i === rowIndex ? row : r,
            ),
        });
    };

    const setCurrencyRow = (
        rowIndex: number,
        patch: Partial<CurrencyConfig>,
    ) => {
        onChange({
            currencyList: catalog.currencyList.map((row, i) =>
                i === rowIndex ? { ...row, ...patch } : row,
            ),
        });
    };

    const addCurrencyRow = () =>
        onChange({
            currencyList: [
                ...catalog.currencyList,
                { name: '', detail: false },
            ],
        });

    const removeCurrencyRow = (rowIndex: number) =>
        onChange({
            currencyList: catalog.currencyList.filter(
                (_, i) => i !== rowIndex,
            ),
        });

    const addZoneRow = () =>
        onChange({ zoneConfigs: [...catalog.zoneConfigs, []] });

    const removeZoneRow = (rowIndex: number) =>
        onChange({
            zoneConfigs: catalog.zoneConfigs.filter(
                (_, i) => i !== rowIndex,
            ),
        });

    return (
        <div className="card p-5 hover-lift animate-fade-in-up space-y-5">
            {/* 头部 */}
            <div className="flex items-start justify-between gap-4">
                <div className="flex items-center gap-2 text-sm font-semibold text-gray-900 dark:text-white">
                    <IconTerminal
                        size={16}
                        className="text-gray-400"
                    />
                    {catalog.name || '未命名游戏'}
                </div>
                <button
                    className="btn btn-ghost text-xs text-red-400"
                    onClick={onRemove}
                >
                    <IconX size={13} />
                    删除
                </button>
            </div>

            <CommitInput
                label="游戏名"
                desc="同时是 data.json 的键与指令参数 `game add <游戏名>`"
                value={catalog.name}
                placeholder="流放之路2"
                onCommit={(value) => onChange({ name: value })}
            />

            <CommitInput
                label="页面 URL"
                desc="从浏览器地址栏原样复制整条。六个 query 参数一个都不能少，也不要改成结构化字段"
                value={catalog.pageUrl}
                placeholder="https://qiandao.com/currency/currency-zone?catalogName=..."
                mono
                onCommit={(value) => onChange({ pageUrl: value })}
            />

            {/* 通货清单 —— 与区服组合同一套逐行形态，只是每行多一个「详情」开关 */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        通货清单
                    </span>
                    <button
                        className="btn btn-ghost text-xs"
                        onClick={addCurrencyRow}
                    >
                        添加通货
                    </button>
                </div>
                <div className="text-xs text-gray-400 mb-2">
                    一行一个通货名，与站点名称
                    <strong className="text-gray-500 dark:text-gray-300">
                        精确匹配
                    </strong>
                    ——写错的表现是静默产出
                    0，不报错。行尾的按钮决定这个通货要不要
                    <strong className="text-gray-500 dark:text-gray-300">
                        抓详情
                    </strong>
                    （成交量 + 前 5
                    条挂单）：开启后每个通货多一次点击与一次面板等待，抓取会明显变慢
                </div>

                {catalog.currencyList.length === 0 ? (
                    <p className="text-xs text-gray-400 py-1">
                        还没有通货，这个游戏不会被抓取
                    </p>
                ) : (
                    <div className="space-y-2">
                        {catalog.currencyList.map(
                            (currency, rowIndex) => (
                                <div
                                    key={rowIndex}
                                    className="flex items-center gap-2"
                                >
                                    <CommitInput
                                        value={currency.name}
                                        placeholder="神圣石"
                                        mono
                                        bare
                                        onCommit={(value) =>
                                            setCurrencyRow(rowIndex, {
                                                name: value,
                                            })
                                        }
                                    />
                                    <button
                                        className={`btn btn-ghost text-xs flex-shrink-0 ${
                                            currency.detail
                                                ? 'text-primary'
                                                : 'text-gray-400'
                                        }`}
                                        title={
                                            currency.detail
                                                ? '已开启详情：抓这个通货的成交量与前 5 条挂单'
                                                : '未开启详情：只抓价格'
                                        }
                                        aria-pressed={currency.detail}
                                        onClick={() =>
                                            setCurrencyRow(rowIndex, {
                                                detail:
                                                    !currency.detail,
                                            })
                                        }
                                    >
                                        详情
                                        {currency.detail
                                            ? '开'
                                            : '关'}
                                    </button>
                                    <button
                                        className="btn btn-ghost text-xs text-red-400 flex-shrink-0"
                                        onClick={() =>
                                            removeCurrencyRow(
                                                rowIndex,
                                            )
                                        }
                                    >
                                        <IconX size={12} />
                                    </button>
                                </div>
                            ),
                        )}
                    </div>
                )}
            </div>

            {/* 区服组合 */}
            <div>
                <div className="flex items-center justify-between mb-1">
                    <span className="text-sm font-medium text-gray-800 dark:text-gray-200">
                        区服组合
                    </span>
                    <button
                        className="btn btn-ghost text-xs"
                        onClick={addZoneRow}
                    >
                        添加组合
                    </button>
                </div>
                <div className="text-xs text-gray-400 mb-2">
                    一行一个组合，用{' '}
                    <code className="font-mono">/</code>{' '}
                    分隔层级。层数随游戏而变—— 流放之路是 3 级（
                    <code className="font-mono">
                        国服 / 赛季 / 普通
                    </code>
                    ）， 火炬之光是 2 级（
                    <code className="font-mono">赛季 / 普通</code>）
                </div>

                {catalog.zoneConfigs.length === 0 ? (
                    <p className="text-xs text-gray-400 py-1">
                        还没有组合，这个游戏不会被抓取
                    </p>
                ) : (
                    <div className="space-y-2">
                        {catalog.zoneConfigs.map((row, rowIndex) => (
                            <div
                                key={rowIndex}
                                className="flex items-center gap-2"
                            >
                                <CommitInput
                                    value={zoneRowToText(row)}
                                    placeholder="国服 / 赛季 / 普通"
                                    mono
                                    bare
                                    onCommit={(value) =>
                                        setZoneRow(
                                            rowIndex,
                                            textToZoneRow(value),
                                        )
                                    }
                                />
                                <button
                                    className="btn btn-ghost text-xs text-red-400 flex-shrink-0"
                                    onClick={() =>
                                        removeZoneRow(rowIndex)
                                    }
                                >
                                    <IconX size={12} />
                                </button>
                            </div>
                        ))}
                    </div>
                )}
            </div>
        </div>
    );
}

/**
 * 失焦/回车才提交的文本输入。
 *
 * **不能边打字边提交**：`zoneConfigs` 行与 `currencyList` 都要先解析成结构，逐字符解析会
 * 在输入 `神圣石,` 的瞬间把尾随逗号吃掉，光标随之跳动。本地留一份原文，提交时才转换。
 */
function CommitInput({
    label,
    desc,
    value,
    placeholder,
    mono,
    bare,
    onCommit,
}: {
    label?: string;
    desc?: string;
    value: string;
    placeholder?: string;
    mono?: boolean;
    /** 只渲染输入框，不要 label / desc（用于区服组合这类紧凑行） */
    bare?: boolean;
    onCommit: (value: string) => void;
}) {
    const [local, setLocal] = useState(value);
    useEffect(() => {
        setLocal(value);
    }, [value]);

    const commit = () => {
        if (local !== value) onCommit(local);
    };

    const input = (
        <input
            className={`input-field ${mono ? 'font-mono text-xs' : ''}`}
            value={local}
            placeholder={placeholder}
            onChange={(e) => setLocal(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => e.key === 'Enter' && commit()}
        />
    );

    if (bare) return <div className="flex-1">{input}</div>;

    return (
        <div>
            <div className="text-sm font-medium text-gray-800 dark:text-gray-200 mb-1">
                {label}
            </div>
            {desc && (
                <div className="text-xs text-gray-400 mb-2">
                    {desc}
                </div>
            )}
            {input}
        </div>
    );
}
