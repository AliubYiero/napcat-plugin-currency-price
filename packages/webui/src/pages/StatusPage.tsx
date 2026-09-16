import { useState, useEffect } from 'react'
import type { PluginStatus } from '../types'
import { useChrome } from '../hooks/useChrome'
import { IconPower, IconClock, IconActivity, IconDownload, IconRefresh, IconTerminal } from '../components/icons'

interface StatusPageProps {
    status: PluginStatus | null
    onRefresh: () => void
}

/** ISO 8601 时刻 → 本地 `YYYY-MM-DD HH:mm`。无法解析或为空时原样/占位 */
function formatReadAt(iso: string): string {
    if (!iso) return '未抓取'

    const date = new Date(iso)
    if (Number.isNaN(date.getTime())) return iso

    const pad = (value: number) => String(value).padStart(2, '0')

    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

/** 浏览器是从哪一档找到的（给部署者看的，不是给普通用户看的） */
const SOURCE_LABEL: Record<string, string> = {
    config: '手动配置',
    shared: '共享安装',
    system: '系统浏览器',
}

/** 将毫秒格式化为可读时长 */
function formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000)
    const days = Math.floor(seconds / 86400)
    const hours = Math.floor((seconds % 86400) / 3600)
    const minutes = Math.floor((seconds % 3600) / 60)
    const secs = seconds % 60

    if (days > 0) return `${days}天 ${hours}小时 ${minutes}分 ${secs}秒`
    if (hours > 0) return `${hours}小时 ${minutes}分 ${secs}秒`
    if (minutes > 0) return `${minutes}分 ${secs}秒`
    return `${secs}秒`
}

export default function StatusPage({ status, onRefresh }: StatusPageProps) {
    const [displayUptime, setDisplayUptime] = useState<string>('-')
    const [syncInfo, setSyncInfo] = useState<{ baseUptime: number; syncTime: number } | null>(null)

    useEffect(() => {
        if (status?.uptime !== undefined && status.uptime > 0) {
            setSyncInfo({ baseUptime: status.uptime, syncTime: Date.now() })
        }
    }, [status?.uptime])

    useEffect(() => {
        if (!syncInfo) { setDisplayUptime('-'); return }
        const updateUptime = () => {
            const elapsed = Date.now() - syncInfo.syncTime
            setDisplayUptime(formatUptime(syncInfo.baseUptime + elapsed))
        }
        updateUptime()
        const interval = setInterval(updateUptime, 1000)
        return () => clearInterval(interval)
    }, [syncInfo])

    if (!status) {
        return (
            <div className="flex items-center justify-center h-64 empty-state">
                <div className="flex flex-col items-center gap-3">
                    <div className="loading-spinner text-primary" />
                    <div className="text-gray-400 text-sm">正在获取插件状态...</div>
                </div>
            </div>
        )
    }

    const { config, stats } = status
    const games = status.games ?? []

    const statCards = [
        {
            label: '插件状态',
            value: config.enabled ? '运行中' : '已停用',
            icon: <IconPower size={18} />,
            color: config.enabled ? 'text-emerald-500' : 'text-red-400',
            bg: config.enabled ? 'bg-emerald-500/10' : 'bg-red-500/10',
        },
        {
            label: '运行时长',
            value: displayUptime,
            icon: <IconClock size={18} />,
            color: 'text-primary',
            bg: 'bg-primary/10',
        },
        {
            label: '今日处理',
            value: String(stats.todayProcessed),
            icon: <IconActivity size={18} />,
            color: 'text-amber-500',
            bg: 'bg-amber-500/10',
        },
        {
            label: '累计处理',
            value: String(stats.processed),
            icon: <IconDownload size={18} />,
            color: 'text-violet-500',
            bg: 'bg-violet-500/10',
        },
    ]

    return (
        <div className="space-y-6">
            {/* 统计卡片 */}
            <div className="grid grid-cols-2 lg:grid-cols-4 gap-4 stagger-children">
                {statCards.map((card) => (
                    <div key={card.label} className="card p-4 hover-lift">
                        <div className="flex items-center justify-between mb-3">
                            <span className="text-xs text-gray-400 font-medium">{card.label}</span>
                            <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${card.bg} ${card.color} transition-transform duration-300 hover:scale-110`}>
                                {card.icon}
                            </div>
                        </div>
                        <div className="text-xl font-bold text-gray-900 dark:text-white">{card.value}</div>
                    </div>
                ))}
            </div>

            {/* 配置概览 */}
            <div className="card p-5 hover-lift animate-fade-in-up">
                <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                        <IconTerminal size={16} className="text-gray-400" />
                        基础信息
                    </h3>
                    <button onClick={onRefresh} className="btn-ghost btn text-xs px-2.5 py-1.5">
                        <IconRefresh size={13} />
                        刷新
                    </button>
                </div>
                <div className="space-y-3">
                    <InfoRow label="指令前缀" value={config.commandPrefix} />
                    <InfoRow
                        label="超级管理员"
                        value={
                            config.adminUsers.length > 0
                                ? config.adminUsers.join('、')
                                : '未配置'
                        }
                    />
                    <InfoRow label="调试模式" value={config.debug ? '开启' : '关闭'} />
                </div>
            </div>

            <ChromeCard />

            {/* 各游戏最后抓取时间 */}
            <div className="card p-5 hover-lift animate-fade-in-up">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2 mb-4">
                    <IconClock size={16} className="text-gray-400" />
                    各游戏数据时间
                </h3>
                {games.length === 0 ? (
                    <div className="text-xs text-gray-400 py-2">还没有抓到过任何游戏的数据</div>
                ) : (
                    <div className="space-y-3">
                        {games.map((game) => (
                            <InfoRow
                                key={game.name}
                                label={game.lastError ? `${game.name}（上次抓取失败）` : game.name}
                                value={formatReadAt(game.readAt)}
                            />
                        ))}
                    </div>
                )}
            </div>
        </div>
    )
}

/**
 * 浏览器状态卡。
 *
 * ⚠️ **可用性、路径、版本都来自 `/chrome/status` 的缓存**——它每 5 秒被轮询一次，
 * 绝不能在那里跑检测。想真的验证一遍得点「重新检测」。
 */
function ChromeCard() {
    const { status, install, busy, detect, startInstall } = useChrome()

    const available = status?.available ?? false
    const unchecked = status?.checkedAt === null || status?.checkedAt === undefined

    return (
        <div className="card p-5 hover-lift animate-fade-in-up">
            <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-semibold text-gray-900 dark:text-white flex items-center gap-2">
                    <IconActivity size={16} className="text-gray-400" />
                    浏览器
                    <span
                        className={`text-xs px-2 py-0.5 rounded-full ${
                            unchecked
                                ? 'bg-gray-500/10 text-gray-400'
                                : available
                                  ? 'bg-emerald-500/10 text-emerald-500'
                                  : 'bg-red-500/10 text-red-400'
                        }`}
                    >
                        {unchecked ? '未检测' : available ? '可用' : '不可用'}
                    </span>
                </h3>
                <div className="flex items-center gap-2">
                    <button
                        onClick={detect}
                        disabled={busy}
                        className="btn-ghost btn text-xs px-2.5 py-1.5 disabled:opacity-50"
                    >
                        <IconRefresh size={13} />
                        重新检测
                    </button>
                    <button
                        onClick={startInstall}
                        disabled={busy || install?.running}
                        className="btn-ghost btn text-xs px-2.5 py-1.5 disabled:opacity-50"
                    >
                        <IconDownload size={13} />
                        安装 Chrome
                    </button>
                </div>
            </div>

            <div className="space-y-3">
                <InfoRow label="路径" value={status?.path ?? '未找到'} />
                <InfoRow label="版本" value={status?.version ?? '未知（需完整检测）'} />
                <InfoRow
                    label="来源"
                    value={status?.source ? (SOURCE_LABEL[status.source] ?? status.source) : '—'}
                />
            </div>

            {/* 不可用时把原因说清楚：装一遍浏览器解决不了权限问题 */}
            {!unchecked && !available && status?.error && (
                <div className="mt-3 text-xs text-red-400 break-all">{status.error}</div>
            )}

            {install?.running && (
                <div className="mt-4">
                    <div className="flex items-center justify-between text-xs text-gray-400 mb-1.5">
                        <span>{install.progress?.message ?? '正在安装…'}</span>
                        <span>{Math.round((install.progress?.percent ?? 0) * 100)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-gray-500/10 overflow-hidden">
                        <div
                            className="h-full bg-primary transition-all duration-300"
                            style={{ width: `${Math.round((install.progress?.percent ?? 0) * 100)}%` }}
                        />
                    </div>
                </div>
            )}

            {install?.error && <div className="mt-3 text-xs text-red-400 whitespace-pre-line">{install.error}</div>}
        </div>
    )
}

function InfoRow({ label, value }: { label: string; value: string }) {
    return (
        <div className="flex items-center justify-between py-1">
            <span className="text-xs text-gray-400">{label}</span>
            <span className="text-xs font-medium text-gray-700 dark:text-gray-300">{value}</span>
        </div>
    )
}
