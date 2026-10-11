import type { Lang } from './i18n'

/** Near-taken outcomes among the `counted` that hold an edit distance, and the mean characters kept per outcome. */
type EditFigures = { near: number; counted: number; nearPercent: number; meanRetained: string }

const zh = {
  predictionStats: (
    taken: number,
    shown: number,
    percent: number,
    medianSeconds: string,
    cachePercent: number | null,
    edits: EditFigures | null,
    abstained: number,
    abstainPercent: number | null,
  ) =>
    `下一步预测：最近显示的 ${shown} 条里采纳了 ${taken} 条（${percent}%）；fork 耗时中位数 ${medianSeconds} 秒` +
    (cachePercent === null ? '' : `；fork 输入 token 有 ${cachePercent}% 读自缓存`) +
    (edits === null ? '' : `；${edits.counted} 条里 ${edits.near} 条接近采纳（${edits.nearPercent}%，编辑距离不超过长度的 30%），平均每条保留 ${edits.meanRetained} 字`) +
    (abstainPercent === null ? '' : `；放弃显示 ${abstained} 次（占全部决定的 ${abstainPercent}%）`),
  predictionStatsEmpty: '还没有预测记录：显示过的预测在你发出下一条后才计入',
}

const en: typeof zh = {
  predictionStats: (taken, shown, percent, medianSeconds, cachePercent, edits, abstained, abstainPercent) =>
    `Next-prompt predictions: ${taken} of the last ${shown} shown were taken (${percent}%); median fork time ${medianSeconds} s` +
    (cachePercent === null ? '' : `; ${cachePercent}% of fork input tokens read from cache`) +
    (edits === null ? '' : `; ${edits.near} of ${edits.counted} near-taken (${edits.nearPercent}%, edit distance within 30% of the length), mean ${edits.meanRetained} chars kept`) +
    (abstainPercent === null ? '' : `; ${abstained} abstained (${abstainPercent}% of decisions)`),
  predictionStatsEmpty: 'No predictions logged yet: a shown prediction counts once you send your next prompt',
}

export const strings: Record<Lang, typeof zh> = { 'zh-CN': zh, en }
