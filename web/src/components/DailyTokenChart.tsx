import React, { useMemo, useState } from 'react';
import type { SavingsDailyItem } from '../types/api';
import { formatNumber } from '../utils/format';

/**
 * Token worker theo ngày: cột chồng (Gemini dưới, Codex trên) để chiều cao cột là tổng,
 * phần trên là tỷ trọng Codex. Trên AREA_THRESHOLD ngày thì chuyển sang vùng chồng.
 */

export const AREA_THRESHOLD = 30;
const MAX_X_LABELS = 12;
const DAY_MS = 86_400_000;

export interface DailyTokenChartLabels {
  gemini: string;
  codex: string;
  total: string;
  codexShare: string;
  ariaLabel: string;
}

export interface DailyPoint {
  date: string;
  gemini: number;
  codex: number;
  total: number;
  /** Ngày được thêm vào để trục liên tục, không có lượt chạy nào. */
  filled: boolean;
}

/** Điền các ngày thiếu giữa ngày đầu và ngày cuối để trục ngày không bị nhảy. */
export function fillDailyGaps(days: SavingsDailyItem[]): DailyPoint[] {
  const valid = days
    .filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d.date))
    .slice()
    .sort((a, b) => a.date.localeCompare(b.date));
  if (valid.length === 0) return [];
  const byDate = new Map(valid.map((d) => [d.date, d]));
  const start = Date.parse(`${valid[0].date}T00:00:00Z`);
  const end = Date.parse(`${valid[valid.length - 1].date}T00:00:00Z`);
  const out: DailyPoint[] = [];
  for (let ts = start; ts <= end; ts += DAY_MS) {
    const date = new Date(ts).toISOString().slice(0, 10);
    const d = byDate.get(date);
    const gemini = Math.max(0, d?.geminiTokens ?? 0);
    const codex = Math.max(0, d?.codexTokens ?? 0);
    out.push({ date, gemini, codex, total: gemini + codex, filled: !d });
  }
  return out;
}

/** Trục Y "đẹp": bước 1/2/2.5/5 × 10^n; chọn 3–5 khoảng chia sao cho mốc trên cùng sát max nhất. */
export function niceTicks(max: number, intervals?: number): number[] {
  if (!(max > 0)) return [0, 1, 2, 3, 4];
  const build = (count: number) => {
    const raw = max / count;
    const pow = 10 ** Math.floor(Math.log10(raw));
    const step = [1, 2, 2.5, 5, 10].map((m) => m * pow).find((s) => s >= raw) ?? 10 * pow;
    return Array.from({ length: count + 1 }, (_, i) => i * step);
  };
  if (intervals) return build(intervals);
  return [4, 5, 3].map(build).reduce((best, ticks) => (ticks[ticks.length - 1] < best[best.length - 1] ? ticks : best));
}

/** 15M, 2,5M, 500K: định dạng gọn cho nhãn trục. */
export function formatCompact(value: number, locale: string): string {
  const units: Array<[number, string]> = [[1e9, 'B'], [1e6, 'M'], [1e3, 'K']];
  for (const [size, suffix] of units) {
    if (Math.abs(value) >= size) {
      const n = value / size;
      return `${n.toLocaleString(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: n < 10 ? 1 : 0 })}${suffix}`;
    }
  }
  return value.toLocaleString(locale === 'en' ? 'en-US' : 'vi-VN');
}

export const DailyTokenChart: React.FC<{
  days: SavingsDailyItem[];
  locale: string;
  labels: DailyTokenChartLabels;
}> = ({ days, locale, labels }) => {
  const points = useMemo(() => fillDailyGaps(days), [days]);
  const [hover, setHover] = useState<number | null>(null);
  const n = points.length;
  const ticks = useMemo(() => niceTicks(Math.max(0, ...points.map((p) => p.total))), [points]);
  const yMax = ticks[ticks.length - 1] || 1;
  const asArea = n > AREA_THRESHOLD;
  const labelStep = Math.max(1, Math.ceil(n / MAX_X_LABELS));
  const pct = (v: number) => (v / yMax) * 100;
  const fmt = (v: number) => formatNumber(v, { locale });

  const hovered = hover !== null ? points[hover] : null;
  // Tooltip nằm cạnh cột (phải ở nửa trái, trái ở nửa phải) để không che đỉnh cột.
  const placeRight = hover !== null && (hover + 0.5) / n <= 0.5;
  const tooltipEdge = hover !== null ? ((placeRight ? hover + 1 : hover) / n) * 100 : 0;

  // Vùng chồng: hệ toạ độ 0..n-1 × 0..100, giãn theo khung bằng preserveAspectRatio="none".
  const areaPaths = useMemo(() => {
    if (!asArea || n < 2) return null;
    const x = (i: number) => i;
    const y = (v: number) => 100 - pct(v);
    const line = (vals: number[]) => vals.map((v, i) => `${i === 0 ? 'M' : 'L'} ${x(i)} ${y(v)}`).join(' ');
    const geminiTop = points.map((p) => p.gemini);
    const totalTop = points.map((p) => p.total);
    const back = (vals: number[]) => vals.map((v, i) => [i, v] as const).reverse().map(([i, v]) => `L ${x(i)} ${y(v)}`).join(' ');
    return {
      gemini: `${line(geminiTop)} L ${n - 1} 100 L 0 100 Z`,
      codex: `${line(totalTop)} ${back(geminiTop)} Z`,
      totalLine: line(totalTop),
    };
  }, [asArea, n, points, yMax]);

  return (
    <div className="w-full" data-testid="daily-token-chart" data-mode={asArea ? 'area' : 'bar'}>
      <div className="relative flex h-64 w-full">
        {/* Trục Y */}
        <div className="relative w-12 shrink-0" aria-hidden="true">
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-2 -translate-y-1/2 font-mono text-[10px] tabular-nums text-[var(--t-text-3)]"
              style={{ top: `${100 - pct(tick)}%` }}
            >
              {formatCompact(tick, locale)}
            </span>
          ))}
        </div>

        {/* Vùng vẽ */}
        <div className="relative flex-1" role="img" aria-label={labels.ariaLabel}>
          {ticks.map((tick, i) => (
            <div
              key={tick}
              aria-hidden="true"
              className={`absolute inset-x-0 border-t ${i === 0 ? 'border-[var(--t-border)]' : 'border-dashed border-[color-mix(in_srgb,var(--t-border)_60%,transparent)]'}`}
              style={{ top: `${100 - pct(tick)}%` }}
            />
          ))}

          {asArea && areaPaths && (
            <svg
              className="absolute inset-0 h-full w-full overflow-visible"
              viewBox={`0 0 ${n - 1} 100`}
              preserveAspectRatio="none"
              aria-hidden="true"
            >
              <path d={areaPaths.gemini} fill="var(--t-series-gemini)" fillOpacity={0.85} />
              <path d={areaPaths.codex} fill="var(--t-series-codex)" fillOpacity={0.85} />
              <path
                d={areaPaths.totalLine}
                fill="none"
                stroke="var(--t-surface)"
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
              />
              {hover !== null && (
                <line
                  x1={hover}
                  x2={hover}
                  y1={0}
                  y2={100}
                  stroke="var(--t-text-3)"
                  strokeWidth={1}
                  vectorEffect="non-scaling-stroke"
                />
              )}
            </svg>
          )}

          {/* Cột theo ngày; ở chế độ vùng chỉ là lớp bắt hover. */}
          <div className="absolute inset-0 flex">
            {points.map((p, i) => {
              const geminiH = pct(p.gemini);
              const codexH = pct(p.codex);
              const active = hover === i;
              return (
                <div
                  key={p.date}
                  data-testid="daily-token-day"
                  data-date={p.date}
                  data-total={p.total}
                  tabIndex={0}
                  aria-label={`${p.date}: ${labels.gemini} ${fmt(p.gemini)}, ${labels.codex} ${fmt(p.codex)}, ${labels.total} ${fmt(p.total)}`}
                  onMouseEnter={() => setHover(i)}
                  onMouseLeave={() => setHover((h) => (h === i ? null : h))}
                  onFocus={() => setHover(i)}
                  onBlur={() => setHover((h) => (h === i ? null : h))}
                  className={`relative flex h-full flex-1 flex-col items-center justify-end outline-hidden focus-visible:ring-2 focus-visible:ring-[var(--t-accent)] ${active && !asArea ? 'bg-[color-mix(in_srgb,var(--t-text)_5%,transparent)]' : ''}`}
                >
                  {!asArea && p.total > 0 && (
                    <div className="flex h-full w-[62%] max-w-10 flex-col justify-end gap-[2px]">
                      {p.codex > 0 && (
                        <div
                          data-series="codex"
                          className="w-full rounded-t-[4px]"
                          style={{ height: `max(2px, calc(${codexH}% - ${p.gemini > 0 ? 1 : 0}px))`, backgroundColor: 'var(--t-series-codex)' }}
                        />
                      )}
                      {p.gemini > 0 && (
                        <div
                          data-series="gemini"
                          className={`w-full ${p.codex > 0 ? '' : 'rounded-t-[4px]'}`}
                          style={{ height: `max(2px, calc(${geminiH}% - ${p.codex > 0 ? 1 : 0}px))`, backgroundColor: 'var(--t-series-gemini)' }}
                        />
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>

          {/* Tooltip */}
          {hovered && (
            <div
              role="tooltip"
              data-testid="daily-token-tooltip"
              className="pointer-events-none absolute top-0 z-10 min-w-44 rounded-lg border border-[var(--t-border)] bg-[var(--t-surface-2)] px-3 py-2 text-xs shadow-md"
              data-placement={placeRight ? 'right' : 'left'}
              style={{
                left: `${tooltipEdge}%`,
                transform: placeRight ? 'translateX(8px)' : 'translateX(calc(-100% - 8px))',
              }}
            >
              <div className="mb-1.5 font-mono font-semibold text-[var(--t-text)]">{hovered.date}</div>
              {[
                { key: 'gemini', label: labels.gemini, value: hovered.gemini, color: 'var(--t-series-gemini)' },
                { key: 'codex', label: labels.codex, value: hovered.codex, color: 'var(--t-series-codex)' },
              ].map((row) => (
                <div key={row.key} className="flex items-center justify-between gap-4">
                  <span className="flex items-center gap-1.5 text-[var(--t-text-2)]">
                    <span className="h-2.5 w-2.5 rounded-xs" style={{ backgroundColor: row.color }} />
                    {row.label}
                  </span>
                  <span className="font-mono tabular-nums text-[var(--t-text)]">{fmt(row.value)}</span>
                </div>
              ))}
              <div className="mt-1.5 flex items-center justify-between gap-4 border-t border-[var(--t-border)] pt-1.5">
                <span className="font-semibold text-[var(--t-text)]">{labels.total}</span>
                <span className="font-mono font-semibold tabular-nums text-[var(--t-text)]">{fmt(hovered.total)}</span>
              </div>
              {hovered.total > 0 && (
                <div className="mt-0.5 flex items-center justify-between gap-4 text-[var(--t-text-3)]">
                  <span>{labels.codexShare}</span>
                  <span className="font-mono tabular-nums">{((hovered.codex / hovered.total) * 100).toLocaleString(locale === 'en' ? 'en-US' : 'vi-VN', { maximumFractionDigits: 1 })}%</span>
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Trục X */}
      <div className="ml-12 flex" aria-hidden="true">
        {points.map((p, i) => (
          <div key={p.date} className="flex-1 pt-2 text-center font-mono text-[10px] text-[var(--t-text-3)]">
            {i % labelStep === 0 || (i === n - 1 && i % labelStep >= labelStep / 2) ? p.date.slice(5) : ''}
          </div>
        ))}
      </div>

      {/* Bảng số liệu cho trình đọc màn hình */}
      <table className="sr-only">
        <thead>
          <tr>
            <th>Date</th>
            <th>{labels.gemini}</th>
            <th>{labels.codex}</th>
            <th>{labels.total}</th>
          </tr>
        </thead>
        <tbody>
          {points.map((p) => (
            <tr key={p.date}>
              <td>{p.date}</td>
              <td>{p.gemini}</td>
              <td>{p.codex}</td>
              <td>{p.total}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
};
